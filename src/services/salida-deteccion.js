// DETECCION DE SALIDA de una parada por GPS (Tarea 5). PURO: la distancia del
// ping a la parada la calcula el caller (salida-deteccion.service, con la MISMA
// distanciaMetros de parada.service), y `ahora` y la config se inyectan.
//
// Regla: con la llegada a la parada ya confirmada (llegada_real), si el chofer
// esta a mas de SALIDA_DETECCION_METROS durante SALIDA_DETECCION_SEGUNDOS
// seguidos, la salida queda "detectada" con la hora del PRIMER ping afuera. Un
// ping de vuelta adentro antes de cumplirse el tiempo resetea la deteccion.
//
// Solo cuentan los pings con timestamp POSTERIOR a llegada_real. El timestamp es
// del celular: uno que viene mas de TOLERANCIA_FUTURO_MS adelantado respecto del
// server se descarta (no se puede adelantar la deteccion mandando pings del
// futuro).
//
// El estado intermedio ({ id_parada, fuera_desde, ultimo_ts }) vive en Redis;
// esta funcion solo dice cual es el estado nuevo.

export const SALIDA_METROS_DEFAULT = 500;
export const SALIDA_SEGUNDOS_DEFAULT = 240;
export const TOLERANCIA_FUTURO_MS = 60_000;

const vacio = (raw) => raw === undefined || raw === null || String(raw).trim() === '';

function positivoDeEnv(raw, porDefecto) {
  if (vacio(raw)) return porDefecto;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}

// Se lee en CADA ping. Basura o <= 0 -> default.
export function configDeteccion(env = process.env) {
  return {
    metros: positivoDeEnv(env.SALIDA_DETECCION_METROS, SALIDA_METROS_DEFAULT),
    segundos: positivoDeEnv(env.SALIDA_DETECCION_SEGUNDOS, SALIDA_SEGUNDOS_DEFAULT),
  };
}

// true si en esta parada todavia se puede detectar la salida.
export const paradaDetectable = (parada) =>
  Boolean(parada?.llegada_real) && !parada.salida_real && !parada.salida_detectada;

// estado:  lo guardado en Redis (o null).
// ping:    { ts (ms, del celular), distancia_metros (a la parada) }.
// parada:  { id_parada, llegada_real, salida_real, salida_detectada }.
// Devuelve { estado, detectada }:
//   estado     lo que hay que guardar (null = borrar la key).
//   detectada  Date con la hora del primer ping afuera, o null.
export function evaluarPingSalida(estado, ping, parada, { metros, segundos, ahora }) {
  if (!paradaDetectable(parada)) return { estado: null, detectada: null };

  // El estado guardado es de otra parada (ya salio de aquella): de cero.
  const previo = estado?.id_parada === parada.id_parada ? estado : null;
  const ignorar = { estado: previo, detectada: null };

  const ts = ping.ts;
  if (!Number.isFinite(ts)) return ignorar;
  if (ts > new Date(ahora).getTime() + TOLERANCIA_FUTURO_MS) return ignorar;
  if (ts <= new Date(parada.llegada_real).getTime()) return ignorar;
  // Desordenado respecto de la racha que se esta midiendo.
  if (previo && ts <= previo.ultimo_ts) return ignorar;

  // Adentro (o justo en el borde): reset.
  if (!(ping.distancia_metros > metros)) return { estado: null, detectada: null };

  const fuera_desde = previo?.fuera_desde ?? ts;
  if (ts - fuera_desde >= segundos * 1000) {
    return { estado: null, detectada: new Date(fuera_desde) };
  }
  return { estado: { id_parada: parada.id_parada, fuera_desde, ultimo_ts: ts }, detectada: null };
}
