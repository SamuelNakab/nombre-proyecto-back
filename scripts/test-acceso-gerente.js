import { io } from 'socket.io-client';
import redis from '../src/config/redis.js';
import prisma from '../src/config/prisma.js';

// Verifica la regla de acceso COMPARTIDA (puedeVerViaje, acceso-viaje.service):
//   - GET /api/viajes/:id
//   - GET /api/viajes/:id/costo-acumulado
//   - GET /api/viajes/:id/remito
// pasan para el cliente dueño, el conductor asignado y el gerente de la empresa
// dueña del viaje; y la regla EXTRA del detalle: un gerente con flota elegible
// puede leer un viaje en BUSCANDO_CONDUCTOR (que todavia no tiene empresa).

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const BASE = 'http://localhost:3000';

const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

const MIN = 60 * 1000;
const HORA = 60 * MIN;

// ── Helpers ─────────────────────────────────────────────────────────────────

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
    data = { error: `Respuesta no-JSON (${res.status}): ${text.slice(0, 500)}` };
  }
  return { status: res.status, data };
}

function conectar(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token: 'Bearer ' + token } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`Socket connect_error: ${e.message}`)));
    setTimeout(() => reject(new Error('Timeout al conectar socket (8s)')), 8000);
  });
}

async function registrar(datos, tipo) {
  const endpoint =
    tipo === 'cliente'
      ? '/api/auth/registro-cliente'
      : tipo === 'gerente'
        ? '/api/auth/registro-gerente'
        : '/api/auth/registro-conductor';
  const { status, data } = await api('POST', endpoint, datos, null);
  if (status !== 201 && status !== 409) {
    throw new Error(`registro ${tipo} (${datos.email}) fallo: ${status} ${JSON.stringify(data)}`);
  }
}

async function crearViaje(clienteToken, condiciones = []) {
  const fecha = new Date(Date.now() + 2 * HORA).toISOString();
  const { status, data } = await api(
    'POST',
    '/api/viajes',
    { zona: 'CABA', fecha_programada: fecha, condiciones_requeridas: condiciones, paradas: [PARADA_1, PARADA_2] },
    clienteToken
  );
  if (status !== 201) throw new Error(`crearViaje fallo (${status}): ${JSON.stringify(data)}`);
  return data.id_viaje;
}

const reservar = (token, id_viaje, id_empresa) =>
  api('POST', `/api/viajes/${id_viaje}/reservar`, { id_empresa }, token);
const asignar = (token, id_viaje, id_conductor, id_vehiculo) =>
  api('POST', `/api/viajes/${id_viaje}/asignar`, { id_conductor, id_vehiculo }, token);
const iniciar = (token, id_viaje) => api('POST', `/api/viajes/${id_viaje}/iniciar`, null, token);

// Los tres endpoints bajo prueba.
const detalle = (token, id_viaje) => api('GET', `/api/viajes/${id_viaje}`, null, token);
const costo = (token, id_viaje) => api('GET', `/api/viajes/${id_viaje}/costo-acumulado`, null, token);
const remito = (token, id_viaje) => api('GET', `/api/viajes/${id_viaje}/remito`, null, token);

const estadoDe = (id_viaje) => prisma.viaje.findUnique({ where: { id_viaje } });

async function conductorIdPorEmail(email) {
  const u = await prisma.usuario.findUnique({ where: { email }, include: { conductor: true } });
  return u.conductor.id_conductor;
}
async function empresaDeGerente(email) {
  const u = await prisma.usuario.findUnique({ where: { email } });
  return prisma.empresa.findFirst({ where: { id_gerente: u.id_usuario } });
}
async function setFecha(id_viaje, fechaDate) {
  await prisma.viaje.update({ where: { id_viaje }, data: { fecha_programada: fechaDate } });
}

