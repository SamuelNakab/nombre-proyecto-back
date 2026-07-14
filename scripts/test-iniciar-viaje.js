import { io } from 'socket.io-client';
import redis from '../src/config/redis.js';
import prisma from '../src/config/prisma.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const BASE = 'http://localhost:3000';

// Dos paradas reales en CABA (zona CABA, sin condiciones → cualquier conductor
// con al menos un vehiculo es elegible).
const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

const MIN = 60 * 1000;
const HORA = 60 * MIN;

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

// Crea el viaje via POST (fecha now+2h para pasar la validacion de fecha futura
// del endpoint). Asi se publica a los conductores elegibles y se une al cliente
// al room viaje:{id} — necesario para los checks de eventos.
async function crearViajePublicado(clienteToken) {
  const fechaViaje = new Date(Date.now() + 2 * HORA).toISOString();
  const { status, data } = await api('POST', '/api/viajes', {
    zona: 'CABA', fecha_programada: fechaViaje, condiciones_requeridas: [], paradas: [PARADA_1, PARADA_2],
  }, clienteToken);
  if (status !== 201) throw new Error(`No se pudo crear viaje (${status}): ${JSON.stringify(data)}`);
  return data.id_viaje;
}

// Ajusta fecha_programada directo en DB (via Prisma). El POST /viajes exige fecha
// futura (>1h), pero para probar la ventana de inicio hacen falta fechas dentro de
// la ventana o en el pasado. Se aplica despues de crear/aceptar.
async function setFecha(id_viaje, fechaDate) {
  await prisma.viaje.update({ where: { id_viaje }, data: { fecha_programada: fechaDate } });
}

async function aceptar(sConductor, id_viaje) {
  sConductor.emit('viaje:aceptar', { id_viaje });
  await esperar(2000);
}

async function estadoDe(id_viaje, token) {
  const { data } = await api('GET', `/api/viajes/${id_viaje}`, null, token);
  return data;
}

