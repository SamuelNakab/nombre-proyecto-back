import prisma from '../config/prisma.js';
import redis from '../config/redis.js';
import * as turf from '@turf/turf';

// Fuente de verdad del ETA: Google Maps Directions API con trafico, desde la
// posicion actual del conductor hasta la proxima parada PENDIENTE. El estado se
// cachea en Redis para servir un countdown local entre recalculos con la API.

const keyEta = (id_viaje) => `gps:${id_viaje}:eta`;

// Consulta a Google Maps Directions. Devuelve { segundos, distancia_metros }.
// Si no hay API key o la llamada falla, cae a una estimacion por linea recta
// (velocidad urbana promedio) para no dejar el ETA sin valor.
async function consultarDirections(origenLat, origenLng, destinoLat, destinoLng) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  const fallback = () => {
    const metros = turf.distance(
      [origenLng, origenLat],
      [destinoLng, destinoLat],
      { units: 'meters' }
    );
    const velocidad_ms = 25000 / 3600; // 25 km/h promedio urbano
    return { segundos: Math.round(metros / velocidad_ms), distancia_metros: Math.round(metros) };
  };

  if (!apiKey) {
    console.warn('[eta.service] Sin GOOGLE_MAPS_API_KEY — ETA estimado por linea recta');
    return fallback();
  }

  try {
    const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
    url.searchParams.set('origin', `${origenLat},${origenLng}`);
    url.searchParams.set('destination', `${destinoLat},${destinoLng}`);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('departure_time', 'now'); // considera trafico actual
    url.searchParams.set('key', apiKey);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.status !== 'OK') throw new Error(data.status);
    const leg = data.routes?.[0]?.legs?.[0];
    if (!leg) throw new Error('Sin legs en la respuesta');

    const segundos = leg.duration_in_traffic?.value ?? leg.duration?.value;
    const distancia_metros = leg.distance?.value ?? 0;
    if (segundos == null) throw new Error('Sin duration en la respuesta');

    return { segundos, distancia_metros };
  } catch (err) {
    console.error('[eta.service] Error en Directions — estimando por linea recta:', err.message);
    return fallback();
  }
}

// Recalcula el ETA con la API y persiste el estado en Redis.
// Devuelve { segundos_restantes, proxima_parada_id, distancia_restante_metros }
// o null si el viaje no tiene paradas pendientes.
export async function calcularEtaConApi(id_viaje, lat, lng) {
  const proxima = await prisma.parada.findFirst({
    where: { id_viaje, estado: 'PENDIENTE' },
    orderBy: { orden: 'asc' },
  });
  if (!proxima) return null;

  const { segundos, distancia_metros } = await consultarDirections(
    lat, lng, proxima.latitud, proxima.longitud
  );

  const estado = {
    segundos_eta_api: segundos,
    timestamp_calculo: Date.now(),
    proxima_parada_id: proxima.id_parada,
  };
  await redis.set(keyEta(id_viaje), JSON.stringify(estado), 'EX', 86400);

  return {
    segundos_restantes: segundos,
    proxima_parada_id: proxima.id_parada,
    distancia_restante_metros: distancia_metros,
  };
}

// Lee el estado crudo del ETA cacheado en Redis (o null). Expuesto para que el
// emisor pueda decidir el recalculo programado sin conocer la key.
export async function leerEstadoEta(id_viaje) {
  const raw = await redis.get(keyEta(id_viaje));
  return raw ? JSON.parse(raw) : null;
}

// Countdown local a partir del ultimo ETA de la API.
// - null: no hay ETA cacheado (el emisor debe calcular con la API).
// - { necesita_recalculo: true }: el countdown llego a 0.
// - { segundos_restantes, proxima_parada_id }: countdown vigente.
export async function obtenerEtaActual(id_viaje) {
  const estado = await leerEstadoEta(id_viaje);
  if (!estado) return null;

  const transcurrido_seg = (Date.now() - estado.timestamp_calculo) / 1000;
  const countdown = estado.segundos_eta_api - transcurrido_seg;

  if (countdown <= 0) return { necesita_recalculo: true };

  return { segundos_restantes: countdown, proxima_parada_id: estado.proxima_parada_id };
}
