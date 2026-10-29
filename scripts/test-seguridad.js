// Tarea 6 — seguridad y monitoreo: errores 400 en vez de 500, mensajes en
// español, JSON mal formado, CORS (Express y socket.io), helmet, rate limit (con
// Retry-After y falla abierta sin Redis), limite del handshake y /health.
//
//   node scripts/test-seguridad.js
//
// NO usa el server de :3000: levanta los suyos.
//   3991  CORS_ORIGINS definida, limiter apagado: errores, CORS, helmet, /health.
//   3992  limiter PRENDIDO con limites bajos por variable: 429 + Retry-After.
//   3993  limiter prendido y Redis inalcanzable: falla abierta.
// Usa las cuentas FIJAS del seed (cliente@, cliente2@, conductor@). No deberia
// crear nada: los registros que prueba fallan en la validacion. Igual registra el
// patron -seg- en la limpieza y verifica que no quedo ningun usuario (DB y
// Firebase) ni vehiculo. Borra las claves de rate limit que dejo en Redis.
import 'dotenv/config';
import { io as ioClient } from 'socket.io-client';
import admin from '../src/config/firebase.js';
import prisma from '../src/config/prisma.js';
import redis from '../src/config/redis.js';
import { getToken } from './_firebase-auth.js';
import { crearRegistro, terminar } from './_limpieza.js';
import { conServer, esperarLinea } from './_server-efimero.js';

const STAMP = Date.now().toString(36);
const PATRON = `-seg-${STAMP}`;
const reg = crearRegistro(PATRON);
const PASS = 'test123456';

const BARRIDOS_OFF = {
  RESERVA_BARRIDO_ARRANQUE: '0',
  VENCIMIENTO_BARRIDO_ARRANQUE: '0',
  CIERRE_BARRIDO_ARRANQUE: '0',
  // Prisma loguea cada query (prisma:query) fuera de production: lo usa el chequeo
  // de que /health no toca la base.
  NODE_ENV: 'development',
};

const pasos = [];
function paso(nombre, ok, detalle = '') {
  pasos.push({ nombre, ok, detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}

async function api(base, method, path, { body, token, headers = {}, raw } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...headers,
    },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { noJson: text.slice(0, 200) };
  }
  return { status: res.status, data, headers: res.headers };
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Conecta un socket y resuelve { ok, error } sin reintentos.
function conectarSocket(base, { token, origin } = {}) {
  return new Promise((resolve) => {
    const s = ioClient(base, {
      auth: token ? { token: 'Bearer ' + token } : {},
      reconnection: false,
      ...(origin ? { extraHeaders: { Origin: origin } } : {}),
      timeout: 8000,
    });
    const fin = (r) => {
      s.close();
      resolve(r);
    };
    s.on('connect', () => fin({ ok: true }));
    s.on('connect_error', (e) => fin({ ok: false, mensaje: e.message, data: e.data }));
  });
}

// Claves de rate limit que dejaron los servers de este test: las de loopback y las
// de los usuarios del test. No toca las de nadie mas (la Redis puede ser de Railway).
// express-rate-limit agrupa IPv6 por /56: '::1' queda como '::/56'.
const LOOPBACK = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1|::\/\d+)$/;

async function limpiarClavesRateLimit(ids = [], uids = []) {
  if (redis.status !== 'ready') return 0;
  const esNuestra = (k) => {
    const rl = k.match(/^rl:[a-z_]+:(.*)$/);
    if (rl) {
      const resto = rl[1];
      if (resto.startsWith('ip:')) return LOOPBACK.test(resto.slice(3));
      if (resto.startsWith('u:')) return ids.includes(Number(resto.slice(2)));
      return LOOPBACK.test(resto) || uids.includes(resto);
    }
    const canje = k.match(/^invitacion:canje:(usuario|ip):(.*)$/);
    if (canje) return canje[1] === 'usuario' ? ids.includes(Number(canje[2])) : LOOPBACK.test(canje[2]);
    return false;
  };
  let borradas = 0;
  for (const patron of ['rl:*', 'invitacion:canje:*']) {
    let cursor = '0';
    do {
      const [sig, claves] = await redis.scan(cursor, 'MATCH', patron, 'COUNT', 500);
      cursor = sig;
      const nuestras = claves.filter(esNuestra);
      if (nuestras.length) borradas += await redis.del(...nuestras);
    } while (cursor !== '0');
  }
  return borradas;
}

