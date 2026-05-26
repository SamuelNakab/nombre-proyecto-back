import * as turf from '@turf/turf';
import redis from '../config/redis.js';

export async function verificarParadaSospechosa(id_viaje, zona, velocidad_kmh, lat, lng, paradas) {
  if (zona === 'PROVINCIA') return { sospechosa: false };

  const umbral_vel = parseFloat(process.env.PARADA_SOSPECHOSA_VELOCIDAD_KMH || '3');
  const umbral_min = parseFloat(process.env.PARADA_SOSPECHOSA_MINUTOS || '5');

  if (velocidad_kmh < umbral_vel) {
    const contador = await redis.incr(`gps:${id_viaje}:pings_detenido`);
    const minutos_detenido = (contador * 15) / 60;

    if (minutos_detenido >= umbral_min) {
      const cercaDeParada = paradas.some((parada) => {
        const dist = turf.distance(
          [lng, lat],
          [parada.longitud, parada.latitud],
          { units: 'meters' }
        );
        return dist < 150;
      });
      if (cercaDeParada) return { sospechosa: false };
      return { sospechosa: true, minutos_detenido: Math.round(minutos_detenido) };
    }
    return { sospechosa: false };
  }

  await redis.del(`gps:${id_viaje}:pings_detenido`);
  return { sospechosa: false };
}
