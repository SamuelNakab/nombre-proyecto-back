import { Prisma } from '@prisma/client';
import { ErrorNegocio } from '../services/error-negocio.js';
import { reportarError, reportarMensaje } from '../config/sentry.js';

// Manejador GLOBAL de errores (Tarea 6). Express 5 manda aca todo lo que tira un
// handler async (y lo que relanza responderErrorNegocio). Antes no habia ninguno:
// todo terminaba en el handler por defecto de Express (500 en HTML).
//
// Regla: un input invalido NUNCA es un 500. Los 4xx no van a Sentry, con UNA
// excepcion acordada: PrismaClientValidationError va como warning, porque casi
// siempre es un input que no validamos en el borde (o un bug nuestro).

const MENSAJE_500 = 'Error interno del servidor';
const MENSAJE_503 = 'El servicio no esta disponible en este momento. Probá de nuevo en unos minutos.';

function campoDe(meta) {
  if (!meta) return null;
  const t = meta.target ?? meta.field_name ?? meta.column_name;
  if (Array.isArray(t)) return t.join(', ');
  return typeof t === 'string' ? t : null;
}

const conCampo = (texto, meta) => (campoDe(meta) ? `${texto} (${campoDe(meta)})` : texto);

// Codigos de Prisma que son culpa del input -> 400.
const PRISMA_400 = new Set(['P2006', 'P2007', 'P2009', 'P2011', 'P2012', 'P2013', 'P2019', 'P2020', 'P2023', 'P2033']);
// Base caida / pool agotado -> 503 (y a Sentry).
const PRISMA_503 = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

// Pura: que responder ante un error. -> { status, error, reportar, nivel, extra? }
export function mapearError(err) {
  if (err instanceof ErrorNegocio) {
    return { status: err.status, error: err.message, extra: err.extra, reportar: err.status >= 500, nivel: 'error' };
  }

  // body-parser (express.json).
  if (err?.type === 'entity.parse.failed') {
    return { status: 400, error: 'El cuerpo de la solicitud no es un JSON válido', reportar: false };
  }
  if (err?.type === 'entity.too.large') {
    return { status: 413, error: 'El cuerpo de la solicitud es demasiado grande', reportar: false };
  }
  if (err?.type === 'charset.unsupported' || err?.type === 'encoding.unsupported') {
    return { status: 415, error: 'Codificación del cuerpo no soportada', reportar: false };
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    return { status: 400, error: 'Algún dato de la solicitud es inválido', reportar: true, nivel: 'warning', prismaValidacion: true };
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const { code, meta } = err;
    if (code === 'P2000') return { status: 400, error: conCampo('Un valor es demasiado largo', meta), reportar: false };
    if (code === 'P2002') return { status: 409, error: conCampo('Ya existe un registro con ese valor', meta), reportar: false };
    if (code === 'P2003') {
      return { status: 409, error: conCampo('La referencia no existe o el registro esta en uso', meta), reportar: false };
    }
    if (code === 'P2025' || code === 'P2001' || code === 'P2015' || code === 'P2018') {
      return { status: 404, error: 'No encontrado', reportar: false };
    }
    if (code === 'P2034') return { status: 409, error: 'Conflicto con otra operación, probá de nuevo', reportar: false };
    if (PRISMA_400.has(code)) return { status: 400, error: 'Algún dato de la solicitud es inválido', reportar: false };
    if (PRISMA_503.has(code)) return { status: 503, error: MENSAJE_503, reportar: true, nivel: 'error' };
    return { status: 500, error: MENSAJE_500, reportar: true, nivel: 'error' };
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return { status: 503, error: MENSAJE_503, reportar: true, nivel: 'error' };
  }

  // Otros middlewares que traen su status (http-errors).
  const status = Number(err?.status ?? err?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return { status, error: 'La solicitud es inválida', reportar: false };
  }

  return { status: 500, error: MENSAJE_500, reportar: true, nivel: 'error' };
}

// Ruta patron (/api/viajes/:id), no la URL con ids ni query.
export const rutaDe = (req) => (req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : req.path);

// Express lo reconoce como manejador de errores por la aridad (4 parametros).
export function manejarErrores(err, req, res, next) {
  const r = mapearError(err);
  const ruta = rutaDe(req);
  const opciones = { contexto: 'express', nivel: r.nivel, usuario: req.usuario, tags: { metodo: req.method, ruta } };

  if (r.prismaValidacion) {
    // El mensaje de Prisma trae los argumentos de la query: ni al log ni a Sentry.
    console.error(`[errores] PrismaClientValidationError en ${req.method} ${ruta} (input sin validar en el borde)`);
    reportarMensaje(`PrismaClientValidationError en ${req.method} ${ruta}`, opciones);
  } else if (r.reportar) {
    console.error(`[errores] ${r.status} en ${req.method} ${ruta}:`, err);
    reportarError(err, opciones);
  }

  if (res.headersSent) return next(err);
  res.status(r.status).json({ error: r.error, ...(r.extra ?? {}) });
}

// 404 JSON para rutas que no existen (mismo cuerpo que el de los flags).
export function rutaNoEncontrada(_req, res) {
  res.status(404).json({ error: 'No encontrado' });
}
