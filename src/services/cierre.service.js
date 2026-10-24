import prisma from '../config/prisma.js';
import { obtenerAcumulado, limpiarGPS, medicionesHasta, ultimoPing } from './gps.service.js';
import { generarRemito } from './remito.service.js';
import { detenerEmisorEta } from './eta-emisor.js';
import { cancelarAvisoVencimiento } from './vencimiento.service.js';
import {
  registrarCambioEstado,
  INCLUDE_HISTORIAL,
} from './historial-estado.service.js';
import {
  calcularMetricasViaje,
  bloqueTiempos,
  paradasConTiempos,
} from './duracion.service.js';
import { salasDeViaje, emitirViajeInterno } from '../sockets/salas.js';
import { marcarViajeCerrado } from './cancelacion.service.js';
import { escribirRealesInterno } from './medicion-real.service.js';
import { tiemposRealesDesdeHistorial } from './tiempos-reales.js';
import { OPCIONES_TX } from './organizacion.service.js';
import { precioDesdeMediciones } from './precio-real.js';
import { planCierre } from './cierre-plan.js';
import { configCierre } from './cierre-fechas.js';
import { cancelarTimersCierre } from './timers-cierre.js';
import { ESTADOS_TERMINALES } from './estado-viaje.service.js';

// Se tira adentro de la tx del cierre interno para hacer rollback cuando algo
// cambio entre el plan y la escritura (otro "salir", otro cierre, una
// cancelacion, una parada confirmada en el medio).
class CierrePerdido extends Error {}

// Origen del historial para cada modo de cierre interno.
const ORIGEN_CIERRE = { CHOFER: 'CONDUCTOR', ORGANIZACION: 'CLIENTE', AUTOMATICO: 'SISTEMA' };

// ─── LEGACY ──────────────────────────────────────────────────────────────────

// Cierre del ciclo LEGACY: confirmarParada, al confirmar la ultima parada. Cierra
// desde EN_RUTA o DESCARGANDO; los reales salen del historial de estados.
// `actor` = { id_usuario, origen } de quien disparo el cierre: cerrarViaje no
// puede saberlo por su cuenta.
//
// La distancia real sale del acumulado GPS de Redis, leido ANTES de limpiarGPS.
//
// Devuelve null si NO cerro: el viaje ya no estaba en el estado esperado.
export async function cerrarViaje(id_viaje, io, actor = {}, { ahora = new Date() } = {}) {
  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    select: {
      id_viaje: true,
      id_organizacion: true,
      zona: true,
      tarifa_hora: true,
      tarifa_km: true,
      // Hacen falta para repartir el precio de los viajes MIXTO.
      paradas: { select: { latitud: true, longitud: true } },
      // Para los reales del ciclo legacy.
      ...INCLUDE_HISTORIAL,
    },
  });

  const acumulado = await obtenerAcumulado(id_viaje);
  const mediciones = {
    tiempo_horas: acumulado?.tiempo_horas ?? 0,
    distancia_km: acumulado?.distancia_km ?? 0,
  };
  const precio = precioDesdeMediciones(viaje, mediciones);

  // GUARD ATOMICO: solo cierra desde los dos estados en los que confirmar-parada
  // acepta confirmar (EN_RUTA o DESCARGANDO). Si una cancelacion se adelanto,
  // matchea 0 filas y el viaje queda CANCELADO.
  const reales = tiemposRealesDesdeHistorial(viaje.historial_estados, ahora);
  const r = await prisma.viaje.updateMany({
    where: { id_viaje, estado: { in: ['EN_RUTA', 'DESCARGANDO'] } },
    data: {
      precio_real: precio.precio_real,
      estado: 'FINALIZADO',
      tiempo_capital: precio.tiempo_capital,
      distancia_provincia: precio.distancia_provincia,
      distancia_real_km: acumulado ? acumulado.distancia_km : null,
      ...(reales ? { manejo_real_horas: reales.manejo_horas, peon_real_horas: reales.peon_horas } : {}),
    },
  });
  if (r.count === 0) return null;

  return despuesDelCierre({ io, viaje, actor, fechaHistorial: ahora, precio, mediciones, extraEvento: {} });
}

// ─── INTERNO (Tarea 5: un cierre, tres modos) ────────────────────────────────

