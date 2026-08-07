import redis from '../src/config/redis.js';
import prisma from '../src/config/prisma.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const BASE = 'http://localhost:3000';

const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

const HORA = 60 * 60 * 1000;

// ── Helpers (mismo patron que scripts/test-jerarquia.js) ────────────────────

const pasos = [];
function paso(nombre, ok, detalle = '') {
  pasos.push({ nombre, ok, detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
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

async function crearEmpresa(gerenteToken, nombre, cuit) {
  const { status, data } = await api('POST', '/api/empresas', { nombre, cuit }, gerenteToken);
  if (status !== 201) throw new Error(`crearEmpresa fallo (${status}): ${JSON.stringify(data)}`);
  return data;
}

async function crearVehiculoFlota(gerenteToken, id_empresa, patente, condiciones) {
  const { status, data } = await api(
    'POST',
    `/api/empresas/${id_empresa}/vehiculos`,
    { patente, marca: 'Iveco', modelo: 'Daily', anio: 2021, color: 'Gris', tipo_vehiculo: 'camion', condiciones },
    gerenteToken
  );
  if (status !== 201) throw new Error(`crearVehiculoFlota fallo (${status}): ${JSON.stringify(data)}`);
  return data.id_vehiculo;
}

async function crearVehiculoPropio(token, patente) {
  await api(
    'POST',
    '/api/conductores/mis-vehiculos',
    { patente, marca: 'Ford', modelo: 'Transit', anio: 2020, color: 'Blanco', tipo_vehiculo: 'furgon' },
    token
  );
}

async function conductorIdPorEmail(email) {
  const u = await prisma.usuario.findUnique({ where: { email }, include: { conductor: true } });
  return u.conductor.id_conductor;
}

const disponiblesEmpresa = (token, id_empresa) =>
  api('GET', `/api/empresas/${id_empresa}/viajes-disponibles`, null, token);

async function cleanup() {
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

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   TEST VISIBILIDAD DEL GERENTE — FLETER      ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const stamp = Date.now();
  const pass = 'test123456';
  const d = String(stamp).slice(-7);
  const lic = '2028-01-01T00:00:00.000Z';

  const U = {
    cli: { email: `cli-vis-${stamp}@test.com`, dni: d + '0', nombre: 'Cli', apellido: 'Vis' },
    con: {
      email: `con-vis-${stamp}@test.com`,
      dni: d + '1',
      nombre: 'Con',
      apellido: 'Vis',
      nro_licencia: 'LVA' + d,
      licencia_vencimiento: lic,
    },
    conRnd: {
      email: `conrnd-vis-${stamp}@test.com`,
      dni: d + '2',
      nombre: 'ConRnd',
      apellido: 'Vis',
      nro_licencia: 'LVR' + d,
      licencia_vencimiento: lic,
    },
    ger: {
      email: `ger-vis-${stamp}@test.com`,
      dni: d + '3',
      nombre: 'Ger',
      apellido: 'Vis',
      cuit_empresa: '30' + d + '40',
      nombre_empresa: `GerVis ${stamp}`,
    },
    ger2: {
      email: `ger2-vis-${stamp}@test.com`,
      dni: d + '4',
      nombre: 'Ger2',
      apellido: 'Vis',
      cuit_empresa: '30' + d + '50',
      nombre_empresa: `Ger2Vis ${stamp}`,
    },
  };

  console.log('── SETUP: usuarios, 2 empresas, flota con condicion FRAGIL ────\n');

  await registrar({ ...U.cli, contrasena: pass }, 'cliente');
  await registrar({ ...U.con, contrasena: pass }, 'conductor');
  await registrar({ ...U.conRnd, contrasena: pass }, 'conductor');
  await registrar({ ...U.ger, contrasena: pass }, 'gerente');
  await registrar({ ...U.ger2, contrasena: pass }, 'gerente');

  const clienteToken = await getToken(U.cli.email, pass);
  const condToken = await getToken(U.con.email, pass);
  const condRndToken = await getToken(U.conRnd.email, pass);
  const gerToken = await getToken(U.ger.email, pass);
  const ger2Token = await getToken(U.ger2.email, pass);

  // El conductor random necesita un vehiculo propio solo para existir como
  // conductor "normal"; no se afilia a ninguna empresa.
  await crearVehiculoPropio(condRndToken, `PR${String(stamp).slice(-5)}`);

  const emp = await crearEmpresa(gerToken, `Flota Vis ${stamp}`, '31' + String(stamp).slice(-9));
  const emp2 = await crearEmpresa(ger2Token, `Flota Vis2 ${stamp}`, '32' + String(stamp).slice(-9));
  const empId = emp.id_empresa;
  const emp2Id = emp2.id_empresa;

  // Flota de empresa1: un vehiculo que cumple FRAGIL (y por lo tanto tambien
  // los viajes sin condiciones), pero NO REFRIGERADO.
  const flotaVehId = await crearVehiculoFlota(gerToken, empId, `FV${String(stamp).slice(-5)}`, ['FRAGIL']);

  // El conductor se afilia a empresa1 y el gerente lo aprueba (ACTIVO).
  const condId = await conductorIdPorEmail(U.con.email);
  await api('POST', '/api/afiliaciones', { codigo_afiliacion: emp.codigo_afiliacion }, condToken);
  await api('POST', `/api/empresas/${empId}/conductores/${condId}/aprobar`, null, gerToken);

  console.log(`  empresa=${empId} (gerente1)  empresa2=${emp2Id} (gerente2)  flotaVeh=${flotaVehId} [FRAGIL]`);

  // ── CASO 1: viajes-disponibles filtra por elegibilidad de la flota ────────
  console.log('\n── CASO 1: GET /empresas/:id/viajes-disponibles filtra por flota ──\n');
  const vSi = await crearViaje(clienteToken, ['FRAGIL']); // la flota SI cumple
  const vNo = await crearViaje(clienteToken, ['REFRIGERADO']); // la flota NO cumple

  const { status: s1, data: disp } = await disponiblesEmpresa(gerToken, empId);
  const listado = Array.isArray(disp) ? disp : [];
  const filaSi = listado.find((v) => v.id_viaje === vSi);
  const filaNo = listado.find((v) => v.id_viaje === vNo);

  paso('CASO 1a: 200 y el viaje que la flota SI cumple esta en la lista', s1 === 200 && !!filaSi, `status=${s1} vSi=${vSi} presente=${!!filaSi}`);
  paso('CASO 1b: el viaje que la flota NO cumple queda excluido', !filaNo, `vNo=${vNo} presente=${!!filaNo}`);
  paso(
    'CASO 1c: cada viaje trae condiciones_req y paradas',
    !!filaSi &&
      Array.isArray(filaSi.condiciones_req) &&
      filaSi.condiciones_req.some((c) => c.condicion === 'FRAGIL') &&
      Array.isArray(filaSi.paradas) &&
      filaSi.paradas.length === 2,
    filaSi
      ? `condiciones_req=${JSON.stringify(filaSi.condiciones_req?.map((c) => c.condicion))} paradas=${filaSi.paradas?.length}`
      : 'viaje no listado'
  );
  paso(
    'CASO 1d: todos los listados estan en BUSCANDO_CONDUCTOR',
    listado.length > 0 && listado.every((v) => v.estado === 'BUSCANDO_CONDUCTOR'),
    `total=${listado.length}`
  );

  // ── CASO 2: rol distinto de GERENTE → 403 ────────────────────────────────
  console.log('\n── CASO 2: conductor / cliente sobre el endpoint → 403 ────────\n');
  const { status: s2c } = await disponiblesEmpresa(condToken, empId);
  const { status: s2cli } = await disponiblesEmpresa(clienteToken, empId);
  paso('CASO 2a: CONDUCTOR → 403', s2c === 403, `status=${s2c}`);
  paso('CASO 2b: CLIENTE → 403', s2cli === 403, `status=${s2cli}`);

  // ── CASO 3: empresa ajena → 403 ──────────────────────────────────────────
  console.log('\n── CASO 3: gerente sobre empresa ajena → 403 ─────────────────\n');
  const { status: s3, data: d3 } = await disponiblesEmpresa(gerToken, emp2Id);
  paso('CASO 3: gerente1 sobre empresa2 → 403', s3 === 403, `status=${s3} err=${d3.error}`);

  // ── CASO 4: GET /empresas/:id/viajes trae condiciones_req + vehiculo ──────
  console.log('\n── CASO 4: /empresas/:id/viajes con condiciones_req + vehiculo ──\n');
  const v4 = await crearViaje(clienteToken, ['FRAGIL']);
  const { status: r4 } = await api('POST', `/api/viajes/${v4}/reservar`, { id_empresa: empId }, gerToken);
  const { status: a4 } = await api('POST', `/api/viajes/${v4}/asignar`, { id_conductor: condId, id_vehiculo: flotaVehId }, gerToken);

  const { status: s4, data: viajesEmp } = await api('GET', `/api/empresas/${empId}/viajes`, null, gerToken);
  const fila4 = Array.isArray(viajesEmp) ? viajesEmp.find((v) => v.id_viaje === v4) : null;

  paso('CASO 4a: reservar + asignar → 200/200', r4 === 200 && a4 === 200, `reservar=${r4} asignar=${a4}`);
  paso(
    'CASO 4b: el viaje trae condiciones_req',
    !!fila4 && Array.isArray(fila4.condiciones_req) && fila4.condiciones_req.some((c) => c.condicion === 'FRAGIL'),
    fila4 ? `condiciones_req=${JSON.stringify(fila4.condiciones_req?.map((c) => c.condicion))}` : 'viaje no listado'
  );
  paso(
    'CASO 4c: el vehiculo asignado trae sus condiciones',
    !!fila4 &&
      fila4.vehiculo?.id_vehiculo === flotaVehId &&
      Array.isArray(fila4.vehiculo.condiciones) &&
      fila4.vehiculo.condiciones.some((c) => c.condicion === 'FRAGIL'),
    fila4?.vehiculo
      ? `id_vehiculo=${fila4.vehiculo.id_vehiculo} condiciones=${JSON.stringify(fila4.vehiculo.condiciones?.map((c) => c.condicion))}`
      : 'sin vehiculo en la respuesta'
  );
  paso(`CASO 4d: status 200 del listado`, s4 === 200, `status=${s4}`);

  // ── CASO 5: GET /api/viajes/:id — quien puede leerlo ─────────────────────
  console.log('\n── CASO 5: GET /api/viajes/:id — accesos ─────────────────────\n');
  const { status: g5, data: gd5 } = await api('GET', `/api/viajes/${v4}`, null, gerToken);
  const { status: g5otro } = await api('GET', `/api/viajes/${v4}`, null, ger2Token);
  const { status: g5cli } = await api('GET', `/api/viajes/${v4}`, null, clienteToken);
  const { status: g5con } = await api('GET', `/api/viajes/${v4}`, null, condToken);
  const { status: g5rnd } = await api('GET', `/api/viajes/${v4}`, null, condRndToken);

  paso(
    'CASO 5a: gerente de la empresa dueña → 200 con condiciones_req',
    g5 === 200 && Array.isArray(gd5.condiciones_req) && gd5.condiciones_req.some((c) => c.condicion === 'FRAGIL'),
    `status=${g5} condiciones_req=${JSON.stringify(gd5.condiciones_req?.map((c) => c.condicion))}`
  );
  paso('CASO 5b: gerente de OTRA empresa → 403', g5otro === 403, `status=${g5otro}`);
  paso('CASO 5c: el cliente dueño sigue accediendo → 200', g5cli === 200, `status=${g5cli}`);
  paso('CASO 5d: el conductor asignado sigue accediendo → 200', g5con === 200, `status=${g5con}`);
  paso('CASO 5e: un conductor random → 403', g5rnd === 403, `status=${g5rnd}`);

  // ── RESUMEN ──────────────────────────────────────────────────────────────
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
