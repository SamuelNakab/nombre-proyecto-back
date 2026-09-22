// Puntualidad del viaje. Se calcula en el READ, no se persiste — mismo criterio
// que duracion_real (duracion.service) y vencido (vencimiento.service).
//
// CAMBIO DE SEMANTICA: antes se medida en la SALIDA (el momento en que el
// conductor apretaba "Iniciar viaje", que lo pone EN_CAMINO_A_ORIGEN) y se
// persistia en Viaje.puntualidad_inicio. Empezar a manejar hacia el origen no
// es llegar: con VENTANA_INICIO_MINUTOS=30 y PUNTUALIDAD_TARDE_MINUTOS=30 la
// banda A_TIEMPO cubria de -30 a +30 minutos alrededor de fecha_programada, y
// casi todo salia A_TIEMPO aunque el conductor llegara tarde.
//
// Ahora se mide en la LLEGADA al origen (Viaje.fecha_llegada_origen).
//
// OJO — hay dos cosas distintas con el MISMO nombre:
//   - la COLUMNA Viaje.puntualidad_inicio, que esta MUERTA (nadie la escribe ni
//     la lee; sus 254 valores viejos se midieron en la salida);
//   - el CAMPO puntualidad_inicio de las respuestas de la API, que es lo que
//     devuelve esta funcion.
// Los endpoints que serializan la fila cruda pisan la columna con este valor.

const UMBRAL_TARDE_DEFAULT = 30;
const UMBRAL_MUY_TARDE_DEFAULT = 120;

// Mismos umbrales de siempre. Se leen en CADA llamada, no se cachean en el
// modulo (mismo criterio que anticipacionMinimaMinutos).
function umbrales() {
  const tarde = Number(process.env.PUNTUALIDAD_TARDE_MINUTOS ?? UMBRAL_TARDE_DEFAULT);
  const muyTarde = Number(process.env.PUNTUALIDAD_MUY_TARDE_MINUTOS ?? UMBRAL_MUY_TARDE_DEFAULT);

  return {
    tarde: Number.isFinite(tarde) ? tarde : UMBRAL_TARDE_DEFAULT,
    muyTarde: Number.isFinite(muyTarde) ? muyTarde : UMBRAL_MUY_TARDE_DEFAULT,
  };
}

// Puntualidad de la LLEGADA al origen: 'A_TIEMPO' | 'TARDE' | 'MUY_TARDE'.
//
// null si el viaje todavia no llego al origen, o si es un viaje anterior a este
// cambio (fecha_llegada_origen null). En ese caso devuelve null SIN IMPORTAR lo
// que diga la columna vieja: ese valor se calculo con otra definicion y ya no
// es confiable.
//
// Solo necesita DOS escalares de la fila — no requiere ningun include, asi que
// se puede aplicar en cualquier endpoint que serialice un viaje.
//
// TIRA si falta alguno de los dos campos, igual que esViajeVencido: un select
// al que se le olvido fecha_llegada_origen devolveria null en silencio y toda
// la metrica de puntualidad saldria vacia sin que nadie se entere.
export function calcularPuntualidadInicio(viaje) {
  if (viaje.fecha_programada === undefined || viaje.fecha_llegada_origen === undefined) {
    throw new Error(
      'calcularPuntualidadInicio: el viaje debe traer fecha_programada y fecha_llegada_origen'
    );
  }

  if (viaje.fecha_llegada_origen === null) return null;

  const { tarde, muyTarde } = umbrales();
  const retrasoMinutos =
    (new Date(viaje.fecha_llegada_origen).getTime() -
      new Date(viaje.fecha_programada).getTime()) /
    60000;

  // Llegar ANTES de hora da retraso negativo -> A_TIEMPO.
  if (retrasoMinutos <= tarde) return 'A_TIEMPO';
  if (retrasoMinutos <= muyTarde) return 'TARDE';
  return 'MUY_TARDE';
}
