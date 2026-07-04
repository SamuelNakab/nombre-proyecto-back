import { io } from 'socket.io-client';
import { execFileSync } from 'child_process';
import redis from '../src/config/redis.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const BASE = 'http://localhost:3000';

const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

// Credenciales del admin de prueba (se crea via crear-admin.js si no existe).
const ADMIN = {
  ADMIN_EMAIL: 'admin-test@fleter.com',
  ADMIN_PASSWORD: 'admintest123',
  ADMIN_NOMBRE: 'Admin',
  ADMIN_APELLIDO: 'Test',
  ADMIN_DNI: '90000001',
};

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
  if (status !== 201) throw new Error(`No se pudo crear viaje (${status}): ${JSON.stringify(data)}`);
  return data.id_viaje;
}

// Lleva un viaje recien creado hasta FINALIZADO (flujo completo estilo fase 5).
async function finalizarViaje(clienteToken, conductorToken, sConductor) {
  const id_viaje = await crearViaje(clienteToken);
  await esperar(1200);
  sConductor.emit('viaje:aceptar', { id_viaje });
  await esperar(2000);
  sConductor.emit('conductor:ubicacion', { id_viaje, lat: PARADA_1.lat, lng: PARADA_1.lng, timestamp: Date.now() });
  await esperar(1000);
  await api('PATCH', `/api/viajes/${id_viaje}/estado`, { estado: 'EN_RUTA' }, conductorToken);
  const { data: qrs } = await api('GET', `/api/viajes/${id_viaje}/qr-paradas`, null, clienteToken);
  const ordenadas = qrs.sort((a, b) => a.orden - b.orden);
  await api('POST', `/api/viajes/${id_viaje}/confirmar-parada`,
    { qr_firmado: ordenadas[0].qr_firmado, lat: PARADA_1.lat, lng: PARADA_1.lng }, conductorToken);
  const { data: conf2 } = await api('POST', `/api/viajes/${id_viaje}/confirmar-parada`,
    { qr_firmado: ordenadas[1].qr_firmado, lat: PARADA_2.lat, lng: PARADA_2.lng }, conductorToken);
  if (!conf2.viaje_finalizado) throw new Error(`El viaje ${id_viaje} no finalizo: ${JSON.stringify(conf2)}`);
  return id_viaje;
}

