import { fechaDeEstado } from './historial-estado.service.js';
import { calcularPuntualidadInicio } from './puntualidad.service.js';

// Duraciones de un viaje, y la UNICA conversion de unidades entre la base y la
// API. Existe para que no se mezclen unidades en una misma respuesta.
//
// Convencion, sin excepciones:
//   - En la BASE y en el calculo de precio, el tiempo va en HORAS (float).
//     Es lo que Google Distance Matrix devuelve y lo que consume tarifa_hora:
//     Viaje.duracion_estimada_horas, desglose.tiempo_horas, tiempo_capital.
//   - En la API, toda duracion se expone en MINUTOS (entero redondeado):
//     duracion_estimada, duracion_real, duracion_carga, duracion_descarga y
//     duracion_aproximacion_origen.
//
// OJO: desglose_estimado.tiempo_horas y duracion_estimada son el MISMO dato en
// distinta unidad — el primero es el input del calculo de precio (horas, float),
// el segundo es el valor de presentacion (minutos, entero). No confundirlos.

// Horas (float) -> minutos (entero). null/undefined pasan como null: un viaje
// creado antes de que existiera la columna no tiene estimacion guardada.
export function horasAMinutos(horas) {
  if (typeof horas !== 'number' || Number.isNaN(horas)) return null;
  return Math.round(horas * 60);
}

// Diferencia en minutos enteros entre dos instantes. null si falta alguno.
// Defensivo: un reloj corrido o datos viejos no deberian producir una duracion
// negativa. Preferimos null antes que un numero sin sentido.
function minutosEntre(desde, hasta) {
  if (desde == null || hasta == null) return null;

  const minutos = (new Date(hasta).getTime() - new Date(desde).getTime()) / 60000;
  if (minutos < 0) return null;

  return Math.round(minutos);
}

// Duracion REAL del viaje, en minutos. Se calcula en el read — no hay columna.
//
// CAMBIO DE SEMANTICA: antes se medida desde fecha_inicio, que es cuando el
// conductor arranca HACIA el origen, antes de cargar. duracion_estimada solo
// suma los tramos de manejo entre paradas, asi que los dos numeros median
// cosas distintas y no se podian comparar.
//
// Ahora se mide desde la SALIDA DEL ORIGEN: el instante de la transicion
// CARGANDO -> EN_RUTA, o sea la fila EN_RUTA del historial. El tiempo de
// aproximacion al origen y el de carga se exponen aparte
// (calcularDuracionAproximacionMinutos y calcularDuracionCargaMinutos).
//
// Fin del viaje = la ultima fecha_entrega de sus paradas. Se usa max() y NO la
// parada de mayor `orden` a proposito: el conductor confirma cada parada por
// proximidad y nada valida el orden, asi que la de mayor orden puede no ser la
// ultima en el tiempo. Confirmar la ultima parada pendiente es lo que
// dispara cerrarViaje, asi que ese maximo ES el momento del cierre.
//
// null si el viaje todavia no termino (estado distinto de FINALIZADO): una
// duracion "real" a mitad de viaje no es real. Y null para los viajes
// anteriores a este cambio, que no tienen fila EN_RUTA — a proposito: devolver
// el numero viejo seria devolver algo que ya no significa lo mismo.
//
// El viaje debe venir con `paradas` (con fecha_entrega) y con el historial.
export function calcularDuracionRealMinutos(viaje) {
  if (viaje.estado !== 'FINALIZADO') return null;

  if (viaje.paradas === undefined) {
    throw new Error(
      'calcularDuracionRealMinutos: el viaje debe venir con la relacion paradas incluida'
    );
  }

  const salidaDelOrigen = fechaDeEstado(viaje, 'EN_RUTA');
  if (salidaDelOrigen === null) return null;

  const entregas = viaje.paradas
    .map((p) => p.fecha_entrega)
    .filter((f) => f != null)
    .map((f) => new Date(f).getTime());

  if (entregas.length === 0) return null;

  return minutosEntre(salidaDelOrigen, Math.max(...entregas));
}

// Tiempo real de CARGA, en minutos: de CARGANDO a EN_RUTA. La mitad del
// "tiempo de peon" — cuanto estuvo el conductor cargando en el origen.
// null si alguna de las dos transiciones no ocurrio.
export function calcularDuracionCargaMinutos(viaje) {
  return minutosEntre(fechaDeEstado(viaje, 'CARGANDO'), fechaDeEstado(viaje, 'EN_RUTA'));
}

// Tiempo real de DESCARGA, en minutos: de DESCARGANDO a FINALIZADO. La otra
// mitad del "tiempo de peon". null si alguna de las dos transiciones no ocurrio.
export function calcularDuracionDescargaMinutos(viaje) {
  return minutosEntre(fechaDeEstado(viaje, 'DESCARGANDO'), fechaDeEstado(viaje, 'FINALIZADO'));
}

// Tiempo de APROXIMACION al origen, en minutos: de fecha_inicio (el conductor
// arranca hacia el origen) a fecha_llegada_origen (llego). Es el tramo que
// antes quedaba metido adentro de duracion_real; se expone aparte para no
// perder el dato.
//
// Solo necesita dos escalares — no requiere el historial incluido.
// null en los viajes anteriores a este cambio (sin fecha_llegada_origen).
export function calcularDuracionAproximacionMinutos(viaje) {
  if (viaje.fecha_inicio === undefined || viaje.fecha_llegada_origen === undefined) {
    throw new Error(
      'calcularDuracionAproximacionMinutos: el viaje debe traer fecha_inicio y fecha_llegada_origen'
    );
  }

  return minutosEntre(viaje.fecha_inicio, viaje.fecha_llegada_origen);
}

// Las CINCO metricas que dependen del historial de estados y/o de la llegada al
// origen, juntas. Existe para que los canales que las exponen no repitan el
// mismo bloque de cinco lineas y no se puedan desincronizar entre si.
//
// OJO con puntualidad_inicio: va DESPUES del spread de la fila cruda, para que
// pise a la columna MUERTA del mismo nombre. Ver puntualidad.service.js.
//
// Requiere que el viaje venga con `paradas` y con INCLUDE_HISTORIAL, y con los
// escalares estado, fecha_programada, fecha_inicio y fecha_llegada_origen.
// Cualquier include olvidado TIRA en vez de devolver nulls en silencio.
//
// Lo usan los SEIS canales listados en CLAUDE.md. Los endpoints que solo
// serializan la fila cruda (sin historial) no pueden usar esto: ahi va
// calcularPuntualidadInicio suelto, que solo necesita dos escalares.
export function calcularMetricasViaje(viaje) {
  return {
    duracion_real: calcularDuracionRealMinutos(viaje),
    duracion_carga: calcularDuracionCargaMinutos(viaje),
    duracion_descarga: calcularDuracionDescargaMinutos(viaje),
    duracion_aproximacion_origen: calcularDuracionAproximacionMinutos(viaje),
    puntualidad_inicio: calcularPuntualidadInicio(viaje),
  };
}
