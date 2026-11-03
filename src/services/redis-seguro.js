import redis from '../config/redis.js';

// Contadores en Redis para los rate limits (canje de codigos, express-rate-limit y
// el handshake de sockets). Regla de todos: si Redis no responde se deja pasar.
// El rate limit es una defensa extra; no puede ser lo que tumbe la API.

// ioredis ENCOLA los comandos mientras reconecta: sin este chequeo, con Redis
// caido el request quedaria colgado esperando una respuesta que no llega.
export const redisListo = (cliente = redis) => cliente.status === 'ready';

export function conTimeout(promesa, ms) {
  let timer;
  const limite = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin respuesta en ${ms}ms`)), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(timer));
}

export const TIMEOUT_CUPO_MS = 500;

// Suma un hit a `clave` en una ventana fija de `ventanaMs`.
// -> { hits, restanteMs }. TIRA si Redis no esta listo o no responde: el caller
// decide (todos dejan pasar).
//
// SET NX PX crea la clave con su TTL solo la primera vez; INCR conserva el TTL. En
// un MULTI, asi una clave nunca queda sin expiracion (con INCR + EXPIRE sueltos, un
// corte entre los dos la dejaria eterna). Mismo patron que el canje.
export async function consumirCupo(clave, ventanaMs, cliente = redis) {
  if (!redisListo(cliente)) throw new Error(`Redis no disponible (status=${cliente.status})`);
  const res = await conTimeout(
    cliente.multi().set(clave, 0, 'PX', ventanaMs, 'NX').incr(clave).pttl(clave).exec(),
    TIMEOUT_CUPO_MS
  );
  if (!res || res.some(([e]) => e)) throw new Error('respuesta invalida de Redis');
  const hits = Number(res[1][1]);
  const pttl = Number(res[2][1]);
  return { hits, restanteMs: pttl > 0 ? pttl : ventanaMs };
}

export async function descontarCupo(clave, cliente = redis) {
  if (!redisListo(cliente)) return;
  try {
    await conTimeout(cliente.decr(clave), TIMEOUT_CUPO_MS);
  } catch {
    // best-effort
  }
}

export async function borrarCupo(clave, cliente = redis) {
  if (!redisListo(cliente)) return;
  try {
    await conTimeout(cliente.del(clave), TIMEOUT_CUPO_MS);
  } catch {
    // best-effort
  }
}

// Log "sin Redis" a lo sumo una vez por minuto por etiqueta: con Redis caido cada
// request lo diria.
const ultimoLog = new Map();
export function logSinRedis(etiqueta, motivo, ahora = Date.now()) {
  if (ahora - (ultimoLog.get(etiqueta) ?? 0) < 60_000) return false;
  ultimoLog.set(etiqueta, ahora);
  console.error(`[${etiqueta}] sin Redis (${motivo}): se deja pasar`);
  return true;
}
