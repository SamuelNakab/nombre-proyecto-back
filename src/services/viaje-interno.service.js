// Ciclo del viaje INTERNO (Paso 2): la PyME asigna el viaje a un chofer
// vinculado, el chofer confirma (eligiendo vehiculo) o rechaza, lo inicia en el
// origen y lo ejecuta. Tabla de transiciones: TRANSICIONES_INTERNO en
// estado-viaje.service.js.
//
// PATRON DE ESCRITURA de toda accion que cambia el estado:
//   1. Lectura previa -> los 400 descriptivos del caso secuencial (estado
//      invalido, ventana, distancia, vehiculo...).
//   2. $transaction: updateMany CONDICIONADO al estado esperado (y al chofer, y
//      a la fecha cuando importa). count === 0 -> 409: otro camino se adelanto.
//      Ese update toma el lock de la fila; lo que puede haber cambiado otra
//      transaccion (condiciones del viaje, vinculo) se re-valida DESPUES, en la
//      misma tx, y si falla se tira -> rollback.
//   3. Fuera de la tx: historial (regla vigente: un fallo del historial no
//      revierte el cambio de estado), timers, Redis y eventos.
//
// El vinculo PyME-chofer se bloquea (SELECT ... FOR UPDATE) en crear y
// reasignar; desvincular toma el mismo lock con su updateMany, asi que no se
// puede crear o reasignar un viaje contra un vinculo que se esta cortando. El
// orden de locks es siempre vinculo -> viaje: no hay deadlock posible.
import prisma from '../config/prisma.js';
import { ErrorNegocio } from './error-negocio.js';
import { OPCIONES_TX } from './organizacion.service.js';
import { estimarCosto } from './costo.service.js';
import { calcularYGuardarRuta, obtenerRutaPlaneada } from './ruta.service.js';
import { registrarCambioEstado, INCLUDE_HISTORIAL } from './historial-estado.service.js';
import {
  validarTransicion,
  ESTADOS_TERMINALES,
  ESTADOS_PRE_INICIO_INTERNO,
  ORIGEN_HISTORIAL,
} from './estado-viaje.service.js';
import {
  esViajeVencido,
  programarVencimientoInterno,
  cancelarAvisoVencimiento,
  vencerSiCorresponde,
} from './vencimiento.service.js';
import { limpiarViajeActivo } from './cancelacion.service.js';
import { distanciaMetros } from './parada.service.js';
import {
  configVentana,
  evaluarVentanaInicio,
  aperturaVentanaInicio,
  finVentanaInicio,
  fechaProgramadaLimiteVencimiento,
  ventanaInicioDespuesMinutos,
  horaLocal,
} from './ventana-inicio.js';
import { horasAMinutos, calcularMetricasViaje } from './duracion.service.js';
import { paradasParaCrear } from './viaje-validacion.js';
import { emitirViajeInterno, salasDeViaje } from '../sockets/salas.js';

// ─── Constantes ──────────────────────────────────────────────────────────────

export const ESTADOS_INTERNOS = [
  'ASIGNADO',
  'CONFIRMADO',
  'CARGANDO',
  'EN_RUTA',
  'DESCARGANDO',
  'FINALIZADO',
  'CANCELADO',
  'RECHAZADO',
  'VENCIDO',
];

const ESTADOS_CURSO_INTERNO = ['CARGANDO', 'EN_RUTA', 'DESCARGANDO'];
const NO_FINALES = ESTADOS_INTERNOS.filter((e) => !ESTADOS_TERMINALES.includes(e));

// Filtros por grupo de las listas. La PyME y el chofer ven grupos distintos.
export const GRUPOS_PYME = {
  activos: NO_FINALES,
  en_curso: ESTADOS_CURSO_INTERNO,
  historial: ESTADOS_TERMINALES,
};
export const GRUPOS_CHOFER = {
  asignados: ['ASIGNADO'],
  confirmados: ['CONFIRMADO'],
  en_curso: ESTADOS_CURSO_INTERNO,
  historial: ESTADOS_TERMINALES,
};

