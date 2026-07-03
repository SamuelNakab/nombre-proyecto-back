import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import * as turf from '@turf/turf';
import prisma from '../config/prisma.js';
import { estimarCosto as estimarCostoService } from '../services/costo.service.js';
import { conductorEsElegible } from '../services/elegibilidad.service.js';
import { publicarViajeAConductoresElegibles } from '../services/matching.service.js';
import { obtenerAcumulado } from '../services/gps.service.js';
import { cerrarViaje } from '../services/cierre.service.js';
import { recalcularEtaInmediato } from '../services/eta-emisor.js';
import { limpiarViajeActivo } from '../services/cancelacion.service.js';
import { calcularYGuardarRuta, obtenerRutaPlaneada } from '../services/ruta.service.js';
import { io } from '../sockets/index.js';

// ─── QR helpers ──────────────────────────────────────────────────────────────

function firmarQR(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const firma = createHmac('sha256', process.env.QR_SECRET).update(data).digest('hex');
  return `${data}.${firma}`;
}

function verificarQR(qr_firmado) {
  const dot = qr_firmado.lastIndexOf('.');
  if (dot === -1) return null;
  const data = qr_firmado.slice(0, dot);
  const firma = qr_firmado.slice(dot + 1);
  const firmaEsperada = createHmac('sha256', process.env.QR_SECRET).update(data).digest('hex');
  try {
    const a = Buffer.from(firma, 'hex');
    const b = Buffer.from(firmaEsperada, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString());
  } catch {
    return null;
  }
}

// ─── Schemas de validacion ───────────────────────────────────────────────────

const CONDICIONES = ['FRAGIL', 'REFRIGERADO', 'CARGA_PESADA', 'PELIGROSO', 'VOLUMINOSO'];

const camposBase = {
  zona: z.enum(['CABA', 'PROVINCIA', 'MIXTO']),
  paradas: z
    .array(
      z.object({
        lat: z.number(),
        lng: z.number(),
        direccion: z.string().min(1).optional(),
      })
    )
    .min(2),
};

const schemaEstimar = z.object({
  ...camposBase,
  fecha_programada: z.string().optional(),
});

const schemaCrear = z.object({
  ...camposBase,
  fecha_programada: z.string().refine(
    (val) => {
      const date = new Date(val);
      return !isNaN(date.getTime()) && date > new Date(Date.now() + 60 * 60 * 1000);
    },
    { message: 'fecha_programada debe ser una fecha ISO futura (al menos 1 hora desde ahora)' }
  ),
  condiciones_requeridas: z
    .array(z.enum(CONDICIONES))
    .optional()
    .default([]),
  descripcion: z.string().max(500).optional(),
});

// ─── Controllers ─────────────────────────────────────────────────────────────

export async function estimarCosto(req, res) {
  const parsed = schemaEstimar.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { zona, paradas, fecha_programada } = parsed.data;
  const fechaEfectiva = fecha_programada ?? new Date().toISOString();

  try {
    const resultado = await estimarCostoService({ zona, paradas, fecha_programada: fechaEfectiva });
    return res.status(200).json(resultado);
  } catch {
    return res.status(503).json({ error: 'No se pudo calcular la distancia' });
  }
}

