import { io } from 'socket.io-client';
import redis from '../src/config/redis.js';
import prisma from '../src/config/prisma.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const BASE = 'http://localhost:3000';

const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

// ── Helpers ───────────────────────────────────────────────────────────────────

const pasos = [];

function paso(nombre, ok, detalle = '') {
  pasos.push({ nombre, ok, detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

async function api(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
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
    data = { error: `Respuesta no-JSON (${res.status}): ${text.slice(0, 3000)}` };
  }
  return { status: res.status, data };
}

async function conectar(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token: 'Bearer ' + token } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`Socket connect_error: ${e.message}`)));
    setTimeout(() => reject(new Error('Timeout al conectar socket (8s)')), 8000);
  });
}

async function registrarSiNoExiste(datos, tipo) {
  const endpoint = tipo === 'cliente'
    ? '/api/auth/registro-cliente'
    : '/api/auth/registro-conductor';
  await api('POST', endpoint, datos, null);
}

async function crearVehiculoSiNoExiste(token, patente) {
  await api('POST', '/api/conductores/mis-vehiculos', {
    patente, marca: 'Ford', modelo: 'Transit', anio: 2020, color: 'Blanco', tipo_vehiculo: 'furgon',
  }, token);
}

async function crearViaje(clienteToken) {
  const fechaViaje = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const { status, data } = await api('POST', '/api/viajes', {
    zona: 'CABA', fecha_programada: fechaViaje, condiciones_requeridas: [], paradas: [PARADA_1, PARADA_2],
  }, clienteToken);
  if (status !== 201) throw new Error(`No se pudo crear viaje (status ${status}): ${JSON.stringify(data)}`);
  return data.id_viaje;
}

async function aceptarConConductor(sConductor, id_viaje) {
  sConductor.emit('viaje:aceptar', { id_viaje });
  await esperar(2000);
}