// Cierre de un viaje del ciclo INTERNO, por cualquiera de los tres caminos:
//   CHOFER        "Salir" de la ULTIMA parada (salirDeParada). La salida es la
//                 detectada por GPS si es anterior al toque; si no, el toque.
//   ORGANIZACION  la PyME finaliza a mano (finalizarViajeOrganizacion valida que
//                 llego a la ultima y que el cierre manual esta habilitado).
//   AUTOMATICO    fin del dia (timer, barrido de arranque, chequeo perezoso).
// Que se escribe en cada parada y en que instante se corta el precio lo decide
// planCierre (puro); el precio lo calcula precioDesdeMediciones con lo medido
// HASTA ese instante (el precio no sigue creciendo con el GPS).
//
// UNA transaccion: FINALIZADO (updateMany con el estado leido en el WHERE), la
// salida de la parada abierta (si hay), las paradas no visitadas y los reales.
// Si algo cambio desde la lectura (otro cierre, una cancelacion, un "salir" o un
// confirmar en el medio), rollback y null: el caller responde 409. Asi, entre
// Salir del chofer, el finalizar de la PyME y el automatico gana UNO solo.
export async function cerrarViajeInterno({ io, id_viaje, modo, actor = {}, ahora = new Date() }) {
  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    select: {
      id_viaje: true,
      id_organizacion: true,
      id_conductor: true,
      estado: true,
      zona: true,
      tarifa_hora: true,
      tarifa_km: true,
      conductor: { select: { id_usuario: true } },
      paradas: {
        select: {
          id_parada: true,
          orden: true,
          latitud: true,
          longitud: true,
          llegada_real: true,
          salida_real: true,
          salida_detectada: true,
          peon_estimado_horas: true,
          manejo_estimado_horas: true,
        },
      },
    },
  });
  if (!viaje || viaje.id_organizacion === null || ESTADOS_TERMINALES.includes(viaje.estado)) return null;

  let plan;
  try {
    plan = planCierre(viaje, modo, {
      ahora,
      ultimoPing: await ultimoPing(id_viaje),
      peonMinutos: configCierre().peonMinutos,
    });
  } catch {
    // El viaje ya no esta donde el caller lo vio (p. ej. otro "salir" lo saco de
    // la ultima parada): es una carrera perdida, no un error.
    return null;
  }

  // Lo medido hasta el corte, leido ANTES de limpiar Redis.
  const mediciones = await medicionesHasta(id_viaje, plan.corte);
  const precio = precioDesdeMediciones(viaje, mediciones);

  try {
    await prisma.$transaction(async (tx) => {
      const r = await tx.viaje.updateMany({
        where: {
          id_viaje,
          estado: { in: plan.estadosEsperados },
          ...(modo === 'CHOFER' ? { id_conductor: viaje.id_conductor } : {}),
        },
        data: {
          estado: 'FINALIZADO',
          cerrado_por: modo,
          precio_real: precio.precio_real,
          tiempo_capital: precio.tiempo_capital,
          distancia_provincia: precio.distancia_provincia,
          distancia_real_km: mediciones.sin_pings ? null : mediciones.distancia_km,
          fecha_corte_precio: plan.corte,
        },
      });
      if (r.count === 0) throw new CierrePerdido();

      if (plan.abierta !== null) {
        // La parada abierta tiene que seguir abierta. Con salida (toque o GPS) se
        // escribe; sin salida (cierre sin "Salir" ni deteccion) queda vacia y su
        // peon "no medido": alcanza con verificar que sigue abierta (el lock de la
        // fila del viaje, tomado arriba, serializa contra "salir"). OJO: un
        // updateMany con data vacia NO corre y devuelve count 0.
        const where = { id_parada: plan.abierta, id_viaje, salida_real: null };
        const sigueAbierta = plan.salida
          ? (await tx.parada.updateMany({
              where,
              data: { salida_real: plan.salida.fecha, origen_salida: plan.salida.origen },
            })).count
          : await tx.parada.count({ where });
        if (sigueAbierta === 0) throw new CierrePerdido();
      }

      if (plan.noVisitadas.length > 0) {
        const nv = await tx.parada.updateMany({
          where: { id_parada: { in: plan.noVisitadas }, id_viaje, llegada_real: null },
          data: { no_visitada: true },
        });
        if (nv.count !== plan.noVisitadas.length) throw new CierrePerdido();
      }

      const frescas = await tx.parada.findMany({
        where: { id_viaje },
        select: { id_parada: true, orden: true, llegada_real: true, salida_real: true },
      });
      // Cerrado MANEJANDO (automatico incompleto en EN_RUTA): el tramo en curso
      // hasta el corte suma al manejo del viaje, igual que al cancelar en curso, asi
      // el real cubre la misma ventana que el precio. Con una parada abierta NO se
      // pasa `fin`: cerraria su peon en el corte (inventado).
      const fin = plan.abierta === null && plan.incompleto ? plan.corte : null;
      await escribirRealesInterno(tx, id_viaje, frescas, { fin });
    }, OPCIONES_TX);
  } catch (err) {
    if (err instanceof CierrePerdido) return null;
    throw err;
  }

  const resultado = await despuesDelCierre({
    io,
    viaje,
    actor: { id_usuario: actor.id_usuario ?? null, origen: ORIGEN_CIERRE[modo] },
    // CHOFER: el mismo instante que la salida de la ultima parada (como el resto
    // del ciclo por parada). PyME / automatico: el momento del cierre.
    fechaHistorial: modo === 'CHOFER' ? plan.salida.fecha : ahora,
    precio,
    mediciones,
    extraEvento: {
      cerrado_por: modo,
      incompleto: plan.incompleto,
      paradas_no_visitadas: plan.noVisitadas,
      fecha_corte_precio: plan.corte,
    },
    id_usuario_chofer: viaje.conductor?.id_usuario ?? null,
  });

  console.log(
    `[cierre] viaje ${id_viaje} FINALIZADO por ${modo}${plan.incompleto ? ' (incompleto)' : ''}, ` +
      `corte ${plan.corte.toISOString()}`
  );
  return { ...resultado, salida: plan.salida, corte: plan.corte };
}

