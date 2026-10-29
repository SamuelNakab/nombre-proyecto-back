// Manejador global de errores (Tarea 6): un input invalido nunca es un 500.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const sentry = vi.hoisted(() => ({ reportarError: vi.fn(), reportarMensaje: vi.fn() }));
vi.mock('../config/sentry.js', () => sentry);

const { mapearError, manejarErrores, rutaNoEncontrada } = await import('./errores.middleware.js');
const { ErrorNegocio } = await import('../services/error-negocio.js');

const VERSION = '6.19.3';
const conocido = (code, meta) => new Prisma.PrismaClientKnownRequestError(`fallo ${code}`, { code, clientVersion: VERSION, meta });

function respuesta() {
  const res = { statusCode: null, body: undefined, headersSent: false };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  return res;
}

beforeEach(() => vi.clearAllMocks());

describe('mapearError', () => {
  it('PrismaClientValidationError -> 400, y se reporta como warning', () => {
    const r = mapearError(new Prisma.PrismaClientValidationError('Invalid `prisma.vehiculo.findUnique()` ... id_vehiculo: NaN', { clientVersion: VERSION }));
    expect(r).toMatchObject({ status: 400, error: 'Algún dato de la solicitud es inválido', reportar: true, nivel: 'warning' });
  });
  it('P2000 -> 400 con el campo', () => {
    expect(mapearError(conocido('P2000', { column_name: 'patente' }))).toMatchObject({ status: 400, error: 'Un valor es demasiado largo (patente)', reportar: false });
  });
  it('P2002 -> 409 con el campo', () => {
    expect(mapearError(conocido('P2002', { target: ['patente'] }))).toMatchObject({ status: 409, error: 'Ya existe un registro con ese valor (patente)', reportar: false });
  });
  it('P2003 -> 409', () => {
    expect(mapearError(conocido('P2003', { field_name: 'id_vehiculo' }))).toMatchObject({ status: 409, reportar: false });
  });
  it('P2025 -> 404', () => {
    expect(mapearError(conocido('P2025'))).toMatchObject({ status: 404, error: 'No encontrado', reportar: false });
  });
  it('P2023 / P2033 -> 400', () => {
    expect(mapearError(conocido('P2023')).status).toBe(400);
    expect(mapearError(conocido('P2033')).status).toBe(400);
  });
  it('P2034 (conflicto de transaccion) -> 409', () => {
    expect(mapearError(conocido('P2034'))).toMatchObject({ status: 409, reportar: false });
  });
  it('base caida (P1001, P2024, init) -> 503 y se reporta', () => {
    expect(mapearError(conocido('P1001'))).toMatchObject({ status: 503, reportar: true });
    expect(mapearError(conocido('P2024'))).toMatchObject({ status: 503, reportar: true });
    expect(mapearError(new Prisma.PrismaClientInitializationError('no llega', VERSION))).toMatchObject({ status: 503, reportar: true });
  });
  it('un codigo de Prisma desconocido -> 500', () => {
    expect(mapearError(conocido('P2999'))).toMatchObject({ status: 500, reportar: true });
  });
  it('JSON mal formado -> 400; body enorme -> 413', () => {
    expect(mapearError(Object.assign(new SyntaxError('Unexpected token'), { type: 'entity.parse.failed', status: 400 }))).toMatchObject({
      status: 400,
      error: 'El cuerpo de la solicitud no es un JSON válido',
      reportar: false,
    });
    expect(mapearError({ type: 'entity.too.large', status: 413 })).toMatchObject({ status: 413, reportar: false });
  });
  it('ErrorNegocio -> su status; 5xx se reporta', () => {
    expect(mapearError(new ErrorNegocio(409, 'ya'))).toMatchObject({ status: 409, error: 'ya', reportar: false });
    expect(mapearError(new ErrorNegocio(503, 'Google'))).toMatchObject({ status: 503, reportar: true });
  });
  it('un 4xx de otro middleware conserva el status', () => {
    expect(mapearError({ status: 415 })).toMatchObject({ status: 415, reportar: false });
  });
  it('cualquier otro error -> 500 y se reporta', () => {
    expect(mapearError(new TypeError("Cannot read properties of undefined (reading 'message')"))).toMatchObject({
      status: 500,
      error: 'Error interno del servidor',
      reportar: true,
    });
  });
});

describe('manejarErrores', () => {
  const req = { method: 'PUT', baseUrl: '/api/conductores', route: { path: '/mis-vehiculos/:id' }, usuario: { id_usuario: 9, rol: 'CONDUCTOR', email: 'x@y.com' } };

  it('Prisma validation: 400 al cliente y a Sentry SIN el mensaje de Prisma', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = respuesta();
    manejarErrores(new Prisma.PrismaClientValidationError('args: { email: "a@b.com" }', { clientVersion: VERSION }), req, res, vi.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Algún dato de la solicitud es inválido' });
    expect(sentry.reportarError).not.toHaveBeenCalled();
    expect(sentry.reportarMensaje).toHaveBeenCalledTimes(1);
    const [mensaje, opciones] = sentry.reportarMensaje.mock.calls[0];
    expect(mensaje).toBe('PrismaClientValidationError en PUT /api/conductores/mis-vehiculos/:id');
    expect(opciones.nivel).toBe('warning');
    expect(String(errSpy.mock.calls)).not.toContain('a@b.com');
    errSpy.mockRestore();
  });
  it('un 4xx no va a Sentry', () => {
    const res = respuesta();
    manejarErrores(conocido('P2002', { target: ['patente'] }), req, res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(sentry.reportarError).not.toHaveBeenCalled();
    expect(sentry.reportarMensaje).not.toHaveBeenCalled();
  });
  it('un 500 va a Sentry con la ruta patron', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = respuesta();
    const err = new Error('boom');
    manejarErrores(err, req, res, vi.fn());
    expect(res.statusCode).toBe(500);
    expect(sentry.reportarError).toHaveBeenCalledWith(err, expect.objectContaining({ tags: { metodo: 'PUT', ruta: '/api/conductores/mis-vehiculos/:id' } }));
    errSpy.mockRestore();
  });
  it('con la respuesta ya enviada delega a Express', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = { ...respuesta(), headersSent: true };
    const next = vi.fn();
    const err = new Error('tarde');
    manejarErrores(err, req, res, next);
    expect(next).toHaveBeenCalledWith(err);
    errSpy.mockRestore();
  });
  it('ruta inexistente -> 404 JSON', () => {
    const res = respuesta();
    rutaNoEncontrada({}, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'No encontrado' });
  });
});
