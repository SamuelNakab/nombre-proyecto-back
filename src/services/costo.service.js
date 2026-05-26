import { obtenerTarifas } from './tarifa.service.js';

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

  try {
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
  } catch (err) {
    console.warn('[costo.service] Error en Google Maps — usando mock:', err.message);
    return { distancia_km: 10, tiempo_horas: 0.5 };
  }
}

export async function calcularDistanciaYTiempo(origen, destino) {
  return getDistanciaYTiempo(origen.lat, origen.lng, destino.lat, destino.lng);
}

export async function estimarCosto({ zona, paradas, fecha_programada }) {
  const { tarifa_hora, tarifa_km, es_hora_pico } = obtenerTarifas(zona, new Date(fecha_programada));

  let distancia_total_km = 0;
  let tiempo_total_horas = 0;

  for (let i = 0; i < paradas.length - 1; i++) {
    const tramo = await calcularDistanciaYTiempo(paradas[i], paradas[i + 1]);
    distancia_total_km += tramo.distancia_km;
    tiempo_total_horas += tramo.tiempo_horas;
  }

  let precio_estimado;
  let precio_por_tiempo = null;
  let precio_por_distancia = null;

  if (zona === 'CABA') {
    precio_por_tiempo = tiempo_total_horas * tarifa_hora;
    precio_estimado = precio_por_tiempo;
  } else if (zona === 'PROVINCIA') {
    precio_por_distancia = distancia_total_km * tarifa_km;
    precio_estimado = precio_por_distancia;
  } else {
    precio_por_tiempo = tiempo_total_horas * tarifa_hora;
    precio_por_distancia = distancia_total_km * tarifa_km;
    precio_estimado = precio_por_tiempo + precio_por_distancia;
  }

  return {
    precio_estimado,
    desglose: {
      precio_por_tiempo,
      precio_por_distancia,
      tiempo_horas: tiempo_total_horas,
      distancia_km: distancia_total_km,
      tarifa_hora,
      tarifa_km,
      es_hora_pico,
    },
  };
}
