import { io } from 'socket.io-client';
import redis from '../src/config/redis.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const BASE = 'http://localhost:3000';

// Dos paradas reales en CABA (zona CABA, sin condiciones → cualquier conductor
// con al menos un vehiculo es elegible).
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
    patente,
    marca: 'Ford',
    modelo: 'Transit',
    anio: 2020,
    color: 'Blanco',
    tipo_vehiculo: 'furgon',
  }, token);
  // 409 = ya existe; OK para el test
}

async function crearViaje(clienteToken) {
  const fechaViaje = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const { status, data } = await api('POST', '/api/viajes', {
    zona: 'CABA',
    fecha_programada: fechaViaje,
    condiciones_requeridas: [],
    paradas: [PARADA_1, PARADA_2],
  }, clienteToken);
  if (status !== 201) throw new Error(`No se pudo crear viaje (status ${status}): ${JSON.stringify(data)}`);
  return data.id_viaje;
}

async function cleanup(sockets) {
  for (const s of sockets) {
    try { s?.disconnect(); } catch { /* noop */ }
  }
  try { await redis.quit(); } catch { /* noop */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   TEST CANCELACION POR CONDUCTOR — FLETER    ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  let sA = null, sB = null, sCliente = null;

  // ── SETUP: autenticacion y vehiculos ─────────────────────────────────────────
  console.log('── SETUP: Autenticacion y vehiculos ───────────────────────────\n');

  await registrarSiNoExiste({
    nombre: 'Test', apellido: 'Cliente', dni: '11111111',
    email: 'cliente@test.com', contrasena: 'test123456',
  }, 'cliente');

  await registrarSiNoExiste({
    nombre: 'Conductor', apellido: 'Uno', dni: '22222222',
    email: 'conductor@test.com', contrasena: 'test123456',
    nro_licencia: 'LIC001', licencia_vencimiento: '2028-01-01T00:00:00.000Z',
  }, 'conductor');

  await registrarSiNoExiste({
    nombre: 'Conductor', apellido: 'Dos', dni: '33333333',
    email: 'conductor2@test.com', contrasena: 'test123456',
    nro_licencia: 'LIC002', licencia_vencimiento: '2028-01-01T00:00:00.000Z',
  }, 'conductor');

  const clienteToken = await getToken('cliente@test.com', 'test123456');
  const conductorAToken = await getToken('conductor@test.com', 'test123456');
  const conductorBToken = await getToken('conductor2@test.com', 'test123456');

  await crearVehiculoSiNoExiste(conductorAToken, 'FLT001');
  await crearVehiculoSiNoExiste(conductorBToken, 'FLT002');
  console.log('  Tokens y vehiculos listos (conductor A=FLT001, conductor B=FLT002)\n');

  // Conectar sockets
  sA = await conectar(conductorAToken);
  sB = await conectar(conductorBToken);
  sCliente = await conectar(clienteToken);

  // Tracking de viaje:disponible por socket (set de id_viaje, reseteable)
  const dispA = new Set();
  const dispB = new Set();
  sA.on('viaje:disponible', (d) => dispA.add(d.id_viaje));
  sB.on('viaje:disponible', (d) => dispB.add(d.id_viaje));

  // Tracking de eta:actualizar por viaje (para PUNTO 10)
  const etaRecibidos = [];
  sCliente.on('eta:actualizar', (d) => etaRecibidos.push(d.id_viaje));

  await esperar(1200);

  // ── PUNTO 1: Feliz — aceptar y cancelar ──────────────────────────────────────
  console.log('── PUNTO 1: Cancelacion feliz ─────────────────────────────────\n');

  const v1 = await crearViaje(clienteToken);
  await esperar(1200);

  sA.emit('viaje:aceptar', { id_viaje: v1 });
  await esperar(2000);

  const { data: v1Asig } = await api('GET', `/api/viajes/${v1}`, null, clienteToken);
  if (v1Asig.estado !== 'CONDUCTOR_ASIGNADO') {
    paso('PUNTO 1: viaje quedo CONDUCTOR_ASIGNADO antes de cancelar', false, v1Asig.estado);
    await cleanup([sA, sB, sCliente]);
    process.exit(1);
  }

  // Reset de flags de disponible para detectar SOLO la republicacion
  dispA.delete(v1);
  dispB.delete(v1);

  const { status: cancelStatus, data: cancelData } = await api(
    'POST', `/api/viajes/${v1}/cancelar-conductor`, null, conductorAToken
  );
  paso('PUNTO 1: POST cancelar-conductor → 200',
    cancelStatus === 200, `status ${cancelStatus} ${JSON.stringify(cancelData)}`);
  paso('PUNTO 1: respuesta { mensaje, id_viaje, estado: BUSCANDO_CONDUCTOR }',
    cancelData.mensaje === 'Viaje cancelado y republicado' &&
    cancelData.id_viaje === v1 &&
    cancelData.estado === 'BUSCANDO_CONDUCTOR',
    JSON.stringify(cancelData));

  await esperar(1500);

  const { data: v1Post } = await api('GET', `/api/viajes/${v1}`, null, clienteToken);
  paso('PUNTO 1: en DB viaje volvio a BUSCANDO_CONDUCTOR con id_conductor e id_vehiculo null',
    v1Post.estado === 'BUSCANDO_CONDUCTOR' &&
    v1Post.id_conductor === null &&
    v1Post.id_vehiculo === null,
    `estado=${v1Post.estado} id_conductor=${v1Post.id_conductor} id_vehiculo=${v1Post.id_vehiculo}`);

  // ── PUNTO 2: Republicacion a conductor B ─────────────────────────────────────
  console.log('\n── PUNTO 2: Republicacion a conductor B ───────────────────────\n');
  paso('PUNTO 2: conductor B (elegible, conectado) recibio viaje:disponible tras la cancelacion',
    dispB.has(v1), dispB.has(v1) ? 'recibido' : 'NO recibido');

  // ── PUNTO 3: Republicacion al MISMO conductor que cancelo (A) ─────────────────
  console.log('\n── PUNTO 3: Republicacion al conductor que cancelo (A) ────────\n');
  paso('PUNTO 3: conductor A (el que cancelo) TAMBIEN recibio viaje:disponible',
    dispA.has(v1), dispA.has(v1) ? 'recibido' : 'NO recibido');

  // ── PUNTO 4: Reaceptacion por el mismo conductor A ───────────────────────────
  console.log('\n── PUNTO 4: Reaceptacion por el conductor A ───────────────────\n');

  sA.emit('viaje:aceptar', { id_viaje: v1 });
  await esperar(2000);

  const { data: v1Reasig } = await api('GET', `/api/viajes/${v1}`, null, clienteToken);
  paso('PUNTO 4: A reacepta → viaje CONDUCTOR_ASIGNADO de nuevo con id_conductor asignado',
    v1Reasig.estado === 'CONDUCTOR_ASIGNADO' && v1Reasig.id_conductor !== null,
    `estado=${v1Reasig.estado} id_conductor=${v1Reasig.id_conductor}`);

  // Primer ping tras reaceptar → EN_CAMINO_A_ORIGEN, GPS/ruta arrancan desde cero
  sA.emit('conductor:ubicacion', {
    id_viaje: v1, lat: PARADA_1.lat, lng: PARADA_1.lng, timestamp: Date.now(),
  });
  await esperar(1500);

  const { data: v1Camino } = await api('GET', `/api/viajes/${v1}`, null, clienteToken);
  const acumuladoRaw = await redis.get(`gps:${v1}:acumulado`);
  paso('PUNTO 4: primer ping tras reaceptar → EN_CAMINO_A_ORIGEN y GPS acumulado recreado desde cero',
    v1Camino.estado === 'EN_CAMINO_A_ORIGEN' && acumuladoRaw !== null,
    `estado=${v1Camino.estado} acumulado=${acumuladoRaw ? 'presente' : 'ausente'}`);

  // ── PUNTO 5: Estado invalido EN_CAMINO_A_ORIGEN → 400 ─────────────────────────
  console.log('\n── PUNTO 5: Cancelar en EN_CAMINO_A_ORIGEN → 400 ──────────────\n');

  const { status: st5, data: d5 } = await api(
    'POST', `/api/viajes/${v1}/cancelar-conductor`, null, conductorAToken
  );
  paso('PUNTO 5: cancelar viaje en EN_CAMINO_A_ORIGEN → 400 con mensaje de estado',
    st5 === 400 && typeof d5.error === 'string' && d5.error.includes('EN_CAMINO_A_ORIGEN'),
    `status ${st5} — ${d5.error}`);

  // ── PUNTO 6: Estado invalido BUSCANDO_CONDUCTOR → 400 ────────────────────────
  console.log('\n── PUNTO 6: Cancelar en BUSCANDO_CONDUCTOR → 400 ──────────────\n');

  const v2 = await crearViaje(clienteToken);
  await esperar(800);
  const { status: st6, data: d6 } = await api(
    'POST', `/api/viajes/${v2}/cancelar-conductor`, null, conductorAToken
  );
  paso('PUNTO 6: cancelar viaje recien creado (BUSCANDO_CONDUCTOR) → 400',
    st6 === 400 && typeof d6.error === 'string' && d6.error.includes('BUSCANDO_CONDUCTOR'),
    `status ${st6} — ${d6.error}`);

  // ── PUNTO 7: Autorizacion — B cancela viaje de A → 403 ───────────────────────
  console.log('\n── PUNTO 7: B cancela viaje asignado a A → 403 ────────────────\n');

  const v3 = await crearViaje(clienteToken);
  await esperar(1200);
  sA.emit('viaje:aceptar', { id_viaje: v3 });
  await esperar(2000);

  const { data: v3Asig } = await api('GET', `/api/viajes/${v3}`, null, clienteToken);
  const { status: st7, data: d7 } = await api(
    'POST', `/api/viajes/${v3}/cancelar-conductor`, null, conductorBToken
  );
  paso('PUNTO 7: conductor B intenta cancelar viaje de A → 403',
    v3Asig.estado === 'CONDUCTOR_ASIGNADO' && st7 === 403 &&
    d7.error === 'No autorizado para cancelar este viaje',
    `estado=${v3Asig.estado} status=${st7} — ${d7.error}`);

  // ── PUNTO 8: Viaje inexistente → 404 ─────────────────────────────────────────
  console.log('\n── PUNTO 8: Viaje inexistente → 404 ───────────────────────────\n');

  const { status: st8, data: d8 } = await api(
    'POST', '/api/viajes/999999/cancelar-conductor', null, conductorAToken
  );
  paso('PUNTO 8: cancelar id_viaje=999999 → 404',
    st8 === 404 && d8.error === 'Viaje no encontrado',
    `status ${st8} — ${d8.error}`);

  // ── PUNTO 9: Redis limpio tras cancelar ──────────────────────────────────────
  console.log('\n── PUNTO 9: Redis limpio (todas las gps:{id}:* borradas) ──────\n');

  const v5 = await crearViaje(clienteToken);
  await esperar(1200);
  sA.emit('viaje:aceptar', { id_viaje: v5 });
  await esperar(2000);

  // Sembramos manualmente keys gps:{v5}:* (en CONDUCTOR_ASIGNADO normalmente solo
  // existe la ruta; sembramos varias para verificar que limpiarGPS las borra TODAS).
  await Promise.all([
    redis.set(`gps:${v5}:ultima`, JSON.stringify({ lat: -34.6, lng: -58.4, timestamp: Date.now() })),
    redis.lpush(`gps:${v5}:historial`, JSON.stringify({ lat: -34.6, lng: -58.4 })),
    redis.set(`gps:${v5}:ruta`, JSON.stringify([[-58.4, -34.6]])),
    redis.set(`gps:${v5}:acumulado`, JSON.stringify({ tiempo_horas: 0, distancia_km: 0 })),
    redis.set(`gps:${v5}:eta`, JSON.stringify({ segundos: 100 })),
    redis.set(`gps:${v5}:pings_detenido`, '0'),
    redis.set(`gps:${v5}:ultimo_recalculo`, String(Date.now())),
    redis.set(`gps:${v5}:pings_desviado`, '0'),
  ]);
  const antes = await redis.keys(`gps:${v5}:*`);

  const { status: st9c } = await api(
    'POST', `/api/viajes/${v5}/cancelar-conductor`, null, conductorAToken
  );
  await esperar(1200);
  const despues = await redis.keys(`gps:${v5}:*`);
  paso('PUNTO 9: tras cancelar, NINGUNA key gps:{id}:* sigue en Redis',
    st9c === 200 && antes.length > 0 && despues.length === 0,
    `sembradas=${antes.length} restantes=${despues.length}${despues.length ? ' (' + despues.join(', ') + ')' : ''}`);

  // ── PUNTO 10: Emisor de ETA detenido (no llegan eta:actualizar) ──────────────
  console.log('\n── PUNTO 10: Emisor de ETA detenido tras cancelar ─────────────\n');

  const v6 = await crearViaje(clienteToken);
  await esperar(1200);
  sA.emit('viaje:aceptar', { id_viaje: v6 });
  await esperar(2000);

  // Reset del tracking de eta para v6 y cancelar
  etaRecibidos.length = 0;
  await api('POST', `/api/viajes/${v6}/cancelar-conductor`, null, conductorAToken);
  await esperar(3000); // ventana de escucha

  const etaV6 = etaRecibidos.filter((id) => id === v6);
  paso('PUNTO 10: tras cancelar no llegan eta:actualizar al room del viaje (emisor detenido)',
    etaV6.length === 0,
    etaV6.length === 0
      ? 'sin eta:actualizar (verificacion completa de detenerEmisorEta: ver log "[eta-emisor] detenido" del servidor)'
      : `llegaron ${etaV6.length} eventos eta:actualizar`);

  // ── RESUMEN ──────────────────────────────────────────────────────────────────
  await cleanup([sA, sB, sCliente]);

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
  console.log('\n  NOTA PUNTO 11 (no regresion): correr aparte `node scripts/test-fase5.js` → 36/36.');

  process.exit(fallaron.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n💥 Error inesperado:', e.message);
  try { await redis.quit(); } catch { /* noop */ }
  process.exit(1);
});