// Manda pings GPS por el socket del conductor para que exista acumulado en Redis
// (sin acumulado, costo-acumulado devuelve 200 con desglose null y el caso 2 no
// probaria nada).
async function mandarPings(socketConductor, id_viaje) {
  const pings = [
    { lat: -34.6037, lng: -58.3816 },
    { lat: -34.6010, lng: -58.3800 },
    { lat: -34.5980, lng: -58.3830 },
    { lat: -34.5895, lng: -58.3974 },
  ];
  const tsBase = Date.now();
  for (let i = 0; i < pings.length; i++) {
    socketConductor.emit('conductor:ubicacion', {
      id_viaje,
      lat: pings[i].lat,
      lng: pings[i].lng,
      timestamp: tsBase + i * 3000,
    });
    await esperar(400);
  }
  await esperar(1200);
}

// Lleva un viaje ya iniciado (EN_CAMINO_A_ORIGEN) hasta FINALIZADO con remito.
async function finalizarViaje(id_viaje, tokenConductor, tokenCliente) {
  await api('PATCH', `/api/viajes/${id_viaje}/estado`, { estado: 'CARGANDO' }, tokenConductor);
  await api('PATCH', `/api/viajes/${id_viaje}/estado`, { estado: 'EN_RUTA' }, tokenConductor);
  const { data: qrs } = await api('GET', `/api/viajes/${id_viaje}/qr-paradas`, null, tokenCliente);
  const ord = [...qrs].sort((a, b) => a.orden - b.orden);
  await api('POST', `/api/viajes/${id_viaje}/confirmar-parada`, { qr_firmado: ord[0].qr_firmado, lat: PARADA_1.lat, lng: PARADA_1.lng }, tokenConductor);
  const { data: fin } = await api('POST', `/api/viajes/${id_viaje}/confirmar-parada`, { qr_firmado: ord[1].qr_firmado, lat: PARADA_2.lat, lng: PARADA_2.lng }, tokenConductor);
  return fin;
}

