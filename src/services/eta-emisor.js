import { obtenerUltimaCoordenada } from './gps.service.js';
import { calcularEtaConApi, obtenerEtaActual, leerEstadoEta } from './eta.service.js';

// Emisor periodico de ETA. Mantiene un setInterval por viaje activo que emite
// eta:actualizar al room cada ETA_EMISION_SEGUNDOS. Entre recalculos con la API
// usa el countdown local de eta.service; cuando el countdown se agota o el
// ultimo calculo es muy viejo, vuelve a pegarle a la API.

const timers = new Map(); // id_viaje → intervalId

const emisionSeg = () => parseInt(process.env.ETA_EMISION_SEGUNDOS) || 30;
const recalculoSeg = () => parseInt(process.env.ETA_RECALCULO_SEGUNDOS) || 360;

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
    resultado = await calcularEtaConApi(id_viaje, ultima.lat, ultima.lng);
  }

  if (!resultado) return; // sin parada pendiente o fallo de calculo

  io.to(`viaje:${id_viaje}`).emit('eta:actualizar', construirPayload(id_viaje, resultado));
}

// Arranca el emisor para un viaje (idempotente). Emite una vez de inmediato y
// luego cada ETA_EMISION_SEGUNDOS.
export function iniciarEmisorEta(io, id_viaje) {
  if (timers.has(id_viaje)) return;

  const handle = setInterval(() => {
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
}

// Fuerza un recalculo con la API y emite el resultado de inmediato. Lo usan el
// recalculo de ruta por desvio y la confirmacion de parada (cambia la proxima
// parada), donde el ETA viejo ya no vale.
export async function recalcularEtaInmediato(io, id_viaje) {
  const ultima = await obtenerUltimaCoordenada(id_viaje);
  if (!ultima) return;

  const resultado = await calcularEtaConApi(id_viaje, ultima.lat, ultima.lng);
  if (!resultado) return;

  io.to(`viaje:${id_viaje}`).emit('eta:actualizar', construirPayload(id_viaje, resultado));
}