async function cleanup(sockets) {
  for (const s of sockets) { try { s?.disconnect(); } catch { /* noop */ } }
  try { await prisma.$disconnect(); } catch { /* noop */ }
  try { await redis.quit(); } catch { /* noop */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║     TEST INICIAR VIAJE (boton) — FLETER      ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  let sA = null, sB = null, sCliente = null;

  // ── SETUP ────────────────────────────────────────────────────────────────────
  console.log('── SETUP: cliente + 2 conductores + vehiculos ─────────────────\n');

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
  console.log('  Tokens y vehiculos listos (A=FLT001, B=FLT002)\n');

  sA = await conectar(conductorAToken);
  sB = await conectar(conductorBToken);
  sCliente = await conectar(clienteToken);

  // Captura de eventos
  let ultimoErrorA = null;
  sA.on('error', (d) => { ultimoErrorA = d; });
  const mapaCliente = [];
  sCliente.on('mapa:actualizar', (d) => { mapaCliente.push(d); });
  const iniciadosCliente = new Map();
  sCliente.on('viaje:iniciado', (d) => { iniciadosCliente.set(d.id_viaje, d); });

  await esperar(1200);

  // ── CASO 1: Feliz dentro de ventana → A_TIEMPO ───────────────────────────────
  console.log('── CASO 1: Feliz dentro de ventana (fecha +10min) → A_TIEMPO ──\n');

  const v1 = await crearViajePublicado(clienteToken);
  await esperar(1200);
  await aceptar(sA, v1);
  await setFecha(v1, new Date(Date.now() + 10 * MIN));

  const { status: si1, data: di1 } = await api('POST', `/api/viajes/${v1}/iniciar`, null, conductorAToken);
  const v1Db = await estadoDe(v1, clienteToken);
  paso('CASO 1: POST iniciar → 200, estado EN_CAMINO_A_ORIGEN, puntualidad A_TIEMPO',
    si1 === 200 && di1.estado === 'EN_CAMINO_A_ORIGEN' && di1.puntualidad_inicio === 'A_TIEMPO' &&
    !!di1.fecha_inicio && di1.mensaje === 'Viaje iniciado',
    `status=${si1} estado=${di1.estado} puntualidad=${di1.puntualidad_inicio} fecha_inicio=${di1.fecha_inicio}`);
  paso('CASO 1: en DB estado=EN_CAMINO_A_ORIGEN, fecha_inicio y puntualidad_inicio guardadas',
    v1Db.estado === 'EN_CAMINO_A_ORIGEN' && !!v1Db.fecha_inicio && v1Db.puntualidad_inicio === 'A_TIEMPO',
    `estado=${v1Db.estado} fecha_inicio=${v1Db.fecha_inicio} puntualidad=${v1Db.puntualidad_inicio}`);

  // ── CASO 2: Demasiado temprano (fecha +2h) → 400 ─────────────────────────────
  console.log('\n── CASO 2: Demasiado temprano (fecha +2h) → 400 ───────────────\n');

  const v2 = await crearViajePublicado(clienteToken);
  await esperar(1200);
  await aceptar(sA, v2);
  await setFecha(v2, new Date(Date.now() + 2 * HORA));

  const { status: si2, data: di2 } = await api('POST', `/api/viajes/${v2}/iniciar`, null, conductorAToken);
  const v2Db = await estadoDe(v2, clienteToken);
  paso('CASO 2: POST iniciar demasiado temprano → 400 con "a partir de las <HH:MM>"',
    si2 === 400 && typeof di2.error === 'string' && di2.error.includes('a partir de las'),
    `status=${si2} — ${di2.error}`);
  paso('CASO 2: el estado NO cambia (sigue CONDUCTOR_ASIGNADO, sin fecha_inicio)',
    v2Db.estado === 'CONDUCTOR_ASIGNADO' && v2Db.fecha_inicio === null,
    `estado=${v2Db.estado} fecha_inicio=${v2Db.fecha_inicio}`);

  // ── CASO 3: Inicio tarde (fecha -45min) → TARDE ──────────────────────────────
  console.log('\n── CASO 3: Inicio tarde (fecha -45min) → TARDE ────────────────\n');

  const v3 = await crearViajePublicado(clienteToken);
  await esperar(1200);
  await aceptar(sA, v3);
  await setFecha(v3, new Date(Date.now() - 45 * MIN));

  const { status: si3, data: di3 } = await api('POST', `/api/viajes/${v3}/iniciar`, null, conductorAToken);
  paso('CASO 3: POST iniciar 45min tarde → 200, puntualidad TARDE',
    si3 === 200 && di3.estado === 'EN_CAMINO_A_ORIGEN' && di3.puntualidad_inicio === 'TARDE',
    `status=${si3} estado=${di3.estado} puntualidad=${di3.puntualidad_inicio}`);

  // ── CASO 4: Inicio muy tarde (fecha -3h) → MUY_TARDE ─────────────────────────
  console.log('\n── CASO 4: Inicio muy tarde (fecha -3h) → MUY_TARDE ───────────\n');

  const v4 = await crearViajePublicado(clienteToken);
  await esperar(1200);
  await aceptar(sA, v4);
  await setFecha(v4, new Date(Date.now() - 3 * HORA));

  const { status: si4, data: di4 } = await api('POST', `/api/viajes/${v4}/iniciar`, null, conductorAToken);
  paso('CASO 4: POST iniciar 3h tarde → 200, puntualidad MUY_TARDE',
    si4 === 200 && di4.estado === 'EN_CAMINO_A_ORIGEN' && di4.puntualidad_inicio === 'MUY_TARDE',
    `status=${si4} estado=${di4.estado} puntualidad=${di4.puntualidad_inicio}`);

  // ── CASO 5: Ping GPS ANTES de iniciar → rechazado, sin efectos ───────────────
  console.log('\n── CASO 5: Ping GPS antes de iniciar → error, sin efecto ──────\n');

  const v5 = await crearViajePublicado(clienteToken);
  await esperar(1200);
  await aceptar(sA, v5);
  const v5Asig = await estadoDe(v5, clienteToken);

  // Higiene: gps:{id}:historial se escribe SIN TTL (a diferencia de :ultima y
  // :acumulado), asi que sobrevive a corridas viejas; y los id_viaje se reciclan
  // al reseedear la DB. Borramos las keys del viaje ANTES del ping para que el
  // check mida solo el efecto del ping y no basura de corridas anteriores.
  await redis.del(`gps:${v5}:ultima`, `gps:${v5}:acumulado`, `gps:${v5}:historial`);

  ultimoErrorA = null;
  sA.emit('conductor:ubicacion', { id_viaje: v5, lat: PARADA_1.lat, lng: PARADA_1.lng, timestamp: Date.now() });
  await esperar(1500);

  const v5Post = await estadoDe(v5, clienteToken);
  const [exU, exA, exH] = await Promise.all([
    redis.exists(`gps:${v5}:ultima`),
    redis.exists(`gps:${v5}:acumulado`),
    redis.exists(`gps:${v5}:historial`),
  ]);
  paso('CASO 5: ping en CONDUCTOR_ASIGNADO → recibe error "El viaje no fue iniciado"',
    ultimoErrorA !== null && ultimoErrorA.error === 'El viaje no fue iniciado',
    ultimoErrorA ? JSON.stringify(ultimoErrorA) : 'no llego error');
  paso('CASO 5: el estado NO cambia y el ping no dejo keys GPS en Redis (ultima/acumulado/historial)',
    v5Asig.estado === 'CONDUCTOR_ASIGNADO' && v5Post.estado === 'CONDUCTOR_ASIGNADO' &&
    exU === 0 && exA === 0 && exH === 0,
    `estado=${v5Post.estado} ultima=${exU} acumulado=${exA} historial=${exH}`);

  // ── CASO 6: Ping GPS DESPUES de iniciar → se procesa normal ──────────────────
  console.log('\n── CASO 6: Ping GPS despues de iniciar → mapa:actualizar ──────\n');

  const v6 = await crearViajePublicado(clienteToken);
  await esperar(1200);
  await aceptar(sA, v6);
  await setFecha(v6, new Date());
  const { status: si6 } = await api('POST', `/api/viajes/${v6}/iniciar`, null, conductorAToken);

  mapaCliente.length = 0;
  sA.emit('conductor:ubicacion', { id_viaje: v6, lat: PARADA_1.lat, lng: PARADA_1.lng, timestamp: Date.now() });
  await esperar(1500);

  const v6Post = await estadoDe(v6, clienteToken);
  const acumV6 = await redis.exists(`gps:${v6}:acumulado`);
  paso('CASO 6: tras iniciar, el ping se procesa normal (mapa:actualizar al room + Redis)',
    si6 === 200 && mapaCliente.length > 0 && acumV6 === 1,
    `iniciar=${si6} mapa:actualizar recibidos=${mapaCliente.length} acumulado=${acumV6}`);
  paso('CASO 6: el estado sigue EN_CAMINO_A_ORIGEN tras el ping',
    v6Post.estado === 'EN_CAMINO_A_ORIGEN', `estado=${v6Post.estado}`);

  // ── CASO 7: Evento viaje:iniciado al cliente (room personal) ─────────────────
  console.log('\n── CASO 7: Evento viaje:iniciado al cliente ───────────────────\n');

  const v7 = await crearViajePublicado(clienteToken);
  await esperar(1200);
  await aceptar(sA, v7);
  await setFecha(v7, new Date());
  iniciadosCliente.delete(v7);
  const { data: di7 } = await api('POST', `/api/viajes/${v7}/iniciar`, null, conductorAToken);
  await esperar(1000);

  const ev7 = iniciadosCliente.get(v7);
  paso('CASO 7: cliente recibe viaje:iniciado con { id_viaje, fecha_inicio, puntualidad_inicio }',
    ev7 != null && ev7.id_viaje === v7 && !!ev7.fecha_inicio &&
    ev7.fecha_inicio === di7.fecha_inicio && ev7.puntualidad_inicio === di7.puntualidad_inicio,
    ev7 ? JSON.stringify(ev7) : 'evento no recibido');

  // ── CASO 8: Doble inicio → 400 (ya no esta en CONDUCTOR_ASIGNADO) ────────────
  console.log('\n── CASO 8: Doble inicio → 400 ────────────────────────────────\n');

  const { status: si8, data: di8 } = await api('POST', `/api/viajes/${v7}/iniciar`, null, conductorAToken);
  paso('CASO 8: iniciar un viaje ya iniciado → 400 con mensaje de estado',
    si8 === 400 && typeof di8.error === 'string' &&
    di8.error.includes('CONDUCTOR_ASIGNADO') && di8.error.includes('EN_CAMINO_A_ORIGEN'),
    `status=${si8} — ${di8.error}`);

  // ── CASO 9: Conductor equivocado → 403 ───────────────────────────────────────
  console.log('\n── CASO 9: Conductor equivocado (B inicia viaje de A) → 403 ───\n');

  const v9 = await crearViajePublicado(clienteToken);
  await esperar(1200);
  await aceptar(sA, v9);
  await setFecha(v9, new Date());
  const { status: si9, data: di9 } = await api('POST', `/api/viajes/${v9}/iniciar`, null, conductorBToken);
  const v9Db = await estadoDe(v9, clienteToken);
  paso('CASO 9: conductor B inicia viaje asignado a A → 403 y estado sin cambios',
    si9 === 403 && di9.error === 'No autorizado para iniciar este viaje' &&
    v9Db.estado === 'CONDUCTOR_ASIGNADO',
    `status=${si9} — ${di9.error} estado=${v9Db.estado}`);

  // ── CASO 10: Viaje inexistente → 404 ─────────────────────────────────────────
  console.log('\n── CASO 10: Viaje inexistente → 404 ───────────────────────────\n');

  const { status: si10, data: di10 } = await api('POST', '/api/viajes/999999/iniciar', null, conductorAToken);
  paso('CASO 10: iniciar id_viaje=999999 → 404',
    si10 === 404 && di10.error === 'Viaje no encontrado',
    `status=${si10} — ${di10.error}`);

  // ── CASO 11: Cancelacion por conductor sigue funcionando antes de iniciar ────
  console.log('\n── CASO 11: Cancelar (sin iniciar) sigue funcionando ──────────\n');

  const v11 = await crearViajePublicado(clienteToken);
  await esperar(1200);
  await aceptar(sA, v11);
  const v11Asig = await estadoDe(v11, clienteToken);
  const { status: si11, data: di11 } = await api('POST', `/api/viajes/${v11}/cancelar-conductor`, null, conductorAToken);
  await esperar(1000);
  const v11Post = await estadoDe(v11, clienteToken);
  paso('CASO 11: aceptar y cancelar sin iniciar → 200 y viaje vuelve a BUSCANDO_CONDUCTOR',
    v11Asig.estado === 'CONDUCTOR_ASIGNADO' && si11 === 200 &&
    di11.estado === 'BUSCANDO_CONDUCTOR' && v11Post.estado === 'BUSCANDO_CONDUCTOR' &&
    v11Post.id_conductor === null,
    `status=${si11} estado=${v11Post.estado} id_conductor=${v11Post.id_conductor}`);

  // ── CASO 12: Flujo completo end-to-end (crear→aceptar→iniciar→…→FINALIZADO) ──
  console.log('\n── CASO 12: Flujo completo end-to-end → FINALIZADO ────────────\n');

  const v12 = await crearViajePublicado(clienteToken);
  await esperar(1200);
  await aceptar(sA, v12);
  await setFecha(v12, new Date());
  const { status: si12 } = await api('POST', `/api/viajes/${v12}/iniciar`, null, conductorAToken);
  paso('CASO 12a: crear → aceptar → iniciar → 200 (EN_CAMINO_A_ORIGEN)', si12 === 200, `iniciar=${si12}`);

  // Pings con timestamps separados 3s para acumular distancia/tiempo real
  const pings = [
    { lat: -34.6037, lng: -58.3816 },
    { lat: -34.6010, lng: -58.3800 },
    { lat: -34.5980, lng: -58.3830 },
    { lat: -34.5940, lng: -58.3890 },
    { lat: -34.5895, lng: -58.3974 },
  ];
  const tsBase = Date.now();
  for (let i = 0; i < pings.length; i++) {
    sA.emit('conductor:ubicacion', { id_viaje: v12, lat: pings[i].lat, lng: pings[i].lng, timestamp: tsBase + i * 3000 });
    await esperar(400);
  }
  await esperar(1500);

  const acum12 = await redis.get(`gps:${v12}:acumulado`);
  const acum12Obj = acum12 ? JSON.parse(acum12) : null;
  paso('CASO 12b: los pings acumulan GPS (distancia_km > 0)',
    acum12Obj !== null && acum12Obj.distancia_km > 0,
    acum12Obj ? `distancia_km=${acum12Obj.distancia_km.toFixed(3)}` : 'sin acumulado');

  await api('PATCH', `/api/viajes/${v12}/estado`, { estado: 'CARGANDO' }, conductorAToken);
  const { data: enRuta12 } = await api('PATCH', `/api/viajes/${v12}/estado`, { estado: 'EN_RUTA' }, conductorAToken);
  paso('CASO 12c: CARGANDO → EN_RUTA', enRuta12.estado_nuevo === 'EN_RUTA', `estado=${enRuta12.estado_nuevo}`);

  const { data: qrs12 } = await api('GET', `/api/viajes/${v12}/qr-paradas`, null, clienteToken);
  const ordenadas = qrs12.sort((a, b) => a.orden - b.orden);
  await api('POST', `/api/viajes/${v12}/confirmar-parada`,
    { qr_firmado: ordenadas[0].qr_firmado, lat: PARADA_1.lat, lng: PARADA_1.lng }, conductorAToken);
  const { data: conf12 } = await api('POST', `/api/viajes/${v12}/confirmar-parada`,
    { qr_firmado: ordenadas[1].qr_firmado, lat: PARADA_2.lat, lng: PARADA_2.lng }, conductorAToken);
  paso('CASO 12d: confirmar ambas paradas por QR → viaje_finalizado con precio_real y remito',
    conf12.viaje_finalizado === true && typeof conf12.precio_real === 'number' && conf12.precio_real >= 0 &&
    typeof conf12.remito_url === 'string' && conf12.remito_url.startsWith('http'),
    `finalizado=${conf12.viaje_finalizado} precio_real=${conf12.precio_real} remito=${conf12.remito_url ? 'si' : 'no'}`);

  const v12Final = await estadoDe(v12, clienteToken);
  paso('CASO 12e: estado final FINALIZADO con precio_real y fecha_inicio conservada',
    v12Final.estado === 'FINALIZADO' && typeof v12Final.precio_real === 'number' && !!v12Final.fecha_inicio,
    `estado=${v12Final.estado} precio_real=${v12Final.precio_real} fecha_inicio=${v12Final.fecha_inicio}`);

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

  process.exit(fallaron.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n💥 Error inesperado:', e.message);
  try { await prisma.$disconnect(); } catch { /* noop */ }
  try { await redis.quit(); } catch { /* noop */ }
  process.exit(1);
});
