import { obtenerTarifas } from './tarifa.service.js';
import { clasificarZona, repartirPorZona } from './zona.service.js';
import { obtenerAcumulado } from './gps.service.js';
import { calcularTramo } from './maps/index.js';
import { estimarRecorrido, tiempoPeonMinutos } from './estimacion.service.js';
import { horasAMinutos } from './duracion.service.js';

// Estimacion de un viaje: recorrido (tramos secuenciales con trafico + peon en
// cada parada, ver estimacion.service) y precio.
//
// EL PRECIO NO CAMBIO: tarifa.service recibe lo mismo que antes, el tiempo de
// MANEJO (ahora con trafico, segun la hora de salida de cada tramo) y la
// distancia. El peon NO se cobra todavia: solo suma a la duracion.
//
// Si Google falla, tira ErrorMaps (503, o 400 si no hay ruta posible): nunca
// mas valores inventados. Va SIEMPRE antes de cualquier transaccion, asi un
// fallo no crea ni modifica nada.
//
// La zona NO se recibe por parametro: se deduce de las coordenadas de las
// paradas con clasificarZona. Lo que el cliente mande como `zona` en el body se
// ignora a proposito. Se devuelve la zona calculada para que el caller la
// persista.
export async function estimarCosto({ paradas, fecha_programada }) {
  const zona = clasificarZona(paradas);
  const fecha = new Date(fecha_programada);
  const { tarifa_hora, tarifa_km, es_hora_pico } = obtenerTarifas(zona, fecha);

  const recorrido = await estimarRecorrido({
    paradas,
    inicio: fecha,
    peonMinutos: tiempoPeonMinutos(),
    calcularTramo,
  });
  const { manejo_horas, distancia_km } = recorrido.totales;

  // Magnitudes facturables. En MIXTO esto reparte proporcionalmente en vez de
  // cobrar el tiempo total Y la distancia total (ver repartirPorZona).
  const { tiempo_capital, distancia_provincia, fraccion_caba } = repartirPorZona({
    zona,
    paradas,
    tiempo_horas: manejo_horas,
    distancia_km,
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
      // El MANEJO (input del precio). La duracion total (manejo + peon) va en
      // `estimado.total_horas` y en Viaje.duracion_estimada_horas.
      tiempo_horas: manejo_horas,
      distancia_km,
      tiempo_capital,
      distancia_provincia,
      fraccion_caba,
      tarifa_hora,
      tarifa_km,
      es_hora_pico,
    },
    // Para persistir (columnas del viaje y de cada parada) y para la ruta
    // planeada (la polilinea concatenada de los tramos).
    recorrido,
  };
}

// Lo que devuelve POST /api/viajes/estimar-costo: el resultado sin la
// polilinea, con el estimado separado en manejo y peon y el detalle por tramo
// (minutos enteros, como toda duracion de la API).
export function serializarEstimacion({ zona, precio_estimado, desglose, recorrido }) {
  const { totales } = recorrido;
  return {
    zona,
    precio_estimado,
    desglose,
    estimado: {
      manejo_horas: totales.manejo_horas,
      peon_horas: totales.peon_horas,
      total_horas: totales.total_horas,
      distancia_km: totales.distancia_km,
      inicio_estimado: totales.inicio_estimado,
      fin_estimado: totales.fin_estimado,
    },
    tramos: recorrido.paradas.map((p) => ({
      orden: p.orden,
      llegada_estimada: p.llegada_estimada,
      salida_estimada: p.salida_estimada,
      peon_estimado_min: horasAMinutos(p.peon_estimado_horas),
      manejo_estimado_min: horasAMinutos(p.manejo_estimado_horas),
      distancia_estimada_km: p.distancia_estimada_km,
    })),
  };
}

// Precio ACUMULADO de un viaje en curso, a partir del acumulado GPS en Redis.
// Estaba inline en GET /api/viajes/:id/costo-acumulado; se extrajo para que la
// ruta de la PyME (GET /api/organizaciones/:id/viajes/:idViaje/costo-acumulado)
// use el MISMO calculo. El viaje tiene que traer id_viaje, zona, tarifa_hora,
// tarifa_km y paradas (latitud, longitud).
export async function calcularCostoAcumulado(viaje) {
  const acumulado = await obtenerAcumulado(viaje.id_viaje);
  if (!acumulado) {
    return { precio_acumulado: 0, desglose: null };
  }

  // Mismo reparto que usan la estimacion y el cierre: en MIXTO se prorratea en
  // vez de cobrar el tiempo total Y la distancia total.
  const { tiempo_capital, distancia_provincia, fraccion_caba } = repartirPorZona({
    zona: viaje.zona,
    paradas: viaje.paradas,
    tiempo_horas: acumulado.tiempo_horas,
    distancia_km: acumulado.distancia_km,
  });

  const precio_por_tiempo =
    tiempo_capital === null ? null : tiempo_capital * (viaje.tarifa_hora || 0);
  const precio_por_distancia =
    distancia_provincia === null ? null : distancia_provincia * (viaje.tarifa_km || 0);
  const precio_acumulado = (precio_por_tiempo ?? 0) + (precio_por_distancia ?? 0);

  const hora = new Date().getHours();
  const es_hora_pico = (hora >= 7 && hora <= 10) || (hora >= 17 && hora <= 20);

  return {
    precio_acumulado,
    desglose: {
      precio_por_tiempo,
      precio_por_distancia,
      tiempo_horas: acumulado.tiempo_horas,
      distancia_km: acumulado.distancia_km,
      tiempo_capital,
      distancia_provincia,
      fraccion_caba,
      tarifa_hora: viaje.tarifa_hora,
      tarifa_km: viaje.tarifa_km,
      es_hora_pico,
    },
  };
}
