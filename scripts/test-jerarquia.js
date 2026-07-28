import { io } from 'socket.io-client';
import redis from '../src/config/redis.js';
import prisma from '../src/config/prisma.js';

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
  // 201 = creado; 409 = ya existia (email/dni). Cualquier otra cosa es un fallo real.
  if (status !== 201 && status !== 409) {
    throw new Error(`registro ${tipo} (${datos.email}) fallo: ${status} ${JSON.stringify(data)}`);
  }
}

async function crearVehiculoPropioSiNoExiste(token, patente) {
  await api(
    'POST',
    '/api/conductores/mis-vehiculos',
    { patente, marca: 'Ford', modelo: 'Transit', anio: 2020, color: 'Blanco', tipo_vehiculo: 'furgon' },
    token
  );
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
const reasignar = (token, id_viaje, id_conductor, id_vehiculo) =>
  api('POST', `/api/viajes/${id_viaje}/reasignar`, { id_conductor, id_vehiculo }, token);
const iniciar = (token, id_viaje) => api('POST', `/api/viajes/${id_viaje}/iniciar`, null, token);
const estadoDe = async (id_viaje) => (await prisma.viaje.findUnique({ where: { id_viaje } }));

async function conductorIdPorEmail(email) {
  const u = await prisma.usuario.findUnique({ where: { email }, include: { conductor: true } });
  return u.conductor.id_conductor;
}
async function setFecha(id_viaje, fechaDate) {
  await prisma.viaje.update({ where: { id_viaje }, data: { fecha_programada: fechaDate } });
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
  console.log('║   TEST ESTRUCTURA JERARQUICA — FLETER        ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const stamp = Date.now();
  let sCliente, sGerente, sA, sB;

  // ── SETUP ────────────────────────────────────────────────────────────────
  console.log('── SETUP: usuarios, empresa, afiliaciones, flota ──────────────\n');

  // Identidades frescas por corrida (email/dni/cuit derivados del timestamp)
  // para evitar el drift Firebase↔DB: registro siempre crea ambos lados limpios.
  const pass = 'test123456';
  const d = String(stamp).slice(-7);
  const lic = '2028-01-01T00:00:00.000Z';
  const U = {
    cli: { email: `cli-jer-${stamp}@test.com`, dni: d + '0', nombre: 'Cli', apellido: 'Jer' },
    conA: { email: `cona-jer-${stamp}@test.com`, dni: d + '1', nombre: 'ConA', apellido: 'Jer', nro_licencia: 'LJA' + d, licencia_vencimiento: lic },
    conB: { email: `conb-jer-${stamp}@test.com`, dni: d + '2', nombre: 'ConB', apellido: 'Jer', nro_licencia: 'LJB' + d, licencia_vencimiento: lic },
    con3: { email: `con3-jer-${stamp}@test.com`, dni: d + '3', nombre: 'Con3', apellido: 'Jer', nro_licencia: 'LJC' + d, licencia_vencimiento: lic },
    ger: { email: `ger-jer-${stamp}@test.com`, dni: d + '4', nombre: 'Ger', apellido: 'Jer', cuit_empresa: '30' + d + '40', nombre_empresa: `GerJer ${stamp}` },
    ger2: { email: `ger2-jer-${stamp}@test.com`, dni: d + '5', nombre: 'Ger2', apellido: 'Jer', cuit_empresa: '30' + d + '50', nombre_empresa: `Ger2Jer ${stamp}` },
  };

  await registrar({ ...U.cli, contrasena: pass }, 'cliente');
  await registrar({ ...U.conA, contrasena: pass }, 'conductor');
  await registrar({ ...U.conB, contrasena: pass }, 'conductor');
  await registrar({ ...U.con3, contrasena: pass }, 'conductor');
  await registrar({ ...U.ger, contrasena: pass }, 'gerente');
  await registrar({ ...U.ger2, contrasena: pass }, 'gerente');

  const clienteToken = await getToken(U.cli.email, pass);
  const condAToken = await getToken(U.conA.email, pass);
  const condBToken = await getToken(U.conB.email, pass);
  const gerenteToken = await getToken(U.ger.email, pass);
  const gerente2Token = await getToken(U.ger2.email, pass);

  await crearVehiculoPropioSiNoExiste(condAToken, `PA${String(stamp).slice(-5)}`);
  await crearVehiculoPropioSiNoExiste(condBToken, `PB${String(stamp).slice(-5)}`);

  const condAId = await conductorIdPorEmail(U.conA.email);
  const condBId = await conductorIdPorEmail(U.conB.email);
  const cond3Id = await conductorIdPorEmail(U.con3.email);
  const gerenteUid = (await prisma.usuario.findUnique({ where: { email: U.ger.email } })).id_usuario;
  const clienteId = (await prisma.usuario.findUnique({ where: { email: U.cli.email }, include: { cliente: true } })).cliente.id_cliente;

  sCliente = await conectar(clienteToken);
  sGerente = await conectar(gerenteToken);
  sA = await conectar(condAToken);
  sB = await conectar(condBToken);

  // Collectors
  const dispG = new Map();
  const resvG = new Map();
  const reasigG = new Map();
  sGerente.on('viaje:disponible', (d) => dispG.set(d.id_viaje, d));
  sGerente.on('viaje:reservado', (d) => resvG.set(d.id_viaje, d));
  sGerente.on('viaje:requiere_reasignacion', (d) => reasigG.set(d.id_viaje, d));

  const asigA = new Map();
  const resvA = new Map();
  const condAsigA = new Map();
  sA.on('viaje:asignado', (d) => asigA.set(d.id_viaje, d));
  sA.on('viaje:reservado', (d) => resvA.set(d.id_viaje, d));
  sA.on('viaje:conductor_asignado', (d) => condAsigA.set(d.id_viaje, d));

  const asigB = new Map();
  sB.on('viaje:asignado', (d) => asigB.set(d.id_viaje, d));

  await esperar(1200);

  // ── CASO 1: Crear empresa → codigo_afiliacion ──────────────────────────────
  console.log('\n── CASO 1: crear empresa → codigo_afiliacion ──────────────────\n');
  const { status: c1s, data: emp } = await api('POST', '/api/empresas', { nombre: `Flota Jerarquia ${stamp}`, cuit: '30' + String(stamp).slice(-9) }, gerenteToken);
  const empId = emp.id_empresa;
  const empCodigo = emp.codigo_afiliacion;
  paso('CASO 1: POST /api/empresas → 201 con codigo_afiliacion', c1s === 201 && typeof empCodigo === 'string' && empCodigo.length >= 6, `status=${c1s} codigo=${empCodigo}`);

  // ── CASO 2: afiliar → PENDIENTE, aprobar → ACTIVO ──────────────────────────
  console.log('\n── CASO 2: afiliar (PENDIENTE) → aprobar (ACTIVO) ─────────────\n');
  const { data: afiliA } = await api('POST', '/api/afiliaciones', { codigo_afiliacion: empCodigo }, condAToken);
  paso('CASO 2a: afiliacion con codigo → PENDIENTE', afiliA.estado === 'PENDIENTE', `estado=${afiliA.estado}`);
  const { status: apA } = await api('POST', `/api/empresas/${empId}/conductores/${condAId}/aprobar`, null, gerenteToken);
  const ceA = await prisma.conductorEmpresa.findUnique({ where: { id_conductor_id_empresa: { id_conductor: condAId, id_empresa: empId } } });
  paso('CASO 2b: gerente aprueba → ACTIVO', apA === 200 && ceA.estado === 'ACTIVO', `aprobar=${apA} estado=${ceA.estado}`);

  // conductorB tambien ACTIVO (para reasignacion, caso 9) — setup silencioso
  await api('POST', '/api/afiliaciones', { codigo_afiliacion: empCodigo }, condBToken);
  await api('POST', `/api/empresas/${empId}/conductores/${condBId}/aprobar`, null, gerenteToken);

  // ── CASO 3: GET /afiliaciones/mias lista la empresa en ACTIVO ──────────────
  console.log('\n── CASO 3: GET /afiliaciones/mias (conductor) → ACTIVO ────────\n');
  const { data: miasA } = await api('GET', '/api/afiliaciones/mias', null, condAToken);
  const filaE = Array.isArray(miasA) ? miasA.find((a) => a.empresa?.id_empresa === empId) : null;
  paso('CASO 3: /afiliaciones/mias incluye la empresa en estado ACTIVO', !!filaE && filaE.estado === 'ACTIVO', filaE ? `estado=${filaE.estado}` : 'empresa no listada');

  // ── CASO 4: registrar vehiculo en flota; GET flota lo lista ────────────────
  console.log('\n── CASO 4: registrar vehiculo de flota + listar ──────────────\n');
  const { status: c4s, data: flotaVeh } = await api('POST', `/api/empresas/${empId}/vehiculos`, { patente: `FL${String(stamp).slice(-5)}`, marca: 'Iveco', modelo: 'Daily', anio: 2021, color: 'Gris', tipo_vehiculo: 'camion' }, gerenteToken);
  const flotaVehId = flotaVeh.id_vehiculo;
  const { data: flotaList } = await api('GET', `/api/empresas/${empId}/vehiculos`, null, gerenteToken);
  paso('CASO 4: POST flota → 201 y GET flota lo lista', c4s === 201 && Array.isArray(flotaList) && flotaList.some((v) => v.id_vehiculo === flotaVehId), `status=${c4s} enLista=${flotaList.some((v) => v.id_vehiculo === flotaVehId)}`);

  // ── CASO 5: cliente crea viaje; gerente lo ve disponible; reserva ──────────
  console.log('\n── CASO 5: gerente ve disponible → reserva → sale del pool ────\n');
  const v5 = await crearViaje(clienteToken);
  await esperar(1500);
  paso('CASO 5a: gerente recibe viaje:disponible (flota cumple condiciones)', dispG.has(v5), dispG.has(v5) ? `id=${v5}` : 'no recibido');
  resvA.delete(v5);
  const { status: r5s } = await reservar(gerenteToken, v5, empId);
  await esperar(1200);
  const v5Db = await estadoDe(v5);
  paso('CASO 5b: reservar → 200, RESERVADO_POR_EMPRESA, id_empresa seteado', r5s === 200 && v5Db.estado === 'RESERVADO_POR_EMPRESA' && v5Db.id_empresa === empId, `status=${r5s} estado=${v5Db.estado} id_empresa=${v5Db.id_empresa}`);
  paso('CASO 5c: sale del pool — conductor A recibe viaje:reservado', resvA.has(v5), resvA.has(v5) ? 'ok' : 'no recibido');

  // ── CASO 6: asignar → CONDUCTOR_ASIGNADO, viaje:asignado, /asignados ───────
  console.log('\n── CASO 6: asignar conductor + vehiculo → viaje:asignado ─────\n');
  asigA.delete(v5);
  const { status: a6s } = await asignar(gerenteToken, v5, condAId, flotaVehId);
  await esperar(1200);
  const v5Asig = await estadoDe(v5);
  paso('CASO 6a: asignar → 200, CONDUCTOR_ASIGNADO con conductor+vehiculo', a6s === 200 && v5Asig.estado === 'CONDUCTOR_ASIGNADO' && v5Asig.id_conductor === condAId && v5Asig.id_vehiculo === flotaVehId, `status=${a6s} estado=${v5Asig.estado}`);
  paso('CASO 6b: el conductor recibe viaje:asignado', asigA.has(v5), asigA.has(v5) ? 'ok' : 'no recibido');
  const { data: asignadosA } = await api('GET', '/api/viajes/asignados', null, condAToken);
  paso('CASO 6c: GET /viajes/asignados lista el viaje con vehiculo', Array.isArray(asignadosA) && asignadosA.some((v) => v.id_viaje === v5 && v.vehiculo?.id_vehiculo === flotaVehId), asignadosA.some((v) => v.id_viaje === v5) ? 'listado' : 'no listado');

  // ── CASO 7: iniciar por GERENTE, y por CONDUCTOR en otro viaje ─────────────
  console.log('\n── CASO 7: iniciar por gerente / por conductor ───────────────\n');
  await setFecha(v5, new Date());
  const { status: i7g, data: i7gd } = await iniciar(gerenteToken, v5);
  paso('CASO 7a: gerente inicia → 200, iniciado_por=GERENTE, EN_CAMINO_A_ORIGEN', i7g === 200 && i7gd.iniciado_por === 'GERENTE' && i7gd.estado === 'EN_CAMINO_A_ORIGEN', `status=${i7g} iniciado_por=${i7gd.iniciado_por}`);

  const v7b = await crearViaje(clienteToken);
  await esperar(1000);
  await reservar(gerenteToken, v7b, empId);
  await asignar(gerenteToken, v7b, condAId, flotaVehId);
  await setFecha(v7b, new Date());
  const { data: i7cd } = await iniciar(condAToken, v7b);
  paso('CASO 7b: conductor inicia otro viaje → iniciado_por=CONDUCTOR', i7cd.iniciado_por === 'CONDUCTOR' && i7cd.estado === 'EN_CAMINO_A_ORIGEN', `iniciado_por=${i7cd.iniciado_por}`);

  // ── CASO 8: timeout de reserva → BUSCANDO_CONDUCTOR + republicacion ────────
  console.log('\n── CASO 8: timeout de reserva → republica a un tardio ────────\n');
  const v8 = await crearViaje(clienteToken);
  await esperar(1200);
  await reservar(gerenteToken, v8, empId);
  await esperar(600);
  // "conector tardio": socket nuevo que NO estaba en el room al reservar
  const sTarde = await conectar(condBToken);
  const dispTarde = new Map();
  sTarde.on('viaje:disponible', (d) => dispTarde.set(d.id_viaje, d));
  await esperar(1000);
  // forzar fecha_reserva vieja y esperar que el job del server la libere
  await prisma.viaje.update({ where: { id_viaje: v8 }, data: { fecha_reserva: new Date(Date.now() - 60 * MIN) } });
  await esperar(6000); // el server corre con RESERVA_CHECK_INTERVAL_MS corto
  const v8Db = await estadoDe(v8);
  paso('CASO 8a: el job libera la reserva → BUSCANDO_CONDUCTOR, sin empresa', v8Db.estado === 'BUSCANDO_CONDUCTOR' && v8Db.id_empresa === null && v8Db.fecha_reserva === null, `estado=${v8Db.estado} id_empresa=${v8Db.id_empresa}`);
  paso('CASO 8b: el conector tardio (post-reserva) recibe viaje:disponible', dispTarde.has(v8), dispTarde.has(v8) ? 'ok' : 'NO recibido');
  sTarde.disconnect();

  // ── CASO 9: reasignacion A → B antes de iniciar ────────────────────────────
  console.log('\n── CASO 9: reasignar conductor A → B (sin iniciar) ───────────\n');
  const v9 = await crearViaje(clienteToken);
  await esperar(1000);
  await reservar(gerenteToken, v9, empId);
  await asignar(gerenteToken, v9, condAId, flotaVehId);
  const { status: re9s } = await reasignar(gerenteToken, v9, condBId, flotaVehId);
  await esperar(800);
  const v9Db = await estadoDe(v9);
  paso('CASO 9: reasignar → el viaje queda con conductor B', re9s === 200 && v9Db.id_conductor === condBId && v9Db.estado === 'CONDUCTOR_ASIGNADO', `status=${re9s} id_conductor=${v9Db.id_conductor} (B=${condBId})`);

  // ── CASO 10: cancelacion de conductor de empresa → RESERVADO + evento ──────
  console.log('\n── CASO 10: conductor de empresa cancela → RESERVADO_POR_EMPRESA ──\n');
  const v10 = await crearViaje(clienteToken);
  await esperar(1000);
  await reservar(gerenteToken, v10, empId);
  await asignar(gerenteToken, v10, condAId, flotaVehId);
  reasigG.delete(v10);
  const { status: c10s, data: c10d } = await api('POST', `/api/viajes/${v10}/cancelar-conductor`, null, condAToken);
  await esperar(1200);
  const v10Db = await estadoDe(v10);
  paso('CASO 10a: cancela conductor de empresa → RESERVADO_POR_EMPRESA (no BUSCANDO_CONDUCTOR)', c10s === 200 && c10d.estado === 'RESERVADO_POR_EMPRESA' && v10Db.estado === 'RESERVADO_POR_EMPRESA', `status=${c10s} estado=${v10Db.estado}`);
  paso('CASO 10b: gerente recibe viaje:requiere_reasignacion motivo conductor_cancelo', reasigG.get(v10)?.motivo === 'conductor_cancelo', reasigG.has(v10) ? `motivo=${reasigG.get(v10).motivo}` : 'no recibido');

  // ── CASO 11: desafiliar con viaje EN CURSO → rechazado ─────────────────────
  console.log('\n── CASO 11: desafiliar con viaje EN CURSO → rechazado ────────\n');
  // v5 quedo EN_CAMINO_A_ORIGEN (caso 7) con conductor A y empresa E → en curso
  const v5Now = await estadoDe(v5);
  const { status: d11s, data: d11d } = await api('DELETE', `/api/empresas/${empId}/conductores/${condAId}`, null, gerenteToken);
  const ceA11 = await prisma.conductorEmpresa.findUnique({ where: { id_conductor_id_empresa: { id_conductor: condAId, id_empresa: empId } } });
  paso('CASO 11: desafiliar con viaje EN CURSO → 400 y sigue afiliado', ['EN_CAMINO_A_ORIGEN', 'CARGANDO', 'EN_RUTA', 'DESCARGANDO'].includes(v5Now.estado) && d11s === 400 && typeof d11d.error === 'string' && ceA11.fecha_baja === null, `estadoViaje=${v5Now.estado} status=${d11s} err=${d11d.error}`);

  // ── CASO 12: desafiliar con viaje ASIGNADO sin iniciar → vuelve a RESERVADO ─
  console.log('\n── CASO 12: desafiliar con viaje ASIGNADO sin iniciar ────────\n');
  const v12 = await crearViaje(clienteToken);
  await esperar(1000);
  await reservar(gerenteToken, v12, empId);
  await asignar(gerenteToken, v12, condBId, flotaVehId); // asignado a B, sin iniciar
  reasigG.delete(v12);
  const { status: d12s } = await api('DELETE', `/api/empresas/${empId}/conductores/${condBId}`, null, gerenteToken);
  await esperar(1200);
  const v12Db = await estadoDe(v12);
  const ceB12 = await prisma.conductorEmpresa.findUnique({ where: { id_conductor_id_empresa: { id_conductor: condBId, id_empresa: empId } } });
  paso('CASO 12a: desafiliar (B) → viaje vuelve a RESERVADO_POR_EMPRESA y B dado de baja', d12s === 200 && v12Db.estado === 'RESERVADO_POR_EMPRESA' && v12Db.id_conductor === null && ceB12.fecha_baja !== null, `status=${d12s} estado=${v12Db.estado} baja=${ceB12.fecha_baja !== null}`);
  paso('CASO 12b: gerente recibe viaje:requiere_reasignacion motivo conductor_desafiliado', reasigG.get(v12)?.motivo === 'conductor_desafiliado', reasigG.has(v12) ? `motivo=${reasigG.get(v12).motivo}` : 'no recibido');

  // ── CASO 13: conductor afiliado conserva su menu personal ──────────────────
  console.log('\n── CASO 13: conductor afiliado acepta viaje propio ───────────\n');
  const v13 = await crearViaje(clienteToken);
  await esperar(1500);
  condAsigA.delete(v13);
  sA.emit('viaje:aceptar', { id_viaje: v13 });
  await esperar(1800);
  const v13Db = await estadoDe(v13);
  paso('CASO 13: conductor afiliado acepta con su vehiculo propio → CONDUCTOR_ASIGNADO, sin empresa', v13Db.estado === 'CONDUCTOR_ASIGNADO' && v13Db.id_conductor === condAId && v13Db.id_empresa === null && condAsigA.has(v13), `estado=${v13Db.estado} id_empresa=${v13Db.id_empresa} evento=${condAsigA.has(v13)}`);

  // ── CASO 14: maquina de estados (retroceso vs valida) ──────────────────────
  console.log('\n── CASO 14: maquina de estados en PATCH /estado ──────────────\n');
  // v13 esta en CONDUCTOR_ASIGNADO con conductor A y su vehiculo propio: lo iniciamos y llevamos a EN_RUTA
  await setFecha(v13, new Date());
  await iniciar(condAToken, v13);
  const { status: t14a } = await api('PATCH', `/api/viajes/${v13}/estado`, { estado: 'CARGANDO' }, condAToken);
  const { status: t14ok } = await api('PATCH', `/api/viajes/${v13}/estado`, { estado: 'EN_RUTA' }, condAToken);
  const { status: t14b, data: t14bd } = await api('PATCH', `/api/viajes/${v13}/estado`, { estado: 'CARGANDO' }, condAToken); // retroceso
  paso('CASO 14a: transicion valida EN_CAMINO_A_ORIGEN→CARGANDO→EN_RUTA → 200', t14a === 200 && t14ok === 200, `cargando=${t14a} enruta=${t14ok}`);
  paso('CASO 14b: retroceso EN_RUTA→CARGANDO → 400 (Transicion invalida)', t14b === 400 && typeof t14bd.error === 'string' && t14bd.error.includes('Transicion invalida'), `status=${t14b} err=${t14bd.error}`);

  // ── CASO 15: calificacion de empresa (promedio de los que tienen) ──────────
  console.log('\n── CASO 15: calificacion de empresa ──────────────────────────\n');
  // Empresa aislada E15 con 3 conductores ACTIVOS: A(5), 3(3) con calificaciones, B sin ninguna.
  const emp15 = await prisma.empresa.create({ data: { id_gerente: gerenteUid, cuit: '31' + String(stamp).slice(-9), nombre: `Calif ${stamp}`, codigo_afiliacion: 'C' + String(stamp).slice(-7) } });
  for (const cid of [condAId, cond3Id, condBId]) {
    await prisma.conductorEmpresa.upsert({
      where: { id_conductor_id_empresa: { id_conductor: cid, id_empresa: emp15.id_empresa } },
      update: { estado: 'ACTIVO', fecha_baja: null },
      create: { id_conductor: cid, id_empresa: emp15.id_empresa, estado: 'ACTIVO' },
    });
  }
  // Dar calificaciones a A y 3 (via viaje+calificacion directos), dejar B sin.
  async function darCalificacion(id_conductor, puntaje) {
    const v = await prisma.viaje.create({ data: { id_cliente: clienteId, zona: 'CABA', fecha_programada: new Date(), estado: 'FINALIZADO', id_conductor } });
    await prisma.calificacion.create({ data: { id_viaje: v.id_viaje, id_cliente: clienteId, id_conductor, puntaje } });
    const avg = await prisma.calificacion.aggregate({ where: { id_conductor }, _avg: { puntaje: true } });
    await prisma.conductor.update({ where: { id_conductor }, data: { calificacion_promedio: avg._avg.puntaje ?? 0 } });
    return avg._avg.puntaje;
  }
  const avgA = await darCalificacion(condAId, 5);
  const avg3 = await darCalificacion(cond3Id, 3);
  // Asegurar que B (conductor2) no tenga calificaciones -> lo omitimos del promedio
  const bCount = await prisma.calificacion.count({ where: { id_conductor: condBId } });
  const { data: emp15Get } = await api('GET', `/api/empresas/${emp15.id_empresa}`, null, gerenteToken);
  const esperado = (avgA + avg3) / 2;
  paso('CASO 15: calificacion_promedio = promedio de los conductores con calificacion (excluye al que no tiene)', bCount === 0 ? Math.abs((emp15Get.calificacion_promedio ?? -1) - esperado) < 0.001 && emp15Get.cantidad_conductores_activos === 3 : true, `promedio=${emp15Get.calificacion_promedio} esperado=${esperado} activos=${emp15Get.cantidad_conductores_activos} bCount=${bCount}`);

  // ── CASO 16: vehiculo que no cumple condiciones → asignar rechazado ────────
  console.log('\n── CASO 16: asignar vehiculo que no cumple condiciones → 400 ──\n');
  const v16 = await crearViaje(clienteToken, ['REFRIGERADO']); // la flota no tiene REFRIGERADO
  await esperar(1000);
  const { status: r16s } = await reservar(gerenteToken, v16, empId);
  const { status: a16s, data: a16d } = await asignar(gerenteToken, v16, condAId, flotaVehId);
  paso('CASO 16: reservar ok pero asignar vehiculo sin la condicion → 400', r16s === 200 && a16s === 400 && typeof a16d.error === 'string' && a16d.error.toLowerCase().includes('condicion'), `reservar=${r16s} asignar=${a16s} err=${a16d.error}`);

  // ── CASO 17: permisos ──────────────────────────────────────────────────────
  console.log('\n── CASO 17: permisos (empresa ajena / rol) ───────────────────\n');
  const { status: p17a, data: p17ad } = await api('GET', `/api/empresas/${empId}`, null, gerente2Token); // empresa ajena
  const v17 = await crearViaje(clienteToken);
  const { status: p17b } = await api('POST', `/api/viajes/${v17}/reservar`, { id_empresa: empId }, condAToken); // conductor reserva
  paso('CASO 17a: gerente sobre empresa ajena → 403', p17a === 403, `status=${p17a} err=${p17ad.error}`);
  paso('CASO 17b: conductor intenta reservar → 403 (rol)', p17b === 403, `status=${p17b}`);

  // ── CASO 18: flujo completo end-to-end por empresa → FINALIZADO ────────────
  console.log('\n── CASO 18: E2E empresa: reservar→asignar→iniciar→…→FINALIZADO ──\n');
  const v18 = await crearViaje(clienteToken);
  await esperar(1200);
  const { status: r18 } = await reservar(gerenteToken, v18, empId);
  const { status: a18 } = await asignar(gerenteToken, v18, condAId, flotaVehId);
  await setFecha(v18, new Date());
  const { status: i18 } = await iniciar(gerenteToken, v18);
  paso('CASO 18a: reservar→asignar→iniciar (gerente) → 200/200/200', r18 === 200 && a18 === 200 && i18 === 200, `reservar=${r18} asignar=${a18} iniciar=${i18}`);

  const pings = [
    { lat: -34.6037, lng: -58.3816 },
    { lat: -34.6010, lng: -58.3800 },
    { lat: -34.5980, lng: -58.3830 },
    { lat: -34.5895, lng: -58.3974 },
  ];
  const tsBase = Date.now();
  for (let i = 0; i < pings.length; i++) {
    sA.emit('conductor:ubicacion', { id_viaje: v18, lat: pings[i].lat, lng: pings[i].lng, timestamp: tsBase + i * 3000 });
    await esperar(400);
  }
  await esperar(1200);
  await api('PATCH', `/api/viajes/${v18}/estado`, { estado: 'CARGANDO' }, condAToken);
  const { status: er18 } = await api('PATCH', `/api/viajes/${v18}/estado`, { estado: 'EN_RUTA' }, condAToken);

  const { data: qrs18 } = await api('GET', `/api/viajes/${v18}/qr-paradas`, null, clienteToken);
  const ord = qrs18.sort((a, b) => a.orden - b.orden);
  await api('POST', `/api/viajes/${v18}/confirmar-parada`, { qr_firmado: ord[0].qr_firmado, lat: PARADA_1.lat, lng: PARADA_1.lng }, condAToken);
  const { data: conf18 } = await api('POST', `/api/viajes/${v18}/confirmar-parada`, { qr_firmado: ord[1].qr_firmado, lat: PARADA_2.lat, lng: PARADA_2.lng }, condAToken);
  const v18Db = await estadoDe(v18);
  paso('CASO 18b: pings + CARGANDO→EN_RUTA + QR ambas paradas → FINALIZADO con remito', er18 === 200 && conf18.viaje_finalizado === true && typeof conf18.remito_url === 'string' && conf18.remito_url.startsWith('http') && v18Db.estado === 'FINALIZADO' && typeof v18Db.precio_real === 'number', `enruta=${er18} finalizado=${conf18.viaje_finalizado} estado=${v18Db.estado} remito=${conf18.remito_url ? 'si' : 'no'}`);

  // ── RESUMEN ────────────────────────────────────────────────────────────────
  await cleanup([sCliente, sGerente, sA, sB]);

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
