import { io } from 'socket.io-client';
import { spawn } from 'child_process';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const BASE = (port = 3000) => `http://localhost:${port}`;

const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

// ── Helpers ───────────────────────────────────────────────────────────────────

const checks = [];
function check(nombre, ok, detalle = '') {
  checks.push({ nombre, ok, detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Distancia geometrica simple (haversine) en metros.
function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function getToken(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error(`Firebase login fallido para ${email}: ${data.error?.message}`);
  return data.idToken;
}

async function api(method, path, body, token, port = 3000) {
  const res = await fetch(`${BASE(port)}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: `no-JSON (${res.status}): ${text.slice(0, 200)}` }; }
  return { status: res.status, data };
}

async function conectar(token, port = 3000) {
  return new Promise((resolve, reject) => {
    const s = io(BASE(port), { auth: { token: 'Bearer ' + token } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`connect_error: ${e.message}`)));
    setTimeout(() => reject(new Error('Timeout al conectar socket (8s)')), 8000);
  });
}

async function registrarSiNoExiste(datos, tipo) {
  const endpoint = tipo === 'cliente' ? '/api/auth/registro-cliente' : '/api/auth/registro-conductor';
  await api('POST', endpoint, datos, null);
}

function mismoFormatoPuntos(ruta) {
  return Array.isArray(ruta) && ruta.length > 0 &&
    ruta.every((p) => Array.isArray(p) && p.length === 2 &&
      typeof p[0] === 'number' && typeof p[1] === 'number');
}

async function cleanup(sockets) {
  for (const s of sockets) { try { s?.disconnect(); } catch {} }
}

// ── PART 7: server descartable con API key invalida ─────────────────────────────

async function testFallbackMapsCaido(clienteToken) {
  console.log('\n── PASO 7: Maps caido al crear → ruta_planeada null ───\n');

  const child = spawn('node', ['src/app.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '3001', GOOGLE_MAPS_API_KEY: 'CLAVE_INVALIDA_PARA_TEST_FALLBACK' },
  });
  let childLog = '';
  child.stdout.on('data', (d) => { childLog += d.toString(); });
  child.stderr.on('data', (d) => { childLog += d.toString(); });

  // Esperar boot (hasta 12s).
  let arranco = false;
  for (let i = 0; i < 60; i++) {
    if (childLog.includes('puerto 3001')) { arranco = true; break; }
    await esperar(200);
  }
  if (!arranco) {
    child.kill();
    check('Server de fallback (key invalida) arranco en :3001', false, 'no arranco — ' + childLog.slice(0, 200));
    return;
  }
  await esperar(500); // que termine de inicializar sockets/redis

  const fechaViaje = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const { status, data } = await api('POST', '/api/viajes', {
    zona: 'CABA', fecha_programada: fechaViaje, condiciones_requeridas: [],
    paradas: [PARADA_1, PARADA_2],
  }, clienteToken, 3001);

  await esperar(900); // dar tiempo a que el server loguee el error de ruta

  check('POST /api/viajes igual devuelve 201 con Maps caido', status === 201, `status ${status}`);
  check('ruta_planeada es null cuando Maps falla al crear',
    data.ruta_planeada === null, `ruta_planeada = ${JSON.stringify(data.ruta_planeada)}`);
  check('El error de ruta se logueo en el servidor',
    /No se pudo calcular la ruta planeada/.test(childLog),
    /No se pudo calcular la ruta planeada/.test(childLog) ? 'log encontrado' : 'log NO encontrado');

  child.kill();
  await esperar(500);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║     TEST RUTA PLANEADA → FRONT — FLETER               ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const sockets = [];

  // ── PASO 1: Autenticacion ──────────────────────────────────────────────────
  console.log('── PASO 1: Autenticacion ──────────────────────────────\n');

  await registrarSiNoExiste({
    nombre: 'Test', apellido: 'Cliente', dni: '11111111',
    email: 'cliente@test.com', contrasena: 'test123456',
  }, 'cliente');
  await registrarSiNoExiste({
    nombre: 'Conductor', apellido: 'Uno', dni: '22222222',
    email: 'conductor@test.com', contrasena: 'test123456',
    nro_licencia: 'LIC001', licencia_vencimiento: '2028-01-01T00:00:00.000Z',
  }, 'conductor');

  const clienteToken = await getToken('cliente@test.com', 'test123456');
  const conductorToken = await getToken('conductor@test.com', 'test123456');
  await api('POST', '/api/conductores/mis-vehiculos', {
    patente: 'FLT001', marca: 'Ford', modelo: 'Transit', anio: 2020, color: 'Blanco', tipo_vehiculo: 'furgon',
  }, conductorToken);
  check('Tokens + vehiculo del conductor listos', true);

  // ── PASO 2: POST /api/viajes incluye ruta_planeada ──────────────────────────
  console.log('\n── PASO 2: POST /api/viajes → ruta_planeada ───────────\n');

  const fechaViaje = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const { status: sv, data: viaje } = await api('POST', '/api/viajes', {
    zona: 'CABA', fecha_programada: fechaViaje, condiciones_requeridas: [],
    paradas: [PARADA_1, PARADA_2],
  }, clienteToken);
  check('POST /api/viajes → 201', sv === 201, sv !== 201 ? JSON.stringify(viaje) : `id ${viaje.id_viaje}`);
  if (sv !== 201) { await cleanup(sockets); process.exit(1); }

  const id_viaje = viaje.id_viaje;
  const rutaPost = viaje.ruta_planeada;

  check('Respuesta incluye ruta_planeada como array no vacio',
    Array.isArray(rutaPost) && rutaPost.length > 0, `${rutaPost?.length ?? 0} puntos`);
  check('Cada elemento es [lng, lat] (2 numeros)', mismoFormatoPuntos(rutaPost), '');

  const primer = rutaPost?.[0];
  const ultimo = rutaPost?.[rutaPost.length - 1];
  const distPrimer = primer ? distanciaMetros(primer[1], primer[0], PARADA_1.lat, PARADA_1.lng) : Infinity;
  const distUltimo = ultimo ? distanciaMetros(ultimo[1], ultimo[0], PARADA_2.lat, PARADA_2.lng) : Infinity;
  check('Primer punto cerca de la parada 1 (<200m)', distPrimer < 200, `${Math.round(distPrimer)}m`);
  check('Ultimo punto cerca de la parada 2 (<200m)', distUltimo < 200, `${Math.round(distUltimo)}m`);

  // ── PASO 3: GET /api/viajes/:id incluye la misma ruta ───────────────────────
  console.log('\n── PASO 3: GET /api/viajes/:id → ruta_planeada ────────\n');

  const { data: viajeGet } = await api('GET', `/api/viajes/${id_viaje}`, null, clienteToken);
  const rutaGet = viajeGet.ruta_planeada;
  check('GET incluye ruta_planeada', mismoFormatoPuntos(rutaGet), `${rutaGet?.length ?? 0} puntos`);
  check('GET tiene mismo primer y ultimo punto que el POST',
    !!rutaGet && JSON.stringify(rutaGet[0]) === JSON.stringify(primer) &&
      JSON.stringify(rutaGet[rutaGet.length - 1]) === JSON.stringify(ultimo),
    rutaGet ? `primero=${JSON.stringify(rutaGet[0])}` : 'sin ruta');

  // ── PASO 4 y 5: viaje:conductor_asignado con ruta_planeada ──────────────────
  console.log('\n── PASO 4-5: viaje:conductor_asignado → ruta_planeada ─\n');

  const sCliente = await conectar(clienteToken);
  const sConductor = await conectar(conductorToken);
  sockets.push(sCliente, sConductor);

  let asignadoConductor = null;
  let asignadoCliente = null;
  const etaEvents = [];
  const rutaRecalcEvents = [];
  sConductor.on('viaje:conductor_asignado', (d) => { asignadoConductor = d; });
  sCliente.on('viaje:conductor_asignado', (d) => { asignadoCliente = d; });
  // Filtramos por id_viaje: el cliente puede estar unido a rooms de otros
  // viajes activos suyos y recibir sus eta:actualizar/ruta:recalculada.
  sCliente.on('eta:actualizar', (d) => { if (d.id_viaje === id_viaje) etaEvents.push({ t: Date.now(), ...d }); });
  sCliente.on('ruta:recalculada', (d) => { if (d.id_viaje === id_viaje) rutaRecalcEvents.push({ t: Date.now(), ...d }); });

  await esperar(1500); // joins de room
  sConductor.emit('viaje:aceptar', { id_viaje });
  await esperar(2500);

  check('Conductor recibe viaje:conductor_asignado con ruta_planeada',
    !!asignadoConductor && mismoFormatoPuntos(asignadoConductor.ruta_planeada),
    asignadoConductor ? `${asignadoConductor.ruta_planeada?.length ?? 0} puntos` : 'no llego el evento');
  check('Cliente recibe viaje:conductor_asignado con ruta_planeada',
    !!asignadoCliente && mismoFormatoPuntos(asignadoCliente.ruta_planeada),
    asignadoCliente ? `${asignadoCliente.ruta_planeada?.length ?? 0} puntos` : 'no llego el evento');

  // ── PASO 6: ETA + recalculo siguen funcionando ─────────────────────────────
  console.log('\n── PASO 6: ETA y recalculo por desvio intactos ────────\n');

  // 1 ping sobre la ruta → arranca emisor de ETA.
  const medio = rutaPost[Math.floor(rutaPost.length / 2)];
  let ts = Date.now();
  sConductor.emit('conductor:ubicacion', { id_viaje, lat: medio[1], lng: medio[0], timestamp: ts });
  await esperar(2500);
  check('Llega eta:actualizar tras ping sobre la ruta',
    etaEvents.length >= 1, `${etaEvents.length} eventos`);

  // Pasar a EN_RUTA y desviar.
  await api('PATCH', `/api/viajes/${id_viaje}/estado`, { estado: 'CARGANDO' }, conductorToken);
  await api('PATCH', `/api/viajes/${id_viaje}/estado`, { estado: 'EN_RUTA' }, conductorToken);

  const DESVIO = { lat: medio[1] + 0.02, lng: medio[0] + 0.02 }; // ~2 km fuera de la ruta
  ts = Date.now();
  sConductor.emit('conductor:ubicacion', { id_viaje, lat: DESVIO.lat, lng: DESVIO.lng, timestamp: ts });
  await esperar(1500);
  sConductor.emit('conductor:ubicacion', { id_viaje, lat: DESVIO.lat + 0.0005, lng: DESVIO.lng + 0.0005, timestamp: ts + 3000 });
  await esperar(3000);

  const recalc = rutaRecalcEvents[rutaRecalcEvents.length - 1];
  check('2 pings desviados → llega ruta:recalculada',
    rutaRecalcEvents.length >= 1, `${rutaRecalcEvents.length} recalculos`);
  check('nueva_ruta tiene formato [lng, lat] y difiere de la ruta_planeada original',
    !!recalc && mismoFormatoPuntos(recalc.nueva_ruta) &&
      JSON.stringify(recalc.nueva_ruta) !== JSON.stringify(rutaPost),
    recalc ? `${recalc.nueva_ruta?.length} puntos (original ${rutaPost.length})` : 'sin recalculo');

  await cleanup(sockets);

  // ── PASO 7: fallback Maps caido ─────────────────────────────────────────────
  await testFallbackMapsCaido(clienteToken);

  // ── RESUMEN ─────────────────────────────────────────────────────────────────
  const ok = checks.filter((c) => c.ok).length;
  const fallaron = checks.filter((c) => !c.ok);

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║                      RESUMEN                          ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
  checks.forEach((c) => console.log(`  ${c.ok ? '✅' : '❌'} ${c.nombre}`));
  console.log(`\n  ${ok}/${checks.length} checks pasaron`);
  if (fallaron.length) {
    console.log('\n  Fallaron:');
    fallaron.forEach((c) => console.log(`    ❌ ${c.nombre}${c.detalle ? ': ' + c.detalle : ''}`));
  }
  process.exit(fallaron.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n💥 Error inesperado:', e.message, e.stack);
  process.exit(1);
});
