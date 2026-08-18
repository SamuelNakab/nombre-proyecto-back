// Test de ANTICIPACION_MINIMA_MINUTOS: el minimo de anticipacion para la
// fecha_programada de POST /api/viajes, que antes estaba hardcodeado en 1 hora.
//
// A diferencia del resto de los scripts, este NO pega contra el server de
// localhost:3000: el valor a probar es una variable de entorno del PROCESO del
// server, asi que un unico server ya levantado solo puede probar UN valor. El
// script levanta su propio server por cada valor (puerto aparte, misma DB y
// mismo Redis) y lo baja al terminar. El de localhost:3000 puede quedar
// corriendo, no molesta.
//
// Casos:
//   valor 60 (default) → 30 min falla, 90 min pasa
//   valor 5            → 10 min pasa (con 60 hubiera fallado), 2 min falla
//   valor 0            → +1 min pasa, pero una fecha PASADA sigue fallando
//   el mensaje de error dice el valor configurado, no "60" fijo
//   estimar-costo NO tiene minimo: acepta una fecha pasada
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import prisma from '../src/config/prisma.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const RAIZ = fileURLToPath(new URL('..', import.meta.url));

const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

const MINUTO = 60 * 1000;

// ── Helpers ─────────────────────────────────────────────────────────────────

const pasos = [];
function paso(nombre, ok, detalle = '') {
  pasos.push({ nombre, ok, detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error(`Firebase login fallido para ${email}: ${data.error?.message}`);
  return data.idToken;
}

async function api(base, method, path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: `Respuesta no-JSON (${res.status}): ${text.slice(0, 500)}` };
  }
  return { status: res.status, data };
}

