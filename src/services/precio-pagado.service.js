// FEEDBACK DEL PRECIO PAGADO (Parte D del precio v2). La PyME carga cuanto le
// pago al chofer por un viaje FINALIZADO: es el dato para recalibrar la formula.
//
// - 1:1 con el viaje (unique en precios_pagados_viaje.id_viaje). PUT crea o
//   actualiza con UN INSERT ... ON CONFLICT (id_viaje) DO UPDATE: dos PUT
//   simultaneos nunca crean dos filas (el segundo actualiza y suma una edicion).
// - Solo FINALIZADO (incluye el finalizado incompleto) -> si no, 400.
// - Editable hasta FEEDBACK_PRECIO_EDICION_DIAS desde el fin del viaje
//   (fecha_corte_precio) -> despues, 409. El estado FINALIZADO es final y
//   fecha_corte_precio no cambia despues del cierre, asi que la lectura previa
//   alcanza para decidir (no hay carrera que la invalide).
// - RESPONSABLE o MIEMBRO de la PyME del viaje. El chofer no llega (las rutas de
//   la PyME exigen rol CLIENTE y membresia).
import prisma from '../config/prisma.js';
import { configPrecio } from '../config/precio.js';
import { ErrorNegocio } from './error-negocio.js';
import {
  motivoNoEditable,
  precioPagadoPendiente,
  editableHasta,
  serializarPrecioPagado,
} from './precio-pagado-reglas.js';

const DIA_MS = 86_400_000;
const diasEdicion = () => configPrecio().FEEDBACK_PRECIO_EDICION_DIAS;

async function viajeConFeedback(id_organizacion, id_viaje) {
  const viaje = await prisma.viaje.findFirst({
    where: { id_viaje, id_organizacion },
    select: { id_viaje: true, estado: true, fecha_corte_precio: true, precio_pagado: true },
  });
  // Mismo 404 que el resto de las rutas de la PyME: no se filtran ids.
  if (!viaje) throw new ErrorNegocio(404, 'Viaje no encontrado');
  return viaje;
}

function respuesta(viaje, precio_pagado, extra = {}) {
  const dias = diasEdicion();
  const conFeedback = { ...viaje, precio_pagado };
  return {
    id_viaje: viaje.id_viaje,
    precio_pagado: serializarPrecioPagado(precio_pagado),
    precio_pagado_pendiente: precioPagadoPendiente(conFeedback, new Date(), dias),
    editable: motivoNoEditable(viaje, new Date(), dias) === null,
    editable_hasta: editableHasta(viaje, dias),
    ...extra,
  };
}

export async function obtenerPrecioPagado(id_organizacion, id_viaje) {
  const viaje = await viajeConFeedback(id_organizacion, id_viaje);
  return respuesta(viaje, viaje.precio_pagado);
}

// datos: { monto, incluye_iva, monto_peajes?, metodo_pago?, ayudantes_reales?,
// comentario? } (ya validado). PUT reemplaza: lo opcional que no llega queda null.
export async function guardarPrecioPagado({ id_organizacion, id_viaje, id_usuario, datos }) {
  const viaje = await viajeConFeedback(id_organizacion, id_viaje);
  const dias = diasEdicion();
  const motivo = motivoNoEditable(viaje, new Date(), dias);
  if (motivo === 'NO_FINALIZADO') {
    throw new ErrorNegocio(400, 'Solo se puede cargar el precio pagado de un viaje finalizado');
  }
  if (motivo === 'VENCIDO') {
    throw new ErrorNegocio(
      409,
      `El plazo para cargar el precio pagado vencio: se puede cargar hasta ${dias} dias despues del fin del viaje`
    );
  }

  // Upsert ATOMICO. xmax = 0 en la fila devuelta <=> la inserto este statement.
  const filas = await prisma.$queryRaw`
    INSERT INTO precios_pagados_viaje
      (id_viaje, monto, incluye_iva, monto_peajes, metodo_pago, ayudantes_reales, comentario,
       id_usuario, creado_en, actualizado_en, ediciones)
    VALUES
      (${id_viaje}, ${datos.monto}, ${datos.incluye_iva}, ${datos.monto_peajes ?? null},
       ${datos.metodo_pago ?? null}::"MetodoPagoFlete", ${datos.ayudantes_reales ?? null},
       ${datos.comentario ?? null}, ${id_usuario}, now(), now(), 0)
    ON CONFLICT (id_viaje) DO UPDATE SET
      monto = EXCLUDED.monto,
      incluye_iva = EXCLUDED.incluye_iva,
      monto_peajes = EXCLUDED.monto_peajes,
      metodo_pago = EXCLUDED.metodo_pago,
      ayudantes_reales = EXCLUDED.ayudantes_reales,
      comentario = EXCLUDED.comentario,
      id_usuario = EXCLUDED.id_usuario,
      actualizado_en = now(),
      ediciones = precios_pagados_viaje.ediciones + 1
    RETURNING id_viaje, monto, incluye_iva, monto_peajes, metodo_pago::text AS metodo_pago,
      ayudantes_reales, comentario, id_usuario, creado_en, actualizado_en, ediciones,
      (xmax = 0) AS creado`;
  const { creado, ...fila } = filas[0];
  return respuesta(viaje, fila, { creado: Boolean(creado) });
}

// Finalizados dentro de la ventana y sin feedback, del mas reciente al mas
// viejo, con lo minimo para pedirlo.
export async function listarPendientes(id_organizacion, { page, limit }) {
  const dias = diasEdicion();
  const desde = new Date(Date.now() - dias * DIA_MS);
  const where = {
    id_organizacion,
    estado: 'FINALIZADO',
    fecha_corte_precio: { gte: desde },
    precio_pagado: { is: null },
  };
  const [total, viajes] = await Promise.all([
    prisma.viaje.count({ where }),
    prisma.viaje.findMany({
      where,
      select: {
        id_viaje: true,
        fecha_programada: true,
        fecha_corte_precio: true,
        version_precio: true,
        precio_estimado: true,
        precio_estimado_min: true,
        precio_estimado_max: true,
        precio_real: true,
        motivo: true,
        paradas: { select: { orden: true, direccion: true }, orderBy: { orden: 'asc' } },
      },
      orderBy: [{ fecha_corte_precio: 'desc' }, { id_viaje: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return {
    total,
    page,
    limit,
    viajes: viajes.map((v) => ({
      id_viaje: v.id_viaje,
      fecha_programada: v.fecha_programada,
      fecha_fin: v.fecha_corte_precio,
      editable_hasta: editableHasta(v, dias),
      motivo: v.motivo,
      origen: v.paradas[0]?.direccion ?? null,
      destino: v.paradas[v.paradas.length - 1]?.direccion ?? null,
      cantidad_paradas: v.paradas.length,
      version_precio: v.version_precio ?? 1,
      precio_estimado: v.precio_estimado,
      rango: { bajo: v.precio_estimado_min, alto: v.precio_estimado_max },
      precio_real: v.precio_real,
    })),
  };
}
