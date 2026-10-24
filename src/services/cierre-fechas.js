// FECHAS del cierre de un viaje INTERNO cuando el chofer no toca "Salir"
// (Tarea 5). Todo PURO: la config (env) y la zona horaria se inyectan, asi se
// testea sin reloj y sin .env (configCierre lee el env aparte).
//
// Definiciones:
//   - Hora prevista de fin = llegada_real a la ULTIMA parada + peon estimado de
//     esa parada. Desde ese instante la PyME puede finalizar el viaje a mano.
//   - Fin del dia = 23:59:59 America/Argentina/Buenos_Aires del dia LOCAL en que
//     se inicio el viaje.
//   - Cierre automatico = el fin del dia; salvo que el chofer ya haya llegado a
//     la ultima parada y la hora prevista de fin caiga DESPUES del fin del dia:
//     ahi es la hora prevista de fin + CIERRE_EXTENSION_MINUTOS (120).
//   - Cierre manual disponible desde = min(hora prevista de fin, salida
//     detectada por GPS de la ultima parada). null si todavia no llego a la
//     ultima.
import { partesLocales, localAUtc, ZONA_HORARIA } from './serie-fechas.js';
import { tiempoPeonMinutos } from './estimacion.service.js';

export const CIERRE_EXTENSION_DEFAULT_MINUTOS = 120;

const HORA_MS = 3_600_000;
const vacio = (raw) => raw === undefined || raw === null || String(raw).trim() === '';

// Basura o <= 0 -> default (mismo criterio que el resto de las variables).
function positivoDeEnv(raw, porDefecto) {
  if (vacio(raw)) return porDefecto;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}

// Se lee en CADA uso, no se cachea. `env` inyectable para los tests.
//   CIERRE_EXTENSION_MINUTOS      (120) margen despues de la hora prevista de fin
//                                 cuando esta cae despues del fin del dia.
//   CIERRE_FIN_DIA_SEGUNDOS_TEST  [SOLO TESTS] si esta, el "fin del dia" pasa a
//                                 ser fecha_inicio + N segundos. En produccion
//                                 NO se setea.
//   peonMinutos: el de TIEMPO_PEON_MINUTOS, solo para paradas sin peon estimado
//                (viajes anteriores al Paso 3).
export function configCierre(env = process.env) {
  return {
    tz: ZONA_HORARIA,
    extensionMinutos: positivoDeEnv(env.CIERRE_EXTENSION_MINUTOS, CIERRE_EXTENSION_DEFAULT_MINUTOS),
    finDiaSegundosTest: positivoDeEnv(env.CIERRE_FIN_DIA_SEGUNDOS_TEST, null),
    peonMinutos: tiempoPeonMinutos(),
  };
}

// La parada de mayor orden (en cualquier orden de array).
export function ultimaParada(paradas) {
  return paradas.reduce((max, p) => (max === null || p.orden > max.orden ? p : max), null);
}

// true si el chofer ya llego a la ultima parada.
export const llegoALaUltima = (paradas) => Boolean(ultimaParada(paradas)?.llegada_real);

// Fin del peon estimado de una parada: llegada_real + peon estimado. null si
// todavia no llego. Para la ultima parada, es la hora prevista de fin del viaje.
export function finPeonEstimado(parada, { peonMinutos }) {
  if (!parada?.llegada_real) return null;
  const peonHoras = parada.peon_estimado_horas ?? peonMinutos / 60;
  return new Date(new Date(parada.llegada_real).getTime() + peonHoras * HORA_MS);
}

export const horaPrevistaFin = (paradas, cfg) => finPeonEstimado(ultimaParada(paradas), cfg);

// 23:59:59 local del dia en que se inicio el viaje (o, en tests, inicio + N s).
export function finDelDia(fecha_inicio, { tz = ZONA_HORARIA, finDiaSegundosTest = null } = {}) {
  if (finDiaSegundosTest) return new Date(new Date(fecha_inicio).getTime() + finDiaSegundosTest * 1000);
  const p = partesLocales(fecha_inicio, tz);
  return localAUtc({ anio: p.anio, mes: p.mes, dia: p.dia, hora: 23, minuto: 59, segundo: 59 }, tz);
}

// Cuando se cierra solo el viaje. viaje: { fecha_inicio, paradas }.
export function momentoCierreAutomatico(viaje, cfg) {
  const fin = finDelDia(viaje.fecha_inicio, cfg);
  const prevista = horaPrevistaFin(viaje.paradas, cfg);
  if (prevista && prevista.getTime() > fin.getTime()) {
    return new Date(prevista.getTime() + cfg.extensionMinutos * 60_000);
  }
  return fin;
}

// Desde cuando la PyME puede finalizar el viaje a mano, y por que.
//   { desde: Date|null, motivo: 'TIEMPO'|'GPS'|null, hora_prevista_fin, salida_detectada }
// GPS gana el empate: si la salida se detecto antes (o en el mismo instante)
// que la hora prevista, el cierre lo habilito el GPS.
export function cierreManualDesde(paradas, cfg) {
  const ultima = ultimaParada(paradas);
  if (!ultima?.llegada_real) {
    return { desde: null, motivo: null, hora_prevista_fin: null, salida_detectada: null };
  }
  const prevista = finPeonEstimado(ultima, cfg);
  const detectada = ultima.salida_detectada ? new Date(ultima.salida_detectada) : null;
  const porGps = detectada !== null && detectada.getTime() <= prevista.getTime();
  return {
    desde: porGps ? detectada : prevista,
    motivo: porGps ? 'GPS' : 'TIEMPO',
    hora_prevista_fin: prevista,
    salida_detectada: detectada,
  };
}

// Filtro GRUESO para buscar candidatos al cierre automatico en SQL (chequeo
// perezoso): un viaje solo puede estar vencido si su fin del dia ya paso, o sea
// si se inicio ANTES del dia local que contiene a (ahora + 1 s). Devuelve ese
// limite (fecha_inicio < limite), o null si no se puede filtrar (con
// CIERRE_FIN_DIA_SEGUNDOS_TEST el "dia" dura segundos). La decision exacta la
// toma momentoCierreAutomatico (que ademas puede correrlo con la extension).
export function limiteInicioCandidatos(ahora, { tz = ZONA_HORARIA, finDiaSegundosTest = null } = {}) {
  if (finDiaSegundosTest) return null;
  const p = partesLocales(new Date(new Date(ahora).getTime() + 1000), tz);
  return localAUtc({ anio: p.anio, mes: p.mes, dia: p.dia, hora: 0, minuto: 0 }, tz);
}