async function cleanup(sockets) {
  for (const s of sockets) {
    try { s?.disconnect(); } catch { /* noop */ }
  }
  try { await prisma.$disconnect(); } catch { /* noop */ }
  try { await redis.quit(); } catch { /* noop */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   TEST CANCELACION POR CLIENTE — FLETER      ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  let sConductor = null;

  // ── SETUP ─────────────────────────────────────────────────────────────────
  console.log('── SETUP: Autenticacion y vehiculo ────────────────────────────\n');

  await registrarSiNoExiste({
    nombre: 'Test', apellido: 'Cliente', dni: '11111111',
    email: 'cliente@test.com', contrasena: 'test123456',
  }, 'cliente');

  await registrarSiNoExiste({
    nombre: 'Cliente', apellido: 'Dos', dni: '44444444',
    email: 'cliente2@test.com', contrasena: 'test123456',
  }, 'cliente');

  await registrarSiNoExiste({
    nombre: 'Conductor', apellido: 'Uno', dni: '22222222',
    email: 'conductor@test.com', contrasena: 'test123456',
    nro_licencia: 'LIC001', licencia_vencimiento: '2028-01-01T00:00:00.000Z',
  }, 'conductor');

  const clienteAToken = await getToken('cliente@test.com', 'test123456');
  const clienteBToken = await getToken('cliente2@test.com', 'test123456');
  const conductorToken = await getToken('conductor@test.com', 'test123456');

  await crearVehiculoSiNoExiste(conductorToken, 'FLT001');
  console.log('  Tokens listos (cliente A, cliente B, conductor con FLT001)\n');

  sConductor = await conectar(conductorToken);
  await esperar(1200);

  // ── CASO 1: Feliz sin conductor (BUSCANDO_CONDUCTOR) ─────────────────────────
  console.log('── CASO 1: Cancelar sin conductor (BUSCANDO_CONDUCTOR) ────────\n');

  const v1 = await crearViaje(clienteAToken);
  await esperar(800);

  const { status: st1, data: d1 } = await api('POST', `/api/viajes/${v1}/cancelar-cliente`, null, clienteAToken);
  const { data: v1Db } = await api('GET', `/api/viajes/${v1}`, null, clienteAToken);
  paso('CASO 1: cancelar en BUSCANDO_CONDUCTOR → 200 { mensaje, id_viaje, estado: CANCELADO }',
    st1 === 200 && d1.mensaje === 'Viaje cancelado' && d1.id_viaje === v1 && d1.estado === 'CANCELADO',
    `status ${st1} ${JSON.stringify(d1)}`);
  paso('CASO 1: en DB viaje CANCELADO con id_conductor null (nunca tuvo conductor)',
    v1Db.estado === 'CANCELADO' && v1Db.id_conductor === null,
    `estado=${v1Db.estado} id_conductor=${v1Db.id_conductor}`);

  // ── CASO 2 y 3: Feliz con conductor asignado + Redis limpio ──────────────────
  console.log('\n── CASO 2/3: Cancelar con conductor asignado + Redis limpio ───\n');

  const v2 = await crearViaje(clienteAToken);
  await esperar(1200);
  await aceptarConConductor(sConductor, v2);

  const { data: v2Asig } = await api('GET', `/api/viajes/${v2}`, null, clienteAToken);
  if (v2Asig.estado !== 'CONDUCTOR_ASIGNADO' || v2Asig.id_conductor === null) {
    paso('CASO 2: precondicion viaje CONDUCTOR_ASIGNADO', false,
      `estado=${v2Asig.estado} id_conductor=${v2Asig.id_conductor}`);
    await cleanup([sConductor]);
    process.exit(1);
  }
  const idConductorAsignado = v2Asig.id_conductor;

  // Sembramos manualmente keys gps:{v2}:* para verificar que limpiarViajeActivo
  // (via limpiarGPS) las borra TODAS al cancelar con conductor asignado.
  await Promise.all([
    redis.set(`gps:${v2}:ultima`, JSON.stringify({ lat: -34.6, lng: -58.4, timestamp: Date.now() })),
    redis.lpush(`gps:${v2}:historial`, JSON.stringify({ lat: -34.6, lng: -58.4 })),
    redis.set(`gps:${v2}:ruta`, JSON.stringify([[-58.4, -34.6]])),
    redis.set(`gps:${v2}:acumulado`, JSON.stringify({ tiempo_horas: 0, distancia_km: 0 })),
    redis.set(`gps:${v2}:eta`, JSON.stringify({ segundos: 100 })),
    redis.set(`gps:${v2}:pings_detenido`, '0'),
    redis.set(`gps:${v2}:ultimo_recalculo`, String(Date.now())),
    redis.set(`gps:${v2}:pings_desviado`, '0'),
  ]);
  const keysAntes = await redis.keys(`gps:${v2}:*`);

  const { status: st2, data: d2 } = await api('POST', `/api/viajes/${v2}/cancelar-cliente`, null, clienteAToken);
  await esperar(1200);
  const { data: v2Db } = await api('GET', `/api/viajes/${v2}`, null, clienteAToken);
  const keysDespues = await redis.keys(`gps:${v2}:*`);

  paso('CASO 2: cancelar en CONDUCTOR_ASIGNADO → 200 y viaje CANCELADO',
    st2 === 200 && d2.estado === 'CANCELADO' && v2Db.estado === 'CANCELADO',
    `status ${st2} estadoDb=${v2Db.estado}`);
  paso('CASO 2: id_conductor se PRESERVA tras cancelar (no se limpia, historial)',
    v2Db.id_conductor === idConductorAsignado && v2Db.id_conductor !== null,
    `id_conductor asignado=${idConductorAsignado} → tras cancelar=${v2Db.id_conductor}`);
  paso('CASO 3: tras cancelar con conductor, NINGUNA key gps:{id}:* sigue en Redis',
    keysAntes.length > 0 && keysDespues.length === 0,
    `sembradas=${keysAntes.length} restantes=${keysDespues.length}${keysDespues.length ? ' (' + keysDespues.join(', ') + ')' : ''}`);

  // ── CASO 4: Estado invalido EN_CAMINO_A_ORIGEN → 400 ─────────────────────────
  console.log('\n── CASO 4: Cancelar en EN_CAMINO_A_ORIGEN → 400 ───────────────\n');

  const v4 = await crearViaje(clienteAToken);
  await esperar(1200);
  await aceptarConConductor(sConductor, v4);

  // El viaje pasa a EN_CAMINO_A_ORIGEN con el boton (POST /:id/iniciar), no por el
  // primer ping. Traemos fecha_programada a "ahora" (via Prisma) para pasar la
  // ventana de inicio; el ping posterior ya se procesa normal.
  await prisma.viaje.update({ where: { id_viaje: v4 }, data: { fecha_programada: new Date() } });
  await api('POST', `/api/viajes/${v4}/iniciar`, null, conductorToken);

  sConductor.emit('conductor:ubicacion', { id_viaje: v4, lat: PARADA_1.lat, lng: PARADA_1.lng, timestamp: Date.now() });
  await esperar(1500);

  const { data: v4Camino } = await api('GET', `/api/viajes/${v4}`, null, clienteAToken);
  const { status: st4, data: d4 } = await api('POST', `/api/viajes/${v4}/cancelar-cliente`, null, clienteAToken);
  paso('CASO 4: primer ping → EN_CAMINO_A_ORIGEN, y cancelar → 400 con mensaje de estado',
    v4Camino.estado === 'EN_CAMINO_A_ORIGEN' && st4 === 400 &&
    typeof d4.error === 'string' && d4.error.includes('EN_CAMINO_A_ORIGEN') &&
    d4.error.startsWith('Solo se puede cancelar un viaje antes de que comience'),
    `estado=${v4Camino.estado} status=${st4} — ${d4.error}`);

  // ── CASO 5: Estado invalido CANCELADO (doble cancelacion) → 400 ──────────────
  console.log('\n── CASO 5: Doble cancelacion (CANCELADO) → 400 ────────────────\n');

  const { status: st5, data: d5 } = await api('POST', `/api/viajes/${v1}/cancelar-cliente`, null, clienteAToken);
  paso('CASO 5: cancelar un viaje ya CANCELADO → 400 con mensaje de estado',
    st5 === 400 && typeof d5.error === 'string' && d5.error.includes('CANCELADO'),
    `status ${st5} — ${d5.error}`);

  // ── CASO 6: Autorizacion — cliente B cancela viaje de A → 403 ────────────────
  console.log('\n── CASO 6: Cliente B cancela viaje de A → 403 ─────────────────\n');

  const v6 = await crearViaje(clienteAToken);
  await esperar(800);
  const { status: st6, data: d6 } = await api('POST', `/api/viajes/${v6}/cancelar-cliente`, null, clienteBToken);
  paso('CASO 6: cliente B (no dueño) intenta cancelar viaje de A → 403',
    st6 === 403 && d6.error === 'No autorizado para cancelar este viaje',
    `status ${st6} — ${d6.error}`);

  // ── CASO 7: Viaje inexistente → 404 ──────────────────────────────────────────
  console.log('\n── CASO 7: Viaje inexistente → 404 ────────────────────────────\n');

  const { status: st7, data: d7 } = await api('POST', '/api/viajes/999999/cancelar-cliente', null, clienteAToken);
  paso('CASO 7: cancelar id_viaje=999999 → 404',
    st7 === 404 && d7.error === 'Viaje no encontrado',
    `status ${st7} — ${d7.error}`);

  // ── RESUMEN ──────────────────────────────────────────────────────────────────
  await cleanup([sConductor]);

  const ok = pasos.filter((p) => p.ok).length;
  const fallaron = pasos.filter((p) => !p.ok);

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║                  RESUMEN                    ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  pasos.forEach((p) => console.log(`  ${p.ok ? '✅' : '❌'} ${p.nombre}`));
  console.log(`\n  ${ok}/${pasos.length} checks pasaron`);

  if (fallaron.length > 0) {
    console.log('\n  Fallaron:');
    fallaron.forEach((p) => console.log(`    ❌ ${p.nombre}${p.detalle ? ': ' + p.detalle : ''}`));
  }
  console.log('\n  NOTA: casos 8 y 9 (regresion) se corren aparte:');
  console.log('    node scripts/test-cancelacion-conductor.js → 11/11');
  console.log('    node scripts/test-fase5.js → 36/36');

  process.exit(fallaron.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n💥 Error inesperado:', e.message);
  try { await redis.quit(); } catch { /* noop */ }
  process.exit(1);
});
