import * as turf from '@turf/turf';
import redis from '../config/redis.js';
import { medicionEn, pingsEn, avanzarAcumulado, calidadGps, PUNTOS_MUESTREO_MS } from './mediciones-gps.js';

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

const distanciaKm = (a, b) => turf.distance(a, b, { units: 'kilometers' });

// El calculo es avanzarAcumulado (mediciones-gps.js, PURO): ignora los pings con
// timestamp <= al ultimo procesado (ignorado: true, no escribe nada) y cuenta
// pings y el mayor hueco entre pings.
export async function actualizarAcumulado(id_viaje, lat, lng, timestamp) {
  const raw = await redis.get(`gps:${id_viaje}:acumulado`);
  const r = avanzarAcumulado(raw ? JSON.parse(raw) : null, { lat, lng, timestamp }, distanciaKm);
  if (!r.ignorado) {
    await redis.set(`gps:${id_viaje}:acumulado`, JSON.stringify(r.nuevo), 'EX', 86400);
  }
  return {
    ...r.nuevo,
    distancia_delta: r.distancia_delta,
    tiempo_delta: r.tiempo_delta,
    es_primer_ping: r.es_primer_ping,
    ignorado: r.ignorado,
  };
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

// ─── Puntos de medicion (Tarea 5) ────────────────────────────────────────────
//
// gps:{id}:puntos es un ZSET (score = timestamp del ping) con el acumulado en
// ese ping, muestreado cada PUNTOS_MUESTREO_MS como minimo: ~2900 puntos en 24
// h. Sirve para cortar el precio real en un instante anterior al ultimo ping
// (salida detectada, hora prevista de fin): ver mediciones-gps.js. Solo los
// viajes internos lo escriben. Solo Redis: ninguna query a la DB por ping.
const keyPuntos = (id_viaje) => `gps:${id_viaje}:puntos`;

export async function registrarPuntoMedicion(id_viaje, timestamp, acumulado) {
  const key = keyPuntos(id_viaje);
  const ultimo = await redis.zrevrange(key, 0, 0, 'WITHSCORES');
  if (ultimo.length === 2 && timestamp - Number(ultimo[1]) < PUNTOS_MUESTREO_MS) return false;
  const punto = {
    ts: timestamp,
    tiempo_horas: acumulado.tiempo_horas,
    distancia_km: acumulado.distancia_km,
    // Pings aceptados hasta este punto: el precio medido cortado antes del
    // ultimo ping necesita saber cuantos hubo hasta el corte.
    pings: acumulado.pings ?? 0,
  };
  await redis.multi().zadd(key, timestamp, JSON.stringify(punto)).expire(key, 86400).exec();
  return true;
}

// { tiempo_horas, distancia_km, sin_pings, pings } medidos hasta `instante`.
// `pings` = pings aceptados hasta ese instante (precio v2).
export async function medicionesHasta(id_viaje, instante) {
  const acumulado = await obtenerAcumulado(id_viaje);
  if (!acumulado || new Date(instante).getTime() >= acumulado.ultima_actualizacion) {
    return { ...medicionEn([], acumulado, instante), pings: pingsEn([], acumulado, instante) };
  }
  const crudos = await redis.zrangebyscore(keyPuntos(id_viaje), '-inf', new Date(instante).getTime());
  const puntos = crudos.map((c) => JSON.parse(c));
  return { ...medicionEn(puntos, acumulado, instante), pings: pingsEn(puntos, acumulado, instante) };
}

// Calidad del GPS del viaje (pings aceptados y mayor hueco), leida ANTES de
// limpiar Redis, para persistir al cerrar o al cancelar en curso.
export async function calidadGpsViaje(id_viaje) {
  return calidadGps(await obtenerAcumulado(id_viaje));
}

// Timestamp (Date) del ultimo ping del viaje, o null.
export async function ultimoPing(id_viaje) {
  const acumulado = await obtenerAcumulado(id_viaje);
  return acumulado ? new Date(acumulado.ultima_actualizacion) : null;
}

export async function limpiarGPS(id_viaje) {
  await Promise.all([
    // Tarea 5: estado de la deteccion de salida y puntos de medicion.
    redis.del(`gps:${id_viaje}:salida`),
    redis.del(keyPuntos(id_viaje)),
    redis.del(`gps:${id_viaje}:ultima`),
    redis.del(`gps:${id_viaje}:historial`),
    redis.del(`gps:${id_viaje}:ruta`),
    redis.del(`gps:${id_viaje}:acumulado`),
    redis.del(`gps:${id_viaje}:pings_detenido`),
    redis.del(`gps:${id_viaje}:eta`),
    redis.del(`gps:${id_viaje}:ultimo_recalculo`),
    redis.del(`gps:${id_viaje}:pings_desviado`),
  ]);
}