export async function crearViaje(req, res) {
  const parsed = schemaCrear.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { zona, paradas, fecha_programada, condiciones_requeridas, descripcion } = parsed.data;

  const cliente = await prisma.cliente.findUnique({
    where: { id_usuario: req.usuario.id_usuario },
  });
  if (!cliente) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de cliente' });
  }

  let resultado;
  try {
    resultado = await estimarCostoService({ zona, paradas, fecha_programada });
  } catch {
    return res.status(503).json({ error: 'No se pudo calcular la distancia' });
  }

  const { tarifa_hora, tarifa_km } = resultado.desglose;

  const viaje = await prisma.viaje.create({
    data: {
      id_cliente: cliente.id_cliente,
      zona,
      tarifa_hora,
      tarifa_km,
      fecha_programada: new Date(fecha_programada),
      descripcion: descripcion ?? null,
      precio_estimado: resultado.precio_estimado,
      paradas: {
        create: paradas.map((p, i) => ({
          orden: i + 1,
          latitud: p.lat,
          longitud: p.lng,
          direccion: p.direccion ?? `${p.lat},${p.lng}`,
        })),
      },
      condiciones_req: {
        create: condiciones_requeridas.map((condicion) => ({ condicion })),
      },
    },
    include: {
      paradas: true,
      condiciones_req: true,
    },
  });

  // Calcular la ruta planeada ahora, al crear el viaje. Si Google Maps falla,
  // no bloqueamos la creacion: ruta_planeada queda null y se reintenta en el
  // primer ping GPS (fallback en gps.socket.js).
  let ruta_planeada = null;
  try {
    ruta_planeada = await calcularYGuardarRuta(viaje.id_viaje);
  } catch (err) {
    console.error(`[crearViaje] No se pudo calcular la ruta planeada para viaje ${viaje.id_viaje}:`, err.message);
  }

  if (io) {
    await publicarViajeAConductoresElegibles(io, viaje, req.usuario.id_usuario);
  }

  return res.status(201).json({ ...viaje, ruta_planeada, desglose_estimado: resultado.desglose });
}

export async function listarViajesDisponibles(req, res) {
  const conductor = await prisma.conductor.findUnique({
    where: { id_usuario: req.usuario.id_usuario },
    include: {
      conductor_vehiculos: {
        include: {
          vehiculo: {
            include: { condiciones: true },
          },
        },
      },
      vehiculos_propios: {
        include: { condiciones: true },
      },
    },
  });
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const viajes = await prisma.viaje.findMany({
    where: {
      estado: 'BUSCANDO_CONDUCTOR',
      fecha_programada: { gt: new Date() },
    },
    include: {
      paradas: true,
      condiciones_req: true,
      cliente: {
        include: {
          usuario: {
            select: { nombre: true, apellido: true, telefono: true },
          },
        },
      },
    },
    orderBy: { fecha_programada: 'asc' },
  });

  const viajesElegibles = viajes.filter((viaje) => {
    const condicionesViaje = viaje.condiciones_req.map((c) => c.condicion);
    return conductorEsElegible(
      conductor.conductor_vehiculos,
      conductor.vehiculos_propios,
      condicionesViaje
    );
  });

  return res.status(200).json(viajesElegibles);
}

export async function obtenerViaje(req, res) {
  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje: Number(req.params.id) },
    include: {
      paradas: { orderBy: { orden: 'asc' } },
      condiciones_req: true,
      cliente: { include: { usuario: true } },
      conductor: { include: { usuario: true } },
      calificacion: true,
    },
  });

  if (!viaje) {
    return res.status(404).json({ error: 'Viaje no encontrado' });
  }

  const esCliente = viaje.cliente.id_usuario === req.usuario.id_usuario;
  const esConductor =
    viaje.conductor !== null && viaje.conductor.id_usuario === req.usuario.id_usuario;

  if (!esCliente && !esConductor) {
    return res.status(403).json({ error: 'Sin acceso a este viaje' });
  }

  // null si el viaje ya termino (Redis limpio) o si la ruta nunca se calculo.
  const ruta_planeada = await obtenerRutaPlaneada(viaje.id_viaje);

  return res.status(200).json({ ...viaje, ruta_planeada });
}