// ─── Comun a los dos ciclos ──────────────────────────────────────────────────

// Lo que pasa DESPUES del commit del cierre: historial, remito, evento y la
// limpieza del estado activo (GPS, ETA, Redis, timers).
async function despuesDelCierre({
  io,
  viaje,
  actor,
  fechaHistorial,
  precio,
  mediciones,
  extraEvento,
  id_usuario_chofer = null,
}) {
  const { id_viaje } = viaje;

  // SITIO 11/12 del historial. Va ANTES de calcular las metricas: la fila
  // FINALIZADO es justamente el cierre de la etapa de descarga, asi que sin
  // ella duracion_descarga saldria null en el evento que emitimos abajo.
  await registrarCambioEstado({
    id_viaje,
    estado: 'FINALIZADO',
    id_usuario: actor.id_usuario ?? null,
    origen: actor.origen ?? null,
    fecha: fechaHistorial,
  });

  const remito_url = await generarRemito(id_viaje);

  // Relectura completa: el select de arriba no trae ni las paradas con sus
  // tiempos ni las columnas de manejo / peon. Una query extra, una sola vez por
  // viaje, en el unico momento en que el cuadro completo existe entero.
  const viajeCompleto = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: { paradas: { orderBy: { orden: 'asc' } }, ...INCLUDE_HISTORIAL },
  });
  const metricas = calcularMetricasViaje(viajeCompleto);
  const tiempos = bloqueTiempos(viajeCompleto);
  const paradas = paradasConTiempos(viajeCompleto.paradas, { terminado: true }).map((p) => ({
    id_parada: p.id_parada,
    orden: p.orden,
    llegada_estimada: p.llegada_estimada,
    salida_estimada: p.salida_estimada,
    llegada_real: p.llegada_real,
    salida_real: p.salida_real,
    salida_detectada: p.salida_detectada,
    origen_salida: p.origen_salida,
    no_visitada: p.no_visitada === true,
    peon_medido: p.peon_medido,
    peon_estimado_min: p.peon_estimado_min,
    manejo_estimado_min: p.manejo_estimado_min,
    peon_real_min: p.peon_real_min,
    manejo_real_min: p.manejo_real_min,
    diferencia_min: p.diferencia_min,
  }));

  const desglose = {
    precio_por_tiempo: precio.precio_por_tiempo,
    precio_por_distancia: precio.precio_por_distancia,
    tiempo_horas: mediciones.tiempo_horas,
    distancia_km: mediciones.distancia_km,
    tiempo_capital: precio.tiempo_capital,
    distancia_provincia: precio.distancia_provincia,
    tarifa_hora: viaje.tarifa_hora,
    tarifa_km: viaje.tarifa_km,
  };

  const cuerpo = {
    precio_real: precio.precio_real,
    desglose,
    remito_url,
    ...metricas,
    ...tiempos,
    paradas,
    ...extraEvento,
  };
  const evento = { id_viaje, ...cuerpo };
  if (io) {
    // Canal 6/6 de las metricas por etapa. viaje:{id} y, si es de una PyME,
    // organizacion:{id}. Desde el Paso 3 tambien los bloques estimado / real y
    // los tiempos de cada parada. Desde la Tarea 5, en un viaje interno tambien
    // al chofer (lo puede cerrar la PyME o el automatico) con cerrado_por.
    if (viaje.id_organizacion !== null) {
      emitirViajeInterno(
        io,
        { id_viaje, id_organizacion: viaje.id_organizacion, id_usuario_chofer },
        'viaje:finalizado',
        evento
      );
    } else {
      io.to(salasDeViaje(viaje)).emit('viaje:finalizado', evento);
    }
  }

  // Marca ANTES de limpiar: un ping en vuelo re-limpia (ver cancelacion.service).
  marcarViajeCerrado(id_viaje);
  detenerEmisorEta(id_viaje);
  // Defensivo: para llegar a FINALIZADO el viaje paso por iniciarViaje, que ya
  // cancelo el aviso. Se cancela igual — es idempotente y gratis — con el mismo
  // criterio que el cancelarTimeoutReserva defensivo de cancelarViajeCliente.
  cancelarAvisoVencimiento(id_viaje);
  cancelarTimersCierre(id_viaje);
  await limpiarGPS(id_viaje);

  return cuerpo;
}
