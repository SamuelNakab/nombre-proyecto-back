// Sentry (Tarea 6): no-op sin DSN y filtro de datos sensibles. SENTRY_DSN va
// vacio por vitest.config.js (aunque el .env local tenga uno).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn((fn) =>
    fn({ setLevel: vi.fn(), setTag: vi.fn(), setUser: vi.fn(), setExtra: vi.fn() })
  ),
  flush: vi.fn(async () => true),
}));
vi.mock('@sentry/node', () => sdk);

const { inicializarSentry, reportarError, sentryActivo, limpiarEvento, filtrarTexto } = await import('./sentry.js');

beforeEach(() => vi.clearAllMocks());

describe('sin SENTRY_DSN', () => {
  it('no inicializa ni manda nada', () => {
    // El import ya corrio inicializarSentry() con el env del test (sin DSN).
    expect(sentryActivo()).toBe(false);
    expect(inicializarSentry({})).toBe(false);
    expect(inicializarSentry({ SENTRY_DSN: '   ' })).toBe(false);
    reportarError(new Error('x'), { contexto: 'test' });
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.captureException).not.toHaveBeenCalled();
  });
});

describe('limpiarEvento', () => {
  const evento = {
    message: 'fallo para ana@test.com con Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJh',
    exception: {
      values: [
        {
          type: 'Error',
          value: 'no conecta a postgresql://user:pass@ep-x.neon.tech/db ni a redis://default:secreto@redis:6379 key AIzaSyA1234567890123456789012345',
        },
      ],
    },
    request: {
      method: 'POST',
      url: 'https://api.fleter/api/admin/usuarios?q=ana@test.com',
      headers: { authorization: 'Bearer abc', cookie: 'x=1' },
      cookies: { x: '1' },
      data: { contrasena: 'secreto', email: 'ana@test.com' },
      query_string: 'q=ana@test.com',
    },
    user: { id: '5', rol: 'CLIENTE', email: 'ana@test.com', ip_address: '1.2.3.4' },
    breadcrumbs: [{ category: 'http', message: 'GET /api/x token eyJaaaaaaaa.bbbbbbbbbb.cccccccccc' }],
  };

  it('saca headers, cookies, body y query; la URL sin query', () => {
    const e = limpiarEvento(evento);
    expect(e.request).toEqual({ method: 'POST', url: 'https://api.fleter/api/admin/usuarios' });
  });
  it('del usuario deja solo id y rol', () => {
    expect(limpiarEvento(evento).user).toEqual({ id: '5', rol: 'CLIENTE' });
  });
  it('tapa emails, Bearer, JWT, connection strings y keys en todo el evento', () => {
    const texto = JSON.stringify(limpiarEvento(evento));
    for (const prohibido of ['ana@test.com', 'eyJ', 'postgresql://', 'redis://', 'secreto', 'AIza', 'Bearer abc']) {
      expect(texto, prohibido).not.toContain(prohibido);
    }
    expect(texto).toContain('[filtrado]');
  });
  it('no muta el evento original', () => {
    limpiarEvento(evento);
    expect(evento.request.headers.authorization).toBe('Bearer abc');
  });
  it('filtrarTexto deja intacto lo que no es sensible', () => {
    expect(filtrarTexto('viaje 12 en EN_RUTA')).toBe('viaje 12 en EN_RUTA');
  });
});

// Al final: deja el modulo activo.
describe('con SENTRY_DSN', () => {
  it('solo errores, sin PII, environment y release de Railway', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(
      inicializarSentry({ SENTRY_DSN: 'https://k@o1.ingest.sentry.io/1', RAILWAY_ENVIRONMENT_NAME: 'staging', RAILWAY_GIT_COMMIT_SHA: 'abc1234def' })
    ).toBe(true);
    const opciones = sdk.init.mock.calls[0][0];
    expect(opciones).toMatchObject({ environment: 'staging', release: 'abc1234def', tracesSampleRate: 0, sendDefaultPii: false });
    const nombres = opciones.integrations([{ name: 'Http' }, { name: 'OnUncaughtException' }, { name: 'OnUnhandledRejection' }, { name: 'Console' }]);
    expect(nombres.map((i) => i.name)).toEqual(['Http']);
    expect(opciones.beforeBreadcrumb({ category: 'console', message: 'x' })).toBeNull();
  });
  it('reportarError: scope local con id y rol del usuario, nada mas', () => {
    const scope = { setLevel: vi.fn(), setTag: vi.fn(), setUser: vi.fn(), setExtra: vi.fn() };
    sdk.withScope.mockImplementationOnce((fn) => fn(scope));
    reportarError(new Error('boom'), { contexto: 'express', usuario: { id_usuario: 9, rol: 'CLIENTE', email: 'a@b.com', dni: '1' } });
    expect(scope.setUser).toHaveBeenCalledWith({ id: '9', rol: 'CLIENTE' });
    expect(scope.setTag).toHaveBeenCalledWith('contexto', 'express');
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
  });
});