export async function cambiarEstado(req, res) {
  const schema = z.object({ estado: z.enum(['CARGANDO', 'DESCARGANDO', 'EN_RUTA']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const id_viaje = Number(req.params.id);
  const { estado } = parsed.data;

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: { conductor: true },
  });
  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (!viaje.conductor || viaje.conductor.id_usuario !== req.usuario.id_usuario) {
    return res.status(403).json({ error: 'No sos el conductor de este viaje' });
  }
  if (viaje.estado === 'FINALIZADO' || viaje.estado === 'CANCELADO') {
    return res.status(400).json({ error: 'El viaje ya esta finalizado o cancelado' });
  }

  const estado_anterior = viaje.estado;
  await prisma.viaje.update({ where: { id_viaje }, data: { estado } });

  if (io) {
    io.to(`viaje:${id_viaje}`).emit('viaje:estado_cambiado', {
      id_viaje,
      estado_anterior,
      estado_nuevo: estado,
    });
  }

  return res.status(200).json({ id_viaje, estado_anterior, estado_nuevo: estado });
}

export async function cancelarViajeConductor(req, res) {
  const id_viaje = Number(req.params.id);

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: { conductor: true },
  });

  // 1. El viaje existe.
  if (!viaje) {
    return res.status(404).json({ error: 'Viaje no encontrado' });
  }

  // 2. Autorizacion: si hay OTRO conductor asignado distinto al autenticado, 403.
  //    Cuando no hay conductor asignado (p. ej. BUSCANDO_CONDUCTOR), no es un
  //    problema de autorizacion sino de estado, y cae al chequeo 3 (400).
  if (viaje.conductor && viaje.conductor.id_usuario !== req.usuario.id_usuario) {
    return res.status(403).json({ error: 'No autorizado para cancelar este viaje' });
  }

  // 3. Solo se puede cancelar desde CONDUCTOR_ASIGNADO.
  if (viaje.estado !== 'CONDUCTOR_ASIGNADO') {
    return res.status(400).json({
      error: `Solo se puede cancelar un viaje en estado CONDUCTOR_ASIGNADO, el viaje actual esta en estado ${viaje.estado}`,
    });
  }

  // El viaje mantiene su id_viaje: vuelve a BUSCANDO_CONDUCTOR y se libera
  // conductor/vehiculo en una sola transaccion.
  await prisma.$transaction([
    prisma.viaje.update({
      where: { id_viaje },
      data: { estado: 'BUSCANDO_CONDUCTOR', id_conductor: null, id_vehiculo: null },
    }),
  ]);

  // Fuera de la transaccion: cleanup del estado activo del viaje (corta el
  // emisor de ETA y borra TODAS las keys gps:{id_viaje}:*). Mismo helper que usa
  // la cancelacion por cliente.
  await limpiarViajeActivo(id_viaje);

  if (io) {
    // El socket del conductor que cancelo sale del room del viaje (best-effort,
    // no bloqueante). Si sigue siendo elegible, publicarViajeAConductoresElegibles
    // lo vuelve a unir enseguida: puede recibir viaje:disponible y reaceptar.
    try {
      const sockets = await io.in(`viaje:${id_viaje}`).fetchSockets();
      for (const s of sockets) {
        if (s.data?.usuario?.id_usuario === req.usuario.id_usuario) {
          await s.leave(`viaje:${id_viaje}`);
        }
      }
    } catch (err) {
      console.error(
        `[cancelarViajeConductor] No se pudo sacar el socket del conductor del room viaje:${id_viaje}:`,
        err.message
      );
    }

    // Republicar reutilizando el mismo flujo que la creacion del viaje. El
    // recalculo de ruta_planeada (Google Maps) ocurre cuando el siguiente
    // conductor acepte y se haga el primer ping, igual que en un viaje nuevo.
    const viajeRepublicar = await prisma.viaje.findUnique({
      where: { id_viaje },
      include: {
        paradas: true,
        condiciones_req: true,
        cliente: { include: { usuario: { select: { id_usuario: true } } } },
      },
    });
    await publicarViajeAConductoresElegibles(
      io,
      viajeRepublicar,
      viajeRepublicar.cliente.usuario.id_usuario
    );
  }

  return res.status(200).json({
    mensaje: 'Viaje cancelado y republicado',
    id_viaje,
    estado: 'BUSCANDO_CONDUCTOR',
  });
}

