import { io } from 'socket.io-client';
import { getToken } from './_firebase-auth.js';
import { crearRegistro, terminar } from './_limpieza.js';

// Al final se borran los conductores de la corrida y los viajes que creo
// (con la cuenta fija cliente@, que NO se toca). Ver _limpieza.js.
const reg = crearRegistro();
const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000';

const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

// ── Helpers ───────────────────────────────────────────────────────────────────

const checks = [];
function check(nombre, ok, detalle = '') {
  checks.push({ nombre, ok, detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function registrar(datos, tipo) {
  const endpoint = tipo === 'cliente' ? '/api/auth/registro-cliente' : '/api/auth/registro-conductor';
  await api('POST', endpoint, datos, null);
}

async function cleanup(sockets) {
  for (const s of sockets) { try { s?.disconnect(); } catch {} }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   TEST GET /api/viajes/mis-viajes-conductor — FLETER  ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const sockets = [];
  // Sufijo unico por corrida: cada conductor arranca sin viajes previos, asi
  // "solo el viaje 1/2" es exacto y el conductor C cumple el caso "sin viajes".
  const suf = String(Date.now());
  const dni = (i) => suf.slice(-7) + i;
  const emailA = `cond-mvc-a-${suf}@test.com`;
  const emailB = `cond-mvc-b-${suf}@test.com`;
  const emailC = `cond-mvc-c-${suf}@test.com`;
  [emailA, emailB, emailC].forEach(reg.email);

  // ── PASO 1: Usuarios + vehiculos ────────────────────────────────────────────
  console.log('── PASO 1: Cliente + 2 conductores + 1 conductor sin viajes ──\n');

  await registrar({
    nombre: 'Cliente', apellido: 'MVC', dni: '11111111',
    email: 'cliente@test.com', contrasena: 'test123456',
  }, 'cliente');
  await registrar({
    nombre: 'Conductor', apellido: 'A', dni: dni(1), email: emailA, contrasena: 'test123456',
    nro_licencia: 'LICA' + suf.slice(-5), licencia_vencimiento: '2028-01-01T00:00:00.000Z',
  }, 'conductor');
  await registrar({
    nombre: 'Conductor', apellido: 'B', dni: dni(2), email: emailB, contrasena: 'test123456',
    nro_licencia: 'LICB' + suf.slice(-5), licencia_vencimiento: '2028-01-01T00:00:00.000Z',
  }, 'conductor');
  await registrar({
    nombre: 'Conductor', apellido: 'C', dni: dni(3), email: emailC, contrasena: 'test123456',
    nro_licencia: 'LICC' + suf.slice(-5), licencia_vencimiento: '2028-01-01T00:00:00.000Z',
  }, 'conductor');

  const clienteToken = await getToken('cliente@test.com', 'test123456');
  const tokenA = await getToken(emailA, 'test123456');
  const tokenB = await getToken(emailB, 'test123456');
  const tokenC = await getToken(emailC, 'test123456');

  // Vehiculo para A y B (requerido por el matching para aceptar). C no acepta nada.
  await api('POST', '/api/conductores/mis-vehiculos', {
    patente: 'A' + suf.slice(-6), marca: 'Ford', modelo: 'Transit', anio: 2020, color: 'Blanco', tipo_vehiculo: 'furgon',
  }, tokenA);
  await api('POST', '/api/conductores/mis-vehiculos', {
    patente: 'B' + suf.slice(-6), marca: 'Fiat', modelo: 'Ducato', anio: 2021, color: 'Gris', tipo_vehiculo: 'furgon',
  }, tokenB);
  check('Cliente + conductores A, B, C + vehiculos listos', true);

  // ── PASO 2: Cliente crea 2 viajes ───────────────────────────────────────────
  console.log('\n── PASO 2: Cliente crea 2 viajes ──────────────────────\n');

  const fecha = () => new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const crearViaje = async () => {
    const { status, data } = await api('POST', '/api/viajes', {
      zona: 'CABA', fecha_programada: fecha(), condiciones_requeridas: [],
      paradas: [PARADA_1, PARADA_2],
    }, clienteToken);
    if (status !== 201) throw new Error('No se pudo crear viaje: ' + JSON.stringify(data));
    return reg.viaje(data.id_viaje);
  };
  const viaje1 = await crearViaje();
  const viaje2 = await crearViaje();
  check('2 viajes creados', !!viaje1 && !!viaje2, `viaje1=${viaje1}, viaje2=${viaje2}`);

  // ── PASO 3: A acepta viaje1, B acepta viaje2 ────────────────────────────────
  console.log('\n── PASO 3: A acepta viaje1, B acepta viaje2 ───────────\n');

  const sA = await conectar(tokenA);
  const sB = await conectar(tokenB);
  sockets.push(sA, sB);
  await esperar(1500); // joins de room

  sA.emit('viaje:aceptar', { id_viaje: viaje1 });
  await esperar(2000);
  sB.emit('viaje:aceptar', { id_viaje: viaje2 });
  await esperar(2000);

  const { data: v1 } = await api('GET', `/api/viajes/${viaje1}`, null, clienteToken);
  const { data: v2 } = await api('GET', `/api/viajes/${viaje2}`, null, clienteToken);
  check('viaje1 quedo CONDUCTOR_ASIGNADO', v1.estado === 'CONDUCTOR_ASIGNADO', v1.estado);
  check('viaje2 quedo CONDUCTOR_ASIGNADO', v2.estado === 'CONDUCTOR_ASIGNADO', v2.estado);

  // ── PASO 4: A ve solo su viaje ──────────────────────────────────────────────
  console.log('\n── PASO 4: mis-viajes-conductor como A ────────────────\n');

  const { status: sa, data: listaA } = await api('GET', '/api/viajes/mis-viajes-conductor', null, tokenA);
  check('GET mis-viajes-conductor (A) → 200', sa === 200, `status ${sa}`);
  const idsA = Array.isArray(listaA) ? listaA.map((v) => v.id_viaje) : [];
  check('A ve solo viaje1, no viaje2',
    idsA.length === 1 && idsA.includes(viaje1) && !idsA.includes(viaje2),
    `ids=[${idsA.join(',')}]`);

  const vA = Array.isArray(listaA) ? listaA[0] : null;
  check('El viaje de A trae los campos esperados (paradas + datos del cliente)',
    !!vA && vA.id_viaje === viaje1 && Array.isArray(vA.paradas) && vA.paradas.length === 2 &&
      vA.paradas[0].orden != null && vA.paradas[0].direccion != null &&
      vA.cliente?.usuario?.nombre != null && 'precio_real' in vA && 'descripcion' in vA && 'creado_en' in vA,
    vA ? `estado=${vA.estado}, paradas=${vA.paradas?.length}, cliente=${vA.cliente?.usuario?.nombre}` : 'sin viaje');

  // ── PASO 5: B ve solo su viaje ──────────────────────────────────────────────
  console.log('\n── PASO 5: mis-viajes-conductor como B ────────────────\n');

  const { data: listaB } = await api('GET', '/api/viajes/mis-viajes-conductor', null, tokenB);
  const idsB = Array.isArray(listaB) ? listaB.map((v) => v.id_viaje) : [];
  check('B ve solo viaje2, no viaje1',
    idsB.length === 1 && idsB.includes(viaje2) && !idsB.includes(viaje1),
    `ids=[${idsB.join(',')}]`);

  // ── PASO 6: filtro por estado ───────────────────────────────────────────────
  console.log('\n── PASO 6: filtro ?estado= ────────────────────────────\n');

  const { data: vacio } = await api('GET', '/api/viajes/mis-viajes-conductor?estado=BUSCANDO_CONDUCTOR', null, tokenA);
  check('A ?estado=BUSCANDO_CONDUCTOR → [] (su viaje esta CONDUCTOR_ASIGNADO)',
    Array.isArray(vacio) && vacio.length === 0, `length ${vacio?.length}`);

  const { data: filtrado } = await api('GET', '/api/viajes/mis-viajes-conductor?estado=CONDUCTOR_ASIGNADO', null, tokenA);
  check('A ?estado=CONDUCTOR_ASIGNADO → devuelve viaje1 (filtro positivo)',
    Array.isArray(filtrado) && filtrado.length === 1 && filtrado[0].id_viaje === viaje1,
    `ids=[${(filtrado || []).map((v) => v.id_viaje).join(',')}]`);

  // ── PASO 7: estado invalido → 400 ───────────────────────────────────────────
  console.log('\n── PASO 7: ?estado=INVALIDO → 400 ─────────────────────\n');

  const { status: si, data: dInval } = await api('GET', '/api/viajes/mis-viajes-conductor?estado=INVALIDO', null, tokenA);
  check('?estado=INVALIDO → 400 con error "Estado invalido"',
    si === 400 && dInval.error === 'Estado invalido', `status ${si}, body ${JSON.stringify(dInval)}`);

  // ── PASO 8: cliente → 403 ───────────────────────────────────────────────────
  console.log('\n── PASO 8: CLIENTE → 403 ──────────────────────────────\n');

  const { status: sc } = await api('GET', '/api/viajes/mis-viajes-conductor', null, clienteToken);
  check('Un CLIENTE recibe 403', sc === 403, `status ${sc}`);

  // ── PASO 9: conductor sin viajes → [] ───────────────────────────────────────
  console.log('\n── PASO 9: conductor recien creado sin viajes → [] ────\n');

  const { status: sC, data: listaC } = await api('GET', '/api/viajes/mis-viajes-conductor', null, tokenC);
  check('Conductor C (sin viajes) recibe array vacio []',
    sC === 200 && Array.isArray(listaC) && listaC.length === 0, `status ${sC}, length ${listaC?.length}`);

  // ── RESUMEN ─────────────────────────────────────────────────────────────────
  await cleanup(sockets);

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
  return fallaron.length === 0;
}

main()
  .then((ok) => terminar(reg, ok))
  .catch((e) => {
    console.error('\n💥 Error inesperado:', e.message, e.stack);
    return terminar(reg, false);
  });
