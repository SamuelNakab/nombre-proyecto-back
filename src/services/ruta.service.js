import prisma from '../config/prisma.js';
import { guardarRuta, obtenerRuta } from './gps.service.js';

// Servicio de ruta planeada del viaje. La ruta es un array de puntos [lng, lat]
// (orden longitud, latitud) trazado por Google Maps Directions desde la primera
// parada hasta la ultima, con las intermedias como waypoints. Se cachea en
// Redis (gps:{id_viaje}:ruta) y se sirve al front al crear el viaje, al asignar
// conductor y al consultar el detalle.

function decodificarPolilinea(encoded) {
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;
    coords.push([lng / 1e5, lat / 1e5]);
  }
  return coords;
}

// Ruta recta entre paradas (modo degradado cuando no hay Maps).
export function obtenerRutaMock(paradas) {
  return paradas.map((p) => [p.longitud, p.latitud]);
}

// Estricta: pide la ruta a Directions y TIRA error si no hay key o la API no
// responde OK. No cae al mock — el llamador decide que hacer con el fallo.
export async function obtenerRutaDesdeDirections(paradas) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('Sin GOOGLE_MAPS_API_KEY');

  const origen = paradas[0];
  const destino = paradas[paradas.length - 1];
  const waypoints = paradas
    .slice(1, -1)
    .map((p) => `${p.latitud},${p.longitud}`)
    .join('|');

  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
  url.searchParams.set('origin', `${origen.latitud},${origen.longitud}`);
  url.searchParams.set('destination', `${destino.latitud},${destino.longitud}`);
  if (waypoints) url.searchParams.set('waypoints', waypoints);
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('key', apiKey);

  const response = await fetch(url.toString());
  const data = await response.json();

  if (data.status !== 'OK') throw new Error(data.error_message || data.status);
  const polilinea = data.routes?.[0]?.overview_polyline?.points;
  if (!polilinea) throw new Error('Sin polilinea en la respuesta');
  return decodificarPolilinea(polilinea);
}

// Con fallback a linea recta: nunca tira error. La usa el recalculo por desvio,
// donde una ruta degradada es preferible a ninguna.
export async function obtenerRutaOptima(paradas) {
  try {
    return await obtenerRutaDesdeDirections(paradas);
  } catch (err) {
    console.error('[ruta.service] Directions fallo — usando ruta recta mock:', err.message);
    return obtenerRutaMock(paradas);
  }
}

// Calcula la ruta planeada del viaje y la guarda en Redis. TIRA error si la API
// falla o el viaje no tiene suficientes paradas — el llamador (creacion del
// viaje) lo cachea como ruta_planeada = null y se reintenta en el primer ping.
export async function calcularYGuardarRuta(id_viaje) {
  const paradas = await prisma.parada.findMany({
    where: { id_viaje },
    orderBy: { orden: 'asc' },
  });
  if (paradas.length < 2) throw new Error('El viaje no tiene suficientes paradas para una ruta');

  const ruta = await obtenerRutaDesdeDirections(paradas);
  await guardarRuta(id_viaje, ruta);
  return ruta;
}

// Lee la ruta planeada cacheada en Redis. Solo LEE: devuelve null si no existe
// (por ejemplo viaje finalizado/cancelado con Redis ya limpio). No recalcula.
export async function obtenerRutaPlaneada(id_viaje) {
  return obtenerRuta(id_viaje);
}