export async function cancelarViajeCliente(req, res) {
  const id_viaje = Number(req.params.id);

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: { cliente: true },
  });

  // 1. El viaje existe.
  if (!viaje) {
    return res.status(404).json({ error: 'Viaje no encontrado' });
  }

  // 2. El cliente autenticado es el dueño del viaje.
  if (viaje.cliente.id_usuario !== req.usuario.id_usuario) {
    return res.status(403).json({ error: 'No autorizado para cancelar este viaje' });
  }

  // 3. Solo se puede cancelar antes de que el viaje comience.
  const ESTADOS_CANCELABLES = ['BUSCANDO_CONDUCTOR', 'CONDUCTOR_ASIGNADO'];
  if (!ESTADOS_CANCELABLES.includes(viaje.estado)) {
    return res.status(400).json({
      error: `Solo se puede cancelar un viaje antes de que comience, el viaje actual esta en estado ${viaje.estado}`,
    });
  }

  // El viaje pasa a CANCELADO (terminal). NO se tocan id_conductor ni
  // id_vehiculo: se preservan como estaban al momento de cancelar, para
  // conservar el historial de con quien estaba asociado el viaje.
  await prisma.$transaction([
    prisma.viaje.update({
      where: { id_viaje },
      data: { estado: 'CANCELADO' },
    }),
  ]);

  // Fuera de la transaccion: cleanup del estado activo. Si estaba en
  // CONDUCTOR_ASIGNADO, esto corta el emisor de ETA y borra las keys GPS. Si
  // estaba en BUSCANDO_CONDUCTOR, limpiarViajeActivo es idempotente (no hay ETA
  // corriendo y limpiarGPS no falla si no encuentra keys), asi que es seguro
  // llamarlo igual.
  await limpiarViajeActivo(id_viaje);

  // Decision explicita: por ahora NO se emite ningun evento WebSocket (ni al
  // conductor asignado, si lo habia). Queda pendiente para el futuro.

  return res.status(200).json({
    mensaje: 'Viaje cancelado',
    id_viaje,
    estado: 'CANCELADO',
  });
}

export async function obtenerCostoAcumulado(req, res) {
  const id_viaje = Number(req.params.id);

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: {
      cliente: true,
      conductor: true,
    },
  });
  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });

  const esCliente = viaje.cliente.id_usuario === req.usuario.id_usuario;
  const esConductor = viaje.conductor !== null && viaje.conductor.id_usuario === req.usuario.id_usuario;
  if (!esCliente && !esConductor) {
    return res.status(403).json({ error: 'Sin acceso a este viaje' });
  }

  const acumulado = await obtenerAcumulado(id_viaje);
  if (!acumulado) {
    return res.status(200).json({ precio_acumulado: 0, desglose: null });
  }

  let precio_acumulado;
  let precio_por_tiempo = null;
  let precio_por_distancia = null;

  if (viaje.zona === 'CABA') {
    precio_por_tiempo = acumulado.tiempo_horas * (viaje.tarifa_hora || 0);
    precio_acumulado = precio_por_tiempo;
  } else if (viaje.zona === 'PROVINCIA') {
    precio_por_distancia = acumulado.distancia_km * (viaje.tarifa_km || 0);
    precio_acumulado = precio_por_distancia;
  } else {
    precio_por_tiempo = acumulado.tiempo_horas * (viaje.tarifa_hora || 0);
    precio_por_distancia = acumulado.distancia_km * (viaje.tarifa_km || 0);
    precio_acumulado = precio_por_tiempo + precio_por_distancia;
  }

  const hora = new Date().getHours();
  const es_hora_pico = (hora >= 7 && hora <= 10) || (hora >= 17 && hora <= 20);

  return res.status(200).json({
    precio_acumulado,
    desglose: {
      precio_por_tiempo,
      precio_por_distancia,
      tiempo_horas: acumulado.tiempo_horas,
      distancia_km: acumulado.distancia_km,
      tarifa_hora: viaje.tarifa_hora,
      tarifa_km: viaje.tarifa_km,
      es_hora_pico,
    },
  });
}

