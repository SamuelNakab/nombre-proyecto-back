export async function calcularETA(conductorLat, conductorLng, destinoLat, destinoLng) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    console.warn('[eta.service] Sin GOOGLE_MAPS_API_KEY — usando ETA mock (15 min)');
    return {
      eta_minutos: 15,
      eta_timestamp: new Date(Date.now() + 15 * 60 * 1000),
    };
  }

  try {
    const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
    url.searchParams.set('origins', `${conductorLat},${conductorLng}`);
    url.searchParams.set('destinations', `${destinoLat},${destinoLng}`);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('departure_time', 'now');
    url.searchParams.set('traffic_model', 'best_guess');
    url.searchParams.set('key', apiKey);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.status !== 'OK') throw new Error(data.status);
    const element = data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== 'OK') throw new Error(element?.status || 'ELEMENT_NOT_FOUND');

    const segundos = element.duration_in_traffic?.value ?? element.duration.value;
    const eta_minutos = Math.round(segundos / 60);
    return {
      eta_minutos,
      eta_timestamp: new Date(Date.now() + eta_minutos * 60 * 1000),
    };
  } catch (err) {
    console.error('[eta.service] Error al calcular ETA — usando mock:', err.message);
    return {
      eta_minutos: 15,
      eta_timestamp: new Date(Date.now() + 15 * 60 * 1000),
    };
  }
}
