import * as turf from '@turf/turf';

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

export function obtenerRutaMock(paradas) {
  return paradas.map((p) => [p.longitud, p.latitud]);
}

export async function obtenerRutaOptima(paradas) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn('[desvio.service] Sin GOOGLE_MAPS_API_KEY — usando ruta recta mock');
    return obtenerRutaMock(paradas);
  }

  try {
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

    if (data.status !== 'OK') throw new Error(data.status);
    const polilinea = data.routes?.[0]?.overview_polyline?.points;
    if (!polilinea) throw new Error('Sin polilinea en respuesta');
    return decodificarPolilinea(polilinea);
  } catch (err) {
    console.error('[desvio.service] Error al obtener ruta — cayendo al mock:', err.message);
    return obtenerRutaMock(paradas);
  }
}

export function verificarDesvio(lat, lng, rutaPolilinea) {
  if (rutaPolilinea.length < 2) return { desviado: false, distancia_metros: 0 };
  const punto = turf.point([lng, lat]);
  const linea = turf.lineString(rutaPolilinea);
  const cercano = turf.nearestPointOnLine(linea, punto, { units: 'meters' });
  const distancia = cercano.properties.dist;
  const umbral = parseFloat(process.env.DESVIO_UMBRAL_METROS || '300');
  return { desviado: distancia > umbral, distancia_metros: distancia };
}
