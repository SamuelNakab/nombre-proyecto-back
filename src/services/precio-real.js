// FORMULA del precio a partir de las mediciones (tiempo y distancia). La UNICA:
// la usan el cierre (los dos ciclos) y el costo acumulado en vivo. Estaba
// duplicada en cierre.service y en costo.service; se extrajo en la Tarea 5 para
// separar la formula (que se va a reemplazar) de la logica de cierre (en que
// instante se corta la medicion: cierre-plan.js).
//
// Mismo reparto por zona que la estimacion (repartirPorZona): en MIXTO se
// prorratea tiempo y distancia por la fraccion de paradas en CABA.
import { repartirPorZona } from './zona.service.js';

// viaje: { zona, paradas: [{ latitud, longitud }], tarifa_hora, tarifa_km }
// mediciones: { tiempo_horas, distancia_km }
export function precioDesdeMediciones(viaje, { tiempo_horas, distancia_km }) {
  const { tiempo_capital, distancia_provincia, fraccion_caba } = repartirPorZona({
    zona: viaje.zona,
    paradas: viaje.paradas,
    tiempo_horas,
    distancia_km,
  });

  const precio_por_tiempo = tiempo_capital === null ? null : tiempo_capital * (viaje.tarifa_hora ?? 0);
  const precio_por_distancia =
    distancia_provincia === null ? null : distancia_provincia * (viaje.tarifa_km ?? 0);
  const precio_real = (precio_por_tiempo ?? 0) + (precio_por_distancia ?? 0);

  return { precio_real, precio_por_tiempo, precio_por_distancia, tiempo_capital, distancia_provincia, fraccion_caba };
}
