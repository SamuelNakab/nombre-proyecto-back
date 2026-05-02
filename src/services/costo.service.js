async function getDistanciaYTiempo(origenLat, origenLng, destinoLat, destinoLng) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    console.warn('[costo.service] GOOGLE_MAPS_API_KEY no configurada — usando valores mock');
    return { distancia_km: 10, tiempo_horas: 0.5 };
  }

  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  url.searchParams.set('origins', `${origenLat},${origenLng}`);
  url.searchParams.set('destinations', `${destinoLat},${destinoLng}`);
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('language', 'es');
  url.searchParams.set('units', 'metric');
  url.searchParams.set('key', apiKey);

  const response = await fetch(url.toString());
  const data = await response.json();

  if (data.status !== 'OK') {
    throw new Error(data.error_message || data.status);
  }

  const element = data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK') {
    throw new Error(element?.status || 'ELEMENT_NOT_FOUND');
  }

  return {
    distancia_km: element.distance.value / 1000,
    tiempo_horas: element.duration.value / 3600,
  };
}

export async function calcularDistanciaYTiempo(origen, destino) {
  return getDistanciaYTiempo(origen.lat, origen.lng, destino.lat, destino.lng);
}

export async function estimarCosto({ zona, paradas, tarifa_hora, tarifa_km }) {
  let distancia_total_km = 0;
  let tiempo_total_horas = 0;

  for (let i = 0; i < paradas.length - 1; i++) {
    const tramo = await calcularDistanciaYTiempo(paradas[i], paradas[i + 1]);
    distancia_total_km += tramo.distancia_km;
    tiempo_total_horas += tramo.tiempo_horas;
  }

  let precio_estimado;
  if (zona === 'CABA') {
    precio_estimado = tiempo_total_horas * tarifa_hora;
  } else if (zona === 'PROVINCIA') {
    precio_estimado = distancia_total_km * tarifa_km;
  } else {
    precio_estimado = tiempo_total_horas * tarifa_hora + distancia_total_km * tarifa_km;
  }

  return { precio_estimado, distancia_total_km, tiempo_total_horas };
}