async function cleanup(sockets) {
  for (const s of sockets) {
    try {
      s?.disconnect();
    } catch {
      /* noop */
    }
  }
  try {
    await prisma.$disconnect();
  } catch {
    /* noop */
  }
  try {
    await redis.quit();
  } catch {
    /* noop */
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   TEST ACCESO DEL GERENTE — FLETER           ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const stamp = Date.now();
  let sConA, sRnd;

  console.log('── SETUP: usuarios, empresas, flota, afiliacion ───────────────\n');

  const pass = 'test123456';
  const d = String(stamp).slice(-7);
  const lic = '2028-01-01T00:00:00.000Z';
  const U = {
    cli: { email: `cli-acc-${stamp}@test.com`, dni: d + '0', nombre: 'Cli', apellido: 'Acc' },
    conA: { email: `cona-acc-${stamp}@test.com`, dni: d + '1', nombre: 'ConA', apellido: 'Acc', nro_licencia: 'LAA' + d, licencia_vencimiento: lic },
    rnd: { email: `rnd-acc-${stamp}@test.com`, dni: d + '2', nombre: 'Rnd', apellido: 'Acc', nro_licencia: 'LAR' + d, licencia_vencimiento: lic },
    ger1: { email: `ger1-acc-${stamp}@test.com`, dni: d + '3', nombre: 'Ger1', apellido: 'Acc', cuit_empresa: '30' + d + '30', nombre_empresa: `AccUno ${stamp}` },
    ger2: { email: `ger2-acc-${stamp}@test.com`, dni: d + '4', nombre: 'Ger2', apellido: 'Acc', cuit_empresa: '30' + d + '40', nombre_empresa: `AccDos ${stamp}` },
  };

  await registrar({ ...U.cli, contrasena: pass }, 'cliente');
  await registrar({ ...U.conA, contrasena: pass }, 'conductor');
  await registrar({ ...U.rnd, contrasena: pass }, 'conductor');
  await registrar({ ...U.ger1, contrasena: pass }, 'gerente');
  await registrar({ ...U.ger2, contrasena: pass }, 'gerente');

  const tCli = await getToken(U.cli.email, pass);
  const tConA = await getToken(U.conA.email, pass);
  const tRnd = await getToken(U.rnd.email, pass);
  const tGer1 = await getToken(U.ger1.email, pass);
  const tGer2 = await getToken(U.ger2.email, pass);

  const conAId = await conductorIdPorEmail(U.conA.email);
  // El conductor independiente necesita vehiculo propio para aceptar viajes.
  await api('POST', '/api/conductores/mis-vehiculos', { patente: `RN${String(stamp).slice(-5)}`, marca: 'Ford', modelo: 'Transit', anio: 2020, color: 'Blanco', tipo_vehiculo: 'furgon' }, tRnd);

  // registro-gerente ya crea una empresa por gerente: la usamos directamente.
  const e1 = await empresaDeGerente(U.ger1.email);
  const e2 = await empresaDeGerente(U.ger2.email);

  // Flota E1 CON REFRIGERADO → elegible para el viaje del caso 4.
  // Flota E2 SIN REFRIGERADO → no elegible (pero es un gerente con flota real).
  const { data: vehE1 } = await api('POST', `/api/empresas/${e1.id_empresa}/vehiculos`, { patente: `E1${String(stamp).slice(-5)}`, marca: 'Iveco', modelo: 'Daily', anio: 2021, color: 'Gris', tipo_vehiculo: 'camion', condiciones: ['REFRIGERADO'] }, tGer1);
  await api('POST', `/api/empresas/${e2.id_empresa}/vehiculos`, { patente: `E2${String(stamp).slice(-5)}`, marca: 'Renault', modelo: 'Master', anio: 2021, color: 'Azul', tipo_vehiculo: 'furgon' }, tGer2);

  // conA ACTIVO en E1 para que el gerente 1 pueda asignarle viajes.
  await api('POST', '/api/afiliaciones', { codigo_afiliacion: e1.codigo_afiliacion }, tConA);
  await api('POST', `/api/empresas/${e1.id_empresa}/conductores/${conAId}/aprobar`, null, tGer1);

  sConA = await conectar(tConA);
  sRnd = await conectar(tRnd);
  const asigRnd = new Map();
  sRnd.on('viaje:conductor_asignado', (x) => asigRnd.set(x.id_viaje, x));
  await esperar(1200);

  console.log(`  setup ok — empresa1=${e1.id_empresa} empresa2=${e2.id_empresa} vehiculoFlota=${vehE1.id_vehiculo} conductorA=${conAId}`);

  // ── CASO 1: viaje de empresa FINALIZADO → remito ───────────────────────────
  console.log('\n── CASO 1: remito de un viaje de empresa FINALIZADO ───────────\n');
  const vA = await crearViaje(tCli);
  await esperar(1200);
  await reservar(tGer1, vA, e1.id_empresa);
  await asignar(tGer1, vA, conAId, vehE1.id_vehiculo);
  await setFecha(vA, new Date());
  await iniciar(tGer1, vA);
  await mandarPings(sConA, vA);
  const finA = await finalizarViaje(vA, tConA, tCli);
  const vADb = await estadoDe(vA);

  const r1Ger1 = await remito(tGer1, vA);
  const r1Ger2 = await remito(tGer2, vA);
  const r1Cli = await remito(tCli, vA);
  const r1ConA = await remito(tConA, vA);
  const r1Rnd = await remito(tRnd, vA);

  paso('CASO 1 (setup): el viaje de empresa llega a FINALIZADO', vADb.estado === 'FINALIZADO' && finA?.viaje_finalizado === true, `estado=${vADb.estado} id_empresa=${vADb.id_empresa}`);
  paso('CASO 1a: remito como GERENTE de la empresa dueña → 200 con remito_url', r1Ger1.status === 200 && typeof r1Ger1.data.remito_url === 'string', `status=${r1Ger1.status} url=${r1Ger1.data.remito_url ? 'si' : 'no'}`);
  paso('CASO 1b: remito como gerente de OTRA empresa → 403', r1Ger2.status === 403, `status=${r1Ger2.status} err=${r1Ger2.data.error}`);
  paso('CASO 1c: remito como CLIENTE dueño → 200 (sin cambios)', r1Cli.status === 200, `status=${r1Cli.status}`);
  paso('CASO 1d: remito como CONDUCTOR asignado → 200 (sin cambios)', r1ConA.status === 200, `status=${r1ConA.status}`);
  paso('CASO 1e: remito como conductor random → 403', r1Rnd.status === 403, `status=${r1Rnd.status} err=${r1Rnd.data.error}`);

  // ── CASO 2: viaje de empresa EN CURSO → costo-acumulado ────────────────────
  console.log('\n── CASO 2: costo-acumulado de un viaje de empresa EN CURSO ────\n');
  const vB = await crearViaje(tCli);
  await esperar(1200);
  await reservar(tGer1, vB, e1.id_empresa);
  await asignar(tGer1, vB, conAId, vehE1.id_vehiculo);
  await setFecha(vB, new Date());
  await iniciar(tGer1, vB);
  await mandarPings(sConA, vB);
  const vBDb = await estadoDe(vB);

  const c2Ger1 = await costo(tGer1, vB);
  const c2Ger2 = await costo(tGer2, vB);
  const c2Cli = await costo(tCli, vB);
  const c2ConA = await costo(tConA, vB);

  paso('CASO 2 (setup): el viaje de empresa esta EN CURSO', ['EN_CAMINO_A_ORIGEN', 'CARGANDO', 'EN_RUTA', 'DESCARGANDO'].includes(vBDb.estado), `estado=${vBDb.estado}`);
  paso('CASO 2a: costo-acumulado como GERENTE de la empresa dueña → 200 con costo', c2Ger1.status === 200 && typeof c2Ger1.data.precio_acumulado === 'number' && c2Ger1.data.desglose !== null, `status=${c2Ger1.status} precio=${c2Ger1.data.precio_acumulado} desglose=${c2Ger1.data.desglose ? 'si' : 'null'}`);
  paso('CASO 2b: costo-acumulado como gerente de OTRA empresa → 403', c2Ger2.status === 403, `status=${c2Ger2.status} err=${c2Ger2.data.error}`);
  paso('CASO 2c: costo-acumulado como CLIENTE dueño → 200 (sin cambios)', c2Cli.status === 200, `status=${c2Cli.status}`);
  paso('CASO 2d: costo-acumulado como CONDUCTOR asignado → 200 (sin cambios)', c2ConA.status === 200, `status=${c2ConA.status}`);

  // ── CASO 3: viaje de conductor INDEPENDIENTE (sin id_empresa) ──────────────
  console.log('\n── CASO 3: viaje independiente → ningun gerente pasa ──────────\n');
  const vC = await crearViaje(tCli);
  await esperar(1500);
  sRnd.emit('viaje:aceptar', { id_viaje: vC });
  await esperar(1800);
  await setFecha(vC, new Date());
  await iniciar(tRnd, vC);
  await mandarPings(sRnd, vC);
  const vCDb = await estadoDe(vC);

  const c3Cli = await costo(tCli, vC);
  const c3Rnd = await costo(tRnd, vC);
  const c3Ger1 = await costo(tGer1, vC);
  const c3Ger2 = await costo(tGer2, vC);

  paso('CASO 3 (setup): viaje aceptado por conductor independiente, sin empresa', vCDb.id_conductor !== null && vCDb.id_empresa === null, `id_empresa=${vCDb.id_empresa} estado=${vCDb.estado}`);
  paso('CASO 3a: costo-acumulado — cliente y conductor siguen en 200', c3Cli.status === 200 && c3Rnd.status === 200, `cliente=${c3Cli.status} conductor=${c3Rnd.status}`);
  paso('CASO 3b: costo-acumulado — cualquier gerente → 403 (no hay empresa dueña)', c3Ger1.status === 403 && c3Ger2.status === 403, `ger1=${c3Ger1.status} ger2=${c3Ger2.status}`);

  await finalizarViaje(vC, tRnd, tCli);
  const vCFin = await estadoDe(vC);
  const r3Cli = await remito(tCli, vC);
  const r3Rnd = await remito(tRnd, vC);
  const r3Ger1 = await remito(tGer1, vC);
  const r3Ger2 = await remito(tGer2, vC);

  paso('CASO 3c: remito — cliente y conductor siguen en 200', vCFin.estado === 'FINALIZADO' && r3Cli.status === 200 && r3Rnd.status === 200, `estado=${vCFin.estado} cliente=${r3Cli.status} conductor=${r3Rnd.status}`);
  paso('CASO 3d: remito — cualquier gerente → 403 (no hay empresa dueña)', r3Ger1.status === 403 && r3Ger2.status === 403, `ger1=${r3Ger1.status} ger2=${r3Ger2.status}`);

  // ── CASO 4: detalle de un viaje en BUSCANDO_CONDUCTOR ──────────────────────
  console.log('\n── CASO 4: detalle del mercado abierto (gerente elegible) ─────\n');
  // Condicion REFRIGERADO: la flota de E1 la cumple, la de E2 no.
  const vD = await crearViaje(tCli, ['REFRIGERADO']);
  await esperar(1500);
  const vDDb = await estadoDe(vD);

  const d4Ger1 = await detalle(tGer1, vD);
  const d4Ger2 = await detalle(tGer2, vD);
  const d4Cli = await detalle(tCli, vD);
  const d4Rnd = await detalle(tRnd, vD);

  const tieneRuta = Array.isArray(d4Ger1.data?.ruta_planeada) && d4Ger1.data.ruta_planeada.length >= 2;
  const tieneCond = Array.isArray(d4Ger1.data?.condiciones_req) && d4Ger1.data.condiciones_req.some((c) => c.condicion === 'REFRIGERADO');

  paso('CASO 4 (setup): el viaje sigue en BUSCANDO_CONDUCTOR y sin empresa', vDDb.estado === 'BUSCANDO_CONDUCTOR' && vDDb.id_empresa === null, `estado=${vDDb.estado} id_empresa=${vDDb.id_empresa}`);
  paso('CASO 4a: detalle como gerente con flota ELEGIBLE → 200', d4Ger1.status === 200, `status=${d4Ger1.status} err=${d4Ger1.data.error ?? ''}`);
  paso('CASO 4b: la respuesta trae ruta_planeada y condiciones_req', tieneRuta && tieneCond, `ruta=${tieneRuta ? d4Ger1.data.ruta_planeada.length + ' puntos' : 'FALTA'} condiciones=${tieneCond ? 'REFRIGERADO' : 'FALTA'}`);
  paso('CASO 4c: detalle como gerente con flota NO elegible → 403', d4Ger2.status === 403, `status=${d4Ger2.status} err=${d4Ger2.data.error}`);
  paso('CASO 4d: detalle como CLIENTE dueño → 200', d4Cli.status === 200, `status=${d4Cli.status}`);
  paso('CASO 4e: detalle como conductor random (no asignado) → 403', d4Rnd.status === 403, `status=${d4Rnd.status} err=${d4Rnd.data.error}`);

  // ── CASO 5: la regla del detalle NO se filtra a costo-acumulado ni remito ──
  console.log('\n── CASO 5: el gerente elegible NO accede a costo/remito ───────\n');
  const c5Ger1 = await costo(tGer1, vD);
  const r5Ger1 = await remito(tGer1, vD);

  paso('CASO 5a: costo-acumulado de un viaje BUSCANDO_CONDUCTOR como gerente elegible → 403 (no 200)', c5Ger1.status === 403, `status=${c5Ger1.status} err=${c5Ger1.data.error}`);
  paso('CASO 5b: remito de un viaje BUSCANDO_CONDUCTOR como gerente elegible → 403 (no 200)', r5Ger1.status === 403, `status=${r5Ger1.status} err=${r5Ger1.data.error}`);

  // ── RESUMEN ────────────────────────────────────────────────────────────────
  await cleanup([sConA, sRnd]);

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
  try {
    await prisma.$disconnect();
  } catch {
    /* noop */
  }
  try {
    await redis.quit();
  } catch {
    /* noop */
  }
  process.exit(1);
});
