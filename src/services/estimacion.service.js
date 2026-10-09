// ALGORITMO DE DURACION ESTIMADA de un viaje: tramos SECUENCIALES con trafico
// segun la hora de salida de cada tramo + tiempo de PEON en cada parada.
//
// Ejemplo A -> B -> C a las 10:00 con peon 30 min:
//   peon en A 10:00-10:30; manejo A->B saliendo 10:30 (40 min) -> llega 11:10;
//   peon en B hasta 11:40; manejo B->C saliendo 11:40 (25 min) -> llega 12:05;
//   peon en C hasta 12:35. Total 2 h 35 = manejo 1 h 05 + peon 1 h 30.
//
// estimarRecorrido es PURA: la funcion de tramo se inyecta (en produccion es
// calcularTramo de la capa de Google; en los tests, una falsa). Las llamadas
// son secuenciales porque la salida de cada tramo depende de la llegada del
// anterior. Un error en cualquier tramo se propaga: nunca se completa con
// valores inventados.
//
// Unidades: horas en la base y en el calculo (convencion de duracion.service);
// la API las expone en minutos.
import { ErrorMaps, concatenarPolilineas } from './maps/comun.js';

const PEON_DEFAULT_MINUTOS = 30;

// TIEMPO_PEON_MINUTOS: tiempo de carga / descarga que se estima en CADA parada.
// Se lee en cada uso. 0 es valido (sin peon); basura o negativo -> default.
export function tiempoPeonMinutos() {
  const crudo = process.env.TIEMPO_PEON_MINUTOS;
  if (crudo === undefined || crudo.trim() === '') return PEON_DEFAULT_MINUTOS;
  const valor = Number(crudo);
  return Number.isFinite(valor) && valor >= 0 ? valor : PEON_DEFAULT_MINUTOS;
}

const HORA_MS = 3_600_000;

// paradas: [{ lat, lng } | { latitud, longitud }, ...] (>= 2), en orden.
// inicio: fecha_programada (Date). Si falta o ya paso, se arranca "ahora".
// Devuelve:
//   paradas[i]: { orden, llegada_estimada, salida_estimada, peon_estimado_horas,
//                 manejo_estimado_horas, distancia_estimada_km }
//               (manejo y distancia son del tramo que LLEGA; null en la 1)
//   totales:    { distancia_km, manejo_horas, peon_horas, total_horas,
//                 inicio_estimado, fin_estimado }
//   polilinea:  la ruta completa [lng, lat], concatenando la de cada tramo.
export async function estimarRecorrido({ paradas, inicio, peonMinutos, calcularTramo, ahora = new Date() }) {
  if (!Array.isArray(paradas) || paradas.length < 2) {
    throw new Error('estimarRecorrido: hacen falta al menos 2 paradas');
  }

  const ahoraMs = ahora.getTime();
  const inicioMs = inicio instanceof Date && inicio.getTime() > ahoraMs ? inicio.getTime() : ahoraMs;
  const peonHoras = peonMinutos / 60;
  const peonMs = peonHoras * HORA_MS;

  const resultado = [];
  const polilineas = [];
  let distancia_km = 0;
  let manejo_horas = 0;
  let llegadaMs = inicioMs;
  let tramoQueLlega = { manejo: null, distancia: null };

  for (let i = 0; i < paradas.length; i++) {
    const salidaMs = llegadaMs + peonMs;
    resultado.push({
      orden: i + 1,
      llegada_estimada: new Date(llegadaMs),
      salida_estimada: new Date(salidaMs),
      peon_estimado_horas: peonHoras,
      manejo_estimado_horas: tramoQueLlega.manejo,
      distancia_estimada_km: tramoQueLlega.distancia,
    });
    if (i === paradas.length - 1) break;

    // Routes rechaza un departureTime pasado: si la salida quedara antes de
    // "ahora", se pide con ahora (y la linea de tiempo sigue desde ahi).
    const salidaPedidoMs = Math.max(salidaMs, ahoraMs);
    let tramo;
    try {
      tramo = await calcularTramo({
        origen: paradas[i],
        destino: paradas[i + 1],
        salida: new Date(salidaPedidoMs),
        ahora,
      });
    } catch (err) {
      if (err instanceof ErrorMaps && err.tipo === 'SIN_RUTA') {
        throw new ErrorMaps('SIN_RUTA', {
          mensaje: `No hay una ruta en auto entre la parada ${i + 1} y la parada ${i + 2}. Revisá las direcciones.`,
          detalle: err.detalle,
        });
      }
      throw err;
    }

    distancia_km += tramo.distancia_km;
    manejo_horas += tramo.manejo_horas;
    polilineas.push(tramo.polilinea ?? []);
    tramoQueLlega = { manejo: tramo.manejo_horas, distancia: tramo.distancia_km };
    llegadaMs = salidaPedidoMs + tramo.manejo_horas * HORA_MS;
  }

  const peon_horas = peonHoras * paradas.length;

  return {
    paradas: resultado,
    totales: {
      distancia_km,
      manejo_horas,
      peon_horas,
      total_horas: manejo_horas + peon_horas,
      inicio_estimado: new Date(inicioMs),
      fin_estimado: resultado[resultado.length - 1].salida_estimada,
    },
    polilinea: concatenarPolilineas(polilineas),
  };
}

// Columnas del viaje a partir de los totales. duracion_estimada_horas es el
// TOTAL (manejo + peon); el precio sigue usando solo el manejo.
export function columnasEstimadasViaje(totales) {
  return {
    duracion_estimada_horas: totales.total_horas,
    manejo_estimado_horas: totales.manejo_horas,
    peon_estimado_horas: totales.peon_horas,
    distancia_estimada_km: totales.distancia_km,
  };
}

// Columnas de una parada a partir de su estimacion.
export function columnasEstimadasParada(estimada) {
  return {
    llegada_estimada: estimada.llegada_estimada,
    salida_estimada: estimada.salida_estimada,
    peon_estimado_horas: estimada.peon_estimado_horas,
    manejo_estimado_horas: estimada.manejo_estimado_horas,
    distancia_estimada_km: estimada.distancia_estimada_km,
  };
}

// Filas de Parada ya mapeadas (paradasParaCrear) + su estimacion, por indice.
export function conEstimacionPorParada(filas, recorrido) {
  return filas.map((fila, i) => ({ ...fila, ...columnasEstimadasParada(recorrido.paradas[i]) }));
}
