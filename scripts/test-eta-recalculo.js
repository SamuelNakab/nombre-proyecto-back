import { io } from 'socket.io-client';
import redis from '../src/config/redis.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const BASE = 'http://localhost:3000';

// Paradas reales en CABA. El conductor arranca lejos de la parada 1 para que el
// ETA inicial sea > 0.
const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

// Posiciones de arranque (Caballito, ~3 km de Plaza de Mayo) para el ETA.
const INICIO_1 = { lat: -34.6180, lng: -58.4400 };
const INICIO_2 = { lat: -34.6150, lng: -58.4350 };

// Puntos claramente fuera de cualquier ruta entre las paradas (> 2 km).
const DESVIO_A = { lat: -34.6287, lng: -58.4066 }; // SO de Plaza de Mayo
const DESVIO_B = { lat: -34.5787, lng: -58.4066 }; // NO, lejos de la ruta nueva

// ── Helpers ───────────────────────────────────────────────────────────────────

const checks = [];
function check(nombre, ok, detalle = '') {
  checks.push({ nombre, ok, detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function api(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: `no-JSON (${res.status}): ${text.slice(0, 200)}` }; }
  return { status: res.status, data };
}

async function conectar(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token: 'Bearer ' + token } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`connect_error: ${e.message}`)));
    setTimeout(() => reject(new Error('Timeout al conectar socket (8s)')), 8000);
  });
}

async function registrarSiNoExiste(datos, tipo) {
  const endpoint = tipo === 'cliente' ? '/api/auth/registro-cliente' : '/api/auth/registro-conductor';
  await api('POST', endpoint, datos, null);
}

