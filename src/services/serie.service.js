// SERIES de viajes (Paso 4): la PyME define una recurrencia (todos los dias,
// ciertos dias de la semana, semanal o mensual a una hora LOCAL) y se generan DE
// UNA VEZ todos los viajes de la ventana (fecha_desde .. fecha_hasta, como maximo
// 31 dias). Cada viaje generado es un viaje INTERNO normal (Paso 2): ASIGNADO al
// chofer, con su propia estimacion de Google (trafico segun SU fecha), su timer
// de vencimiento y su fila de historial. El chofer confirma o rechaza cada uno
// por separado, y la PyME los edita, reasigna o cancela por separado con las
// rutas de siempre: NADA se propaga a la serie ni a los otros viajes.
//
// TODO O NADA al crear:
//   1. Validaciones (PyME operativa, ventana, chofer asignable, lugares).
//   2. TODAS las estimaciones, de a SERIE_CONCURRENCIA_MAPS a la vez y con un
//      tope total de SERIE_TIMEOUT_MS. Si cualquiera falla -> el error (503 si
//      Google no responde, 400 si no hay ruta) y no se escribio NADA.
//   3. UNA transaccion: lock del vinculo (el mismo de crear, serializa contra
//      desvincular) -> la serie -> todos los viajes, paradas y condiciones con
//      createMany (un puñado de queries, no un round-trip por viaje).
//   4. Fuera de la tx: historial, timers, rutas, y UN evento serie:asignada.
//
// La serie no se renueva sola. Cancelarla (CANCELADA) no toca los viajes ya
// creados. Desvincular al chofer la pasa a BORRADA en la misma tx que cancela
// sus viajes (vinculo-chofer.service).
import prisma from '../config/prisma.js';
import { ErrorNegocio } from './error-negocio.js';
import { ErrorMaps } from './maps/comun.js';
import { estimarCosto } from './costo.service.js';
import { columnasEstimadasViaje, conEstimacionPorParada } from './estimacion.service.js';
import { paradasParaCrear, anticipacionMinimaMinutos } from './viaje-validacion.js';
import { resolverParadas } from './lugar.service.js';
import {
  exigirPymeOperativa,
  validarChoferAsignable,
  bloquearVinculoActivo,
  transaccion,
  guardarRutaSinTirar,
  resumenViaje,
  serializarViajePyme,
  INCLUDE_VIAJE_INTERNO,
} from './viaje-interno.service.js';
import { registrarCambiosEstado } from './historial-estado.service.js';
import { ORIGEN_HISTORIAL } from './estado-viaje.service.js';
import { programarVencimientoInterno, vencerSiCorresponde } from './vencimiento.service.js';
import { generarOcurrencias, resolverVentana, ZONA_HORARIA } from './serie-fechas.js';
import { ejecutarConLimite } from './limite-concurrencia.js';
import { emitirViajeInterno } from '../sockets/salas.js';

// ─── Configuracion ───────────────────────────────────────────────────────────

const CONCURRENCIA_DEFAULT = 4;
const TIMEOUT_DEFAULT_MS = 60_000;
// La ruta planeada vive en Redis con TTL de 24 h (gps.service): guardarla para un
// viaje que sale en 20 dias es tirarla. El resto la recalcula el fallback de
// gps.socket en el primer ping (1 llamada Essentials).
const HORIZONTE_RUTA_MS = 24 * 3_600_000;

// Estimaciones a Google en vuelo a la vez al crear una serie. Se lee en cada
// request; basura o < 1 -> default.
export function serieConcurrenciaMaps(env = process.env) {
  const n = Number(env.SERIE_CONCURRENCIA_MAPS);
  return Number.isInteger(n) && n >= 1 ? n : CONCURRENCIA_DEFAULT;
}

