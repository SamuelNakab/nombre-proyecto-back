import redis from '../config/redis.js';
import { intentosMaxCanje, ventanaCanjeMinutos } from './invitacion.service.js';
import { conTimeout, redisListo } from './redis-seguro.js';

// Rate limit del canje de codigos: INVITACION_INTENTOS_MAX intentos cada
// INVITACION_VENTANA_MINUTOS, por usuario Y por IP. Cuenta CADA intento (bueno o
// malo): la idea es frenar a quien prueba codigos al voleo.
//
// Si Redis no responde se deja pasar y se loguea. El rate limit es una defensa
// extra (el codigo tiene 31^10 combinaciones); no puede ser lo que tumbe el
// canje si se cae Redis.

const TIMEOUT_REDIS_MS = 1000;

// La IP real del cliente. Desde la Tarea 6 la app corre con `trust proxy` (1
// salto: el proxy de Railway AGREGA la IP que vio al final de X-Forwarded-For, y
// lo de adelante lo puede mandar el cliente), asi que req.ip ya es ese ultimo
// valor. Sin header (local), el socket.
export function ipDelRequest(req) {
  return req.ip ?? req.socket?.remoteAddress ?? 'desconocida';
}

export const claveUsuario = (id_usuario) => `invitacion:canje:usuario:${id_usuario}`;
export const claveIp = (ip) => `invitacion:canje:ip:${ip}`;

// -> { permitido: boolean, retryAfter?: segundos }. Suma un intento a las dos
// claves. retryAfter (para el header Retry-After) = lo que le falta a la clave que
// se paso del maximo.
export async function consumirIntentoCanje({ id_usuario, ip }) {
  // ioredis encola los comandos mientras reconecta: sin este chequeo, con Redis
  // caido el request quedaria colgado esperando una respuesta que no llega.
  if (!redisListo(redis)) {
    console.error(`[invitaciones] rate limit sin Redis (status=${redis.status}): se deja pasar el canje`);
    return { permitido: true };
  }

  const max = intentosMaxCanje();
  const segundos = Math.max(1, Math.round(ventanaCanjeMinutos() * 60));
  const kU = claveUsuario(id_usuario);
  const kI = claveIp(ip);

  try {
    // SET NX EX crea la clave con su TTL solo la primera vez; INCR conserva el
    // TTL. En un MULTI, asi una clave nunca queda sin expiracion (con
    // INCR + EXPIRE sueltos, un corte entre los dos la dejaria eterna).
    const res = await conTimeout(
      redis
        .multi()
        .set(kU, 0, 'EX', segundos, 'NX')
        .incr(kU)
        .set(kI, 0, 'EX', segundos, 'NX')
        .incr(kI)
        .pttl(kU)
        .pttl(kI)
        .exec(),
      TIMEOUT_REDIS_MS
    );
    const intentosUsuario = res[1][1];
    const intentosIp = res[3][1];
    const permitido = intentosUsuario <= max && intentosIp <= max;
    if (permitido) return { permitido };
    const ms = Math.max(intentosUsuario > max ? res[4][1] : 0, intentosIp > max ? res[5][1] : 0);
    return { permitido, retryAfter: Math.max(1, Math.ceil((ms > 0 ? ms : segundos * 1000) / 1000)) };
  } catch (e) {
    console.error(`[invitaciones] rate limit sin Redis (${e.message}): se deja pasar el canje`);
    return { permitido: true };
  }
}