// ─── Fase 5 ───────────────────────────────────────────────────────────────────

export async function obtenerQRParadas(req, res) {
  const id_viaje = Number(req.params.id);

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: {
      cliente: true,
      paradas: { orderBy: { orden: 'asc' } },
    },
  });

  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (viaje.cliente.id_usuario !== req.usuario.id_usuario) {
    return res.status(403).json({ error: 'Sin acceso a este viaje' });
  }

  const qrs = viaje.paradas.map((p) => ({
    id_parada: p.id_parada,
    orden: p.orden,
    direccion: p.direccion,
    qr_firmado: firmarQR({ id_parada: p.id_parada, id_viaje, orden: p.orden }),
  }));

  return res.status(200).json(qrs);
}

export async function confirmarParada(req, res) {
  const schema = z.object({
    qr_firmado: z.string(),
    lat: z.number(),
    lng: z.number(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const { qr_firmado, lat, lng } = parsed.data;
  const id_viaje = Number(req.params.id);

  const payload = verificarQR(qr_firmado);
  if (!payload) return res.status(400).json({ error: 'QR invalido o firma incorrecta' });
  if (payload.id_viaje !== id_viaje) return res.status(400).json({ error: 'El QR no corresponde a este viaje' });

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: {
      conductor: true,
      paradas: true,
    },
  });

  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (!viaje.conductor || viaje.conductor.id_usuario !== req.usuario.id_usuario) {
    return res.status(403).json({ error: 'No sos el conductor de este viaje' });
  }
  if (viaje.estado !== 'EN_RUTA' && viaje.estado !== 'DESCARGANDO') {
    return res.status(400).json({ error: 'El viaje debe estar en estado EN_RUTA o DESCARGANDO' });
  }

  const parada = viaje.paradas.find((p) => p.id_parada === payload.id_parada);
  if (!parada) return res.status(404).json({ error: 'Parada no encontrada' });
  if (parada.estado === 'ENTREGADO') return res.status(400).json({ error: 'La parada ya fue confirmada' });

  const distancia_metros = turf.distance(
    turf.point([lng, lat]),
    turf.point([parada.longitud, parada.latitud]),
    { units: 'meters' }
  );
  if (distancia_metros > 200) {
    return res.status(400).json({
      error: `Estas a ${Math.round(distancia_metros)}m de la parada. Debes estar a menos de 200m`,
    });
  }

  await prisma.parada.update({
    where: { id_parada: parada.id_parada },
    data: { estado: 'ENTREGADO', fecha_entrega: new Date() },
  });

  const pendientes = await prisma.parada.count({
    where: { id_viaje, estado: 'PENDIENTE' },
  });

  if (pendientes > 0) {
    // La proxima parada pendiente cambio: forzamos recalculo de ETA inmediato.
    await recalcularEtaInmediato(io, id_viaje);
    return res.status(200).json({ confirmada: true, viaje_finalizado: false });
  }

  const { precio_real, remito_url } = await cerrarViaje(id_viaje, io);
  return res.status(200).json({ confirmada: true, viaje_finalizado: true, precio_real, remito_url });
}

export async function calificarViaje(req, res) {
  const schema = z.object({
    puntuacion: z.number().int().min(1).max(5),
    comentario: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const { puntuacion, comentario } = parsed.data;
  const id_viaje = Number(req.params.id);

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: {
      cliente: true,
      conductor: true,
      calificacion: true,
    },
  });

  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (viaje.estado !== 'FINALIZADO') return res.status(400).json({ error: 'Solo se puede calificar un viaje finalizado' });
  if (viaje.cliente.id_usuario !== req.usuario.id_usuario) return res.status(403).json({ error: 'Sin acceso a este viaje' });
  if (viaje.calificacion) return res.status(409).json({ error: 'Este viaje ya tiene una calificacion' });
  if (!viaje.conductor) return res.status(400).json({ error: 'El viaje no tiene conductor asignado' });

  const calificacion = await prisma.calificacion.create({
    data: {
      id_viaje,
      id_cliente: viaje.cliente.id_cliente,
      id_conductor: viaje.conductor.id_conductor,
      puntaje: puntuacion,
      comentario: comentario ?? null,
    },
  });

  const promedio = await prisma.calificacion.aggregate({
    where: { id_conductor: viaje.conductor.id_conductor },
    _avg: { puntaje: true },
  });

  await prisma.conductor.update({
    where: { id_conductor: viaje.conductor.id_conductor },
    data: { calificacion_promedio: promedio._avg.puntaje ?? 0 },
  });

  return res.status(201).json({
    id_calificacion: calificacion.id_calificacion,
    puntuacion: calificacion.puntaje,
    comentario: calificacion.comentario,
  });
}

export async function obtenerRemito(req, res) {
  const id_viaje = Number(req.params.id);

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: { cliente: true, conductor: true },
  });

  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });

  const esCliente = viaje.cliente.id_usuario === req.usuario.id_usuario;
  const esConductor = viaje.conductor?.id_usuario === req.usuario.id_usuario;
  if (!esCliente && !esConductor) return res.status(403).json({ error: 'Sin acceso a este viaje' });
  if (viaje.estado !== 'FINALIZADO') return res.status(400).json({ error: 'El remito solo esta disponible para viajes finalizados' });

  return res.status(200).json({ remito_url: `${process.env.R2_PUBLIC_URL}/remitos/${id_viaje}.pdf` });
}

