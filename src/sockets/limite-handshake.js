import { consumirCupo, logSinRedis } from '../services/redis-seguro.js';
import { maxDe, ventanaSegDe, rateLimitHabilitado, mensaje429 } from '../middlewares/rate-limit.middleware.js';

// Rate limit del HANDSHAKE de socket.io (Tarea 6). El limiter de Express no lo
// cubre: engine.io atiende /socket.io/ antes que Express.
//
// - SOCKET_IP (300 / min por IP, antes de autenticar): umbral pensado para CGNAT.
//   Un celular con señal intermitente reintenta con el backoff por defecto de
//   socket.io (1 a 5 s): ~12 handshakes/min como mucho. 300 = 25 celulares en loop
//   detras de la misma IP de la telefonica, o 300 clientes reconectandose juntos
//   despues de un deploy. Solo frena una rafaga sostenida de mas de 5 por segundo.
// - SOCKET_USUARIO (30 / min por uid de Firebase, despues de verifyIdToken y
//   antes de la DB, ver auth.socket.js): un usuario tiene 1 a 3 conexiones; 30
//   seguidas es un cliente en loop, no CGNAT.
//
// El rechazo es identificable: err.message === 'RATE_LIMIT' y err.data =
// { retryAfter, error }. OJO: un rechazo del middleware NO reconecta solo en el
// cliente: mobile tiene que reintentar ante connect_error (ver API.md).
// Sin Redis: falla abierta, como el limiter de Express.

export function errorRateLimit(retryAfter) {
  const e = new Error('RATE_LIMIT');
  e.data = { retryAfter, error: mensaje429(retryAfter, 'conexiones') };
  return e;
}

// -> { permitido: true } | { permitido: false, retryAfter }
export async function consumirHandshake(nombre, clave, env = process.env) {
  if (!rateLimitHabilitado(env)) return { permitido: true };
  const ventanaMs = ventanaSegDe(nombre, env) * 1000;
  try {
    const { hits, restanteMs } = await consumirCupo(`rl:${nombre.toLowerCase()}:${clave}`, ventanaMs);
    if (hits <= maxDe(nombre, env)) return { permitido: true };
    return { permitido: false, retryAfter: Math.max(1, Math.ceil(restanteMs / 1000)) };
  } catch (e) {
    logSinRedis('rate-limit', e.message);
    return { permitido: true };
  }
}

// La misma IP que req.ip con `trust proxy` = TRUST_PROXY saltos (el handshake no
// pasa por Express): el valor N-esimo desde la derecha de X-Forwarded-For.
export function ipDeHandshake(req, env = process.env) {
  const saltos = saltosProxy(env);
  const xff = req?.headers?.['x-forwarded-for'];
  if (saltos > 0 && xff) {
    const partes = String(xff)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (partes.length > 0) return partes[Math.max(0, partes.length - saltos)];
  }
  return req?.socket?.remoteAddress ?? 'desconocida';
}

export function saltosProxy(env = process.env) {
  const n = Number(env.TRUST_PROXY ?? 1);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

// io.use: va ANTES de autenticarSocket.
export async function limitarHandshakeIp(socket, next) {
  const r = await consumirHandshake('SOCKET_IP', ipDeHandshake(socket.request));
  return r.permitido ? next() : next(errorRateLimit(r.retryAfter));
}
