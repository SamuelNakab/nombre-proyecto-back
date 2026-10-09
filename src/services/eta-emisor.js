import redis from '../config/redis.js';
import { obtenerUltimaCoordenada } from './gps.service.js';
import { calcularEtaConApi, obtenerEtaActual, leerEstadoEta } from './eta.service.js';

// Emisor periodico de ETA. Mantiene un setInterval por viaje activo que emite
// eta:actualizar al room cada ETA_EMISION_SEGUNDOS. Entre recalculos con la API
// usa el countdown local de eta.service; cuando el countdown se agota o el
// ultimo calculo es muy viejo, vuelve a pegarle a la API.

const timers = new Map(); // id_viaje → intervalId
const ultimaActividad = new Map(); // id_viaje → wall-clock ms del ultimo ping
// Salas a las que se emite el ETA de cada viaje: viaje:{id} y, si el viaje es de
// una PyME, organizacion:{id} (ver sockets/salas.js). Las pasa gps.socket en cada
// ping; sin entrada se emite solo al room del viaje, como siempre.
const salasPorViaje = new Map(); // id_viaje → string[]
const salasDe = (id_viaje) => salasPorViaje.get(id_viaje) ?? [`viaje:${id_viaje}`];

const emisionSeg = () => parseInt(process.env.ETA_EMISION_SEGUNDOS) || 30;
const recalculoSeg = () => parseInt(process.env.ETA_RECALCULO_SEGUNDOS) || 360;
// Si un viaje no recibe pings por este tiempo, el emisor se auto-detiene en vez
// de quedar como timer huerfano emitiendo eta:actualizar al room para siempre
// (lo normal es que detenerEmisorEta lo corte al finalizar; esto cubre viajes
// que nunca finalizan: conductor que abandona, app cerrada, etc.).
const idleSeg = () => parseInt(process.env.ETA_EMISOR_IDLE_SEGUNDOS) || 300;

const FALLO = Symbol('fallo');

// calcularEtaConApi tira si Google falla. Aca se loguea y se devuelve FALLO para
// que el caller saltee el ciclo sin emitir.
async function calcularConApi(id_viaje, ultima) {
  try {
    return await calcularEtaConApi(id_viaje, ultima.lat, ultima.lng);
  } catch (err) {
    console.error(`[eta-emisor] viaje ${id_viaje}: ciclo salteado, no se pudo calcular el ETA (${err.detalle ?? err.message})`);
    return FALLO;
  }
}

function construirPayload(id_viaje, resultado) {
  const segundos_restantes = Math.max(0, Math.round(resultado.segundos_restantes));
  return {
    id_viaje,
    proxima_parada_id: resultado.proxima_parada_id,
    segundos_restantes,
    minutos_restantes: Math.ceil(segundos_restantes / 60),
  };
}

async function emitirEta(io, id_viaje) {
  const ultima = await obtenerUltimaCoordenada(id_viaje);
  if (!ultima) return; // todavia no hay posicion del conductor

  let resultado = await obtenerEtaActual(id_viaje);

  // Recalculo programado: si el ultimo calculo de la API supera el umbral,
  // forzamos un recalculo aunque el countdown siga vigente.
  if (resultado && resultado.segundos_restantes != null) {
    const estado = await leerEstadoEta(id_viaje);
    if (estado && (Date.now() - estado.timestamp_calculo) / 1000 >= recalculoSeg()) {
      resultado = null;
    }
  }

  if (!resultado || resultado.necesita_recalculo) {
    resultado = await calcularConApi(id_viaje, ultima);
    // Google fallo: se saltea este ciclo (ya se logueo). El proximo tick
    // reintenta; nunca se emite un ETA inventado.
    if (resultado === FALLO) return;
  }

  // El viaje se cerro o se cancelo MIENTRAS se calculaba (detenerEmisorEta ya
  // corrio y limpiarGPS ya borro las keys): calcularEtaConApi acaba de volver a
  // escribir gps:{id}:eta y quedaria huerfana 24 h. Se borra y no se emite.
  if (!timers.has(id_viaje)) {
    await redis.del(`gps:${id_viaje}:eta`);
    return;
  }

  if (!resultado) return; // sin parada pendiente

  io.to(salasDe(id_viaje)).emit('eta:actualizar', construirPayload(id_viaje, resultado));
}

// Arranca el emisor para un viaje (idempotente). Emite una vez de inmediato y
// luego cada ETA_EMISION_SEGUNDOS.
export function iniciarEmisorEta(io, id_viaje, salas = null) {
  if (salas) salasPorViaje.set(id_viaje, salas);
  // Registrar actividad en CADA ping (aunque el emisor ya este corriendo) para
  // que el watchdog de inactividad sepa que el viaje sigue vivo.
  ultimaActividad.set(id_viaje, Date.now());

  if (timers.has(id_viaje)) return;

  const handle = setInterval(() => {
    // Watchdog: si el viaje dejo de mandar pings, cortamos el emisor huerfano.
    const ultima = ultimaActividad.get(id_viaje) || 0;
    if (Date.now() - ultima > idleSeg() * 1000) {
      detenerEmisorEta(id_viaje);
      return;
    }
    emitirEta(io, id_viaje).catch((e) =>
      console.error(`[eta-emisor] viaje ${id_viaje}:`, e.message)
    );
  }, emisionSeg() * 1000);

  timers.set(id_viaje, handle);
  console.log(`[eta-emisor] iniciado para viaje ${id_viaje} (cada ${emisionSeg()}s)`);

  // Primera emision inmediata para no esperar el primer tick.
  emitirEta(io, id_viaje).catch(() => {});
}

// Detiene el emisor de un viaje y limpia el timer.
export function detenerEmisorEta(id_viaje) {
  const handle = timers.get(id_viaje);
  if (handle) {
    clearInterval(handle);
    timers.delete(id_viaje);
    console.log(`[eta-emisor] detenido para viaje ${id_viaje}`);
  }
  ultimaActividad.delete(id_viaje);
  salasPorViaje.delete(id_viaje);
}

// Fuerza un recalculo con la API y emite el resultado de inmediato. Lo usan el
// recalculo de ruta por desvio y la confirmacion de parada (cambia la proxima
// parada), donde el ETA viejo ya no vale.
export async function recalcularEtaInmediato(io, id_viaje, salas = null) {
  const ultima = await obtenerUltimaCoordenada(id_viaje);
  if (!ultima) return;

  const resultado = await calcularConApi(id_viaje, ultima);
  if (!resultado || resultado === FALLO) return;

  io.to(salas ?? salasDe(id_viaje)).emit('eta:actualizar', construirPayload(id_viaje, resultado));
}
