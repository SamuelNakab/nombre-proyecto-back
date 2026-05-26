import * as turf from '@turf/turf';
import redis from '../config/redis.js';

export async function guardarCoordenada(id_viaje, lat, lng, timestamp) {
  const payload = JSON.stringify({ lat, lng, timestamp });
  await Promise.all([
    redis.set(`gps:${id_viaje}:ultima`, payload, 'EX', 7200),
    redis.lpush(`gps:${id_viaje}:historial`, payload).then(() =>
      redis.ltrim(`gps:${id_viaje}:historial`, 0, 19)
    ),
  ]);
}

export async function obtenerUltimaCoordenada(id_viaje) {
  const raw = await redis.get(`gps:${id_viaje}:ultima`);
  return raw ? JSON.parse(raw) : null;
}

export async function obtenerAcumulado(id_viaje) {
  const raw = await redis.get(`gps:${id_viaje}:acumulado`);
  return raw ? JSON.parse(raw) : null;
}

export async function actualizarAcumulado(id_viaje, lat, lng, timestamp) {
  const raw = await redis.get(`gps:${id_viaje}:acumulado`);

  if (!raw) {
    const inicial = {
      tiempo_horas: 0,
      distancia_km: 0,
      ultima_lat: lat,
      ultima_lng: lng,
      ultima_actualizacion: timestamp,
    };
    await redis.set(`gps:${id_viaje}:acumulado`, JSON.stringify(inicial), 'EX', 86400);
    return { tiempo_horas: 0, distancia_km: 0, es_primer_ping: true };
  }

  const acumulado = JSON.parse(raw);
  const distancia_delta = turf.distance(
    [acumulado.ultima_lng, acumulado.ultima_lat],
    [lng, lat],
    { units: 'kilometers' }
  );
  const tiempo_delta = (timestamp - acumulado.ultima_actualizacion) / 3600000;

  const nuevo = {
    tiempo_horas: acumulado.tiempo_horas + tiempo_delta,
    distancia_km: acumulado.distancia_km + distancia_delta,
    ultima_lat: lat,
    ultima_lng: lng,
    ultima_actualizacion: timestamp,
  };
  await redis.set(`gps:${id_viaje}:acumulado`, JSON.stringify(nuevo), 'EX', 86400);
  return { ...nuevo, distancia_delta, tiempo_delta, es_primer_ping: false };
}

export function calcularVelocidad(lat_ant, lng_ant, ts_ant, lat_nueva, lng_nueva, ts_nuevo) {
  if (ts_nuevo === ts_ant) return 0;
  const distancia_metros = turf.distance(
    [lng_ant, lat_ant],
    [lng_nueva, lat_nueva],
    { units: 'meters' }
  );
  const tiempo_segundos = (ts_nuevo - ts_ant) / 1000;
  if (tiempo_segundos <= 0) return 0;
  return (distancia_metros / tiempo_segundos) * 3.6;
}

export async function guardarRuta(id_viaje, polilinea) {
  await redis.set(`gps:${id_viaje}:ruta`, JSON.stringify(polilinea), 'EX', 86400);
}

export async function obtenerRuta(id_viaje) {
  const raw = await redis.get(`gps:${id_viaje}:ruta`);
  return raw ? JSON.parse(raw) : null;
}

export async function limpiarGPS(id_viaje) {
  await Promise.all([
    redis.del(`gps:${id_viaje}:ultima`),
    redis.del(`gps:${id_viaje}:historial`),
    redis.del(`gps:${id_viaje}:ruta`),
    redis.del(`gps:${id_viaje}:acumulado`),
    redis.del(`gps:${id_viaje}:pings_detenido`),
  ]);
}
