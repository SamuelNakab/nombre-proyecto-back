import { fechaDeEstado } from './historial-estado.service.js';
import { calcularPuntualidadInicio } from './puntualidad.service.js';
import { cicloDe } from './estado-viaje.service.js';

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
// OJO: desde el Paso 3, desglose_estimado.tiempo_horas y duracion_estimada YA NO
// son el mismo dato: tiempo_horas es solo el MANEJO (el input del precio) y
// duracion_estimada es el TOTAL estimado, manejo + peon (ver
// estimacion.service). manejo y peon separados van en el bloque `estimado`.

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
//
// Viaje INTERNO (ciclo por parada del Paso 3): las tres duraciones salen de
// llegada_real / salida_real de las paradas, no del historial, porque
// DESCARGANDO se repite en cada parada y "su primera aparicion" ya no es la
// descarga:
//   duracion_real     = llegada a la parada 1 -> salida de la ultima (el MISMO
//                       intervalo que la duracion estimada; = real.total_horas)
//   duracion_carga    = peon de la parada 1
//   duracion_descarga = peon de la ultima parada
export function calcularMetricasViaje(viaje) {
  if (cicloDe(viaje) === 'INTERNO') {
    return {
      ...metricasInterno(viaje),
      duracion_aproximacion_origen: calcularDuracionAproximacionMinutos(viaje),
      puntualidad_inicio: calcularPuntualidadInicio(viaje),
    };
  }
  return {
    duracion_real: calcularDuracionRealMinutos(viaje),
    duracion_carga: calcularDuracionCargaMinutos(viaje),
    duracion_descarga: calcularDuracionDescargaMinutos(viaje),
    duracion_aproximacion_origen: calcularDuracionAproximacionMinutos(viaje),
    puntualidad_inicio: calcularPuntualidadInicio(viaje),
  };
}

function metricasInterno(viaje) {
  if (viaje.paradas === undefined || viaje.paradas.some((p) => p.llegada_real === undefined)) {
    throw new Error(
      'calcularMetricasViaje: un viaje interno debe venir con sus paradas (con llegada_real y salida_real)'
    );
  }
  const paradas = [...viaje.paradas].sort((a, b) => a.orden - b.orden);
  const primera = paradas[0];
  const ultima = paradas[paradas.length - 1];
  return {
    duracion_real:
      viaje.estado === 'FINALIZADO' ? minutosEntre(primera?.llegada_real, ultima?.salida_real) : null,
    duracion_carga: minutosEntre(primera?.llegada_real, primera?.salida_real),
    duracion_descarga: minutosEntre(ultima?.llegada_real, ultima?.salida_real),
  };
}

// ─── Manejo / peon (Paso 3) ──────────────────────────────────────────────────

// Bloques estimado / real de un viaje, en HORAS (los nombres llevan la unidad).
//   estimado: null en los viajes anteriores al Paso 3 (no tienen estimacion).
//   real:     null mientras el viaje no termino. En un CANCELADO en curso trae
//             lo medido hasta la cancelacion; en uno que nunca arranco, null.
// TIRA si el viaje no trae las columnas: un select al que le falten devolveria
// null en silencio.
export function bloqueTiempos(viaje) {
  if (viaje.manejo_estimado_horas === undefined || viaje.manejo_real_horas === undefined) {
    throw new Error('bloqueTiempos: el viaje debe traer las columnas de manejo / peon');
  }
  const estimado =
    viaje.manejo_estimado_horas === null
      ? null
      : {
          manejo_horas: viaje.manejo_estimado_horas,
          peon_horas: viaje.peon_estimado_horas,
          total_horas: viaje.manejo_estimado_horas + (viaje.peon_estimado_horas ?? 0),
          distancia_km: viaje.distancia_estimada_km,
        };
  const termino = viaje.estado === 'FINALIZADO' || viaje.estado === 'CANCELADO';
  const real =
    termino && viaje.manejo_real_horas !== null
      ? {
          manejo_horas: viaje.manejo_real_horas,
          peon_horas: viaje.peon_real_horas,
          total_horas: viaje.manejo_real_horas + (viaje.peon_real_horas ?? 0),
          distancia_km: viaje.distancia_real_km,
        }
      : null;
  return { estimado, real };
}

// Campos en MINUTOS de una parada (los *_horas y los timestamps vienen en la
// fila cruda). diferencia_min = llegada real - llegada estimada (positivo =
// llego tarde); null mientras no llego.
export function tiemposParada(parada) {
  const { llegada_real, llegada_estimada } = parada;
  return {
    peon_estimado_min: horasAMinutos(parada.peon_estimado_horas),
    manejo_estimado_min: horasAMinutos(parada.manejo_estimado_horas),
    peon_real_min: horasAMinutos(parada.peon_real_horas),
    manejo_real_min: horasAMinutos(parada.manejo_real_horas),
    diferencia_min:
      llegada_real && llegada_estimada
        ? Math.round((new Date(llegada_real).getTime() - new Date(llegada_estimada).getTime()) / 60000)
        : null,
  };
}

// Las paradas de un viaje con sus campos en minutos sumados.
export const paradasConTiempos = (paradas) => paradas.map((p) => ({ ...p, ...tiemposParada(p) }));
