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
import { OPCIONES_TX, exigirPymeOperativa } from './organizacion.service.js';
import { resolverParadas } from './lugar.service.js';
import { paradaVistaChofer, paradaVistaPyme } from './vista-parada.js';
import { estimarCosto } from './costo.service.js';
import {
  columnasEstimadasViaje,
  columnasEstimadasParada,
  conEstimacionPorParada,
} from './estimacion.service.js';
import { escribirRealesInterno, guardarMedicionParcial } from './medicion-real.service.js';
import { cerrarViaje } from './cierre.service.js';
import { recalcularEtaInmediato } from './eta-emisor.js';
import { guardarRutaPlaneada, obtenerRutaPlaneada } from './ruta.service.js';
import { registrarCambioEstado, INCLUDE_HISTORIAL } from './historial-estado.service.js';
import {
  validarTransicion,
  ESTADOS_TERMINALES,
  ESTADOS_PRE_INICIO_INTERNO,
  ESTADOS_EN_PARADA_INTERNO,
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
import {
  horasAMinutos,
  calcularMetricasViaje,
  bloqueTiempos,
  paradasConTiempos,
} from './duracion.service.js';
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

// El include de todo lo que devuelve un viaje interno (listas y detalle). Trae
// el lugar guardado de cada parada para la PyME; serializarViajeChofer lo saca
// (el chofer nunca ve el nombre del lugar, ver vista-parada.js).
export const INCLUDE_VIAJE_INTERNO = {
  paradas: {
    orderBy: { orden: 'asc' },
    include: { lugar: { select: { id_lugar: true, nombre: true, activo: true } } },
  },
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

export { exigirPymeOperativa };

export async function conductorDe(id_usuario) {
  const conductor = await prisma.conductor.findUnique({
    where: { id_usuario },
    select: { id_conductor: true },
  });
  if (!conductor) throw new ErrorNegocio(400, 'El usuario no tiene perfil de conductor');
  return conductor.id_conductor;
}

// El chofer puede recibir este viaje: vinculo ACTIVO con la PyME y al menos un
// vehiculo propio que cumpla las condiciones. Las mismas validaciones al crear,
// reasignar y editar (y una vez por serie).
export async function validarChoferAsignable(id_organizacion, id_conductor, condiciones) {
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
export async function bloquearVinculoActivo(tx, id_organizacion, id_conductor) {
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

export async function transaccion(fn) {
  return prisma.$transaction(fn, OPCIONES_TX);
}

// Se tira adentro de la tx cuando el updateMany condicionado no matcheo.
const conflicto = (mensaje = 'El viaje cambio de estado mientras se procesaba tu pedido: volve a cargarlo') =>
  new ErrorNegocio(409, mensaje);

function mensajeEstado(accion, estado) {
  return `No se puede ${accion} un viaje en estado ${estado}`;
}

export async function guardarRutaSinTirar(id_viaje, polilinea) {
  try {
    return await guardarRutaPlaneada(id_viaje, polilinea);
  } catch (err) {
    console.error(`[viaje-interno] No se pudo guardar la ruta del viaje ${id_viaje}:`, err.message);
    return null;
  }
}

const HORA_MS = 3_600_000;

const remitoUrl = (id_viaje) => `${process.env.R2_PUBLIC_URL}/remitos/${id_viaje}.pdf`;

// ─── Serializacion ───────────────────────────────────────────────────────────

// Lo que devuelven las listas y el detalle. La fila cruda + los campos
// calculados en el read (mismos que los canales legacy): duracion_estimada (el
// TOTAL, manejo + peon), las cinco metricas (puntualidad incluida, que pisa a la
// columna MUERTA del mismo nombre), vencido, los bloques estimado / real y, en
// cada parada, sus tiempos en minutos (ver duracion.service).
//
// DOS vistas (Paso 4): la PyME ve el lugar guardado de cada parada (su nombre
// actual); el chofer NO: sus paradas salen sin lugar ni id_lugar.
function serializarViaje(viaje, vistaParada) {
  const { condiciones_req, conductor, ...resto } = viaje;
  return {
    ...resto,
    paradas: paradasConTiempos(viaje.paradas).map(vistaParada),
    ...bloqueTiempos(viaje),
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

export const serializarViajePyme = (viaje) => serializarViaje(viaje, paradaVistaPyme);
export const serializarViajeChofer = (viaje) => serializarViaje(viaje, paradaVistaChofer);

// Payload compacto de los eventos de socket. Lo reciben la PyME Y el chofer en
// el MISMO emit: las paradas van con campos EXPLICITOS y NUNCA con el lugar
// guardado (el chofer no ve su nombre). La PyME lo ve por REST.
export function resumenViaje(viaje) {
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
    id_serie: viaje.id_serie ?? null,
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

export const leerViaje = (id_viaje) =>
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
  return viajes.map(serializarViajePyme);
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
  return { ...serializarViajePyme(viaje), ruta_planeada: await obtenerRutaPlaneada(id_viaje) };
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
  return viajes.map(serializarViajeChofer);
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
  return { ...serializarViajeChofer(viaje), ruta_planeada: await obtenerRutaPlaneada(id_viaje) };
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
  const { id_conductor, fecha_programada, condiciones_requeridas, descripcion } = datos;

  await exigirPymeOperativa(id_organizacion);

  // id_cliente es NOT NULL en el schema: el ancla es el Cliente del creador.
  const cliente = await prisma.cliente.findUnique({
    where: { id_usuario },
    select: { id_cliente: true },
  });
  if (!cliente) throw new ErrorNegocio(400, 'El usuario no tiene perfil de cliente');

  await validarChoferAsignable(id_organizacion, id_conductor, condiciones_requeridas);

  // Paradas { id_lugar } -> copia de direccion y coordenadas del lugar (400 si
  // no existe, es de otra PyME o esta borrado).
  const paradas = await resolverParadas(id_organizacion, datos.paradas);

  // Precio, duracion (manejo + peon) y ruta: UNA estimacion (costo.service).
  // Fuera de la tx y ANTES de escribir nada: llama a Google. Si Google falla,
  // ErrorMaps (503, o 400 si no hay ruta posible) y no se crea nada.
  const resultado = await estimarCosto({ paradas, fecha_programada });
  const { tarifa_hora, tarifa_km } = resultado.desglose;
  const { recorrido } = resultado;

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
        ...columnasEstimadasViaje(recorrido.totales),
        paradas: { create: conEstimacionPorParada(paradasParaCrear(paradas), recorrido) },
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

  // Ruta planeada: la polilinea de los tramos de la estimacion (sin otra
  // llamada a Google). Si Redis falla el viaje ya existe: se loguea y la ruta
  // se recalcula en el primer ping GPS (fallback de gps.socket).
  const ruta_planeada = await guardarRutaSinTirar(id_viaje, recorrido.polilinea);

  programarVencimientoInterno(io, id_viaje, new Date(fecha_programada));

  const viaje = await leerViaje(id_viaje);
  emitirViajeInterno(io, destinosDe(viaje), 'viaje:asignado', resumenViaje(viaje));

  return {
    ...serializarViajePyme(viaje),
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

    // Ciclo por parada: iniciar ES la llegada a la parada 1. Se marca tambien
    // entregada (fecha_entrega): con el orden obligatorio nadie mas la puede
    // confirmar, y el conteo de pendientes y el ETA dependen de eso.
    const p = await tx.parada.updateMany({
      where: { id_parada: origen.id_parada, id_viaje, llegada_real: null },
      data: { llegada_real: ahora, fecha_entrega: ahora, estado: 'ENTREGADO' },
    });
    if (p.count === 0) throw conflicto();
  });

  await registrarCambioEstado({
    id_viaje,
    estado: 'CARGANDO',
    id_usuario,
    origen: ORIGEN_HISTORIAL.CHOFER,
    fecha: ahora,
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
      id_parada: origen.id_parada,
    });
  }

  return {
    mensaje: 'Viaje iniciado',
    id_viaje,
    estado: 'CARGANDO',
    fecha_inicio: ahora,
    fecha_llegada_origen: ahora,
    id_parada: origen.id_parada,
    llegada_real: ahora,
  };
}

// ─── Chofer: ciclo por parada (confirmar llegada / salir) ────────────────────
//
// En curso, el viaje alterna entre "en una parada" (CARGANDO en la 1,
// DESCARGANDO en las demas) y EN_RUTA. Cada parada queda con llegada_real y
// salida_real; de ahi salen el peon y el manejo reales (medicion-real.service).

const etaSinTirar = (io, id_viaje, salas) =>
  recalcularEtaInmediato(io, id_viaje, salas).catch((err) =>
    console.error(`[viaje-interno] viaje ${id_viaje}: no se pudo recalcular el ETA: ${err.message}`)
  );

const ordenadas = (paradas) => [...paradas].sort((a, b) => a.orden - b.orden);

// Salir de la parada actual. Si quedan paradas -> EN_RUTA; si era la ultima ->
// FINALIZADO (el cierre de siempre: precio real, remito, distancia real).
// GUARD: el estado leido Y la parada abierta (salida_real null) en el WHERE; dos
// "salir" a la vez o un salir contra una cancelacion: gana uno, el otro 409.
export async function salirDeParada({ io, id_usuario, id_viaje }) {
  const id_conductor = await conductorDe(id_usuario);
  const viaje = await viajeDeChofer(id_conductor, id_viaje, { paradas: { orderBy: { orden: 'asc' } } });

  if (!ESTADOS_EN_PARADA_INTERNO.includes(viaje.estado)) {
    if (viaje.estado === 'EN_RUTA') {
      throw new ErrorNegocio(400, 'No estas en ninguna parada: confirma la llegada a la siguiente antes de salir');
    }
    throw new ErrorNegocio(400, `No se puede salir de una parada en un viaje en estado ${viaje.estado}`);
  }

  const paradas = ordenadas(viaje.paradas);
  const abierta = paradas.find((p) => p.llegada_real && !p.salida_real);
  if (!abierta) throw conflicto();
  const quedan = paradas.some((p) => !p.llegada_real);
  const destino = quedan ? 'EN_RUTA' : 'FINALIZADO';
  validarTransicion(viaje.estado, destino, { ciclo: 'INTERNO', quien: 'CHOFER' });

  const actor = { id_usuario, origen: ORIGEN_HISTORIAL.CHOFER };
  const ahora = new Date();

  if (!quedan) {
    // Ultima parada: el cierre escribe la salida, los reales y FINALIZADO en
    // UNA transaccion. null = perdio la carrera (otro salir, una cancelacion).
    const cierre = await cerrarViaje(id_viaje, io, actor, { paradaQueSale: abierta.id_parada, ahora });
    if (!cierre) throw conflicto();
    return {
      mensaje: 'Viaje finalizado',
      id_viaje,
      id_parada: abierta.id_parada,
      estado: 'FINALIZADO',
      salida_real: ahora,
      viaje_finalizado: true,
      precio_real: cierre.precio_real,
      remito_url: cierre.remito_url,
      estimado: cierre.estimado,
      real: cierre.real,
    };
  }

  await transaccion(async (tx) => {
    const r = await tx.viaje.updateMany({
      where: { id_viaje, id_conductor, estado: viaje.estado },
      data: { estado: 'EN_RUTA' },
    });
    if (r.count === 0) throw conflicto();
    const p = await tx.parada.updateMany({
      where: { id_parada: abierta.id_parada, id_viaje, salida_real: null },
      data: { salida_real: ahora },
    });
    if (p.count === 0) throw conflicto();
    // Peon de esta parada y totales del viaje, con las paradas frescas.
    const frescas = await tx.parada.findMany({
      where: { id_viaje },
      select: { id_parada: true, orden: true, llegada_real: true, salida_real: true },
    });
    await escribirRealesInterno(tx, id_viaje, frescas);
  });

  await registrarCambioEstado({ id_viaje, estado: 'EN_RUTA', ...actor, fecha: ahora });

  if (io) {
    const salas = salasDeViaje(viaje);
    io.to(salas).emit('viaje:estado_cambiado', {
      id_viaje,
      estado_anterior: viaje.estado,
      estado_nuevo: 'EN_RUTA',
      id_parada: abierta.id_parada,
    });
    // La proxima parada cambio: ETA nuevo. Best-effort: el cambio de estado ya
    // se hizo (si Google falla, el emisor ya saltea y loguea).
    await etaSinTirar(io, id_viaje, salas);
  }

  return {
    mensaje: 'Saliste de la parada',
    id_viaje,
    id_parada: abierta.id_parada,
    estado: 'EN_RUTA',
    salida_real: ahora,
    viaje_finalizado: false,
  };
}

// Confirmar la llegada a una parada de un viaje INTERNO. La llama
// POST /api/viajes/:id/confirmar-parada despues de sus validaciones comunes
// (viaje 404, chofer 403, parada ajena 400, ya confirmada 400). Aca, en este
// orden: estado EN_RUTA -> 400; es la SIGUIENTE en orden -> 400; proximidad ->
// 400. Pasa a DESCARGANDO ("en una parada"). Confirmar la ultima ya NO
// finaliza: finaliza el "salir" de la ultima.
export async function confirmarParadaInterna({ io, viaje, parada, id_usuario, lat, lng }) {
  if (viaje.estado !== 'EN_RUTA') {
    if (ESTADOS_EN_PARADA_INTERNO.includes(viaje.estado)) {
      throw new ErrorNegocio(400, 'Todavia estas en una parada: toca "Salir" antes de confirmar la siguiente');
    }
    throw new ErrorNegocio(400, 'El viaje debe estar en estado EN_RUTA para confirmar una parada');
  }

  const paradas = ordenadas(viaje.paradas);
  const siguiente = paradas.find((p) => !p.llegada_real);
  if (!siguiente || siguiente.id_parada !== parada.id_parada) {
    throw new ErrorNegocio(400, `Primero tenes que confirmar la parada ${siguiente?.orden ?? '-'}`);
  }

  const radio_metros = parseFloat(process.env.RADIO_CONFIRMACION_METROS || '50');
  const distancia_metros = distanciaMetros(lat, lng, parada);
  if (distancia_metros > radio_metros) {
    throw new ErrorNegocio(
      400,
      `Estas a ${Math.round(distancia_metros)}m de la parada. Debes estar a menos de ${radio_metros}m`
    );
  }
  validarTransicion('EN_RUTA', 'DESCARGANDO', { ciclo: 'INTERNO', quien: 'CHOFER' });

  const ahora = new Date();
  await transaccion(async (tx) => {
    const r = await tx.viaje.updateMany({
      where: { id_viaje: viaje.id_viaje, estado: 'EN_RUTA', id_conductor: viaje.id_conductor },
      data: { estado: 'DESCARGANDO' },
    });
    if (r.count === 0) throw conflicto();

    // Ya con el lock del viaje: la anterior tiene que haber salido. De su salida
    // sale el manejo real del tramo que llega a esta.
    const anterior = await tx.parada.findFirst({
      where: { id_viaje: viaje.id_viaje, orden: { lt: parada.orden } },
      orderBy: { orden: 'desc' },
      select: { salida_real: true },
    });
    if (!anterior?.salida_real) throw conflicto();

    const p = await tx.parada.updateMany({
      where: { id_parada: parada.id_parada, id_viaje: viaje.id_viaje, llegada_real: null },
      data: {
        llegada_real: ahora,
        // Compatibilidad: fecha_entrega y estado ENTREGADO como siempre (el
        // ETA y el conteo de pendientes van por estado).
        fecha_entrega: ahora,
        estado: 'ENTREGADO',
        manejo_real_horas: (ahora.getTime() - anterior.salida_real.getTime()) / HORA_MS,
      },
    });
    if (p.count === 0) throw conflicto();
  });

  await registrarCambioEstado({
    id_viaje: viaje.id_viaje,
    estado: 'DESCARGANDO',
    id_usuario,
    origen: ORIGEN_HISTORIAL.CHOFER,
    fecha: ahora,
  });

  if (io) {
    const salas = salasDeViaje(viaje);
    io.to(salas).emit('viaje:estado_cambiado', {
      id_viaje: viaje.id_viaje,
      estado_anterior: 'EN_RUTA',
      estado_nuevo: 'DESCARGANDO',
      id_parada: parada.id_parada,
    });
    await etaSinTirar(io, viaje.id_viaje, salas);
  }

  return {
    confirmada: true,
    viaje_finalizado: false,
    id_viaje: viaje.id_viaje,
    id_parada: parada.id_parada,
    estado: 'DESCARGANDO',
    llegada_real: ahora,
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
  const ahora = new Date();

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
  // Cancelado EN CURSO: se guarda lo medido hasta ahora (la parada abierta se
  // cierra en este instante para el calculo). ANTES de limpiar Redis: la
  // distancia real sale del acumulado GPS. Nunca tira.
  if (ESTADOS_CURSO_INTERNO.includes(estado_anterior)) {
    await guardarMedicionParcial(id_viaje, ahora);
  }
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

  return serializarViajePyme(actualizado);
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

  // Paradas nuevas: { id_lugar } -> snapshot del lugar. Sin paradas nuevas, las
  // actuales (con su snapshot, aunque el lugar haya cambiado despues).
  const paradasNuevas = datos.paradas ? await resolverParadas(id_organizacion, datos.paradas) : null;
  const paradas =
    paradasNuevas ??
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

  // Precio, zona, duracion (manejo + peon) y ruta se recalculan si cambian las
  // paradas o la fecha (la fecha define la hora pico y el trafico de cada
  // tramo). Mismo calculo que al crear, ANTES de la tx: si Google falla,
  // ErrorMaps y no se modifica nada.
  let costo = {};
  let recorrido = null;
  if (datos.paradas || datos.fecha_programada) {
    const resultado = await estimarCosto({ paradas, fecha_programada: fecha_programada.toISOString() });
    recorrido = resultado.recorrido;
    costo = {
      zona: resultado.zona,
      tarifa_hora: resultado.desglose.tarifa_hora,
      tarifa_km: resultado.desglose.tarifa_km,
      precio_estimado: resultado.precio_estimado,
      ...columnasEstimadasViaje(recorrido.totales),
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

    if (paradasNuevas) {
      await tx.parada.deleteMany({ where: { id_viaje } });
      await tx.parada.createMany({
        data: conEstimacionPorParada(paradasParaCrear(paradasNuevas), recorrido).map((p) => ({
          ...p,
          id_viaje,
        })),
      });
    } else if (recorrido) {
      // Solo cambio la fecha: mismas paradas, estimacion nueva. Se releen
      // dentro de la tx (ya con el lock del viaje) por si otra edicion las
      // reemplazo en el medio.
      const actuales = await tx.parada.findMany({ where: { id_viaje }, orderBy: { orden: 'asc' } });
      if (actuales.length !== recorrido.paradas.length) throw conflicto();
      for (const [i, p] of actuales.entries()) {
        await tx.parada.update({
          where: { id_parada: p.id_parada },
          data: columnasEstimadasParada(recorrido.paradas[i]),
        });
      }
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

  // La ruta de la estimacion nueva (sin otra llamada a Google).
  if (recorrido) await guardarRutaSinTirar(id_viaje, recorrido.polilinea);

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
    ...serializarViajePyme(actualizado),
    ruta_planeada: await obtenerRutaPlaneada(id_viaje),
  };
}