// /health responde antes de que el Redis del server efimero este 'ready' (la de
// Railway tarda), y sin Redis el limiter deja pasar (falla abierta). SONDA: pega
// a una ruta que cuenta hasta que aparece la clave del limiter general en Redis.
async function esperarRedisDelServer(base) {
  const limite = Date.now() + 20000;
  while (Date.now() < limite) {
    await fetch(`${base}/api/no-existe`).catch(() => {});
    let cursor = '0';
    do {
      const [sig, claves] = await redis.scan(cursor, 'MATCH', 'rl:general:ip:*', 'COUNT', 500);
      cursor = sig;
      if (claves.some((k) => LOOPBACK.test(k.slice('rl:general:ip:'.length)))) return true;
    } while (cursor !== '0');
    await esperar(300);
  }
  return false;
}

async function main() {
  const tCond = await getToken('conductor@test.com', PASS);
  const tCli = await getToken('cliente@test.com', PASS);
  const tCli2 = await getToken('cliente2@test.com', PASS);
  const fijas = await prisma.usuario.findMany({
    where: { email: { in: ['conductor@test.com', 'cliente@test.com', 'cliente2@test.com'] } },
    select: { id_usuario: true, firebase_uid: true },
  });
  const ids = fijas.map((u) => u.id_usuario);
  const uids = fijas.map((u) => u.firebase_uid);
  const vehiculosAntes = await prisma.vehiculo.count();
  await limpiarClavesRateLimit(ids, uids);

  // ── 3991: errores, CORS, helmet, /health ─────────────────────────────────
  console.log('\n-- CASO 1: errores 400, CORS, helmet y /health (3991) ---------\n');
  await conServer(
    {
      ...BARRIDOS_OFF,
      CORS_ORIGINS: 'https://app.fleter.test/, https://*.preview.fleter.test',
      RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567890',
    },
    3991,
    async (base, leerLog) => {
      // /health: version, uptime y SIN query a la base. Primero se espera a que
      // termine lo async del arranque (el barrido de avisos legacy lee la DB).
      await esperarLinea(leerLog, /\[viaje-vencido\] barrido de arranque:/, 20000);
      await esperar(1500);
      const antes = leerLog().length;
      let h;
      for (let i = 0; i < 5; i++) h = await api(base, 'GET', '/health');
      await esperar(800);
      const durante = leerLog().slice(antes);
      paso('1a /health 200 con version (commit corto) y uptime_segundos', h.status === 200 && h.data.version === 'abcdef1' && Number.isInteger(h.data.uptime_segundos), JSON.stringify(h.data));
      paso('1b /health mantiene capacidades viaje-interno', h.data.capacidades?.includes('viaje-interno'));
      paso('1c 5 GET /health sin ninguna query a la base', !durante.includes('prisma:query'), durante.includes('prisma:query') ? durante.slice(0, 300) : 'sin prisma:query');
      paso('1d el arranque avisa los origenes CORS cargados', /\[cors\] origenes permitidos: https:\/\/app\.fleter\.test, https:\/\/\*\.preview\.fleter\.test/.test(leerLog()));

      // Errores que antes daban 500.
      const v1 = await api(base, 'PUT', '/api/conductores/mis-vehiculos/abc', { body: { color: 'rojo' }, token: tCond });
      paso('1e PUT mis-vehiculos/abc -> 400', v1.status === 400 && v1.data.error === 'id de vehiculo invalido', `${v1.status} ${JSON.stringify(v1.data)}`);
      const v2 = await api(base, 'PUT', '/api/conductores/mis-vehiculos/undefined', { body: {}, token: tCond });
      paso('1f PUT mis-vehiculos/undefined -> 400', v2.status === 400, `${v2.status} ${JSON.stringify(v2.data)}`);
      const v3 = await api(base, 'DELETE', '/api/conductores/mis-vehiculos/99999999999', { token: tCond });
      paso('1g DELETE mis-vehiculos/99999999999 (fuera de INT4) -> 400', v3.status === 400, `${v3.status} ${JSON.stringify(v3.data)}`);
      const v4 = await api(base, 'POST', '/api/conductores/mis-vehiculos', { body: {}, token: tCond });
      paso('1h POST mis-vehiculos {} -> 400 en español', v4.status === 400 && v4.data.error === 'El campo patente es obligatorio', `${v4.status} ${JSON.stringify(v4.data)}`);
      const v5 = await api(base, 'PUT', '/api/conductores/mis-vehiculos/1', { body: { anio: 'x' }, token: tCond });
      paso('1i PUT mis-vehiculos con anio "x" -> 400 en español', v5.status === 400 && v5.data.error === 'El campo anio debe ser un número', `${v5.status} ${JSON.stringify(v5.data)}`);

      const email = reg.email(`chofer${PATRON}@test.com`);
      const r1 = await api(base, 'POST', '/api/auth/registro-conductor', {
        body: { apellido: 'Seg', dni: '99887766', email, contrasena: 'secreto1', nro_licencia: 'L-SEG', licencia_vencimiento: '2030-01-01T00:00:00.000Z' },
      });
      paso('1j registro-conductor sin nombre -> 400 en español', r1.status === 400 && r1.data.error === 'El campo nombre es obligatorio', `${r1.status} ${JSON.stringify(r1.data)}`);
      const enFirebase = await admin
        .auth()
        .getUserByEmail(email)
        .then(() => true)
        .catch(() => false);
      paso('1k ... y no se creo en Firebase', !enFirebase);

      const j = await api(base, 'POST', '/api/auth/registro-cliente', { raw: '{"nombre": "x",' });
      paso('1l JSON mal formado -> 400 { error }', j.status === 400 && j.data.error === 'El cuerpo de la solicitud no es un JSON válido', `${j.status} ${JSON.stringify(j.data)}`);
      const grande = await api(base, 'POST', '/api/auth/registro-cliente', { raw: JSON.stringify({ nombre: 'x'.repeat(150_000) }) });
      paso('1m body de mas de 100kb -> 413 { error }', grande.status === 413 && typeof grande.data.error === 'string', `${grande.status} ${JSON.stringify(grande.data)}`);
      const g1 = await api(base, 'GET', '/api/viajes/abc', { token: tCond });
      paso('1n GET /api/viajes/abc -> 400', g1.status === 400 && g1.data.error === 'id de viaje invalido', `${g1.status} ${JSON.stringify(g1.data)}`);
      const g2 = await api(base, 'GET', '/api/organizaciones/99999999999', { token: tCli });
      paso('1o GET /api/organizaciones/99999999999 -> 400', g2.status === 400 && g2.data.error === 'id de PyME invalido', `${g2.status} ${JSON.stringify(g2.data)}`);
      const g3 = await api(base, 'POST', '/api/viajes/abc/confirmar-parada', { body: { id_parada: 1, lat: -34.6, lng: -58.4 }, token: tCond });
      paso('1p POST /api/viajes/abc/confirmar-parada -> 400', g3.status === 400, `${g3.status} ${JSON.stringify(g3.data)}`);
      const nf = await api(base, 'GET', '/api/no-existe');
      paso('1q ruta inexistente -> 404 JSON', nf.status === 404 && nf.data.error === 'No encontrado', `${nf.status} ${JSON.stringify(nf.data)}`);
      const sinTok = await api(base, 'GET', '/api/auth/me');
      paso('1r mensajes existentes intactos (401 sin token)', sinTok.status === 401 && sinTok.data.error === 'Token no proporcionado');

      // CORS.
      const ok1 = await api(base, 'GET', '/health', { headers: { Origin: 'https://app.fleter.test' } });
      paso('1s CORS: origen permitido -> eco del origen', ok1.headers.get('access-control-allow-origin') === 'https://app.fleter.test');
      paso('1t CORS: expone Retry-After', (ok1.headers.get('access-control-expose-headers') ?? '').includes('Retry-After'));
      const ok2 = await api(base, 'GET', '/health', { headers: { Origin: 'https://pr-7.preview.fleter.test' } });
      paso('1u CORS: comodin de previews', ok2.headers.get('access-control-allow-origin') === 'https://pr-7.preview.fleter.test');
      const no1 = await api(base, 'GET', '/health', { headers: { Origin: 'https://evil.test' } });
      paso('1v CORS: origen no permitido -> sin Access-Control-Allow-Origin', no1.headers.get('access-control-allow-origin') === null);
      const no2 = await api(base, 'GET', '/health', { headers: { Origin: 'https://a.b.preview.fleter.test' } });
      paso('1w CORS: el comodin no cubre dos etiquetas', no2.headers.get('access-control-allow-origin') === null);
      const sinOrigin = await api(base, 'GET', '/api/auth/me', { token: tCli });
      paso('1x sin Origin (mobile / curl) pasa normal', sinOrigin.status === 200);
      const pre = await fetch(`${base}/api/auth/me`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://app.fleter.test', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
      });
      paso('1y preflight permitido -> 204 con ACAO y Max-Age 600', pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://app.fleter.test' && pre.headers.get('access-control-max-age') === '600');
      const preNo = await fetch(`${base}/api/auth/me`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.test', 'Access-Control-Request-Method': 'GET' },
      });
      paso('1z preflight no permitido -> sin ACAO', preNo.headers.get('access-control-allow-origin') === null);

      // Socket.io: mismo criterio.
      const sNo = await conectarSocket(base, { token: tCli, origin: 'https://evil.test' });
      paso('1aa socket con Origin no permitido -> rechazado', !sNo.ok, sNo.mensaje);
      const sSin = await conectarSocket(base, { token: tCli });
      paso('1ab socket sin Origin (mobile) -> conecta', sSin.ok, sSin.mensaje);
      const sSi = await conectarSocket(base, { token: tCli, origin: 'https://app.fleter.test' });
      paso('1ac socket con Origin permitido -> conecta', sSi.ok, sSi.mensaje);

      // helmet.
      paso('1ad helmet: nosniff, X-Frame-Options DENY, CSP none, sin X-Powered-By',
        ok1.headers.get('x-content-type-options') === 'nosniff' &&
          ok1.headers.get('x-frame-options') === 'DENY' &&
          (ok1.headers.get('content-security-policy') ?? '').includes("default-src 'none'") &&
          ok1.headers.get('x-powered-by') === null);
    }
  );

  // ── 3992: limiter prendido ───────────────────────────────────────────────
  console.log('\n-- CASO 2: rate limit con limites bajos (3992) -----------------\n');
  await limpiarClavesRateLimit(ids, uids);
  await conServer(
    {
      ...BARRIDOS_OFF,
      RATE_LIMIT_HABILITADO: '1',
      RATE_LIMIT_GENERAL_MAX: '40',
      RATE_LIMIT_REGISTRO_MAX: '2',
      RATE_LIMIT_MAPS_MAX: '2',
      RATE_LIMIT_SOCKET_USUARIO_MAX: '2',
      RATE_LIMIT_SOCKET_IP_MAX: '50',
      INVITACION_INTENTOS_MAX: '1',
    },
    3992,
    async (base) => {
      paso('2 sonda: el limiter del server ya escribe en Redis', await esperarRedisDelServer(base));
      const hs = [];
      for (let i = 0; i < 45; i++) hs.push((await api(base, 'GET', '/health')).status);
      paso('2a /health nunca da 429 (fuera del limiter)', hs.every((s) => s === 200));

      const reg1 = await api(base, 'POST', '/api/auth/registro-cliente', { body: {} });
      const reg2 = await api(base, 'POST', '/api/auth/registro-cliente', { body: {} });
      const reg3 = await api(base, 'POST', '/api/auth/registro-conductor', { body: {} });
      paso('2b registro: 2 intentos pasan (400 de validacion)', reg1.status === 400 && reg2.status === 400);
      paso('2c registro: el 3ro -> 429 ANTES de validar el body (cliente y conductor comparten el limite)', reg3.status === 429, `${reg3.status} ${JSON.stringify(reg3.data)}`);
      paso('2d 429 con Retry-After y mensaje en español', Number(reg3.headers.get('retry-after')) > 0 && /^Demasiadas cuentas creadas desde esta conexión\. Probá de nuevo en \d+ minutos\.$/.test(reg3.data.error ?? ''), `Retry-After ${reg3.headers.get('retry-after')} ${reg3.data.error}`);

      const m = [];
      for (let i = 0; i < 3; i++) m.push(await api(base, 'POST', '/api/viajes/estimar-costo', { body: {}, token: tCli }));
      paso('2e MAPS por usuario: 2 pasan (400), el 3ro -> 429', m[0].status === 400 && m[1].status === 400 && m[2].status === 429, m.map((r) => r.status).join(','));
      paso('2f ... con Retry-After', Number(m[2].headers.get('retry-after')) > 0);
      const otro = await api(base, 'POST', '/api/viajes/estimar-costo', { body: {}, token: tCli2 });
      paso('2g MAPS es por usuario, no por IP: otro usuario de la misma IP pasa', otro.status === 400, `${otro.status}`);

      const c1 = await api(base, 'POST', '/api/invitaciones/canjear', { body: { codigo: 'XXXXX-XXXXX' }, token: tCond });
      const c2 = await api(base, 'POST', '/api/invitaciones/canjear', { body: { codigo: 'XXXXX-XXXXX' }, token: tCond });
      paso('2h canje: 429 con su mensaje de siempre y ahora Retry-After', c1.status === 400 && c2.status === 429 && c2.data.error === 'Demasiados intentos. Proba de nuevo en unos minutos' && Number(c2.headers.get('retry-after')) > 0, `${c1.status},${c2.status} Retry-After ${c2.headers.get('retry-after')}`);

      const s = [];
      for (let i = 0; i < 3; i++) s.push(await conectarSocket(base, { token: tCond }));
      paso('2i handshake por usuario: 2 conectan, el 3ro -> connect_error RATE_LIMIT', s[0].ok && s[1].ok && !s[2].ok && s[2].mensaje === 'RATE_LIMIT', JSON.stringify(s[2]));
      paso('2j ... con data.retryAfter y mensaje', Number(s[2].data?.retryAfter) > 0 && /^Demasiadas conexiones/.test(s[2].data?.error ?? ''));

      // General: se agota el resto del cupo (40 por minuto por IP).
      let primero429 = null;
      for (let i = 0; i < 45 && !primero429; i++) {
        const r = await api(base, 'GET', '/api/no-existe');
        if (r.status === 429) primero429 = r;
      }
      paso('2k general por IP -> 429 con Retry-After y mensaje en español', primero429 !== null && Number(primero429.headers.get('retry-after')) > 0 && /^Demasiadas solicitudes\. Probá de nuevo en \d+ segundos?\.$/.test(primero429.data.error ?? ''), primero429 ? primero429.data.error : 'nunca dio 429');
      paso('2l headers RateLimit estandar', primero429 !== null && primero429.headers.get('ratelimit-policy') !== null);
      const hDespues = await api(base, 'GET', '/health');
      paso('2m /health sigue respondiendo con el cupo agotado', hDespues.status === 200);
    }
  );
  const borradas = await limpiarClavesRateLimit(ids, uids);
  paso('2n claves de rate limit del test borradas de Redis', borradas > 0, `${borradas} claves`);

  // ── 3993: Redis inalcanzable ─────────────────────────────────────────────
  console.log('\n-- CASO 3: limiter prendido sin Redis (3993) -------------------\n');
  await conServer(
    { ...BARRIDOS_OFF, RATE_LIMIT_HABILITADO: '1', RATE_LIMIT_GENERAL_MAX: '1', REDIS_URL: 'redis://127.0.0.1:6390' },
    3993,
    async (base, leerLog) => {
      const rs = [];
      for (let i = 0; i < 5; i++) rs.push((await api(base, 'GET', '/api/no-existe')).status);
      paso('3a sin Redis falla abierta: 5 requests con max 1 pasan (404, ningun 429)', rs.every((s) => s === 404), rs.join(','));
      const linea = await esperarLinea(leerLog, /\[rate-limit\] sin Redis/, 5000);
      paso('3b ... y lo loguea', linea !== null);
      const n = (leerLog().match(/\[rate-limit\] sin Redis/g) ?? []).length;
      paso('3c el log "sin Redis" sale una sola vez (no uno por request)', n === 1, `${n} veces`);
      const s = await conectarSocket(base, { token: tCond });
      paso('3d el handshake tambien falla abierto', s.ok, s.mensaje);
    }
  );

  // Nada creado.
  paso('4a no se creo ningun vehiculo', (await prisma.vehiculo.count()) === vehiculosAntes);
  const quedan = await prisma.usuario.count({ where: { email: { contains: PATRON } } });
  paso('4b no se creo ningun usuario', quedan === 0);
}

main()
  .catch((e) => {
    console.error('\n💥', e);
    paso('la suite termino sin excepciones', false, e.message);
  })
  .finally(async () => {
    const fallidos = pasos.filter((p) => !p.ok);
    console.log(`\n  ${pasos.length - fallidos.length}/${pasos.length} OK`);
    for (const f of fallidos) console.log(`  ❌ ${f.nombre}  →  ${f.detalle}`);
    await terminar(reg, fallidos.length === 0);
  });
