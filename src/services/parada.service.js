import * as turf from '@turf/turf';
import redis from '../config/redis.js';

// Distancia en METROS entre una coordenada suelta y una parada de la base.
// Estaba inline dentro de confirmarParada; se extrajo para que la deteccion de
// llegada al origen (gps.socket.js) use la MISMA funcion y no una nueva.
//
// La usan:
//   - confirmarParada  (proximidad a la parada que se confirma)
//   - gps.socket       (llegada al origen, la parada de orden 1)
// Las DOS con RADIO_CONFIRMACION_METROS. Esa variable no se usa en ningun otro
// lado: verificarParadaSospechosa, mas abajo, comparte esta funcion pero tiene
// su propio umbral de 150m, para que los dos radios puedan cambiar por separado.
export function distanciaMetros(lat, lng, parada) {
  return turf.distance(
    turf.point([lng, lat]),
    turf.point([parada.longitud, parada.latitud]),
    { units: 'meters' }
  );
}

export async function verificarParadaSospechosa(id_viaje, zona, velocidad_kmh, lat, lng, paradas) {
  if (zona === 'PROVINCIA') return { sospechosa: false };

  const umbral_vel = parseFloat(process.env.PARADA_SOSPECHOSA_VELOCIDAD_KMH || '3');
  const umbral_min = parseFloat(process.env.PARADA_SOSPECHOSA_MINUTOS || '5');

  if (velocidad_kmh < umbral_vel) {
    const contador = await redis.incr(`gps:${id_viaje}:pings_detenido`);
    const minutos_detenido = (contador * 15) / 60;

    if (minutos_detenido >= umbral_min) {
      // Umbral propio de 150m, NO RADIO_CONFIRMACION_METROS: "estoy detenido
      // cerca de una parada, es normal" es una pregunta distinta de "llegue a
      // la parada", y los dos radios tienen que poder moverse por separado.
      const cercaDeParada = paradas.some((parada) => distanciaMetros(lat, lng, parada) < 150);
      if (cercaDeParada) return { sospechosa: false };
      return { sospechosa: true, minutos_detenido: Math.round(minutos_detenido) };
    }
    return { sospechosa: false };
  }

  await redis.del(`gps:${id_viaje}:pings_detenido`);
  return { sospechosa: false };
}
