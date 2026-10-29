import 'dotenv/config';
import * as Sentry from '@sentry/node';

// Sentry, SOLO errores (Tarea 6). Va como segundo import de app.js (despues de
// dotenv), antes que express.
//
// - Sin SENTRY_DSN no se inicializa y reportarError no hace nada: tests y local
//   no mandan nada.
// - No hace falta `node --import`: eso es para la auto-instrumentacion de
//   OpenTelemetry (tracing), que no se usa. Los errores se capturan A MANO en el
//   manejador global de Express, en los handlers de socket, en los timers y en
//   process (ver instalarManejadoresProceso). Si algun dia se quiere tracing:
//   `node --import ./src/instrument.js src/app.js`.
// - Nada de datos sensibles: limpiarEvento saca headers, cuerpos, query strings y
//   tapa emails, tokens, JWTs, connection strings y keys. Del usuario, como mucho
//   id y rol.

let activo = false;

const INTEGRACIONES_FUERA = new Set([
  // Los de process los maneja instalarManejadoresProceso, con el mismo
  // comportamiento haya DSN o no (Sentry, por defecto, cambia si el proceso muere).
  'OnUncaughtException',
  'OnUnhandledRejection',
  // Breadcrumbs de consola: los logs llevan datos de viajes y de usuarios.
  'Console',
]);

export function inicializarSentry(env = process.env) {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV || 'local',
    release: env.RAILWAY_GIT_COMMIT_SHA || undefined,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    registerEsmLoaderHooks: false,
    integrations: (porDefecto) => porDefecto.filter((i) => !INTEGRACIONES_FUERA.has(i.name)),
    beforeSend: limpiarEvento,
    beforeBreadcrumb: (b) => (b.category === 'console' ? null : limpiarProfundo(b)),
  });
  activo = true;
  console.log(`[sentry] activo (environment ${env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV || 'local'})`);
  return true;
}

export const sentryActivo = () => activo;

// ─── Filtro de datos sensibles ───────────────────────────────────────────────

const PATRONES = [
  /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, // emails
  /Bearer\s+[\w.~+/=-]+/gi, // Authorization
  /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, // JWT (tokens de Firebase)
  /\b(postgres(ql)?|redis(s)?|mysql|mongodb(\+srv)?):\/\/\S+/gi, // connection strings
  /\bAIza[\w-]{20,}/g, // keys de Google
];

export function filtrarTexto(texto) {
  if (typeof texto !== 'string') return texto;
  return PATRONES.reduce((t, re) => t.replace(re, '[filtrado]'), texto);
}

function limpiarProfundo(valor, profundidad = 0) {
  if (typeof valor === 'string') return filtrarTexto(valor);
  if (!valor || typeof valor !== 'object' || profundidad > 8) return valor;
  if (Array.isArray(valor)) return valor.map((v) => limpiarProfundo(v, profundidad + 1));
  const out = {};
  for (const [k, v] of Object.entries(valor)) out[k] = limpiarProfundo(v, profundidad + 1);
  return out;
}

// beforeSend. Pura: devuelve una copia limpia del evento.
export function limpiarEvento(evento) {
  if (!evento) return evento;
  const e = limpiarProfundo(evento);
  if (e.request) {
    const { method, url } = e.request;
    // Ni headers (Authorization), ni cookies, ni body, ni query string (un filtro
    // del admin puede llevar un email). La URL, sin la query.
    e.request = { ...(method ? { method } : {}), ...(url ? { url: String(url).split('?')[0] } : {}) };
  }
  if (e.user) {
    const { id, rol } = e.user;
    e.user = { ...(id !== undefined ? { id } : {}), ...(rol !== undefined ? { rol } : {}) };
  }
  return e;
}

// ─── Captura ─────────────────────────────────────────────────────────────────

// Captura con scope LOCAL: no se usa Sentry.setUser global porque, sin la
// instrumentacion, no hay aislamiento por request y se mezclarian usuarios entre
// requests concurrentes. `usuario` = req.usuario o socket.data.usuario (solo se
// toman id_usuario y rol). Nunca tira.
export function reportarError(err, { contexto, nivel = 'error', usuario = null, tags = {}, extra = {} } = {}) {
  if (!activo) return;
  try {
    Sentry.withScope((scope) => {
      scope.setLevel(nivel);
      if (contexto) scope.setTag('contexto', contexto);
      for (const [k, v] of Object.entries(tags)) if (v !== undefined && v !== null) scope.setTag(k, String(v));
      if (usuario?.id_usuario) scope.setUser({ id: String(usuario.id_usuario), rol: usuario.rol });
      for (const [k, v] of Object.entries(extra)) scope.setExtra(k, v);
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
    });
  } catch (e) {
    console.error('[sentry] no se pudo reportar:', e.message);
  }
}

// Para un evento sin excepcion propia (p. ej. el warning de Prisma, cuyo mensaje
// original trae los argumentos de la query y NO se manda).
export function reportarMensaje(mensaje, opciones = {}) {
  reportarError(new Error(mensaje), opciones);
}

export async function vaciarSentry(ms = 2000) {
  if (!activo) return;
  try {
    await Sentry.flush(ms);
  } catch {
    // best-effort
  }
}

// unhandledRejection: log + Sentry y el proceso SIGUE (antes Node 22 lo mataba y
// se perdian los timers en memoria; los barridos los reconstruyen, pero no hace
// falta reiniciar por una promesa sin catch).
// uncaughtException: log + Sentry + exit(1): el estado puede quedar corrupto,
// Railway lo reinicia.
export function instalarManejadoresProceso(proc = process) {
  proc.on('unhandledRejection', (razon) => {
    console.error('[proceso] promesa rechazada sin catch:', razon);
    reportarError(razon, { contexto: 'unhandledRejection' });
  });
  proc.on('uncaughtException', (err) => {
    console.error('[proceso] excepcion no capturada, el proceso se reinicia:', err);
    reportarError(err, { contexto: 'uncaughtException', nivel: 'fatal' });
    vaciarSentry(2000).finally(() => proc.exit(1));
  });
}

inicializarSentry();