// Levanta src/app.js con ANTICIPACION_MINIMA_MINUTOS=<valor> en un puerto
// propio, corre fn(base) y lo baja pase lo que pase.
//
// El valor va en el env del hijo: dotenv NO pisa lo que ya esta en process.env,
// asi que gana sobre el .env local (que puede tener cualquier otro valor).
async function conServer(valor, puerto, fn) {
  const base = `http://localhost:${puerto}`;
  console.log(`\n  ⏳ levantando server con ANTICIPACION_MINIMA_MINUTOS=${valor} en :${puerto}...`);

  const hijo = spawn(process.execPath, ['src/app.js'], {
    cwd: RAIZ,
    env: {
      ...process.env,
      PORT: String(puerto),
      ANTICIPACION_MINIMA_MINUTOS: String(valor),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  hijo.stdout.on('data', (d) => (log += d));
  hijo.stderr.on('data', (d) => (log += d));

  let murio = false;
  hijo.on('exit', () => (murio = true));

  try {
    // Espera a que /health responda (hasta 45s: arranca Prisma, Redis y sockets).
    const limite = Date.now() + 45000;
    let arriba = false;
    while (Date.now() < limite && !murio) {
      try {
        const res = await fetch(`${base}/health`);
        if (res.ok) {
          arriba = true;
          break;
        }
      } catch {
        /* todavia no escucha */
      }
      await esperar(500);
    }
    if (!arriba) {
      throw new Error(
        `El server en :${puerto} no levanto${murio ? ' (el proceso murio)' : ''}.\n--- log ---\n${log}`
      );
    }
    console.log(`  ✅ server :${puerto} arriba`);
    return await fn(base);
  } finally {
    hijo.kill();
    await esperar(500);
  }
}

// fecha_programada a N minutos de ahora (N negativo = fecha pasada).
const enMinutos = (n) => new Date(Date.now() + n * MINUTO).toISOString();

async function crear(base, token, minutos) {
  return api(
    base,
    'POST',
    '/api/viajes',
    {
      zona: 'CABA',
      fecha_programada: enMinutos(minutos),
      condiciones_requeridas: [],
      paradas: [PARADA_1, PARADA_2],
    },
    token
  );
}

const MENSAJE = (min) =>
  `fecha_programada debe ser una fecha ISO futura (al menos ${min} minutos desde ahora)`;

async function cleanup() {
  try {
    await prisma.$disconnect();
  } catch {
    /* noop */
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   TEST ANTICIPACION MINIMA — FLETER          ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const clienteToken = await getToken('cliente@test.com', 'test123456');

  // ── CASO 1: valor 60 (el default de siempre) ──────────────────────────────
  await conServer(60, 3101, async (base) => {
    console.log('\n── CASO 1: ANTICIPACION_MINIMA_MINUTOS=60 ─────────────────\n');

    const r30 = await crear(base, clienteToken, 30);
    paso(
      'CASO 1a: con 60, un viaje a 30 min → 400',
      r30.status === 400,
      `status=${r30.status} error=${JSON.stringify(r30.data.error)}`
    );
    paso(
      'CASO 1b: el mensaje dice "al menos 60 minutos"',
      r30.data.error === MENSAJE(60),
      JSON.stringify(r30.data.error)
    );

    const r90 = await crear(base, clienteToken, 90);
    paso(
      'CASO 1c: con 60, un viaje a 90 min → 201',
      r90.status === 201,
      `status=${r90.status} viaje=${r90.data.id_viaje ?? JSON.stringify(r90.data)}`
    );
  });

  // ── CASO 2: valor 5 ───────────────────────────────────────────────────────
  await conServer(5, 3102, async (base) => {
    console.log('\n── CASO 2: ANTICIPACION_MINIMA_MINUTOS=5 ──────────────────\n');

    const r10 = await crear(base, clienteToken, 10);
    paso(
      'CASO 2a: con 5, un viaje a 10 min → 201 (con 60 hubiera fallado)',
      r10.status === 201,
      `status=${r10.status} viaje=${r10.data.id_viaje ?? JSON.stringify(r10.data)}`
    );

    const r2 = await crear(base, clienteToken, 2);
    paso(
      'CASO 2b: con 5, un viaje a 2 min → 400',
      r2.status === 400,
      `status=${r2.status} error=${JSON.stringify(r2.data.error)}`
    );
    paso(
      'CASO 2c: el mensaje refleja el valor configurado (5), no 60 fijo',
      r2.data.error === MENSAJE(5),
      JSON.stringify(r2.data.error)
    );
  });

  // ── CASO 3: valor 0 — el piso de "futura" se mantiene ─────────────────────
  await conServer(0, 3103, async (base) => {
    console.log('\n── CASO 3: ANTICIPACION_MINIMA_MINUTOS=0 ──────────────────\n');

    const r1 = await crear(base, clienteToken, 1);
    paso(
      'CASO 3a: con 0, un viaje a 1 min en el futuro → 201',
      r1.status === 201,
      `status=${r1.status} viaje=${r1.data.id_viaje ?? JSON.stringify(r1.data)}`
    );

    const rPasado = await crear(base, clienteToken, -10);
    paso(
      'CASO 3b: con 0, una fecha PASADA (−10 min) → 400 igual',
      rPasado.status === 400,
      `status=${rPasado.status} error=${JSON.stringify(rPasado.data.error)}`
    );
    paso(
      'CASO 3c: el mensaje dice "al menos 0 minutos"',
      rPasado.data.error === MENSAJE(0),
      JSON.stringify(rPasado.data.error)
    );

    // schemaEstimar no cambio: estimar-costo nunca tuvo minimo de anticipacion.
    const est = await api(
      base,
      'POST',
      '/api/viajes/estimar-costo',
      {
        zona: 'CABA',
        fecha_programada: enMinutos(-600),
        paradas: [PARADA_1, PARADA_2],
      },
      clienteToken
    );
    paso(
      'CASO 3d: estimar-costo acepta una fecha pasada (no tiene minimo)',
      est.status === 200,
      `status=${est.status}`
    );
  });

  // ── RESUMEN ───────────────────────────────────────────────────────────────
  await cleanup();

  const ok = pasos.filter((p) => p.ok).length;
  const fallaron = pasos.filter((p) => !p.ok);

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║                  RESUMEN                     ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  pasos.forEach((p) => console.log(`  ${p.ok ? '✅' : '❌'} ${p.nombre}`));
  console.log(`\n  ${ok}/${pasos.length} checks pasaron`);
  if (fallaron.length > 0) {
    console.log('\n  Fallaron:');
    fallaron.forEach((p) => console.log(`    ❌ ${p.nombre}${p.detalle ? ': ' + p.detalle : ''}`));
  }

  process.exit(fallaron.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n💥 Error inesperado:', e.message, e.stack);
  await cleanup();
  process.exit(1);
});