async function cleanup(sCond, sCli) {
  try { sCond?.disconnect(); } catch {}
  try { sCli?.disconnect(); } catch {}
  try { await redis.quit(); } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║      TEST ETA EN VIVO + RECALCULO DE RUTA — FLETER    ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  let sConductor = null, sCliente = null;

  // Eventos recibidos por el cliente (con marca de tiempo de recepcion).
  const etaEvents = [];
  const rutaEvents = [];

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
  check('Tokens obtenidos (cliente y conductor)', true);

  await api('POST', '/api/conductores/mis-vehiculos', {
    patente: 'FLT001', marca: 'Ford', modelo: 'Transit', anio: 2020, color: 'Blanco', tipo_vehiculo: 'furgon',
  }, conductorToken); // 409 si ya existe → OK
  check('Vehiculo del conductor disponible (FLT001)', true);

  // ── PASO 2: Crear viaje ─────────────────────────────────────────────────────
  console.log('\n── PASO 2: Crear viaje (2 paradas, CABA) ──────────────\n');

  const fechaViaje = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const { status: sv, data: viajeData } = await api('POST', '/api/viajes', {
    zona: 'CABA', fecha_programada: fechaViaje, condiciones_requeridas: [],
    paradas: [PARADA_1, PARADA_2],
  }, clienteToken);
  check('POST /api/viajes → 201', sv === 201, sv !== 201 ? JSON.stringify(viajeData) : '');
  if (sv !== 201) { await cleanup(); process.exit(1); }
  const id_viaje = viajeData.id_viaje;
  console.log(`  viaje id = ${id_viaje}`);

  // ── PASO 3: Sockets + aceptar viaje ─────────────────────────────────────────
  console.log('\n── PASO 3: Conectar sockets y aceptar viaje ───────────\n');

  sCliente = await conectar(clienteToken);   // se une al room del viaje (BUSCANDO_CONDUCTOR)
  sConductor = await conectar(conductorToken);

  // Filtramos por id_viaje: el cliente puede estar unido a rooms de otros
  // viajes activos suyos y recibir sus eta:actualizar/ruta:recalculada. El
  // payload trae id_viaje justamente para distinguirlos.
  sCliente.on('eta:actualizar', (d) => { if (d.id_viaje === id_viaje) etaEvents.push({ t: Date.now(), ...d }); });
  sCliente.on('ruta:recalculada', (d) => { if (d.id_viaje === id_viaje) rutaEvents.push({ t: Date.now(), ...d }); });

  await esperar(1500); // esperar joins de room

  sConductor.emit('viaje:aceptar', { id_viaje });
  await esperar(2500);

  const { data: vAsig } = await api('GET', `/api/viajes/${id_viaje}`, null, clienteToken);
  check('Viaje en CONDUCTOR_ASIGNADO', vAsig.estado === 'CONDUCTOR_ASIGNADO', vAsig.estado);
  if (vAsig.estado !== 'CONDUCTOR_ASIGNADO') { await cleanup(sConductor, sCliente); process.exit(1); }

  // ── PASO 4: Pings iniciales → arranca ETA ───────────────────────────────────
  console.log('\n── PASO 4: Pings iniciales (lejos de parada 1) ────────\n');

  let ts = Date.now();
  sConductor.emit('conductor:ubicacion', { id_viaje, lat: INICIO_1.lat, lng: INICIO_1.lng, timestamp: ts });
  await esperar(2500);
  sConductor.emit('conductor:ubicacion', { id_viaje, lat: INICIO_2.lat, lng: INICIO_2.lng, timestamp: ts + 3000 });
  await esperar(2500);

  const { data: vGps } = await api('GET', `/api/viajes/${id_viaje}`, null, clienteToken);
  check('Primer ping → EN_CAMINO_A_ORIGEN', vGps.estado === 'EN_CAMINO_A_ORIGEN', vGps.estado);

  const primerEta = etaEvents[0];
  check('Llego al menos un eta:actualizar con segundos_restantes > 0',
    !!primerEta && primerEta.segundos_restantes > 0,
    primerEta ? `segundos=${primerEta.segundos_restantes}, minutos=${primerEta.minutos_restantes}, parada=${primerEta.proxima_parada_id}` : 'ningun evento');

  check('Estado ETA persistido en Redis (gps:{id}:eta)',
    !!(await redis.get(`gps:${id_viaje}:eta`)), '');

  // ── PASO 5: Countdown local (esperar > 30s) ─────────────────────────────────
  console.log('\n── PASO 5: Countdown local — esperando 37s ────────────\n');

  const etaCountStart = etaEvents.length;
  const etaAntes = etaEvents[etaEvents.length - 1];
  await esperar(37000);
  const nuevos = etaEvents.slice(etaCountStart);
  const etaDespues = etaEvents[etaEvents.length - 1];

  check('Llego otro eta:actualizar durante la espera (tick de 30s)',
    nuevos.length >= 1, `${nuevos.length} eventos nuevos`);
  check('El countdown DECRECIO (segundos_restantes menor al anterior)',
    !!etaAntes && !!etaDespues && etaDespues.segundos_restantes < etaAntes.segundos_restantes,
    etaAntes && etaDespues ? `antes=${etaAntes.segundos_restantes}s → despues=${etaDespues.segundos_restantes}s` : 'faltan eventos');

  // ── PASO 6: Transicion a EN_RUTA + pings sobre la ruta ──────────────────────
  console.log('\n── PASO 6: Pasar a EN_RUTA y pings sobre la ruta ──────\n');

  await api('PATCH', `/api/viajes/${id_viaje}/estado`, { estado: 'CARGANDO' }, conductorToken);
  const { data: enRuta } = await api('PATCH', `/api/viajes/${id_viaje}/estado`, { estado: 'EN_RUTA' }, conductorToken);
  check('Viaje en EN_RUTA', enRuta.estado_nuevo === 'EN_RUTA', enRuta.estado_nuevo);

  const rutaRaw = await redis.get(`gps:${id_viaje}:ruta`);
  const ruta = rutaRaw ? JSON.parse(rutaRaw) : [];
  check('Ruta cargada en Redis con puntos', Array.isArray(ruta) && ruta.length >= 2, `${ruta.length} puntos`);

  // Pings sobre la ruta (no deben disparar recalculo).
  const rutaRecalcAntes = rutaEvents.length;
  ts = Date.now();
  for (let i = 0; i < 2; i++) {
    const p = ruta[Math.floor((ruta.length - 1) * (i === 0 ? 0.3 : 0.5))]; // [lng, lat]
    sConductor.emit('conductor:ubicacion', { id_viaje, lat: p[1], lng: p[0], timestamp: ts + i * 3000 });
    await esperar(1200);
  }
  check('Pings sobre la ruta NO dispararon recalculo',
    rutaEvents.length === rutaRecalcAntes, `recalculos: ${rutaEvents.length - rutaRecalcAntes}`);

  // ── PASO 7: Desvio (2 pings consecutivos) → recalculo ───────────────────────
  console.log('\n── PASO 7: 2 pings desviados → ruta:recalculada ───────\n');

  const etaAntesRecalc = etaEvents.length;
  ts = Date.now();
  sConductor.emit('conductor:ubicacion', { id_viaje, lat: DESVIO_A.lat, lng: DESVIO_A.lng, timestamp: ts });
  await esperar(1500);
  check('1er ping desviado NO recalcula todavia',
    rutaEvents.length === rutaRecalcAntes, `recalculos: ${rutaEvents.length - rutaRecalcAntes}`);

  sConductor.emit('conductor:ubicacion', { id_viaje, lat: DESVIO_A.lat + 0.0005, lng: DESVIO_A.lng + 0.0005, timestamp: ts + 3000 });
  await esperar(3000);

  const recalc1 = rutaEvents[rutaEvents.length - 1];
  check('2do ping desviado → llego ruta:recalculada',
    rutaEvents.length === rutaRecalcAntes + 1,
    `recalculos: ${rutaEvents.length - rutaRecalcAntes}`);
  check('ruta:recalculada trae nueva_ruta no vacia',
    !!recalc1 && Array.isArray(recalc1.nueva_ruta) && recalc1.nueva_ruta.length >= 2,
    recalc1 ? `${recalc1.nueva_ruta?.length} puntos, motivo=${recalc1.motivo}, parada=${recalc1.proxima_parada_id}` : 'sin evento');

  const etaPostRecalc = etaEvents.slice(etaAntesRecalc);
  const etaDespuesDeRuta = recalc1 ? etaPostRecalc.find((e) => e.t >= recalc1.t) : null;
  check('Inmediatamente despues llego un eta:actualizar nuevo',
    !!etaDespuesDeRuta,
    etaDespuesDeRuta ? `segundos=${etaDespuesDeRuta.segundos_restantes}` : 'no llego eta tras recalculo');

  check('ultimo_recalculo guardado en Redis',
    !!(await redis.get(`gps:${id_viaje}:ultimo_recalculo`)), '');

  // ── PASO 8: Cooldown — desvio nuevo antes de 120s → NO recalcula ────────────
  console.log('\n── PASO 8: Cooldown — otro desvio antes de 120s ───────\n');

  const recalcAntesCooldown = rutaEvents.length;
  ts = Date.now();
  sConductor.emit('conductor:ubicacion', { id_viaje, lat: DESVIO_B.lat, lng: DESVIO_B.lng, timestamp: ts });
  await esperar(1500);
  sConductor.emit('conductor:ubicacion', { id_viaje, lat: DESVIO_B.lat + 0.0005, lng: DESVIO_B.lng + 0.0005, timestamp: ts + 3000 });
  await esperar(2500);

  check('Cooldown activo: NO llego otro ruta:recalculada',
    rutaEvents.length === recalcAntesCooldown,
    `recalculos extra: ${rutaEvents.length - recalcAntesCooldown}`);

  // ── RESUMEN ─────────────────────────────────────────────────────────────────
  await cleanup(sConductor, sCliente);

  const ok = checks.filter((c) => c.ok).length;
  const fallaron = checks.filter((c) => !c.ok);

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║                      RESUMEN                          ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
  checks.forEach((c) => console.log(`  ${c.ok ? '✅' : '❌'} ${c.nombre}`));
  console.log(`\n  ${ok}/${checks.length} checks pasaron`);
  console.log(`  eta:actualizar recibidos: ${etaEvents.length} | ruta:recalculada recibidos: ${rutaEvents.length}`);
  if (fallaron.length) {
    console.log('\n  Fallaron:');
    fallaron.forEach((c) => console.log(`    ❌ ${c.nombre}${c.detalle ? ': ' + c.detalle : ''}`));
  }
  process.exit(fallaron.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n💥 Error inesperado:', e.message, e.stack);
  try { await redis.quit(); } catch {}
  process.exit(1);
});
