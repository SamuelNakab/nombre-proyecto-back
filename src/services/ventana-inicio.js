// Ventana de inicio de un viaje del ciclo INTERNO, y el vencimiento que sale de
// ella. Funciones PURAS (salvo la lectura de env, que esta aparte) para poder
// testearlas sin .env.
//
// El chofer puede iniciar entre
//   fecha_programada − VENTANA_INICIO_ANTES_MINUTOS   (default 60)
//   fecha_programada + VENTANA_INICIO_DESPUES_MINUTOS (default 90)
// Un viaje a las 10:00 se inicia entre las 9:00 y las 11:30. Pasado el fin de
// la ventana, un viaje ASIGNADO o CONFIRMADO VENCE (ver vencimiento.service).
//
// VENTANA_INICIO_MINUTOS (la vieja, sin limite superior) queda REEMPLAZADA: solo
// sobrevive como fallback del iniciar LEGACY (ventanaInicioAntesMinutosLegacy).
//
// OJO: mientras la DB de Neon este compartida entre staging y produccion, las
// dos variables tienen que valer LO MISMO en los dos environments: los dos
// procesos vencen viajes de la misma base.

export const VENTANA_ANTES_DEFAULT = 60;
export const VENTANA_DESPUES_DEFAULT = 90;

// parseFloat y no parseInt: los tests usan fraccionarios (0.05 = 3 segundos).
// Basura, negativo o vacio -> default. 0 es valido (ventana que cierra justo en
// la hora programada).
const vacio = (raw) => raw === undefined || raw === null || String(raw).trim() === '';

function minutosDeEnv(raw, porDefecto) {
  if (vacio(raw)) return porDefecto;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
}

// Se leen en CADA llamada, no se cachean (mismo criterio que
// anticipacionMinimaMinutos). `env` es inyectable para los tests.
export function ventanaInicioAntesMinutos(env = process.env) {
  return minutosDeEnv(env.VENTANA_INICIO_ANTES_MINUTOS, VENTANA_ANTES_DEFAULT);
}

// SOLO para el iniciar LEGACY del marketplace: ANTES, y si no esta definida (o
// esta vacia) la vieja VENTANA_INICIO_MINUTOS, que es la que ese endpoint usaba.
// El ciclo interno NO depende de la variable reemplazada.
export function ventanaInicioAntesMinutosLegacy(env = process.env) {
  const raw = vacio(env.VENTANA_INICIO_ANTES_MINUTOS)
    ? env.VENTANA_INICIO_MINUTOS
    : env.VENTANA_INICIO_ANTES_MINUTOS;
  return minutosDeEnv(raw, VENTANA_ANTES_DEFAULT);
}

export function ventanaInicioDespuesMinutos(env = process.env) {
  return minutosDeEnv(env.VENTANA_INICIO_DESPUES_MINUTOS, VENTANA_DESPUES_DEFAULT);
}

export function configVentana(env = process.env) {
  return { antes: ventanaInicioAntesMinutos(env), despues: ventanaInicioDespuesMinutos(env) };
}

export function aperturaVentanaInicio(fechaProgramada, antesMinutos) {
  return new Date(new Date(fechaProgramada).getTime() - antesMinutos * 60000);
}

// Fin de la ventana = el momento en que un viaje ASIGNADO o CONFIRMADO vence.
export function finVentanaInicio(fechaProgramada, despuesMinutos) {
  return new Date(new Date(fechaProgramada).getTime() + despuesMinutos * 60000);
}

// 'ANTES' | 'DENTRO' | 'DESPUES'. Los dos bordes son inclusivos: se puede
// iniciar exactamente en la apertura y exactamente en el cierre.
export function evaluarVentanaInicio(ahora, fechaProgramada, { antes, despues }) {
  const t = new Date(ahora).getTime();
  if (t < aperturaVentanaInicio(fechaProgramada, antes).getTime()) return 'ANTES';
  if (t > finVentanaInicio(fechaProgramada, despues).getTime()) return 'DESPUES';
  return 'DENTRO';
}

// La fecha_programada a partir de la cual un viaje YA vencio: todo viaje con
// fecha_programada < este valor tiene la ventana cerrada. Es la condicion que
// van en los WHERE (vencer) y en los WHERE de confirmar/iniciar (no vencido).
export function fechaProgramadaLimiteVencimiento(ahora, despuesMinutos) {
  return new Date(new Date(ahora).getTime() - despuesMinutos * 60000);
}

// "HH:MM" en hora de Buenos Aires, para los mensajes de error.
export function horaLocal(fecha) {
  return new Date(fecha).toLocaleTimeString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
