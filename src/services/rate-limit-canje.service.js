import redis from '../config/redis.js';
import { intentosMaxCanje, ventanaCanjeMinutos } from './invitacion.service.js';

// Rate limit del canje de codigos: INVITACION_INTENTOS_MAX intentos cada
// INVITACION_VENTANA_MINUTOS, por usuario Y por IP. Cuenta CADA intento (bueno o
// malo): la idea es frenar a quien prueba codigos al voleo.
//
// Si Redis no responde se deja pasar y se loguea. El rate limit es una defensa
// extra (el codigo tiene 31^10 combinaciones); no puede ser lo que tumbe el
// canje si se cae Redis.

const TIMEOUT_REDIS_MS = 1000;

// La IP real del cliente. En Railway el request llega por un proxy que AGREGA la
// IP que vio al final de X-Forwarded-For; lo de adelante lo puede mandar el
// cliente, asi que se toma el ultimo valor. Sin header (local), el socket.
// No se usa `trust proxy` para no cambiar req.ip en toda la app.
export function ipDelRequest(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const partes = String(xff)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (partes.length > 0) return partes[partes.length - 1];
  }
  return req.socket?.remoteAddress ?? 'desconocida';
}

export const claveUsuario = (id_usuario) => `invitacion:canje:usuario:${id_usuario}`;
export const claveIp = (ip) => `invitacion:canje:ip:${ip}`;

function conTimeout(promesa, ms) {
  let timer;
  const limite = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin respuesta en ${ms}ms`)), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(timer));
}

// -> { permitido: boolean }. Suma un intento a las dos claves.
export async function consumirIntentoCanje({ id_usuario, ip }) {
  // ioredis encola los comandos mientras reconecta: sin este chequeo, con Redis
  // caido el request quedaria colgado esperando una respuesta que no llega.
  if (redis.status !== 'ready') {
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
        .exec(),
      TIMEOUT_REDIS_MS
    );
    const intentosUsuario = res[1][1];
    const intentosIp = res[3][1];
    return { permitido: intentosUsuario <= max && intentosIp <= max };
  } catch (e) {
    console.error(`[invitaciones] rate limit sin Redis (${e.message}): se deja pasar el canje`);
    return { permitido: true };
  }
}
