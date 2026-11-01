// Rate limit (Tarea 6): 429 con Retry-After y mensaje en español, apagado con
// RATE_LIMIT_HABILITADO=0, y FALLA ABIERTA sin Redis. Redis falso en memoria.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

const fake = vi.hoisted(() => {
  const datos = new Map(); // clave -> { v, vence }
  const vivo = (k) => {
    const e = datos.get(k);
    if (e && e.vence <= Date.now()) datos.delete(k);
    return datos.get(k);
  };
  const cliente = {
    status: 'ready',
    colgado: false,
    datos,
    on: () => {},
    multi() {
      const ops = [];
      const m = {
        set: (k, v, _px, ms) => (ops.push(() => (vivo(k) ? null : (datos.set(k, { v: Number(v), vence: Date.now() + ms }), 'OK'))), m),
        incr: (k) => (ops.push(() => ++vivo(k).v), m),
        pttl: (k) => (ops.push(() => (vivo(k) ? vivo(k).vence - Date.now() : -2)), m),
        exec: () => (cliente.colgado ? new Promise(() => {}) : Promise.resolve(ops.map((f) => [null, f()]))),
      };
      return m;
    },
    decr: async (k) => (vivo(k) ? --vivo(k).v : 0),
    del: async (k) => datos.delete(k),
  };
  return cliente;
});
vi.mock('../config/redis.js', () => ({ default: fake }));

const { limitarGeneral, mensaje429, rateLimitHabilitado, maxDe } = await import('./rate-limit.middleware.js');

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(limitarGeneral);
  app.get('/x', (_req, res) => res.json({ ok: true }));
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  fake.datos.clear();
  fake.status = 'ready';
  fake.colgado = false;
  process.env.RATE_LIMIT_GENERAL_MAX = '3';
  delete process.env.RATE_LIMIT_HABILITADO;
});

const pedir = async (n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await fetch(`${base}/x`));
  return out;
};

describe('limiter habilitado', () => {
  it('pasado el maximo -> 429 con Retry-After y mensaje en español', async () => {
    const rs = await pedir(4);
    expect(rs.slice(0, 3).map((r) => r.status)).toEqual([200, 200, 200]);
    const r = rs[3];
    expect(r.status).toBe(429);
    const ra = Number(r.headers.get('retry-after'));
    expect(ra).toBeGreaterThan(0);
    expect(ra).toBeLessThanOrEqual(60);
    expect(r.headers.get('ratelimit-policy')).toBeTruthy();
    const body = await r.json();
    expect(body.error).toMatch(/^Demasiadas solicitudes\. Probá de nuevo en \d+ segundos?\.$/);
  });
  it('la clave vive en Redis con TTL (prefijo rl:general:)', async () => {
    await pedir(1);
    const claves = [...fake.datos.keys()];
    expect(claves).toHaveLength(1);
    expect(claves[0]).toMatch(/^rl:general:ip:/);
  });
});

describe('RATE_LIMIT_HABILITADO=0', () => {
  it('nunca da 429 ni toca Redis', async () => {
    process.env.RATE_LIMIT_HABILITADO = '0';
    const rs = await pedir(6);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(fake.datos.size).toBe(0);
    expect(rateLimitHabilitado({ RATE_LIMIT_HABILITADO: 'false' })).toBe(false);
    expect(rateLimitHabilitado({})).toBe(true);
  });
});

describe('falla abierta sin Redis', () => {
  it('Redis no ready: deja pasar y loguea una vez', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.status = 'reconnecting';
    const rs = await pedir(6);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const sinRedis = err.mock.calls.filter((c) => String(c[0]).includes('[rate-limit] sin Redis'));
    expect(sinRedis.length).toBeLessThanOrEqual(1);
    err.mockRestore();
  });
  it('Redis colgado: no se cuelga el request (timeout) y pasa', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.colgado = true;
    const t0 = Date.now();
    const [r] = await pedir(1);
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(3000);
    err.mockRestore();
  });
});

describe('helpers', () => {
  it('mensaje429', () => {
    expect(mensaje429(1)).toBe('Demasiadas solicitudes. Probá de nuevo en 1 segundo.');
    expect(mensaje429(45.2)).toBe('Demasiadas solicitudes. Probá de nuevo en 46 segundos.');
    expect(mensaje429(600, 'series creadas')).toBe('Demasiadas series creadas. Probá de nuevo en 10 minutos.');
  });
  it('maxDe: basura o <= 0 -> default', () => {
    expect(maxDe('GENERAL', { RATE_LIMIT_GENERAL_MAX: 'x' })).toBe(600);
    expect(maxDe('GENERAL', { RATE_LIMIT_GENERAL_MAX: '-3' })).toBe(600);
    expect(maxDe('REGISTRO', {})).toBe(20);
    expect(maxDe('SOCKET_IP', { RATE_LIMIT_SOCKET_IP_MAX: '50' })).toBe(50);
  });
});