// El include de todo lo que devuelve un viaje interno (listas y detalle).
const INCLUDE_VIAJE_INTERNO = {
  paradas: { orderBy: { orden: 'asc' } },
  condiciones_req: true,
  organizacion: { select: { id_organizacion: true, nombre: true, cuit: true } },
  creador: { select: { id_usuario: true, nombre: true, apellido: true } },
  conductor: {
    select: {
      id_conductor: true,
      usuario: { select: { id_usuario: true, nombre: true, apellido: true, telefono: true } },
    },
  },
  vehiculo: {
    select: {
      id_vehiculo: true,
      patente: true,
      marca: true,
      modelo: true,
      anio: true,
      color: true,
      tipo_vehiculo: true,
    },
  },
  ...INCLUDE_HISTORIAL,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const condicionesDe = (viaje) => viaje.condiciones_req.map((c) => c.condicion);

function vehiculoCumple(vehiculo, condiciones) {
  const tiene = vehiculo.condiciones.map((c) => c.condicion);
  return condiciones.every((req) => tiene.includes(req));
}

// Los vehiculos que cuentan son los PROPIOS del chofer (Vehiculo.id_conductor).
// La flota de las empresas de logistica donde trabaje (conductor_vehiculos) es
// de otra organizacion y no cuenta. Vehiculo no tiene columna `activo`: el
// borrado es fisico y esta bloqueado mientras el vehiculo tenga un viaje no
// final, asi que "activo" = que exista.
const vehiculosPropios = (db, id_conductor) =>
  db.vehiculo.findMany({ where: { id_conductor }, include: { condiciones: true } });

const listaCondiciones = (condiciones) => (condiciones.length ? `: ${condiciones.join(', ')}` : '');

export async function conductorDe(id_usuario) {
  const conductor = await prisma.conductor.findUnique({
    where: { id_usuario },
    select: { id_conductor: true },
  });
  if (!conductor) throw new ErrorNegocio(400, 'El usuario no tiene perfil de conductor');
  return conductor.id_conductor;
}

// 403 si la PyME esta SUSPENDIDA: no puede generar trabajo nuevo (crear,
// editar, reasignar). Cancelar sigue permitido.
async function exigirPymeOperativa(id_organizacion) {
  const org = await prisma.organizacion.findUnique({
    where: { id_organizacion },
    select: { estado: true },
  });
  if (!org) throw new ErrorNegocio(404, 'PyME no encontrada');
  if (org.estado === 'SUSPENDIDA') {
    throw new ErrorNegocio(403, 'La PyME esta suspendida: no puede crear ni modificar viajes');
  }
}

// El chofer puede recibir este viaje: vinculo ACTIVO con la PyME y al menos un
// vehiculo propio que cumpla las condiciones. Las mismas validaciones al crear,
// reasignar y editar.
async function validarChoferAsignable(id_organizacion, id_conductor, condiciones) {
  const vinculo = await prisma.vinculoChofer.findFirst({
    where: { id_organizacion, id_conductor, activo: true },
    select: { id_vinculo: true },
  });
  if (!vinculo) throw new ErrorNegocio(400, 'El chofer no esta vinculado a esta PyME');

  const vehiculos = await vehiculosPropios(prisma, id_conductor);
  if (vehiculos.length === 0) {
    throw new ErrorNegocio(400, 'El chofer no tiene vehiculos propios registrados');
  }
  if (!vehiculos.some((v) => vehiculoCumple(v, condiciones))) {
    throw new ErrorNegocio(
      400,
      `El chofer no tiene un vehiculo propio que cumpla las condiciones del viaje${listaCondiciones(condiciones)}`
    );
  }
}

// Lock del vinculo ACTIVO (FOR UPDATE). Devuelve su metodo de cobro, o null si
// ya no esta activo (lo cortaron entre la validacion previa y la tx).
async function bloquearVinculoActivo(tx, id_organizacion, id_conductor) {
  const filas = await tx.$queryRaw`
    SELECT id_vinculo, metodo_cobro::text AS metodo_cobro
    FROM vinculos_chofer
    WHERE id_organizacion = ${id_organizacion} AND id_conductor = ${id_conductor} AND activo = true
    ORDER BY id_vinculo
    LIMIT 1
    FOR UPDATE`;
  return filas[0] ?? null;
}

// Lock de la fila del viaje dentro de la tx; devuelve el estado REAL al momento
// del lock (para saber si la transicion genera fila de historial).
async function bloquearViaje(tx, id_viaje) {
  const filas = await tx.$queryRaw`
    SELECT estado::text AS estado FROM viajes WHERE id_viaje = ${id_viaje} FOR UPDATE`;
  return filas[0]?.estado ?? null;
}

async function transaccion(fn) {
  return prisma.$transaction(fn, OPCIONES_TX);
}

// Se tira adentro de la tx cuando el updateMany condicionado no matcheo.
const conflicto = (mensaje = 'El viaje cambio de estado mientras se procesaba tu pedido: volve a cargarlo') =>
  new ErrorNegocio(409, mensaje);

function mensajeEstado(accion, estado) {
  return `No se puede ${accion} un viaje en estado ${estado}`;
}

const remitoUrl = (id_viaje) => `${process.env.R2_PUBLIC_URL}/remitos/${id_viaje}.pdf`;

// ─── Serializacion ───────────────────────────────────────────────────────────

// Lo que devuelven las listas y el detalle, para la PyME y para el chofer. La
// fila cruda + los campos calculados en el read (mismos que los canales
// legacy): duracion_estimada, las cinco metricas del historial (puntualidad
// incluida, que pisa a la columna MUERTA del mismo nombre) y vencido.
export function serializarViajeInterno(viaje) {
  const { condiciones_req, conductor, ...resto } = viaje;
  return {
    ...resto,
    condiciones_requeridas: condiciones_req.map((c) => c.condicion),
    conductor: conductor
      ? {
          id_conductor: conductor.id_conductor,
          id_usuario: conductor.usuario.id_usuario,
          nombre: conductor.usuario.nombre,
          apellido: conductor.usuario.apellido,
          telefono: conductor.usuario.telefono,
        }
      : null,
    duracion_estimada: horasAMinutos(viaje.duracion_estimada_horas),
    ...calcularMetricasViaje(viaje),
    vencido: esViajeVencido(viaje),
    remito_url: viaje.estado === 'FINALIZADO' ? remitoUrl(viaje.id_viaje) : null,
  };
}

// Payload compacto de los eventos de socket.
function resumenViaje(viaje) {
  return {
    id_viaje: viaje.id_viaje,
    id_organizacion: viaje.id_organizacion,
    organizacion: viaje.organizacion
      ? { id_organizacion: viaje.organizacion.id_organizacion, nombre: viaje.organizacion.nombre }
      : null,
    estado: viaje.estado,
    fecha_programada: viaje.fecha_programada,
    precio_estimado: viaje.precio_estimado,
    descripcion: viaje.descripcion,
    paradas: viaje.paradas.map((p) => ({
      id_parada: p.id_parada,
      orden: p.orden,
      direccion: p.direccion,
      latitud: p.latitud,
      longitud: p.longitud,
    })),
    condiciones_requeridas: condicionesDe(viaje),
  };
}

const leerViaje = (id_viaje) =>
  prisma.viaje.findUnique({ where: { id_viaje }, include: INCLUDE_VIAJE_INTERNO });

const destinosDe = (viaje) => ({
  id_viaje: viaje.id_viaje,
  id_organizacion: viaje.id_organizacion,
  id_usuario_chofer: viaje.conductor?.usuario?.id_usuario ?? viaje.conductor?.id_usuario ?? null,
});

// ─── Lecturas ────────────────────────────────────────────────────────────────

function filtroEstado({ estado, grupo }, grupos) {
  if (estado) return { estado };
  if (grupo) return { estado: { in: grupos[grupo] } };
  return {};
}

// La PyME ve TODOS los viajes de su organizacion (scoping por id_organizacion,
// nunca por usuario). Antes de leer, chequeo perezoso de vencimiento.
export async function listarViajesOrganizacion(io, id_organizacion, filtros = {}) {
  await vencerSiCorresponde(io, { id_organizacion });
  const viajes = await prisma.viaje.findMany({
    where: { id_organizacion, ...filtroEstado(filtros, GRUPOS_PYME) },
    include: INCLUDE_VIAJE_INTERNO,
    orderBy: [{ fecha_programada: 'desc' }, { id_viaje: 'desc' }],
  });
  return viajes.map(serializarViajeInterno);
}

// Un viaje de OTRA PyME da 404, igual que uno que no existe: no se filtran ids.
async function viajeDeOrganizacion(id_organizacion, id_viaje, include = INCLUDE_VIAJE_INTERNO) {
  const viaje = await prisma.viaje.findFirst({ where: { id_viaje, id_organizacion }, include });
  if (!viaje) throw new ErrorNegocio(404, 'Viaje no encontrado');
  return viaje;
}

export async function obtenerViajeOrganizacion(io, id_organizacion, id_viaje) {
  await vencerSiCorresponde(io, { id_viaje, id_organizacion });
  const viaje = await viajeDeOrganizacion(id_organizacion, id_viaje);
  return { ...serializarViajeInterno(viaje), ruta_planeada: await obtenerRutaPlaneada(id_viaje) };
}

// El chofer ve SOLO sus viajes internos, de todas sus PyMEs, cada uno con el
// nombre de la PyME (organizacion.nombre).
export async function listarViajesChofer(io, id_usuario, filtros = {}) {
  const id_conductor = await conductorDe(id_usuario);
  await vencerSiCorresponde(io, { id_conductor });
  const viajes = await prisma.viaje.findMany({
    where: {
      id_conductor,
      id_organizacion: { not: null },
      ...filtroEstado(filtros, GRUPOS_CHOFER),
    },
    include: INCLUDE_VIAJE_INTERNO,
    orderBy: [{ fecha_programada: 'asc' }, { id_viaje: 'asc' }],
  });
  return viajes.map(serializarViajeInterno);
}

async function viajeDeChofer(id_conductor, id_viaje, include = INCLUDE_VIAJE_INTERNO) {
  const viaje = await prisma.viaje.findFirst({
    where: { id_viaje, id_conductor, id_organizacion: { not: null } },
    include,
  });
  if (!viaje) throw new ErrorNegocio(404, 'Viaje no encontrado');
  return viaje;
}

export async function obtenerViajeChofer(io, id_usuario, id_viaje) {
  const id_conductor = await conductorDe(id_usuario);
  await vencerSiCorresponde(io, { id_viaje, id_conductor });
  const viaje = await viajeDeChofer(id_conductor, id_viaje);
  return { ...serializarViajeInterno(viaje), ruta_planeada: await obtenerRutaPlaneada(id_viaje) };
}

export async function remitoOrganizacion(id_organizacion, id_viaje) {
  const viaje = await viajeDeOrganizacion(id_organizacion, id_viaje, {});
  if (viaje.estado !== 'FINALIZADO') {
    throw new ErrorNegocio(400, 'El remito solo esta disponible para viajes finalizados');
  }
  return { remito_url: remitoUrl(id_viaje) };
}

export async function viajeParaCostoAcumulado(id_organizacion, id_viaje) {
  return viajeDeOrganizacion(id_organizacion, id_viaje, {
    paradas: { select: { latitud: true, longitud: true } },
  });
}

// ─── Crear ───────────────────────────────────────────────────────────────────

export async function crearViajeInterno({ io, id_organizacion, id_usuario, datos }) {
  const { id_conductor, paradas, fecha_programada, condiciones_requeridas, descripcion } = datos;

  await exigirPymeOperativa(id_organizacion);

  // id_cliente es NOT NULL en el schema: el ancla es el Cliente del creador.
  const cliente = await prisma.cliente.findUnique({
    where: { id_usuario },
    select: { id_cliente: true },
  });
  if (!cliente) throw new ErrorNegocio(400, 'El usuario no tiene perfil de cliente');

  await validarChoferAsignable(id_organizacion, id_conductor, condiciones_requeridas);

  // Precio y duracion: el calculo actual de costo.service, sin cambios. Fuera
  // de la tx: es una llamada a Google.
  let resultado;
  try {
    resultado = await estimarCosto({ paradas, fecha_programada });
  } catch {
    throw new ErrorNegocio(503, 'No se pudo calcular la distancia');
  }
  const { tarifa_hora, tarifa_km } = resultado.desglose;

  const { id_viaje } = await transaccion(async (tx) => {
    const vinculo = await bloquearVinculoActivo(tx, id_organizacion, id_conductor);
    if (!vinculo) throw new ErrorNegocio(400, 'El chofer no esta vinculado a esta PyME');

    return tx.viaje.create({
      data: {
        estado: 'ASIGNADO',
        id_organizacion,
        id_creador: id_usuario,
        id_cliente: cliente.id_cliente,
        id_conductor,
        metodo_cobro: vinculo.metodo_cobro,
        zona: resultado.zona,
        tarifa_hora,
        tarifa_km,
        fecha_programada: new Date(fecha_programada),
        descripcion: descripcion ?? null,
        precio_estimado: resultado.precio_estimado,
        duracion_estimada_horas: resultado.desglose.tiempo_horas,
        paradas: { create: paradasParaCrear(paradas) },
        condiciones_req: { create: condiciones_requeridas.map((condicion) => ({ condicion })) },
      },
      select: { id_viaje: true },
    });
  });

  await registrarCambioEstado({
    id_viaje,
    estado: 'ASIGNADO',
    id_usuario,
    origen: ORIGEN_HISTORIAL.PYME,
  });

  // Best-effort, como en la ruta legacy: si Google falla, ruta_planeada queda
  // null y se reintenta en el primer ping GPS.
  let ruta_planeada = null;
  try {
    ruta_planeada = await calcularYGuardarRuta(id_viaje);
  } catch (err) {
    console.error(`[viaje-interno] No se pudo calcular la ruta del viaje ${id_viaje}:`, err.message);
  }

  programarVencimientoInterno(io, id_viaje, new Date(fecha_programada));

  const viaje = await leerViaje(id_viaje);
  emitirViajeInterno(io, destinosDe(viaje), 'viaje:asignado', resumenViaje(viaje));

  return {
    ...serializarViajeInterno(viaje),
    ruta_planeada,
    desglose_estimado: resultado.desglose,
  };
}

// ─── Chofer: confirmar / rechazar / iniciar / cancelar ───────────────────────

export async function confirmarViaje({ io, id_usuario, id_viaje, id_vehiculo }) {
  const id_conductor = await conductorDe(id_usuario);
  await vencerSiCorresponde(io, { id_viaje, id_conductor });
  const viaje = await viajeDeChofer(id_conductor, id_viaje, { condiciones_req: true });

  if (viaje.estado !== 'ASIGNADO') {
    throw new ErrorNegocio(400, mensajeEstado('confirmar', viaje.estado));
  }
  validarTransicion(viaje.estado, 'CONFIRMADO', { ciclo: 'INTERNO', quien: 'CHOFER' });

  const vehiculo = await prisma.vehiculo.findUnique({
    where: { id_vehiculo },
    include: { condiciones: true },
  });
  if (!vehiculo || vehiculo.id_conductor !== id_conductor) {
    throw new ErrorNegocio(400, 'El vehiculo no es tuyo');
  }
  const condiciones = condicionesDe(viaje);
  if (!vehiculoCumple(vehiculo, condiciones)) {
    throw new ErrorNegocio(400, `El vehiculo no cumple las condiciones del viaje${listaCondiciones(condiciones)}`);
  }

  const ahora = new Date();
  const limite = fechaProgramadaLimiteVencimiento(ahora, ventanaInicioDespuesMinutos());

  await transaccion(async (tx) => {
    // GUARD: el estado, el chofer (una reasignacion concurrente lo cambia) y la
    // fecha (un viaje con la ventana cerrada no se confirma aunque el timer
    // todavia no haya disparado).
    const r = await tx.viaje.updateMany({
      where: {
        id_viaje,
        estado: 'ASIGNADO',
        id_conductor,
        fecha_programada: { gte: limite },
      },
      data: { estado: 'CONFIRMADO', id_vehiculo, fecha_confirmacion: ahora },
    });
    if (r.count === 0) throw conflicto();

    // Re-validacion con las condiciones FRESCAS: una edicion concurrente pudo
    // cambiarlas (edit hace su updateMany primero, asi que si commiteo antes, aca
    // ya se ve lo nuevo).
    const frescas = await tx.condicionRequerida.findMany({ where: { id_viaje } });
    const requeridas = frescas.map((c) => c.condicion);
    if (!vehiculoCumple(vehiculo, requeridas)) {
      throw conflicto(`El viaje cambio: el vehiculo no cumple las condiciones${listaCondiciones(requeridas)}`);
    }
  });

  await registrarCambioEstado({
    id_viaje,
    estado: 'CONFIRMADO',
    id_usuario,
    origen: ORIGEN_HISTORIAL.CHOFER,
  });

  const vehiculoPublico = {
    id_vehiculo: vehiculo.id_vehiculo,
    patente: vehiculo.patente,
    marca: vehiculo.marca,
    modelo: vehiculo.modelo,
    tipo_vehiculo: vehiculo.tipo_vehiculo,
  };
  emitirViajeInterno(
    io,
    { id_viaje, id_organizacion: viaje.id_organizacion },
    'viaje:confirmado',
    { id_viaje, id_organizacion: viaje.id_organizacion, estado: 'CONFIRMADO', vehiculo: vehiculoPublico }
  );

  return {
    mensaje: 'Viaje confirmado',
    id_viaje,
    estado: 'CONFIRMADO',
    fecha_confirmacion: ahora,
    vehiculo: vehiculoPublico,
  };
}

export async function rechazarViaje({ io, id_usuario, id_viaje }) {
  const id_conductor = await conductorDe(id_usuario);
  await vencerSiCorresponde(io, { id_viaje, id_conductor });
  const viaje = await viajeDeChofer(id_conductor, id_viaje, {});

  if (viaje.estado !== 'ASIGNADO') {
    throw new ErrorNegocio(400, mensajeEstado('rechazar', viaje.estado));
  }
  validarTransicion(viaje.estado, 'RECHAZADO', { ciclo: 'INTERNO', quien: 'CHOFER' });

  const ahora = new Date();
  await transaccion(async (tx) => {
    const r = await tx.viaje.updateMany({
      where: { id_viaje, estado: 'ASIGNADO', id_conductor },
      data: { estado: 'RECHAZADO', fecha_rechazo: ahora },
    });
    if (r.count === 0) throw conflicto();
  });

  await registrarCambioEstado({
    id_viaje,
    estado: 'RECHAZADO',
    id_usuario,
    origen: ORIGEN_HISTORIAL.CHOFER,
  });
  cancelarAvisoVencimiento(id_viaje);

  emitirViajeInterno(
    io,
    { id_viaje, id_organizacion: viaje.id_organizacion },
    'viaje:rechazado',
    { id_viaje, id_organizacion: viaje.id_organizacion, estado: 'RECHAZADO' }
  );

  return { mensaje: 'Viaje rechazado', id_viaje, estado: 'RECHAZADO', fecha_rechazo: ahora };
}

// Iniciar: CONFIRMADO -> CARGANDO directo (el ciclo interno no tiene
// EN_CAMINO_A_ORIGEN). Exige estar dentro de la ventana Y a <=
// RADIO_CONFIRMACION_METROS del origen (la parada de orden 1), con la MISMA
// funcion de distancia y la misma fuente de ubicacion (lat/lng del body) que
// confirmar-parada. Si falla alguna, el 400 dice cual (o las dos).
export async function iniciarViajeInterno({ io, id_usuario, id_viaje, lat, lng }) {
  const id_conductor = await conductorDe(id_usuario);
  await vencerSiCorresponde(io, { id_viaje, id_conductor });
  const viaje = await viajeDeChofer(id_conductor, id_viaje, {
    paradas: { orderBy: { orden: 'asc' } },
  });

  const { antes, despues } = configVentana();

  // El chequeo perezoso de arriba ya lo vencio si la ventana cerro.
  if (viaje.estado === 'VENCIDO') {
    throw new ErrorNegocio(
      400,
      `La ventana para iniciar el viaje cerro a las ${horaLocal(finVentanaInicio(viaje.fecha_programada, despues))}; el viaje vencio`
    );
  }
  if (viaje.estado === 'ASIGNADO') {
    throw new ErrorNegocio(400, 'Tenes que confirmar el viaje (elegir el vehiculo) antes de iniciarlo');
  }
  if (viaje.estado !== 'CONFIRMADO') {
    throw new ErrorNegocio(400, mensajeEstado('iniciar', viaje.estado));
  }
  validarTransicion(viaje.estado, 'CARGANDO', { ciclo: 'INTERNO', quien: 'CHOFER' });

  const ahora = new Date();
  const fallas = [];

  const ventana = evaluarVentanaInicio(ahora, viaje.fecha_programada, { antes, despues });
  if (ventana === 'ANTES') {
    fallas.push(
      `el viaje solo puede iniciarse a partir de las ${horaLocal(aperturaVentanaInicio(viaje.fecha_programada, antes))}`
    );
  } else if (ventana === 'DESPUES') {
    fallas.push(
      `la ventana para iniciar el viaje cerro a las ${horaLocal(finVentanaInicio(viaje.fecha_programada, despues))}`
    );
  }

  const radio_metros = parseFloat(process.env.RADIO_CONFIRMACION_METROS || '50');
  const origen = viaje.paradas[0];
  const distancia_metros = distanciaMetros(lat, lng, origen);
  if (distancia_metros > radio_metros) {
    fallas.push(
      `estas a ${Math.round(distancia_metros)}m del origen y debes estar a menos de ${radio_metros}m`
    );
  }

  if (fallas.length > 0) {
    throw new ErrorNegocio(400, `No podes iniciar el viaje: ${fallas.join('; ')}`);
  }

  const limite = fechaProgramadaLimiteVencimiento(ahora, despues);
  await transaccion(async (tx) => {
    const r = await tx.viaje.updateMany({
      where: {
        id_viaje,
        estado: 'CONFIRMADO',
        id_conductor,
        fecha_programada: { gte: limite },
      },
      data: {
        estado: 'CARGANDO',
        fecha_inicio: ahora,
        // Inicia EN el origen (la proximidad recien se valido): la llegada es
        // este mismo instante. La puntualidad se sigue calculando en el read.
        fecha_llegada_origen: ahora,
        iniciado_por: 'CONDUCTOR',
      },
    });
    if (r.count === 0) throw conflicto();
  });

  await registrarCambioEstado({
    id_viaje,
    estado: 'CARGANDO',
    id_usuario,
    origen: ORIGEN_HISTORIAL.CHOFER,
  });
  // Arranco: ya no puede vencer.
  cancelarAvisoVencimiento(id_viaje);

  if (io) {
    const salas = salasDeViaje(viaje);
    io.to(salas).emit('viaje:iniciado', {
      id_viaje,
      id_organizacion: viaje.id_organizacion,
      fecha_inicio: ahora,
    });
    io.to(salas).emit('viaje:estado_cambiado', {
      id_viaje,
      estado_anterior: 'CONFIRMADO',
      estado_nuevo: 'CARGANDO',
    });
  }

  return {
    mensaje: 'Viaje iniciado',
    id_viaje,
    estado: 'CARGANDO',
    fecha_inicio: ahora,
    fecha_llegada_origen: ahora,
  };
}

// Cancelar, compartido por el chofer y la PyME.
//   - CHOFER: solo antes de iniciar (ASIGNADO o CONFIRMADO).
//   - PYME:   en cualquier estado no final, incluido en curso.
// El viaje queda CANCELADO (final), con causa_cancelacion. Limpia ETA, GPS y
// Redis con el helper de siempre (idempotente).
async function cancelar({ io, viaje, quien, id_usuario, motivo }) {
  const permitidos = quien === 'CHOFER' ? ESTADOS_PRE_INICIO_INTERNO : NO_FINALES;

  if (!permitidos.includes(viaje.estado)) {
    if (quien === 'CHOFER' && ESTADOS_CURSO_INTERNO.includes(viaje.estado)) {
      throw new ErrorNegocio(
        400,
        'El viaje ya esta en curso: no lo podes cancelar. Pedile a la PyME que lo cancele'
      );
    }
    throw new ErrorNegocio(400, mensajeEstado('cancelar', viaje.estado));
  }
  validarTransicion(viaje.estado, 'CANCELADO', { ciclo: 'INTERNO', quien });

  const causa = quien === 'CHOFER' ? 'CHOFER' : 'ORGANIZACION';
  const id_viaje = viaje.id_viaje;

  const estado_anterior = await transaccion(async (tx) => {
    const estadoReal = await bloquearViaje(tx, id_viaje);
    const r = await tx.viaje.updateMany({
      where: {
        id_viaje,
        estado: { in: permitidos },
        ...(quien === 'CHOFER' ? { id_conductor: viaje.id_conductor } : {}),
      },
      data: {
        estado: 'CANCELADO',
        causa_cancelacion: causa,
        ...(motivo ? { motivo_cancelacion: motivo } : {}),
      },
    });
    if (r.count === 0) throw conflicto();
    return estadoReal;
  });

  await registrarCambioEstado({
    id_viaje,
    estado: 'CANCELADO',
    id_usuario,
    origen: ORIGEN_HISTORIAL[quien],
  });
  cancelarAvisoVencimiento(id_viaje);
  await limpiarViajeActivo(id_viaje);

  emitirViajeInterno(
    io,
    {
      id_viaje,
      id_organizacion: viaje.id_organizacion,
      id_usuario_chofer: quien === 'PYME' ? viaje.conductor?.id_usuario : null,
    },
    'viaje:cancelado',
    {
      id_viaje,
      id_organizacion: viaje.id_organizacion,
      estado: 'CANCELADO',
      estado_anterior,
      causa,
      motivo: motivo ?? null,
    }
  );

  return { mensaje: 'Viaje cancelado', id_viaje, estado: 'CANCELADO', causa_cancelacion: causa };
}

export async function cancelarViajeChofer({ io, id_usuario, id_viaje }) {
  const id_conductor = await conductorDe(id_usuario);
  await vencerSiCorresponde(io, { id_viaje, id_conductor });
  const viaje = await viajeDeChofer(id_conductor, id_viaje, {});
  return cancelar({ io, viaje, quien: 'CHOFER', id_usuario });
}

export async function cancelarViajeOrganizacion({ io, id_organizacion, id_usuario, id_viaje, motivo }) {
  await vencerSiCorresponde(io, { id_viaje, id_organizacion });
  const viaje = await viajeDeOrganizacion(id_organizacion, id_viaje, {
    conductor: { select: { id_usuario: true } },
  });
  return cancelar({ io, viaje, quien: 'PYME', id_usuario, motivo });
}

// ─── PyME: reasignar / editar ────────────────────────────────────────────────

export async function reasignarViaje({ io, id_organizacion, id_usuario, id_viaje, id_conductor }) {
  await exigirPymeOperativa(id_organizacion);
  await vencerSiCorresponde(io, { id_viaje, id_organizacion });
  const viaje = await viajeDeOrganizacion(id_organizacion, id_viaje, {
    condiciones_req: true,
    conductor: { select: { id_usuario: true } },
  });

  if (!ESTADOS_PRE_INICIO_INTERNO.includes(viaje.estado)) {
    throw new ErrorNegocio(
      400,
      `Solo se puede reasignar un viaje ASIGNADO o CONFIRMADO; este esta en estado ${viaje.estado}`
    );
  }
  if (viaje.id_conductor === id_conductor) {
    throw new ErrorNegocio(400, 'El viaje ya esta asignado a ese chofer');
  }
  validarTransicion(viaje.estado, 'ASIGNADO', { ciclo: 'INTERNO', quien: 'PYME' });

  const condiciones = condicionesDe(viaje);
  await validarChoferAsignable(id_organizacion, id_conductor, condiciones);

  const id_conductor_anterior = viaje.id_conductor;

  const estado_anterior = await transaccion(async (tx) => {
    const vinculo = await bloquearVinculoActivo(tx, id_organizacion, id_conductor);
    if (!vinculo) throw new ErrorNegocio(400, 'El chofer no esta vinculado a esta PyME');

    const estadoReal = await bloquearViaje(tx, id_viaje);
    // GUARD: estado pre-inicio Y el chofer que leimos. Si otra reasignacion se
    // adelanto, el chofer cambio y esto matchea 0 filas.
    const r = await tx.viaje.updateMany({
      where: {
        id_viaje,
        id_organizacion,
        estado: { in: ESTADOS_PRE_INICIO_INTERNO },
        id_conductor: id_conductor_anterior,
      },
      data: {
        estado: 'ASIGNADO',
        id_conductor,
        id_vehiculo: null,
        fecha_confirmacion: null,
        metodo_cobro: vinculo.metodo_cobro,
      },
    });
    if (r.count === 0) throw conflicto();

    // Condiciones frescas (una edicion concurrente) contra los vehiculos del
    // chofer nuevo.
    const frescas = (await tx.condicionRequerida.findMany({ where: { id_viaje } })).map((c) => c.condicion);
    const vehiculos = await vehiculosPropios(tx, id_conductor);
    if (!vehiculos.some((v) => vehiculoCumple(v, frescas))) {
      throw conflicto(
        `El viaje cambio: el chofer no tiene un vehiculo propio que cumpla las condiciones${listaCondiciones(frescas)}`
      );
    }
    return estadoReal;
  });

  // CONFIRMADO -> ASIGNADO es un cambio de estado; ASIGNADO -> ASIGNADO no.
  if (estado_anterior === 'CONFIRMADO') {
    await registrarCambioEstado({
      id_viaje,
      estado: 'ASIGNADO',
      id_usuario,
      origen: ORIGEN_HISTORIAL.PYME,
    });
  }

  programarVencimientoInterno(io, id_viaje, viaje.fecha_programada);

  const actualizado = await leerViaje(id_viaje);
  emitirViajeInterno(
    io,
    {
      id_viaje,
      id_organizacion,
      id_usuario_chofer: viaje.conductor?.id_usuario,
    },
    'viaje:desasignado',
    { id_viaje, id_organizacion, motivo: 'reasignado' }
  );
  emitirViajeInterno(
    io,
    { id_organizacion, id_usuario_chofer: actualizado.conductor.usuario.id_usuario },
    'viaje:asignado',
    resumenViaje(actualizado)
  );

  return serializarViajeInterno(actualizado);
}

export async function editarViaje({ io, id_organizacion, id_usuario, id_viaje, datos }) {
  await exigirPymeOperativa(id_organizacion);
  await vencerSiCorresponde(io, { id_viaje, id_organizacion });
  const viaje = await viajeDeOrganizacion(id_organizacion, id_viaje, {
    paradas: { orderBy: { orden: 'asc' } },
    condiciones_req: true,
    conductor: { select: { id_usuario: true } },
  });

  if (!ESTADOS_PRE_INICIO_INTERNO.includes(viaje.estado)) {
    throw new ErrorNegocio(
      400,
      `Solo se puede editar un viaje ASIGNADO o CONFIRMADO; este esta en estado ${viaje.estado}`
    );
  }
  validarTransicion(viaje.estado, 'ASIGNADO', { ciclo: 'INTERNO', quien: 'PYME' });

  const paradas =
    datos.paradas ??
    viaje.paradas.map((p) => ({ lat: p.latitud, lng: p.longitud, direccion: p.direccion }));
  const fecha_programada = datos.fecha_programada
    ? new Date(datos.fecha_programada)
    : viaje.fecha_programada;
  const condiciones = datos.condiciones_requeridas ?? condicionesDe(viaje);

  // El chofer actual tiene que poder hacer el viaje editado.
  if (datos.condiciones_requeridas) {
    try {
      await validarChoferAsignable(id_organizacion, viaje.id_conductor, condiciones);
    } catch (err) {
      if (err instanceof ErrorNegocio && err.status === 400) {
        throw new ErrorNegocio(400, `${err.message}. Reasigna el viaje a otro chofer`);
      }
      throw err;
    }
  }

  // Precio, zona y duracion se recalculan si cambian las paradas o la fecha
  // (la fecha define la hora pico). Mismo calculo que al crear.
  let costo = {};
  if (datos.paradas || datos.fecha_programada) {
    let resultado;
    try {
      resultado = await estimarCosto({ paradas, fecha_programada: fecha_programada.toISOString() });
    } catch {
      throw new ErrorNegocio(503, 'No se pudo calcular la distancia');
    }
    costo = {
      zona: resultado.zona,
      tarifa_hora: resultado.desglose.tarifa_hora,
      tarifa_km: resultado.desglose.tarifa_km,
      precio_estimado: resultado.precio_estimado,
      duracion_estimada_horas: resultado.desglose.tiempo_horas,
    };
  }

  const estado_anterior = await transaccion(async (tx) => {
    const estadoReal = await bloquearViaje(tx, id_viaje);
    // El updateMany va PRIMERO: toma el lock antes de tocar paradas y
    // condiciones, asi un confirmar concurrente ve todo lo nuevo o nada.
    const r = await tx.viaje.updateMany({
      where: { id_viaje, id_organizacion, estado: { in: ESTADOS_PRE_INICIO_INTERNO } },
      data: {
        estado: 'ASIGNADO',
        id_vehiculo: null,
        fecha_confirmacion: null,
        fecha_programada,
        ...(datos.descripcion !== undefined ? { descripcion: datos.descripcion } : {}),
        ...costo,
      },
    });
    if (r.count === 0) throw conflicto();

    if (datos.paradas) {
      await tx.parada.deleteMany({ where: { id_viaje } });
      await tx.parada.createMany({
        data: paradasParaCrear(datos.paradas).map((p) => ({ ...p, id_viaje })),
      });
    }
    if (datos.condiciones_requeridas) {
      await tx.condicionRequerida.deleteMany({ where: { id_viaje } });
      await tx.condicionRequerida.createMany({
        data: datos.condiciones_requeridas.map((condicion) => ({ id_viaje, condicion })),
      });
    }
    return estadoReal;
  });

  if (estado_anterior === 'CONFIRMADO') {
    await registrarCambioEstado({
      id_viaje,
      estado: 'ASIGNADO',
      id_usuario,
      origen: ORIGEN_HISTORIAL.PYME,
    });
  }

  if (datos.paradas) {
    try {
      await calcularYGuardarRuta(id_viaje);
    } catch (err) {
      console.error(`[viaje-interno] No se pudo recalcular la ruta del viaje ${id_viaje}:`, err.message);
    }
  }

  // La fecha pudo cambiar: el vencimiento se reprograma siempre.
  programarVencimientoInterno(io, id_viaje, fecha_programada);

  const actualizado = await leerViaje(id_viaje);
  emitirViajeInterno(
    io,
    { id_viaje, id_organizacion, id_usuario_chofer: viaje.conductor?.id_usuario },
    'viaje:editado',
    {
      ...resumenViaje(actualizado),
      // true si estaba CONFIRMADO: el chofer tiene que volver a confirmar.
      confirmacion_anulada: estado_anterior === 'CONFIRMADO',
    }
  );

  return {
    ...serializarViajeInterno(actualizado),
    ruta_planeada: await obtenerRutaPlaneada(id_viaje),
  };
}
