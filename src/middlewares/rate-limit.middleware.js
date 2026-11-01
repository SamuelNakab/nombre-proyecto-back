import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { consumirCupo, descontarCupo, borrarCupo, logSinRedis } from '../services/redis-seguro.js';

// Rate limit de la API (Tarea 6): express-rate-limit con un store propio en Redis
// (nada de queries a la DB). Si Redis no responde, FALLA ABIERTA: el store tira,
// passOnStoreError deja pasar y se loguea "[rate-limit] sin Redis" a lo sumo una
// vez por minuto. Nunca tumba la API.
//
// Variables (se leen en CADA request, salvo la ventana, que fija express-rate-limit
// al crear el limiter, o sea al arrancar):
//   RATE_LIMIT_HABILITADO               default prendido; '0' o 'false' lo apagan
//                                       (SOLO tests / local para suites sueltas)
//   RATE_LIMIT_<NOMBRE>_MAX             hits por ventana
//   RATE_LIMIT_<NOMBRE>_VENTANA_SEGUNDOS
// Basura o <= 0 -> default.

export const LIMITES = {
  GENERAL: { max: 600, ventanaSeg: 60, clave: 'ip' },
  REGISTRO: { max: 20, ventanaSeg: 3600, clave: 'ip' },
  MAPS: { max: 60, ventanaSeg: 600, clave: 'usuario' },
  SERIES: { max: 10, ventanaSeg: 3600, clave: 'usuario' },
  INVITACIONES: { max: 30, ventanaSeg: 3600, clave: 'usuario' },
  SOCKET_IP: { max: 300, ventanaSeg: 60, clave: 'ip' },
  SOCKET_USUARIO: { max: 30, ventanaSeg: 60, clave: 'usuario' },
};

export function rateLimitHabilitado(env = process.env) {
  const v = env.RATE_LIMIT_HABILITADO?.trim().toLowerCase();
  return v !== '0' && v !== 'false';
}

function entero(valor, porDefecto) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : porDefecto;
}

export const maxDe = (nombre, env = process.env) => entero(env[`RATE_LIMIT_${nombre}_MAX`], LIMITES[nombre].max);
export const ventanaSegDe = (nombre, env = process.env) =>
  entero(env[`RATE_LIMIT_${nombre}_VENTANA_SEGUNDOS`], LIMITES[nombre].ventanaSeg);

// "Probá de nuevo en 40 segundos" / "en 12 minutos".
export function mensaje429(segundos, que = 'solicitudes') {
  const s = Math.max(1, Math.ceil(segundos));
  const cuando = s < 90 ? `${s} segundo${s === 1 ? '' : 's'}` : `${Math.ceil(s / 60)} minutos`;
  return `Demasiadas ${que}. Probá de nuevo en ${cuando}.`;
}

// Store de express-rate-limit sobre consumirCupo. Una instancia por limiter
// (express-rate-limit no deja compartirlas), cada una con su prefijo.
export class StoreRedis {
  constructor(nombre) {
    this.prefix = `rl:${nombre.toLowerCase()}:`;
    this.localKeys = false;
    this.windowMs = LIMITES[nombre].ventanaSeg * 1000;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    try {
      const { hits, restanteMs } = await consumirCupo(this.prefix + key, this.windowMs);
      return { totalHits: hits, resetTime: new Date(Date.now() + restanteMs) };
    } catch (e) {
      logSinRedis('rate-limit', e.message);
      throw e;
    }
  }

  async decrement(key) {
    await descontarCupo(this.prefix + key);
  }

  async resetKey(key) {
    await borrarCupo(this.prefix + key);
  }
}

// El store ya logueo (con su limite de 1 por minuto) el "sin Redis": no repetirlo
// en cada request. El resto (validaciones de configuracion) sale normal.
const logger = {
  error: (err, mensaje) => {
    if (String(mensaje ?? '').includes('error from store')) return;
    console.error('[rate-limit]', mensaje ?? '', err?.message ?? err);
  },
  warn: (err, mensaje) => console.warn('[rate-limit]', mensaje ?? '', err?.message ?? err),
};

const claveIp = (req) => `ip:${ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? 'desconocida')}`;
// Por usuario autenticado (va despues de verificarToken); sin usuario, por IP.
const claveUsuario = (req) => (req.usuario?.id_usuario ? `u:${req.usuario.id_usuario}` : claveIp(req));

export function crearLimiter(nombre, { que = 'solicitudes' } = {}) {
  const { clave } = LIMITES[nombre];
  return rateLimit({
    windowMs: ventanaSegDe(nombre) * 1000,
    limit: () => maxDe(nombre),
    skip: () => !rateLimitHabilitado(),
    keyGenerator: clave === 'usuario' ? claveUsuario : claveIp,
    store: new StoreRedis(nombre),
    passOnStoreError: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    logger,
    handler: (req, res) => {
      const reset = req.rateLimit?.resetTime;
      const seg = reset ? (reset.getTime() - Date.now()) / 1000 : ventanaSegDe(nombre);
      res.status(429).json({ error: mensaje429(seg, que) });
    },
  });
}

// GENERAL va en app.js (despues de /health). Los demas, en las rutas: los de
// usuario DESPUES de verificarToken (y de requireMiembro, asi un no-miembro sigue
// recibiendo su 403).
export const limitarGeneral = crearLimiter('GENERAL');
export const limitarRegistro = crearLimiter('REGISTRO', { que: 'cuentas creadas desde esta conexión' });
export const limitarMaps = crearLimiter('MAPS', { que: 'solicitudes que calculan rutas' });
export const limitarSeries = crearLimiter('SERIES', { que: 'series creadas' });
export const limitarInvitaciones = crearLimiter('INVITACIONES', { que: 'invitaciones creadas' });
