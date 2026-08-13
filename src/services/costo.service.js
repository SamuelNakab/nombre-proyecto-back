import { obtenerTarifas } from './tarifa.service.js';
import { clasificarZona, repartirPorZona } from './zona.service.js';

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

// La zona NO se recibe por parametro: se deduce de las coordenadas de las
// paradas con clasificarZona. Lo que el cliente mande como `zona` en el body se
// ignora a proposito. Se devuelve la zona calculada para que el caller la
// persista.
export async function estimarCosto({ paradas, fecha_programada }) {
  const zona = clasificarZona(paradas);
  const { tarifa_hora, tarifa_km, es_hora_pico } = obtenerTarifas(zona, new Date(fecha_programada));

  let distancia_total_km = 0;
  let tiempo_total_horas = 0;

  for (let i = 0; i < paradas.length - 1; i++) {
    const tramo = await calcularDistanciaYTiempo(paradas[i], paradas[i + 1]);
    distancia_total_km += tramo.distancia_km;
    tiempo_total_horas += tramo.tiempo_horas;
  }

  // Magnitudes facturables. En MIXTO esto reparte proporcionalmente en vez de
  // cobrar el tiempo total Y la distancia total (ver repartirPorZona).
  const { tiempo_capital, distancia_provincia, fraccion_caba } = repartirPorZona({
    zona,
    paradas,
    tiempo_horas: tiempo_total_horas,
    distancia_km: distancia_total_km,
  });

  const precio_por_tiempo = tiempo_capital === null ? null : tiempo_capital * tarifa_hora;
  const precio_por_distancia =
    distancia_provincia === null ? null : distancia_provincia * tarifa_km;
  const precio_estimado = (precio_por_tiempo ?? 0) + (precio_por_distancia ?? 0);

  return {
    zona,
    precio_estimado,
    desglose: {
      precio_por_tiempo,
      precio_por_distancia,
      tiempo_horas: tiempo_total_horas,
      distancia_km: distancia_total_km,
      tiempo_capital,
      distancia_provincia,
      fraccion_caba,
      tarifa_hora,
      tarifa_km,
      es_hora_pico,
    },
  };
}