async function cleanup(sockets) {
  for (const s of sockets) { try { s?.disconnect(); } catch { /* noop */ } }
  try { await redis.quit(); } catch { /* noop */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║        TEST PANEL ADMIN — FLETER            ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  let sConductor = null, sCliente = null;

  // ── SETUP ────────────────────────────────────────────────────────────────────
  console.log('── SETUP: admin + cliente + conductor + vehiculo ──────────────\n');

  // Crear admin (idempotente) via crear-admin.js con env de test
  try {
    const out = execFileSync('node', ['scripts/crear-admin.js'], {
      env: { ...process.env, ...ADMIN },
      encoding: 'utf8',
    });
    console.log('  [crear-admin.js] ' + out.trim().split('\n').join('\n  [crear-admin.js] '));
  } catch (e) {
    console.error('  crear-admin.js fallo:', e.stdout || e.message);
    throw e;
  }

  await registrarSiNoExiste({
    nombre: 'Test', apellido: 'Cliente', dni: '11111111',
    email: 'cliente@test.com', contrasena: 'test123456',
  }, 'cliente');
  await registrarSiNoExiste({
    nombre: 'Conductor', apellido: 'Uno', dni: '22222222',
    email: 'conductor@test.com', contrasena: 'test123456',
    nro_licencia: 'LIC001', licencia_vencimiento: '2028-01-01T00:00:00.000Z',
  }, 'conductor');

  const adminToken = await getToken(ADMIN.ADMIN_EMAIL, ADMIN.ADMIN_PASSWORD);
  const clienteToken = await getToken('cliente@test.com', 'test123456');
  const conductorToken = await getToken('conductor@test.com', 'test123456');
  await crearVehiculoSiNoExiste(conductorToken, 'FLT001');
  console.log('  Admin, cliente y conductor autenticados; vehiculo FLT001 listo.\n');

  sConductor = await conectar(conductorToken);
  sCliente = await conectar(clienteToken);

  // ── Poblar viajes en distintos estados ───────────────────────────────────────
  console.log('── Poblando viajes de prueba ──────────────────────────────────\n');

  const vBusca = await crearViaje(clienteToken);          // BUSCANDO_CONDUCTOR
  const vFinal = await finalizarViaje(clienteToken, conductorToken, sConductor); // FINALIZADO
  console.log(`  Viaje BUSCANDO_CONDUCTOR: ${vBusca}`);
  console.log(`  Viaje FINALIZADO: ${vFinal}\n`);

  // ── 1. GET /api/admin/usuarios ───────────────────────────────────────────────
  console.log('── CHECK 1: GET /api/admin/usuarios ───────────────────────────\n');
  const { status: s1, data: d1 } = await api('GET', '/api/admin/usuarios?limit=200', null, adminToken);
  const contieneAdmin = Array.isArray(d1.usuarios) && d1.usuarios.some((u) => u.email === ADMIN.ADMIN_EMAIL);
  paso('CHECK 1: GET /api/admin/usuarios → 200 con total/page/limit y usuarios de prueba',
    s1 === 200 && typeof d1.total === 'number' && d1.page === 1 && d1.limit === 200 && contieneAdmin,
    `status=${s1} total=${d1.total} contieneAdmin=${contieneAdmin}`);

  // ── 2. GET /api/admin/usuarios?rol=CONDUCTOR ─────────────────────────────────
  const { status: s2, data: d2 } = await api('GET', '/api/admin/usuarios?rol=CONDUCTOR&limit=200', null, adminToken);
  const todosConductores = Array.isArray(d2.usuarios) && d2.usuarios.length > 0 && d2.usuarios.every((u) => u.rol === 'CONDUCTOR');
  paso('CHECK 2: ?rol=CONDUCTOR devuelve solo conductores', s2 === 200 && todosConductores,
    `status=${s2} n=${d2.usuarios?.length} todos=${todosConductores}`);

  // ── 3. GET /api/admin/usuarios?rol=INVALIDO → 400 ────────────────────────────
  const { status: s3 } = await api('GET', '/api/admin/usuarios?rol=INVALIDO', null, adminToken);
  paso('CHECK 3: ?rol=INVALIDO → 400', s3 === 400, `status=${s3}`);

  // ── 4. GET usuarios/:id como CLIENTE (no admin) → 403 ────────────────────────
  const { status: s4 } = await api('GET', '/api/admin/usuarios/1', null, clienteToken);
  paso('CHECK 4: usuarios/:id con token CLIENTE → 403', s4 === 403, `status=${s4}`);

  // ── 5. GET usuarios/:id de un conductor → incluye vehiculos y calificacion ───
  const conductorItem = d2.usuarios.find((u) => u.email === 'conductor@test.com') ?? d2.usuarios[0];
  const { status: s5, data: d5 } = await api('GET', `/api/admin/usuarios/${conductorItem.id_usuario}`, null, adminToken);
  const tieneVehiculos = Array.isArray(d5.conductor?.vehiculos) && d5.conductor.vehiculos.length > 0;
  const tieneCalif = typeof d5.conductor?.calificacion_promedio === 'number';
  paso('CHECK 5: detalle de conductor incluye vehiculos y calificacion_promedio',
    s5 === 200 && tieneVehiculos && tieneCalif,
    `status=${s5} vehiculos=${d5.conductor?.vehiculos?.length} calif=${d5.conductor?.calificacion_promedio}`);

  // ── 6. GET usuarios/:id inexistente → 404 ────────────────────────────────────
  const { status: s6 } = await api('GET', '/api/admin/usuarios/999999', null, adminToken);
  paso('CHECK 6: usuarios/:id inexistente → 404', s6 === 404, `status=${s6}`);

  // ── 7. GET viajes?estado=BUSCANDO_CONDUCTOR ──────────────────────────────────
  const { status: s7, data: d7 } = await api('GET', '/api/admin/viajes?estado=BUSCANDO_CONDUCTOR&limit=200', null, adminToken);
  const todosBuscando = Array.isArray(d7.viajes) && d7.viajes.length > 0 && d7.viajes.every((v) => v.estado === 'BUSCANDO_CONDUCTOR');
  paso('CHECK 7: ?estado=BUSCANDO_CONDUCTOR filtra bien', s7 === 200 && todosBuscando,
    `status=${s7} n=${d7.viajes?.length} todos=${todosBuscando}`);

  // ── 8. GET viajes?cantidad_paradas=2 ─────────────────────────────────────────
  const { status: s8, data: d8 } = await api('GET', '/api/admin/viajes?cantidad_paradas=2&limit=200', null, adminToken);
  const todos2Paradas = Array.isArray(d8.viajes) && d8.viajes.length > 0 && d8.viajes.every((v) => v._count?.paradas === 2);
  paso('CHECK 8: ?cantidad_paradas=2 filtra bien', s8 === 200 && todos2Paradas,
    `status=${s8} n=${d8.viajes?.length} todos2=${todos2Paradas}`);

  // ── 9. GET viajes?zona=CABA&desde&hasta ──────────────────────────────────────
  const desde = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const hasta = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { status: s9, data: d9 } = await api('GET',
    `/api/admin/viajes?zona=CABA&desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}&limit=200`, null, adminToken);
  const combinaOk = Array.isArray(d9.viajes) && d9.viajes.length > 0 &&
    d9.viajes.every((v) => v.zona === 'CABA' && new Date(v.creado_en) >= new Date(desde) && new Date(v.creado_en) <= new Date(hasta));
  paso('CHECK 9: ?zona=CABA&desde&hasta combina filtros', s9 === 200 && combinaOk,
    `status=${s9} n=${d9.viajes?.length} ok=${combinaOk}`);

  // ── 10. GET viajes/:id detalle completo ──────────────────────────────────────
  const { status: s10, data: d10 } = await api('GET', `/api/admin/viajes/${vFinal}`, null, adminToken);
  const detalleOk = s10 === 200 && Array.isArray(d10.paradas) && d10.cliente?.usuario &&
    d10.conductor?.usuario && 'fee' in d10 && 'remito_url' in d10 && typeof d10.precio_real === 'number';
  paso('CHECK 10: viajes/:id detalle completo (paradas, cliente, conductor, fee, remito_url)',
    detalleOk, `status=${s10} fee=${d10.fee} remito=${d10.remito_url ? 'si' : 'no'}`);

  // ── 11. GET estadisticas ─────────────────────────────────────────────────────
  const { status: s11, data: d11 } = await api('GET', '/api/admin/estadisticas', null, adminToken);
  const estOk = s11 === 200 && d11.usuarios && d11.viajes && d11.plata &&
    typeof d11.usuarios.total === 'number' && d11.usuarios.por_rol &&
    Array.isArray(d11.usuarios.registrados_por_dia_ultimos_30_dias) &&
    d11.viajes.por_estado && Array.isArray(d11.viajes.por_dia_ultimos_30_dias) &&
    Array.isArray(d11.plata.top_conductores_por_ganancia) &&
    Array.isArray(d11.plata.top_clientes_por_gasto);
  const totalP = d11.plata?.total_precio_real_finalizados ?? 0;
  const suma = (d11.plata?.total_fee_app ?? 0) + (d11.plata?.total_neto_conductores ?? 0);
  const coherente = Math.abs(suma - totalP) < 0.01;
  paso('CHECK 11: estadisticas estructura + fee+neto==total_precio_real_finalizados',
    estOk && coherente,
    `status=${s11} total=${totalP.toFixed(2)} fee+neto=${suma.toFixed(2)} coherente=${coherente}`);

  // ── 12. POST cancelar en BUSCANDO_CONDUCTOR → 200 CANCELADO + motivo ──────────
  const { status: s12, data: d12 } = await api('POST', `/api/admin/viajes/${vBusca}/cancelar`, { motivo: 'test admin BUSCANDO' }, adminToken);
  const { data: v12 } = await api('GET', `/api/admin/viajes/${vBusca}`, null, adminToken);
  paso('CHECK 12: cancelar BUSCANDO_CONDUCTOR → 200, CANCELADO, motivo guardado',
    s12 === 200 && d12.estado === 'CANCELADO' && v12.estado === 'CANCELADO' && v12.motivo_cancelacion === 'test admin BUSCANDO',
    `status=${s12} estado=${v12.estado} motivo=${v12.motivo_cancelacion}`);

  // ── 13/17/18. cancelar en CONDUCTOR_ASIGNADO → 200, Redis limpio, eventos WS ──
  const vAsig = await crearViaje(clienteToken);
  await esperar(1200);
  sConductor.emit('viaje:aceptar', { id_viaje: vAsig });
  await esperar(2000);
  const { data: vAsigCheck } = await api('GET', `/api/admin/viajes/${vAsig}`, null, adminToken);

  // Sembrar keys gps para verificar que limpiarViajeActivo las borra
  await Promise.all([
    redis.set(`gps:${vAsig}:ultima`, JSON.stringify({ lat: -34.6, lng: -58.4, timestamp: Date.now() })),
    redis.set(`gps:${vAsig}:acumulado`, JSON.stringify({ tiempo_horas: 0, distancia_km: 0 })),
    redis.set(`gps:${vAsig}:ruta`, JSON.stringify([[-58.4, -34.6]])),
    redis.set(`gps:${vAsig}:eta`, JSON.stringify({ segundos: 100 })),
  ]);

  let condEvento = null, cliEvento = null;
  sConductor.on('viaje:cancelado_por_admin', (d) => { if (d.id_viaje === vAsig) condEvento = d; });
  sCliente.on('viaje:cancelado_por_admin', (d) => { if (d.id_viaje === vAsig) cliEvento = d; });

  const { status: s13 } = await api('POST', `/api/admin/viajes/${vAsig}/cancelar`, { motivo: 'test admin ASIGNADO' }, adminToken);
  await esperar(1500);
  const { data: v13 } = await api('GET', `/api/admin/viajes/${vAsig}`, null, adminToken);
  const keysAsig = await redis.keys(`gps:${vAsig}:*`);
  paso('CHECK 13: cancelar CONDUCTOR_ASIGNADO → 200, CANCELADO, Redis limpio',
    vAsigCheck.estado === 'CONDUCTOR_ASIGNADO' && s13 === 200 && v13.estado === 'CANCELADO' && keysAsig.length === 0,
    `estadoPrevio=${vAsigCheck.estado} status=${s13} estado=${v13.estado} keysRestantes=${keysAsig.length}`);
  paso('CHECK 17: evento viaje:cancelado_por_admin recibido por el conductor (room del viaje)',
    condEvento !== null && condEvento.estado === 'CANCELADO' && condEvento.motivo === 'test admin ASIGNADO',
    condEvento ? JSON.stringify(condEvento) : 'no recibido');
  paso('CHECK 18: evento viaje:cancelado_por_admin recibido por el cliente (room personal)',
    cliEvento !== null && cliEvento.estado === 'CANCELADO',
    cliEvento ? JSON.stringify(cliEvento) : 'no recibido');

  // ── 14. cancelar en EN_RUTA (GPS activo) → 200, Redis limpio ─────────────────
  const vRuta = await crearViaje(clienteToken);
  await esperar(1200);
  sConductor.emit('viaje:aceptar', { id_viaje: vRuta });
  await esperar(2000);
  sConductor.emit('conductor:ubicacion', { id_viaje: vRuta, lat: PARADA_1.lat, lng: PARADA_1.lng, timestamp: Date.now() });
  await esperar(1000);
  await api('PATCH', `/api/viajes/${vRuta}/estado`, { estado: 'EN_RUTA' }, conductorToken);
  sConductor.emit('conductor:ubicacion', { id_viaje: vRuta, lat: -34.6010, lng: -58.3800, timestamp: Date.now() + 3000 });
  await esperar(1200);
  const keysAntesRuta = await redis.keys(`gps:${vRuta}:*`);
  const { status: s14 } = await api('POST', `/api/admin/viajes/${vRuta}/cancelar`, { motivo: 'test admin EN_RUTA' }, adminToken);
  await esperar(1200);
  const { data: v14 } = await api('GET', `/api/admin/viajes/${vRuta}`, null, adminToken);
  const keysDespuesRuta = await redis.keys(`gps:${vRuta}:*`);
  paso('CHECK 14: cancelar EN_RUTA (GPS activo) → 200, CANCELADO, Redis limpio',
    s14 === 200 && v14.estado === 'CANCELADO' && keysAntesRuta.length > 0 && keysDespuesRuta.length === 0,
    `status=${s14} estado=${v14.estado} keysAntes=${keysAntesRuta.length} keysDespues=${keysDespuesRuta.length}`);

  // ── 15. cancelar en FINALIZADO → 400 ─────────────────────────────────────────
  const { status: s15, data: d15 } = await api('POST', `/api/admin/viajes/${vFinal}/cancelar`, { motivo: 'no deberia' }, adminToken);
  paso('CHECK 15: cancelar viaje FINALIZADO → 400 con mensaje claro',
    s15 === 400 && typeof d15.error === 'string' && d15.error.includes('FINALIZADO'),
    `status=${s15} — ${d15.error}`);

  // ── 16. cancelar un viaje ya CANCELADO → 400 ─────────────────────────────────
  const { status: s16, data: d16 } = await api('POST', `/api/admin/viajes/${vBusca}/cancelar`, {}, adminToken);
  paso('CHECK 16: cancelar viaje ya CANCELADO → 400 con mensaje claro',
    s16 === 400 && typeof d16.error === 'string' && d16.error.includes('CANCELADO'),
    `status=${s16} — ${d16.error}`);

  // ── 19. no-admin (CLIENTE) intenta cancelar → 403 ────────────────────────────
  const { status: s19 } = await api('POST', `/api/admin/viajes/${vFinal}/cancelar`, {}, clienteToken);
  paso('CHECK 19: token CLIENTE en POST cancelar admin → 403', s19 === 403, `status=${s19}`);

  // ── 20. sin token → 401 ──────────────────────────────────────────────────────
  const { status: s20 } = await api('GET', '/api/admin/usuarios', null, null);
  paso('CHECK 20: endpoint admin sin token → 401', s20 === 401, `status=${s20}`);

  // ── RESUMEN ──────────────────────────────────────────────────────────────────
  await cleanup([sConductor, sCliente]);
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
  console.log('\n  NOTA: regresion (21/22/23) se corre aparte:');
  console.log('    node scripts/test-fase5.js → 36/36');
  console.log('    node scripts/test-cancelacion-conductor.js → 11/11');
  console.log('    node scripts/test-cancelacion-cliente.js → 9/9');

  process.exit(fallaron.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n💥 Error inesperado:', e.message);
  try { await redis.quit(); } catch { /* noop */ }
  process.exit(1);
});
