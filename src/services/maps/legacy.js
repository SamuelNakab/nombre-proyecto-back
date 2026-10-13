// Proveedor LEGACY: Directions API (la vieja). ROLLBACK TEMPORAL detras de
// MAPS_PROVIDER=legacy, por si Routes API falla en produccion. Se borra cuando
// Routes lleve 1 a 2 semanas estable en produccion.
//
// Mismo contrato que routes.js (arma pedidos y lee respuestas, sin fetch): las
// tres operaciones salen de Directions. Distance Matrix ya no se usa.
// OJO: aca la key va en la QUERY STRING. index.js nunca loguea la URL.
import {
  coordenadas,
  decodificarPolilinea,
  metrosAKm,
  noDisponible,
  segundosAHoras,
  sinRuta,
} from './comun.js';

const URL_DIRECTIONS = 'https://maps.googleapis.com/maps/api/directions/json';
const MARGEN_SALIDA_MS = 60_000;

const latLng = (punto) => {
  const { lat, lng } = coordenadas(punto);
  return `${lat},${lng}`;
};

function pedido(apiKey, params) {
  const url = new URL(URL_DIRECTIONS);
  for (const [k, v] of Object.entries({ ...params, mode: 'driving', language: 'es', units: 'metric' })) {
    url.searchParams.set(k, String(v));
  }
  url.searchParams.set('key', apiKey);
  return { sku: 'LEGACY', url: url.toString(), init: { method: 'GET' } };
}

// status OK -> la primera ruta; ZERO_RESULTS / NOT_FOUND -> SIN_RUTA; el resto
// (REQUEST_DENIED, OVER_QUERY_LIMIT, UNKNOWN_ERROR...) -> 503.
function primeraRuta(cuerpo) {
  const status = cuerpo?.status;
  if (status === 'ZERO_RESULTS' || status === 'NOT_FOUND') throw sinRuta(status);
  if (status !== 'OK') {
    throw noDisponible(`status ${status}${cuerpo?.error_message ? `: ${cuerpo.error_message}` : ''}`);
  }
  const ruta = cuerpo.routes?.[0];
  if (!ruta?.legs?.length) throw sinRuta('routes vacio');
  return ruta;
}

const departure = (salida, ahora) =>
  salida && salida.getTime() > ahora.getTime() + MARGEN_SALIDA_MS
    ? Math.floor(salida.getTime() / 1000)
    : 'now';

function leerLeg(cuerpo) {
  const ruta = primeraRuta(cuerpo);
  const leg = ruta.legs[0];
  const segundos = leg.duration_in_traffic?.value ?? leg.duration?.value;
  if (typeof segundos !== 'number') throw noDisponible('leg sin duration');
  return { ruta, leg, segundos };
}

export const pedidoTramo = ({ origen, destino, salida, ahora, apiKey }) =>
  pedido(apiKey, { origin: latLng(origen), destination: latLng(destino), departure_time: departure(salida, ahora) });

export function leerTramo(cuerpo) {
  const { ruta, leg, segundos } = leerLeg(cuerpo);
  const encoded = ruta.overview_polyline?.points;
  return {
    distancia_km: metrosAKm(leg.distance?.value ?? 0),
    manejo_horas: segundosAHoras(segundos),
    polilinea: encoded ? decodificarPolilinea(encoded) : [],
  };
}

export const pedidoEta = ({ origen, destino, apiKey }) =>
  pedido(apiKey, { origin: latLng(origen), destination: latLng(destino), departure_time: 'now' });

export function leerEta(cuerpo) {
  const { leg, segundos } = leerLeg(cuerpo);
  return { segundos: Math.round(segundos), distancia_metros: Math.round(leg.distance?.value ?? 0) };
}

export function pedidoRuta({ puntos, apiKey }) {
  const intermedios = puntos.slice(1, -1).map(latLng).join('|');
  return pedido(apiKey, {
    origin: latLng(puntos[0]),
    destination: latLng(puntos[puntos.length - 1]),
    ...(intermedios ? { waypoints: intermedios } : {}),
  });
}

export function leerRuta(cuerpo) {
  const encoded = primeraRuta(cuerpo).overview_polyline?.points;
  if (!encoded) throw noDisponible('ruta sin polilinea');
  return decodificarPolilinea(encoded);
}
