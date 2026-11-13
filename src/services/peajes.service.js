// PEAJES DE GOOGLE para el precio v2 de los viajes internos.
//
// UNA llamada Enterprise (Routes, extraComputations TOLLS) por calculo, aparte
// de los tramos (que siguen en Pro). La usan crear, crear serie (una por serie),
// estimar-precio y editar (solo si cambian paradas o fecha). Cierre, medido y
// vivo usan los peajes del snapshot del viaje: nunca se recalculan.
//
// NUNCA TIRA y NUNCA bloquea el estimado (a diferencia de los tramos, que dan
// 503): si Google falla devuelve { error: true } y el precio sale sin peajes de
// Google (fuente NINGUNA, salvo lo declarado por la PyME), con log y un warning
// a Sentry (a lo sumo uno por minuto: con la cuota agotada cada estimado fallaria).
//
// Orden: kill switch (PEAJES_GOOGLE_HABILITADO) -> proveedor (con
// MAPS_PROVIDER=legacy no se calcula) -> cache en Redis -> Google.
//
// CACHE: el resultado CRUDO de Google ({ ida, incompleto, tramos }), no el
// precio. Clave = coordenadas de las paradas en orden (5 decimales) + fecha y
// hora LOCAL (America/Argentina/Buenos_Aires) de la salida: la tarifa depende de
// la franja horaria (pico / valle). TTL PRECIO_PEAJES_CACHE_SEGUNDOS (0 = sin
// cache). Asi estimar-precio y crear el mismo viaje justo despues hacen UNA sola
// llamada. Solo se cachean los exitos. Si Redis falla se sigue sin cache.
import { createHash } from 'node:crypto';
import redis from '../config/redis.js';
import { configPrecio } from '../config/precio.js';
import { reportarError } from '../config/sentry.js';
import { calcularPeajes, proveedorMaps } from './maps/index.js';
import { coordenadas } from './maps/comun.js';
import { redisListo, conTimeout, logSinRedis } from './redis-seguro.js';
import { ZONA_HORARIA } from './serie-fechas.js';

export const ORIGEN_PEAJES = {
  GOOGLE: 'GOOGLE',
  CACHE: 'CACHE',
  DESHABILITADO: 'DESHABILITADO',
  LEGACY: 'LEGACY',
  ERROR: 'ERROR',
};

const TIMEOUT_REDIS_MS = 500;
const PREFIJO = 'peajes:';

const formatoFranja = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_HORARIA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

// "YYYY-MM-DDTHH" de un instante, en hora argentina (la franja de 1 hora).
export function franjaHoraria(fecha) {
  const p = Object.fromEntries(formatoFranja.formatToParts(fecha).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}`;
}

// Clave del cache: PURA.
export function clavePeajes(paradas, salida) {
  const coords = paradas
    .map((pa) => {
      const { lat, lng } = coordenadas(pa);
      return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
    })
    .join('|');
  const hash = createHash('sha256').update(`${coords}@${franjaHoraria(salida)}`).digest('hex');
  return `${PREFIJO}${hash}`;
}

const resultadoValido = (r) =>
  r && Number.isInteger(r.ida) && r.ida >= 0 && typeof r.incompleto === 'boolean' && Array.isArray(r.tramos);

const sinGoogle = (origen, error = false) => ({ ida: null, incompleto: null, tramos: null, error, origen });

async function leerCache(cliente, clave) {
  if (!redisListo(cliente)) {
    logSinRedis('peajes', `status=${cliente.status}`);
    return null;
  }
  try {
    const crudo = await conTimeout(cliente.get(clave), TIMEOUT_REDIS_MS);
    if (!crudo) return null;
    const r = JSON.parse(crudo);
    return resultadoValido(r) ? r : null;
  } catch (err) {
    logSinRedis('peajes', err.message);
    return null;
  }
}

async function escribirCache(cliente, clave, resultado, ttl) {
  if (!redisListo(cliente)) return;
  try {
    await conTimeout(cliente.set(clave, JSON.stringify(resultado), 'EX', ttl), TIMEOUT_REDIS_MS);
  } catch (err) {
    logSinRedis('peajes', err.message);
  }
}

// Warning a Sentry a lo sumo una vez por minuto.
let ultimoReporte = 0;
function reportarFalla(err, reportar, ahoraMs) {
  if (ahoraMs - ultimoReporte < 60_000) return;
  ultimoReporte = ahoraMs;
  reportar(err, { contexto: 'peajes-google', nivel: 'warning' });
}

// Solo para tests: resetea el tope de reportes a Sentry.
export function _reiniciarReportes() {
  ultimoReporte = 0;
}

// paradas: [{ lat, lng } | { latitud, longitud }] (>= 2), en orden.
// salida: la salida estimada del ORIGEN (salidaDelOrigen de estimacion.service),
//   la misma hora con la que sale el primer tramo.
// Devuelve { ida, incompleto, tramos, error, origen } (ida null si no hay dato
// de Google). Nunca tira.
export async function obtenerPeajesGoogle({ paradas, salida, ahora = new Date() }, deps = {}) {
  const {
    calcular = calcularPeajes,
    cliente = redis,
    config = configPrecio,
    reportar = reportarError,
    proveedor = proveedorMaps,
  } = deps;
  try {
    const p = config();
    if (!p.PEAJES_GOOGLE_HABILITADO) return sinGoogle(ORIGEN_PEAJES.DESHABILITADO);
    if (proveedor() !== 'routes') return sinGoogle(ORIGEN_PEAJES.LEGACY);

    const ttl = p.PRECIO_PEAJES_CACHE_SEGUNDOS;
    const clave = clavePeajes(paradas, salida);
    if (ttl > 0) {
      const cacheado = await leerCache(cliente, clave);
      if (cacheado) {
        console.log(`[peajes] cache hit (ida ${cacheado.ida})`);
        return { ...cacheado, error: false, origen: ORIGEN_PEAJES.CACHE };
      }
    }

    let resultado;
    try {
      resultado = await calcular({ puntos: paradas, salida, ahora });
    } catch (err) {
      console.error(
        `[peajes] no se pudieron calcular los peajes (${err?.tipo ?? 'ERROR'}: ${err?.detalle ?? err?.message}): el estimado sigue sin peajes de Google`
      );
      reportarFalla(err, reportar, Date.now());
      return sinGoogle(ORIGEN_PEAJES.ERROR, true);
    }

    if (ttl > 0) await escribirCache(cliente, clave, resultado, ttl);
    return { ...resultado, error: false, origen: ORIGEN_PEAJES.GOOGLE };
  } catch (err) {
    // Defensivo (p. ej. paradas mal formadas): nunca tirar.
    console.error(`[peajes] error inesperado: ${err?.message}`);
    reportarFalla(err, reportar, Date.now());
    return sinGoogle(ORIGEN_PEAJES.ERROR, true);
  }
}