// Tope TOTAL de las estimaciones de una serie. Cada llamada ya tiene su propio
// MAPS_TIMEOUT_MS; esto corta el conjunto. Basura o <= 0 -> default.
export function serieTimeoutMs(env = process.env) {
  const n = Number(env.SERIE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : TIMEOUT_DEFAULT_MS;
}

// ─── Serializacion ───────────────────────────────────────────────────────────

const fechaTexto = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
// "YYYY-MM-DD" -> Date para una columna @db.Date (medianoche UTC = esa fecha).
const fechaColumna = (texto) => new Date(`${texto}T00:00:00.000Z`);

const INCLUDE_SERIE = {
  conductor: {
    select: {
      id_conductor: true,
      usuario: { select: { id_usuario: true, nombre: true, apellido: true } },
    },
  },
};

// Nombres de los lugares de las plantillas (la PyME ve el nombre ACTUAL, igual
// que en las paradas de sus viajes). UNA query para todas las series.
async function lugaresDePlantillas(series) {
  const ids = [
    ...new Set(series.flatMap((s) => s.paradas.map((p) => p.id_lugar).filter((id) => id != null))),
  ];
  if (ids.length === 0) return new Map();
  const lugares = await prisma.lugar.findMany({
    where: { id_lugar: { in: ids } },
    select: { id_lugar: true, nombre: true, activo: true },
  });
  return new Map(lugares.map((l) => [l.id_lugar, l]));
}

// Solo para la PyME (las series no tienen rutas del chofer).
export function serializarSerie(serie, lugares = new Map()) {
  return {
    id_serie: serie.id_serie,
    id_organizacion: serie.id_organizacion,
    id_creador: serie.id_creador,
    id_conductor: serie.id_conductor,
    conductor: serie.conductor
      ? {
          id_conductor: serie.conductor.id_conductor,
          id_usuario: serie.conductor.usuario.id_usuario,
          nombre: serie.conductor.usuario.nombre,
          apellido: serie.conductor.usuario.apellido,
        }
      : null,
    frecuencia: serie.frecuencia,
    dias_semana: serie.dias_semana,
    dia_semana: serie.dia_semana,
    dia_mes: serie.dia_mes,
    hora: serie.hora,
    zona_horaria: ZONA_HORARIA,
    fecha_desde: fechaTexto(serie.fecha_desde),
    fecha_hasta: fechaTexto(serie.fecha_hasta),
    paradas: serie.paradas.map((p) => ({
      ...p,
      lugar: p.id_lugar != null && lugares.has(p.id_lugar) ? lugares.get(p.id_lugar) : null,
    })),
    condiciones_requeridas: serie.condiciones,
    descripcion: serie.descripcion,
    estado: serie.estado,
    fecha_baja: serie.fecha_baja,
    creado_en: serie.creado_en,
    actualizado_en: serie.actualizado_en,
  };
}

const ocurrenciaPublica = ({ fecha, fecha_programada, motivo }) => ({ fecha, fecha_programada, motivo });

// ─── Crear ───────────────────────────────────────────────────────────────────

export async function crearSerie({ io, id_organizacion, id_usuario, datos }) {
  const t0 = Date.now();
  const { id_conductor, frecuencia, hora, descripcion } = datos;
  const condiciones = datos.condiciones_requeridas;

  await exigirPymeOperativa(id_organizacion);

  const cliente = await prisma.cliente.findUnique({
    where: { id_usuario },
    select: { id_cliente: true },
  });
  if (!cliente) throw new ErrorNegocio(400, 'El usuario no tiene perfil de cliente');

  const ahora = new Date();
  const ventana = resolverVentana({ fecha_desde: datos.fecha_desde, fecha_hasta: datos.fecha_hasta, ahora });
  if (ventana.error) throw new ErrorNegocio(400, ventana.error);

  await validarChoferAsignable(id_organizacion, id_conductor, condiciones);

  // Plantilla: { id_lugar } -> snapshot de direccion y coordenadas.
  const paradas = await resolverParadas(id_organizacion, datos.paradas);

  const { ocurrencias, salteadas } = generarOcurrencias({
    frecuencia,
    dias_semana: datos.dias_semana ?? [],
    dia_semana: datos.dia_semana ?? null,
    dia_mes: datos.dia_mes ?? null,
    hora,
    fecha_desde: ventana.fecha_desde,
    fecha_hasta: ventana.fecha_hasta,
    ahora,
    anticipacionMinutos: anticipacionMinimaMinutos(),
  });
  if (ocurrencias.length === 0) {
    throw new ErrorNegocio(400, 'La serie no genera ningun viaje en esa ventana', {
      salteadas: salteadas.map(ocurrenciaPublica),
    });
  }

  // Estimaciones: TODAS antes de escribir nada. Cada una con SU fecha (trafico y
  // hora pico propios). Si cualquiera falla, sale su error y no se crea nada.
  const tEstimacion = Date.now();
  const timeoutMs = serieTimeoutMs();
  const estimaciones = await ejecutarConLimite(
    ocurrencias,
    serieConcurrenciaMaps(),
    (o) => estimarCosto({ paradas, fecha_programada: o.fecha_programada.toISOString() }),
    {
      deadlineMs: timeoutMs,
      errorDeadline: () => new ErrorMaps('NO_DISPONIBLE', { detalle: `serie: se supero el limite de ${timeoutMs}ms` }),
    }
  );
  const msEstimacion = Date.now() - tEstimacion;

  const filasParada = paradasParaCrear(paradas);
  const plantilla = filasParada.map((p) => ({
    orden: p.orden,
    direccion: p.direccion,
    lat: p.latitud,
    lng: p.longitud,
    id_lugar: p.id_lugar,
  }));

  const tTx = Date.now();
  const { id_serie, creados } = await transaccion(async (tx) => {
    // El MISMO lock que crear un viaje: un desvincular concurrente espera, o ya
    // corto el vinculo y esto lo ve inactivo (400, rollback de todo).
    const vinculo = await bloquearVinculoActivo(tx, id_organizacion, id_conductor);
    if (!vinculo) throw new ErrorNegocio(400, 'El chofer no esta vinculado a esta PyME');

    const serie = await tx.serieViaje.create({
      data: {
        id_organizacion,
        id_creador: id_usuario,
        id_conductor,
        frecuencia,
        dias_semana: datos.dias_semana ?? [],
        dia_semana: datos.dia_semana ?? null,
        dia_mes: datos.dia_mes ?? null,
        hora,
        fecha_desde: fechaColumna(ventana.fecha_desde),
        fecha_hasta: fechaColumna(ventana.fecha_hasta),
        paradas: plantilla,
        condiciones,
        descripcion: descripcion ?? null,
      },
      select: { id_serie: true },
    });

    const viajes = await tx.viaje.createManyAndReturn({
      data: ocurrencias.map((o, i) => {
        const e = estimaciones[i];
        return {
          estado: 'ASIGNADO',
          id_organizacion,
          id_creador: id_usuario,
          id_cliente: cliente.id_cliente,
          id_conductor,
          id_serie: serie.id_serie,
          metodo_cobro: vinculo.metodo_cobro,
          zona: e.zona,
          tarifa_hora: e.desglose.tarifa_hora,
          tarifa_km: e.desglose.tarifa_km,
          fecha_programada: o.fecha_programada,
          descripcion: descripcion ?? null,
          precio_estimado: e.precio_estimado,
          ...columnasEstimadasViaje(e.recorrido.totales),
        };
      }),
      select: { id_viaje: true, fecha_programada: true },
    });

    // Los ids se emparejan por fecha_programada (unica dentro de la serie: una
    // ocurrencia por dia), no por el orden del RETURNING.
    const idPorFecha = new Map(viajes.map((v) => [v.fecha_programada.getTime(), v.id_viaje]));
    const creados = ocurrencias.map((o, i) => ({
      id_viaje: idPorFecha.get(o.fecha_programada.getTime()),
      fecha_programada: o.fecha_programada,
      estimacion: estimaciones[i],
    }));
    if (creados.some((c) => c.id_viaje === undefined)) {
      throw new Error('crearSerie: no se pudieron emparejar los viajes creados');
    }

    await tx.parada.createMany({
      data: creados.flatMap((c) =>
        conEstimacionPorParada(filasParada, c.estimacion.recorrido).map((p) => ({ ...p, id_viaje: c.id_viaje }))
      ),
    });
    if (condiciones.length > 0) {
      await tx.condicionRequerida.createMany({
        data: creados.flatMap((c) => condiciones.map((condicion) => ({ id_viaje: c.id_viaje, condicion }))),
      });
    }
    return { id_serie: serie.id_serie, creados };
  });
  const msTx = Date.now() - tTx;

  // Fuera de la tx: un ASIGNADO por viaje (en lote, nunca tira), timers de
  // vencimiento y la ruta de los que salen dentro de 24 h.
  await registrarCambiosEstado(
    creados.map((c) => ({ id_viaje: c.id_viaje, estado: 'ASIGNADO', id_usuario, origen: ORIGEN_HISTORIAL.PYME }))
  );
  for (const c of creados) {
    programarVencimientoInterno(io, c.id_viaje, c.fecha_programada);
    if (c.fecha_programada.getTime() - Date.now() <= HORIZONTE_RUTA_MS) {
      await guardarRutaSinTirar(c.id_viaje, c.estimacion.recorrido.polilinea);
    }
  }

  const [serie, viajes] = await Promise.all([
    prisma.serieViaje.findUnique({ where: { id_serie }, include: INCLUDE_SERIE }),
    prisma.viaje.findMany({
      where: { id_serie },
      include: INCLUDE_VIAJE_INTERNO,
      orderBy: [{ fecha_programada: 'asc' }, { id_viaje: 'asc' }],
    }),
  ]);

  // UN evento para toda la serie (no N viaje:asignado): al chofer y a la sala de
  // la PyME. Las paradas van por resumenViaje: sin el nombre del lugar.
  emitirViajeInterno(
    io,
    { id_organizacion, id_usuario_chofer: serie.conductor.usuario.id_usuario },
    'serie:asignada',
    {
      id_serie,
      id_organizacion,
      organizacion: viajes[0].organizacion
        ? { id_organizacion, nombre: viajes[0].organizacion.nombre }
        : null,
      frecuencia: serie.frecuencia,
      hora: serie.hora,
      zona_horaria: ZONA_HORARIA,
      fecha_desde: fechaTexto(serie.fecha_desde),
      fecha_hasta: fechaTexto(serie.fecha_hasta),
      cantidad_viajes: viajes.length,
      viajes: viajes.map(resumenViaje),
    }
  );

  const llamadas = ocurrencias.length * (paradas.length - 1);
  console.log(
    `[series] serie ${id_serie}: ${viajes.length} viajes, ${llamadas} llamadas Pro, ` +
      `estimacion ${msEstimacion}ms, tx ${msTx}ms, total ${Date.now() - t0}ms`
  );

  return {
    serie: serializarSerie(serie, await lugaresDePlantillas([serie])),
    viajes: viajes.map(serializarViajePyme),
    salteadas: salteadas.map(ocurrenciaPublica),
    ajustadas: ocurrencias.filter((o) => o.ajuste).map((o) => ({ fecha: o.fecha, motivo: o.ajuste })),
  };
}

// ─── Lecturas ────────────────────────────────────────────────────────────────

// Lista de la PyME, con cuantos viajes hay en cada estado. Antes, el chequeo
// perezoso de vencimiento (que los conteos no muestren ASIGNADO lo que ya vencio).
export async function listarSeries(io, id_organizacion, { estado } = {}) {
  await vencerSiCorresponde(io, { id_organizacion });
  const series = await prisma.serieViaje.findMany({
    where: { id_organizacion, ...(estado ? { estado } : {}) },
    include: { ...INCLUDE_SERIE, viajes: { select: { estado: true } } },
    orderBy: [{ creado_en: 'desc' }, { id_serie: 'desc' }],
  });
  const lugares = await lugaresDePlantillas(series);
  return series.map((s) => {
    const por_estado = {};
    for (const v of s.viajes) por_estado[v.estado] = (por_estado[v.estado] ?? 0) + 1;
    return { ...serializarSerie(s, lugares), resumen_viajes: { total: s.viajes.length, por_estado } };
  });
}

// Una serie de OTRA PyME da 404, igual que una que no existe.
async function serieDeOrganizacion(id_organizacion, id_serie) {
  const serie = await prisma.serieViaje.findFirst({ where: { id_serie, id_organizacion }, include: INCLUDE_SERIE });
  if (!serie) throw new ErrorNegocio(404, 'Serie no encontrada');
  return serie;
}

export async function obtenerSerie(io, id_organizacion, id_serie) {
  await vencerSiCorresponde(io, { id_organizacion });
  const serie = await serieDeOrganizacion(id_organizacion, id_serie);
  const viajes = await prisma.viaje.findMany({
    where: { id_serie, id_organizacion },
    include: INCLUDE_VIAJE_INTERNO,
    orderBy: [{ fecha_programada: 'asc' }, { id_viaje: 'asc' }],
  });
  return {
    ...serializarSerie(serie, await lugaresDePlantillas([serie])),
    viajes: viajes.map(serializarViajePyme),
  };
}

// ─── Cancelar ────────────────────────────────────────────────────────────────

// ACTIVA -> CANCELADA. Los viajes ya creados NO se tocan (cada uno se cancela
// por su ruta). Permitido aunque la PyME este SUSPENDIDA.
// Lectura previa -> 404 / 400 (caso secuencial); updateMany condicionado a
// ACTIVA -> 409 si otro cancelar (o un desvincular) se adelanto.
export async function cancelarSerie({ io, id_organizacion, id_usuario, id_serie }) {
  const serie = await serieDeOrganizacion(id_organizacion, id_serie);
  if (serie.estado !== 'ACTIVA') {
    throw new ErrorNegocio(400, `No se puede cancelar una serie en estado ${serie.estado}`);
  }

  const ahora = new Date();
  const r = await prisma.serieViaje.updateMany({
    where: { id_serie, id_organizacion, estado: 'ACTIVA' },
    data: { estado: 'CANCELADA', fecha_baja: ahora, baja_por_id_usuario: id_usuario },
  });
  if (r.count === 0) {
    throw new ErrorNegocio(409, 'La serie cambio de estado mientras se procesaba tu pedido: volve a cargarla');
  }

  // Solo a la PyME: los viajes no cambian, al chofer no le cambia nada.
  emitirViajeInterno(io, { id_organizacion }, 'serie:cancelada', {
    id_serie,
    id_organizacion,
    estado: 'CANCELADA',
  });

  return { mensaje: 'Serie cancelada. Sus viajes no se modificaron', id_serie, estado: 'CANCELADA', fecha_baja: ahora };
}
