// Proveedor ROUTES API (el de produccion): computeRoutes de
// https://routes.googleapis.com. Este modulo solo ARMA los pedidos y LEE las
// respuestas (puro, sin fetch): el fetch, el timeout, el log y el contador los
// pone index.js, igual para los dos proveedores.
//
// Doc: https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes
// - X-Goog-FieldMask es OBLIGATORIO (sin default). Se pide lo minimo.
// - departureTime en el pasado da 400 en DRIVE ("Timestamp must be set to a
//   future time"); sin departureTime, Google usa la hora del pedido.
// - routes vacio (HTTP 200) = no hay ruta posible.
// SKU (https://developers.google.com/maps/documentation/routes/usage-and-billing):
// TRAFFIC_AWARE -> Pro; TRAFFIC_UNAWARE con <= 10 intermedios -> Essentials.
import {
  coordenadas,
  decodificarPolilinea,
  duracionASegundos,
  metrosAKm,
  noDisponible,
  segundosAHoras,
  sinRuta,
} from './comun.js';
import { parsearPeajes } from './peajes.js';

const URL_ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';

// Margen para mandar departureTime: si la salida es dentro del proximo minuto
// (o ya paso), no se manda y Google usa "ahora". Evita el 400 por un reloj
// corrido o por la latencia entre que se calcula la salida y llega el pedido.
const MARGEN_SALIDA_MS = 60_000;

const waypoint = (punto) => {
  const { lat, lng } = coordenadas(punto);
  return { location: { latLng: { latitude: lat, longitude: lng } } };
};

function pedido(apiKey, fieldMask, body) {
  return {
    url: URL_ROUTES,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify({ travelMode: 'DRIVE', languageCode: 'es', units: 'METRIC', ...body }),
    },
  };
}

// La primera ruta, o SIN_RUTA si Google no encontro ninguna.
function primeraRuta(cuerpo) {
  const ruta = cuerpo?.routes?.[0];
  if (!ruta) throw sinRuta('routes vacio');
  return ruta;
}

// distanceMeters es proto3: si vale 0 (origen = destino) Google lo OMITE.
const distanciaDe = (ruta) => metrosAKm(ruta.distanceMeters ?? 0);

// ─── Tramo: crear / editar / estimar (Pro) ──────────────────────────────────

export function pedidoTramo({ origen, destino, salida, ahora, apiKey }) {
  const body = {
    origin: waypoint(origen),
    destination: waypoint(destino),
    routingPreference: 'TRAFFIC_AWARE',
  };
  if (salida && salida.getTime() > ahora.getTime() + MARGEN_SALIDA_MS) {
    body.departureTime = salida.toISOString();
  }
  return {
    sku: 'PRO',
    // routes.staticDuration (manejo SIN transito) va en la misma llamada: la
    // FieldMask no es un disparador de SKU (los disparadores son features como
    // TRAFFIC_AWARE o TOLLS), asi que sigue siendo Pro.
    ...pedido(
      apiKey,
      'routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline',
      body
    ),
  };
}

export function leerTramo(cuerpo) {
  const ruta = primeraRuta(cuerpo);
  const encoded = ruta.polyline?.encodedPolyline;
  return {
    distancia_km: distanciaDe(ruta),
    manejo_horas: segundosAHoras(duracionASegundos(ruta.duration)),
    // null si Google no lo devolvio (no se inventa).
    manejo_sin_transito_horas: ruta.staticDuration ? segundosAHoras(duracionASegundos(ruta.staticDuration)) : null,
    polilinea: encoded ? decodificarPolilinea(encoded) : [],
  };
}

// ─── ETA desde una posicion (Pro, trafico de ahora) ─────────────────────────

export function pedidoEta({ origen, destino, apiKey }) {
  return {
    sku: 'PRO',
    ...pedido(apiKey, 'routes.duration,routes.distanceMeters', {
      origin: waypoint(origen),
      destination: waypoint(destino),
      routingPreference: 'TRAFFIC_AWARE',
    }),
  };
}

export function leerEta(cuerpo) {
  const ruta = primeraRuta(cuerpo);
  return {
    segundos: Math.round(duracionASegundos(ruta.duration)),
    distancia_metros: Math.round((ruta.distanceMeters ?? 0)),
  };
}

// ─── Peajes de un viaje completo (Enterprise) ───────────────────────────────
// UNA llamada por calculo: origen = primera parada, destino = ultima, el resto
// como intermedios (un leg por tramo). extraComputations TOLLS factura Compute
// Routes ENTERPRISE (el SKU mas alto: TRAFFIC_AWARE o > 10 intermedios no lo
// suben mas). TRAFFIC_AWARE + departureTime: la tarifa depende de la hora (pico /
// valle, verificado: Belgrano -> La Plata ARS 6483,84 a las 08:00 y 5187,06 a
// las 14:00) y asi la ruta coincide con la de los tramos del estimado. FieldMask
// minima: solo los tollInfo.

export function pedidoPeajes({ puntos, salida, ahora, apiKey }) {
  const intermedios = puntos.slice(1, -1);
  const body = {
    origin: waypoint(puntos[0]),
    destination: waypoint(puntos[puntos.length - 1]),
    ...(intermedios.length ? { intermediates: intermedios.map(waypoint) } : {}),
    routingPreference: 'TRAFFIC_AWARE',
    extraComputations: ['TOLLS'],
    routeModifiers: { tollPasses: ['AR_TELEPASE'] },
  };
  if (salida && salida.getTime() > ahora.getTime() + MARGEN_SALIDA_MS) {
    body.departureTime = salida.toISOString();
  }
  return {
    sku: 'ENTERPRISE',
    ...pedido(apiKey, 'routes.travelAdvisory.tollInfo,routes.legs.travelAdvisory.tollInfo', body),
  };
}

export const leerPeajes = (cuerpo) => parsearPeajes(primeraRuta(cuerpo));

// ─── Ruta de N puntos: desvio y fallback de gps.socket (Essentials) ─────────

export function pedidoRuta({ puntos, apiKey }) {
  const intermedios = puntos.slice(1, -1);
  return {
    // Mas de 10 intermedios sube a Pro aunque no haya trafico.
    sku: intermedios.length > 10 ? 'PRO' : 'ESSENTIALS',
    ...pedido(apiKey, 'routes.polyline.encodedPolyline', {
      origin: waypoint(puntos[0]),
      destination: waypoint(puntos[puntos.length - 1]),
      ...(intermedios.length ? { intermediates: intermedios.map(waypoint) } : {}),
      routingPreference: 'TRAFFIC_UNAWARE',
    }),
  };
}

export function leerRuta(cuerpo) {
  const encoded = primeraRuta(cuerpo).polyline?.encodedPolyline;
  if (!encoded) throw noDisponible('ruta sin polilinea');
  return decodificarPolilinea(encoded);
}
