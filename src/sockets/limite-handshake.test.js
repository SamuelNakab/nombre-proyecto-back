// Handshake de sockets (Tarea 6): limite por IP y por uid, error RATE_LIMIT
// identificable, falla abierta sin Redis, verifyIdToken antes de la DB y cache.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fake = vi.hoisted(() => {
  const datos = new Map();
  const cliente = {
    status: 'ready',
    datos,
    on: () => {},
    multi() {
      const ops = [];
      const m = {
        set: (k, v, _px, ms) => (ops.push(() => (datos.has(k) ? null : (datos.set(k, { v: Number(v), vence: Date.now() + ms }), 'OK'))), m),
        incr: (k) => (ops.push(() => ++datos.get(k).v), m),
        pttl: (k) => (ops.push(() => datos.get(k).vence - Date.now()), m),
        exec: () => Promise.resolve(ops.map((f) => [null, f()])),
      };
      return m;
    },
  };
  return cliente;
});
const firebase = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
const prismaMock = vi.hoisted(() => ({ usuario: { findUnique: vi.fn() } }));

vi.mock('../config/redis.js', () => ({ default: fake }));
vi.mock('../config/firebase.js', () => ({ default: { auth: () => firebase } }));
vi.mock('../config/prisma.js', () => ({ default: prismaMock }));

const { limitarHandshakeIp, ipDeHandshake, consumirHandshake } = await import('./limite-handshake.js');
const { autenticarSocket, vaciarCacheSocket, tamanoCacheSocket } = await import('./auth.socket.js');

const USUARIO = { id_usuario: 5, rol: 'CONDUCTOR', firebase_uid: 'uid-5' };
const enUnaHora = () => Math.floor(Date.now() / 1000) + 3600;

const socketCon = ({ token = 'tok-a', ip = '200.1.1.1' } = {}) => ({
  handshake: { auth: { token } },
  request: { headers: { 'x-forwarded-for': `10.0.0.1, ${ip}` }, socket: { remoteAddress: '127.0.0.1' } },
  data: {},
});

async function correr(mw, socket) {
  let resultado;
  await mw(socket, (err) => (resultado = err ?? 'ok'));
  return resultado;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.datos.clear();
  fake.status = 'ready';
  vaciarCacheSocket();
  delete process.env.RATE_LIMIT_HABILITADO;
  process.env.RATE_LIMIT_SOCKET_IP_MAX = '3';
  process.env.RATE_LIMIT_SOCKET_USUARIO_MAX = '2';
  firebase.verifyIdToken.mockImplementation(async (t) => {
    if (t === 'malo') throw new Error('invalid');
    return { uid: 'uid-5', exp: enUnaHora() };
  });
  prismaMock.usuario.findUnique.mockResolvedValue(USUARIO);
});

describe('limite por IP', () => {
  it('pasado el maximo -> RATE_LIMIT con data.retryAfter', async () => {
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push(await correr(limitarHandshakeIp, socketCon()));
    expect(rs.slice(0, 3)).toEqual(['ok', 'ok', 'ok']);
    expect(rs[3]).toBeInstanceOf(Error);
    expect(rs[3].message).toBe('RATE_LIMIT');
    expect(rs[3].data.retryAfter).toBeGreaterThan(0);
    expect(rs[3].data.error).toMatch(/^Demasiadas conexiones\. Probá de nuevo en/);
    // Otra IP no se ve afectada.
    expect(await correr(limitarHandshakeIp, socketCon({ ip: '200.2.2.2' }))).toBe('ok');
  });
  it('la IP es la de trust proxy (ultimo valor de X-Forwarded-For)', () => {
    expect(ipDeHandshake(socketCon().request, {})).toBe('200.1.1.1');
    expect(ipDeHandshake(socketCon().request, { TRUST_PROXY: '0' })).toBe('127.0.0.1');
    expect(ipDeHandshake({ headers: {}, socket: { remoteAddress: '::1' } }, {})).toBe('::1');
  });
  it('sin Redis falla abierta', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.status = 'end';
    for (let i = 0; i < 6; i++) expect(await correr(limitarHandshakeIp, socketCon())).toBe('ok');
    err.mockRestore();
  });
  it('RATE_LIMIT_HABILITADO=0 no cuenta', async () => {
    process.env.RATE_LIMIT_HABILITADO = '0';
    expect(await consumirHandshake('SOCKET_IP', 'x')).toEqual({ permitido: true });
    expect(fake.datos.size).toBe(0);
  });
});

describe('autenticarSocket', () => {
  it('token invalido: no toca la DB', async () => {
    const r = await correr(autenticarSocket, socketCon({ token: 'malo' }));
    expect(r.message).toBe('Token invalido');
    expect(prismaMock.usuario.findUnique).not.toHaveBeenCalled();
  });
  it('cache: la reconexion con el mismo token no llama ni a Firebase ni a la DB', async () => {
    const s1 = socketCon();
    expect(await correr(autenticarSocket, s1)).toBe('ok');
    expect(s1.data.usuario).toEqual(USUARIO);
    const s2 = socketCon();
    expect(await correr(autenticarSocket, s2)).toBe('ok');
    expect(s2.data.usuario).toEqual(USUARIO);
    expect(firebase.verifyIdToken).toHaveBeenCalledTimes(1);
    expect(prismaMock.usuario.findUnique).toHaveBeenCalledTimes(1);
    expect(tamanoCacheSocket()).toBe(1);
  });
  it('la cache vence con el token', async () => {
    firebase.verifyIdToken.mockResolvedValue({ uid: 'uid-5', exp: Math.floor(Date.now() / 1000) - 1 });
    expect(await correr(autenticarSocket, socketCon())).toBe('ok');
    expect(await correr(autenticarSocket, socketCon())).toBe('ok');
    expect(prismaMock.usuario.findUnique).toHaveBeenCalledTimes(2);
  });
  it('limite por uid: un cliente en loop recibe RATE_LIMIT, aun con la cache', async () => {
    const rs = [];
    for (let i = 0; i < 3; i++) rs.push(await correr(autenticarSocket, socketCon()));
    expect(rs.slice(0, 2)).toEqual(['ok', 'ok']);
    expect(rs[2].message).toBe('RATE_LIMIT');
    expect(rs[2].data.retryAfter).toBeGreaterThan(0);
  });
  it('el limite por uid corta ANTES de la DB', async () => {
    process.env.RATE_LIMIT_SOCKET_USUARIO_MAX = '1';
    expect(await correr(autenticarSocket, socketCon({ token: 't1' }))).toBe('ok');
    const r = await correr(autenticarSocket, socketCon({ token: 't2' }));
    expect(r.message).toBe('RATE_LIMIT');
    expect(prismaMock.usuario.findUnique).toHaveBeenCalledTimes(1);
  });
  it('usuario no registrado: no se cachea', async () => {
    prismaMock.usuario.findUnique.mockResolvedValue(null);
    expect((await correr(autenticarSocket, socketCon())).message).toBe('Usuario no registrado');
    expect(tamanoCacheSocket()).toBe(0);
  });
  it('un error de la DB ya no sale como "Token invalido"', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.usuario.findUnique.mockRejectedValue(new Error('Neon caido'));
    expect((await correr(autenticarSocket, socketCon())).message).toBe('Error interno');
    err.mockRestore();
  });
});
