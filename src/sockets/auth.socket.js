import { createHash } from 'node:crypto';
import admin from '../config/firebase.js';
import prisma from '../config/prisma.js';
import { reportarError } from '../config/sentry.js';
import { consumirHandshake, errorRateLimit } from './limite-handshake.js';

// Autenticacion del handshake. Orden (Tarea 6):
// 1. verifyIdToken ANTES de cualquier query: un token invalido no toca Neon.
// 2. Limite por uid (SOCKET_USUARIO): un cliente en loop no llega a la DB.
// 3. Recien ahi el usuario en la DB.
// El resultado (uid + usuario) queda en una CACHE en memoria hasta que vence el
// token o SOCKET_AUTH_CACHE_SEGUNDOS (120), lo que pase primero: las
// reconexiones seguidas no le pegan ni a Firebase ni a la DB. No empeora la
// revocacion: verifyIdToken sin checkRevoked ya acepta un token revocado hasta
// que vence. Solo se cachean los positivos.

const CACHE_MAX = 5000;
const cache = new Map(); // sha256(token) -> { uid, usuario, expira }

export function cacheSegundos(env = process.env) {
  const n = Number(env.SOCKET_AUTH_CACHE_SEGUNDOS);
  return Number.isFinite(n) && n >= 0 ? n : 120;
}

const claveToken = (token) => createHash('sha256').update(token).digest('hex');

function leerCache(clave, ahora) {
  const e = cache.get(clave);
  if (!e) return null;
  if (e.expira <= ahora) {
    cache.delete(clave);
    return null;
  }
  return e;
}

// Sin pollers: al insertar con la cache llena se barren las vencidas y, si sigue
// llena, se saca la mas vieja (el Map conserva el orden de insercion).
function guardarCache(clave, entrada, ahora) {
  if (cache.size >= CACHE_MAX) {
    for (const [k, v] of cache) if (v.expira <= ahora) cache.delete(k);
    while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  cache.set(clave, entrada);
}

// Para los tests.
export const tamanoCacheSocket = () => cache.size;
export const vaciarCacheSocket = () => cache.clear();

export async function autenticarSocket(socket, next) {
  const raw = socket.handshake.auth?.token;
  if (!raw) {
    return next(new Error('Token no proporcionado'));
  }

  const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
  const clave = claveToken(token);
  const ahora = Date.now();
  let entrada = leerCache(clave, ahora);

  let decoded = null;
  if (!entrada) {
    try {
      decoded = await admin.auth().verifyIdToken(token);
    } catch {
      return next(new Error('Token invalido'));
    }
  }

  const uid = entrada?.uid ?? decoded.uid;
  const limite = await consumirHandshake('SOCKET_USUARIO', uid);
  if (!limite.permitido) return next(errorRateLimit(limite.retryAfter));

  if (!entrada) {
    let usuario;
    try {
      usuario = await prisma.usuario.findUnique({ where: { firebase_uid: uid } });
    } catch (err) {
      // Antes este error salia como "Token invalido": una caida de la base
      // disfrazada de token vencido.
      console.error('[Socket] no se pudo leer el usuario del handshake:', err.message);
      reportarError(err, { contexto: 'socket:handshake' });
      return next(new Error('Error interno'));
    }
    if (!usuario) {
      return next(new Error('Usuario no registrado'));
    }
    const vence = Math.min(decoded.exp * 1000, ahora + cacheSegundos() * 1000);
    entrada = { uid, usuario, expira: vence };
    if (vence > ahora) guardarCache(clave, entrada, ahora);
  }

  socket.data.usuario = entrada.usuario;
  next();
}