export async function listarMisViajes(req, res) {
  const cliente = await prisma.cliente.findUnique({
    where: { id_usuario: req.usuario.id_usuario },
  });
  if (!cliente) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de cliente' });
  }

  const viajes = await prisma.viaje.findMany({
    where: { id_cliente: cliente.id_cliente },
    include: {
      paradas: true,
      conductor: { include: { usuario: true } },
    },
    orderBy: { creado_en: 'desc' },
  });

  return res.status(200).json(viajes);
}

const ESTADOS_VIAJE = [
  'BUSCANDO_CONDUCTOR',
  'CONDUCTOR_ASIGNADO',
  'EN_CAMINO_A_ORIGEN',
  'CARGANDO',
  'EN_RUTA',
  'DESCARGANDO',
  'FINALIZADO',
  'CANCELADO',
];

export async function listarMisViajesConductor(req, res) {
  const conductor = await prisma.conductor.findUnique({
    where: { id_usuario: req.usuario.id_usuario },
  });
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const { estado } = req.query;
  if (estado !== undefined && !ESTADOS_VIAJE.includes(estado)) {
    return res.status(400).json({ error: 'Estado invalido' });
  }

  const viajes = await prisma.viaje.findMany({
    where: {
      id_conductor: conductor.id_conductor,
      ...(estado ? { estado } : {}),
    },
    select: {
      id_viaje: true,
      zona: true,
      precio_estimado: true,
      precio_real: true,
      estado: true,
      fecha_programada: true,
      descripcion: true,
      creado_en: true,
      paradas: {
        select: { orden: true, direccion: true, estado: true, fecha_entrega: true },
        orderBy: { orden: 'asc' },
      },
      cliente: {
        select: {
          usuario: { select: { nombre: true, apellido: true, telefono: true } },
        },
      },
    },
    orderBy: { creado_en: 'desc' },
  });

  return res.status(200).json(viajes);
}
