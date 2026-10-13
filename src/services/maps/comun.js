// Piezas PURAS de la capa de Google (sin red, sin env): errores tipados,
// conversiones de unidades y polilineas. Las comparten los dos proveedores
// (routes.js y legacy.js) y se testean sin red en comun.test.js.
import { ErrorNegocio } from '../error-negocio.js';

// ─── Errores ─────────────────────────────────────────────────────────────────

export const MENSAJE_NO_DISPONIBLE = 'No se pudo calcular la ruta. Probá de nuevo en unos minutos.';
export const MENSAJE_SIN_RUTA = 'No hay una ruta en auto entre esos puntos. Revisá las direcciones.';

// Error de la capa de Google. Extiende ErrorNegocio para que salga solo por
// responderErrorNegocio con su status:
//   NO_DISPONIBLE -> 503: Google caido, timeout, sin key, 401/403/429, 5xx o
//                    cualquier respuesta que no sepamos leer.
//   SIN_RUTA      -> 400: Google respondio bien y no hay ruta posible.
// `detalle` es para el log (nunca lleva la key); el mensaje es el de la API.
export class ErrorMaps extends ErrorNegocio {
  constructor(tipo, { mensaje, detalle } = {}) {
    const esSinRuta = tipo === 'SIN_RUTA';
    super(esSinRuta ? 400 : 503, mensaje ?? (esSinRuta ? MENSAJE_SIN_RUTA : MENSAJE_NO_DISPONIBLE));
    this.tipo = tipo;
    this.detalle = detalle ?? null;
  }
}

export const noDisponible = (detalle) => new ErrorMaps('NO_DISPONIBLE', { detalle });
export const sinRuta = (detalle) => new ErrorMaps('SIN_RUTA', { detalle });

// Error de fetch (timeout de AbortSignal.timeout, red caida, DNS) -> 503.
export function errorDeRed(err) {
  if (err instanceof ErrorMaps) return err;
  const esTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return noDisponible(esTimeout ? 'timeout' : `red: ${err?.message ?? err}`);
}

// Respuesta HTTP no-2xx de Google -> SIEMPRE 503. Un 400 de Google (p. ej.
// departureTime pasado) es un bug nuestro, no un problema del usuario: no hay
// nada que el usuario pueda corregir, asi que tampoco es un 400 nuestro.
export function errorDesdeHttp(status, cuerpo) {
  const mensaje = cuerpo?.error?.message ?? cuerpo?.error_message ?? '';
  return noDisponible(`HTTP ${status}${mensaje ? `: ${mensaje}` : ''}`);
}

// ─── Unidades ────────────────────────────────────────────────────────────────

// Duration de Routes API: segundos con hasta 9 decimales terminado en "s"
// ("123s", "3.5s"). Cualquier otra cosa tira: preferimos un 503 a una duracion
// inventada.
export function duracionASegundos(valor) {
  if (typeof valor !== 'string' || !/^\d+(\.\d+)?s$/.test(valor)) {
    throw noDisponible(`duracion ilegible: ${JSON.stringify(valor)}`);
  }
  return Number(valor.slice(0, -1));
}

export function metrosAKm(metros) {
  if (typeof metros !== 'number' || !Number.isFinite(metros) || metros < 0) {
    throw noDisponible(`distancia ilegible: ${JSON.stringify(metros)}`);
  }
  return metros / 1000;
}

export const segundosAHoras = (segundos) => segundos / 3600;

// ─── Polilineas ──────────────────────────────────────────────────────────────

// Encoded polyline (formato de Google, precision 1e5) -> array de [lng, lat]
// (longitud primero), el formato que espera el front y turf.
export function decodificarPolilinea(encoded) {
  const coords = [];
  let index = 0,
    lat = 0,
    lng = 0;
  while (index < encoded.length) {
    let b,
      shift = 0,
      result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lng / 1e5, lat / 1e5]);
  }
  return coords;
}

// Concatena las polilineas de tramos consecutivos. El ultimo punto de un tramo
// y el primero del siguiente son la misma parada: si coinciden, no se repite.
export function concatenarPolilineas(polilineas) {
  const ruta = [];
  for (const tramo of polilineas) {
    for (const punto of tramo) {
      const ultimo = ruta[ruta.length - 1];
      if (ultimo && ultimo[0] === punto[0] && ultimo[1] === punto[1]) continue;
      ruta.push(punto);
    }
  }
  return ruta;
}

// Acepta { lat, lng } (body) o { latitud, longitud } (base), como zona.service.
export function coordenadas(punto) {
  const lat = punto.lat ?? punto.latitud;
  const lng = punto.lng ?? punto.longitud;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw new Error('maps: el punto debe traer lat/lng o latitud/longitud');
  }
  return { lat, lng };
}
