// Test del timeout de reservas por TEMPORIZADOR (reemplazo del viejo job
// periodico que polleaba la DB y mantenia despierta la base de Neon).
//
// A diferencia del grueso de los scripts, este NO pega contra :3000: el timeout
// se congela al programar el setTimeout, con el RESERVA_TIMEOUT_MINUTOS del
// PROCESO, asi que un server ya levantado con el default de 10 minutos no sirve.
// Levanta su propio server por caso (helper compartido _server-efimero.js) con
// RESERVA_TIMEOUT_MINUTOS=0.1 (6 segundos) y espera de verdad al timer.
//
// IMPORTANTE — los server efimeros de los casos 1..3 arrancan con
// RESERVA_BARRIDO_ARRANQUE=0. La DB de Neon esta COMPARTIDA con produccion: un
// barrido con timeout de 6 segundos liberaria al arrancar TODA reserva de mas
// de 6 segundos, incluidas las reales. El CASO 4, que si prueba el barrido, usa
// el timeout POR DEFECTO (10 min) y planta su viaje con fecha_reserva de hace
// una hora — asi solo toca reservas genuinamente vencidas, que es exactamente
// lo que el barrido debe hacer en produccion.
//
// Casos:
//   1. Reservar y no asignar -> pasado el timeout vuelve a BUSCANDO_CONDUCTOR y
//      se republica: un conductor conectado DESPUES de la reserva recibe
//      viaje:disponible.
//   2. Reservar y asignar ANTES del timeout -> el timer no libera nada; pasado
//      el tiempo el viaje sigue en CONDUCTOR_ASIGNADO con su conductor.
//   3. Reservar y cancelar-reserva a mano -> pasado el tiempo no pasa nada raro
//      (el timer no dispara sobre un viaje que ya volvio al mercado).
//   4. Barrido de arranque: viaje en RESERVADO_POR_EMPRESA con fecha_reserva
//      vencida escrito directo en la DB -> el server lo libera al levantar.
import { io as ioClient } from 'socket.io-client';
import prisma from '../src/config/prisma.js';
import redis from '../src/config/redis.js';
import { conServer } from './_server-efimero.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const SETUP_BASE = 'http://localhost:3000'; // solo para el alta de fixtures

const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

const MIN = 60 * 1000;
const HORA = 60 * MIN;

// RESERVA_TIMEOUT_MINUTOS de los casos 1..3. 0.1 min = 6 s.
const TIMEOUT_CORTO = 0.1;
// Margen sobre los 6 s antes de mirar el resultado.
const ESPERA_POST_TIMEOUT = 9000;

// -- Helpers ----------------------------------------------------------------

const pasos = [];
function paso(nombre, ok, detalle = '') {
  pasos.push({ nombre, ok, detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function api(base, method, path, body, token) {
  const res = await fetch(`${base}${path}`, {
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

function conectar(base, token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { auth: { token: 'Bearer ' + token } });
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
  const { status, data } = await api(SETUP_BASE, 'POST', endpoint, datos, null);
  if (status !== 201 && status !== 409) {
    throw new Error(`registro ${tipo} (${datos.email}) fallo: ${status} ${JSON.stringify(data)}`);
  }
}

async function crearViaje(base, clienteToken) {
  const fecha = new Date(Date.now() + 2 * HORA).toISOString();
  const { status, data } = await api(
    base,
    'POST',
    '/api/viajes',
    {
      zona: 'CABA',
      fecha_programada: fecha,
      condiciones_requeridas: [],
      paradas: [PARADA_1, PARADA_2],
    },
    clienteToken
  );
  if (status !== 201) throw new Error(`crearViaje fallo (${status}): ${JSON.stringify(data)}`);
  return data.id_viaje;
}

const reservar = (base, token, id_viaje, id_empresa) =>
  api(base, 'POST', `/api/viajes/${id_viaje}/reservar`, { id_empresa }, token);
const asignar = (base, token, id_viaje, id_conductor, id_vehiculo) =>
  api(base, 'POST', `/api/viajes/${id_viaje}/asignar`, { id_conductor, id_vehiculo }, token);
const cancelarReserva = (base, token, id_viaje) =>
  api(base, 'POST', `/api/viajes/${id_viaje}/cancelar-reserva`, null, token);
const estadoDe = (id_viaje) => prisma.viaje.findUnique({ where: { id_viaje } });

async function cleanup(sockets = []) {
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

// -- Main -------------------------------------------------------------------

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   TEST TIMEOUT DE RESERVA (TIMERS) — FLETER  ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const stamp = Date.now();
  const pass = 'test123456';
  const d = String(stamp).slice(-7);
  const lic = '2028-01-01T00:00:00.000Z';

  // -- SETUP (contra :3000, que ya tiene que estar corriendo) ---------------
  console.log('-- SETUP: usuarios, empresa, afiliacion, flota ----------------\n');

  const U = {
    cli: { email: `cli-tmo-${stamp}@test.com`, dni: d + '0', nombre: 'Cli', apellido: 'Tmo' },
    con: { email: `con-tmo-${stamp}@test.com`, dni: d + '1', nombre: 'Con', apellido: 'Tmo', nro_licencia: 'LT' + d, licencia_vencimiento: lic },
    tar: { email: `tar-tmo-${stamp}@test.com`, dni: d + '2', nombre: 'Tar', apellido: 'Tmo', nro_licencia: 'LR' + d, licencia_vencimiento: lic },
    ger: { email: `ger-tmo-${stamp}@test.com`, dni: d + '3', nombre: 'Ger', apellido: 'Tmo', cuit_empresa: '30' + d + '40', nombre_empresa: `GerTmo ${stamp}` },
  };

  await registrar({ ...U.cli, contrasena: pass }, 'cliente');
  await registrar({ ...U.con, contrasena: pass }, 'conductor');
  await registrar({ ...U.tar, contrasena: pass }, 'conductor');
  await registrar({ ...U.ger, contrasena: pass }, 'gerente');

  const clienteToken = await getToken(U.cli.email, pass);
  const condToken = await getToken(U.con.email, pass);
  const tardioToken = await getToken(U.tar.email, pass);
  const gerenteToken = await getToken(U.ger.email, pass);

  // El "tardio" necesita un vehiculo propio para ser elegible en la republicacion.
  await api(
    SETUP_BASE,
    'POST',
    '/api/conductores/mis-vehiculos',
    { patente: `TR${String(stamp).slice(-5)}`, marca: 'Ford', modelo: 'Transit', anio: 2020, color: 'Blanco', tipo_vehiculo: 'furgon' },
    tardioToken
  );

  const condId = (
    await prisma.usuario.findUnique({ where: { email: U.con.email }, include: { conductor: true } })
  ).conductor.id_conductor;

  const { data: emp } = await api(
    SETUP_BASE,
    'POST',
    '/api/empresas',
    { nombre: `Flota Timeout ${stamp}`, cuit: '30' + String(stamp).slice(-9) },
    gerenteToken
  );
  const empId = emp.id_empresa;

  await api(SETUP_BASE, 'POST', '/api/afiliaciones', { codigo_afiliacion: emp.codigo_afiliacion }, condToken);
  await api(SETUP_BASE, 'POST', `/api/empresas/${empId}/conductores/${condId}/aprobar`, null, gerenteToken);

  const { data: flotaVeh } = await api(
    SETUP_BASE,
    'POST',
    `/api/empresas/${empId}/vehiculos`,
    { patente: `FT${String(stamp).slice(-5)}`, marca: 'Iveco', modelo: 'Daily', anio: 2021, color: 'Gris', tipo_vehiculo: 'camion' },
    gerenteToken
  );
  const flotaVehId = flotaVeh.id_vehiculo;

  console.log(`  setup ok: empresa=${empId} conductor=${condId} vehiculo_flota=${flotaVehId}`);

  const ENV_CORTO = {
    RESERVA_TIMEOUT_MINUTOS: String(TIMEOUT_CORTO),
    RESERVA_BARRIDO_ARRANQUE: '0',
  };

  // -- CASO 1: reservar y NO asignar -> el timer libera y republica ---------
  await conServer(ENV_CORTO, 3201, async (base) => {
    console.log('\n-- CASO 1: reservar sin asignar -> timeout libera + republica --\n');

    const v = await crearViaje(base, clienteToken);
    await esperar(1200);
    const { status: rs } = await reservar(base, gerenteToken, v, empId);
    const reservado = await estadoDe(v);

    // "Conector tardio": se conecta DESPUES de la reserva, o sea que NO esta en
    // el room del viaje. Solo lo alcanza si la liberacion republica DE CERO.
    const sTardio = await conectar(base, tardioToken);
    const disponibles = new Map();
    sTardio.on('viaje:disponible', (dat) => disponibles.set(dat.id_viaje, dat));
    await esperar(1000);

    paso(
      'CASO 1a: reservar -> 200 y RESERVADO_POR_EMPRESA',
      rs === 200 && reservado.estado === 'RESERVADO_POR_EMPRESA' && reservado.id_empresa === empId,
      `status=${rs} estado=${reservado.estado}`
    );

    // Todavia dentro de la ventana: el timer NO tiene que haber disparado.
    await esperar(2000);
    const antes = await estadoDe(v);
    paso(
      'CASO 1b: a los ~2s (timeout 6s) la reserva SIGUE viva',
      antes.estado === 'RESERVADO_POR_EMPRESA',
      `estado=${antes.estado}`
    );

    await esperar(ESPERA_POST_TIMEOUT);
    const despues = await estadoDe(v);
    paso(
      'CASO 1c: pasado el timeout -> BUSCANDO_CONDUCTOR, sin empresa ni fecha_reserva',
      despues.estado === 'BUSCANDO_CONDUCTOR' &&
        despues.id_empresa === null &&
        despues.fecha_reserva === null,
      `estado=${despues.estado} id_empresa=${despues.id_empresa} fecha_reserva=${despues.fecha_reserva}`
    );
    paso(
      'CASO 1d: el conductor conectado DESPUES de la reserva recibe viaje:disponible',
      disponibles.has(v),
      disponibles.has(v) ? 'ok' : 'NO recibido'
    );

    sTardio.disconnect();
  });

  // -- CASO 2: asignar antes del timeout -> el timer no libera nada ---------
  await conServer(ENV_CORTO, 3202, async (base) => {
    console.log('\n-- CASO 2: asignar antes del timeout -> el timer no toca nada --\n');

    const v = await crearViaje(base, clienteToken);
    await esperar(1200);
    await reservar(base, gerenteToken, v, empId);

    const { status: as } = await asignar(base, gerenteToken, v, condId, flotaVehId);
    const asignado = await estadoDe(v);
    paso(
      'CASO 2a: asignar dentro de la ventana -> 200 y CONDUCTOR_ASIGNADO',
      as === 200 && asignado.estado === 'CONDUCTOR_ASIGNADO' && asignado.id_conductor === condId,
      `status=${as} estado=${asignado.estado}`
    );

    // Pasado el momento en que el timer HABRIA disparado, el viaje no se movio.
    await esperar(ESPERA_POST_TIMEOUT);
    const despues = await estadoDe(v);
    paso(
      'CASO 2b: pasado el timeout el viaje SIGUE en CONDUCTOR_ASIGNADO',
      despues.estado === 'CONDUCTOR_ASIGNADO',
      `estado=${despues.estado}`
    );
    paso(
      'CASO 2c: conserva conductor, vehiculo y empresa (no se limpio nada)',
      despues.id_conductor === condId &&
        despues.id_vehiculo === flotaVehId &&
        despues.id_empresa === empId,
      `id_conductor=${despues.id_conductor} id_vehiculo=${despues.id_vehiculo} id_empresa=${despues.id_empresa}`
    );
  });

  // -- CASO 3: cancelar-reserva a mano y dejar vencer el timer --------------
  await conServer(ENV_CORTO, 3203, async (base) => {
    console.log('\n-- CASO 3: cancelar-reserva a mano -> el timer no hace daño ---\n');

    const v = await crearViaje(base, clienteToken);
    await esperar(1200);
    await reservar(base, gerenteToken, v, empId);

    const { status: cs } = await cancelarReserva(base, gerenteToken, v);
    const trasCancelar = await estadoDe(v);
    paso(
      'CASO 3a: cancelar-reserva -> 200 y vuelve a BUSCANDO_CONDUCTOR',
      cs === 200 && trasCancelar.estado === 'BUSCANDO_CONDUCTOR' && trasCancelar.id_empresa === null,
      `status=${cs} estado=${trasCancelar.estado}`
    );

    // El momento en que el timer original habria vencido pasa sin consecuencias:
    // ni re-libera, ni republica de nuevo, ni rompe el viaje.
    await esperar(ESPERA_POST_TIMEOUT);
    const despues = await estadoDe(v);
    paso(
      'CASO 3b: pasado el vencimiento sigue en BUSCANDO_CONDUCTOR, intacto',
      despues.estado === 'BUSCANDO_CONDUCTOR' &&
        despues.id_empresa === null &&
        despues.fecha_reserva === null &&
        despues.id_conductor === null,
      `estado=${despues.estado} id_empresa=${despues.id_empresa} id_conductor=${despues.id_conductor}`
    );

    // Y un viaje reservado DESPUES de esa cancelacion no se ve afectado: prueba
    // que el Map de timers no quedo con basura del viaje anterior.
    const v2 = await crearViaje(base, clienteToken);
    await esperar(1200);
    await reservar(base, gerenteToken, v2, empId);
    const v2Reservado = await estadoDe(v2);
    paso(
      'CASO 3c: una reserva nueva posterior arranca sana (RESERVADO_POR_EMPRESA)',
      v2Reservado.estado === 'RESERVADO_POR_EMPRESA',
      `estado=${v2Reservado.estado}`
    );
    await esperar(ESPERA_POST_TIMEOUT);
    const v2Despues = await estadoDe(v2);
    paso(
      'CASO 3d: y esa reserva nueva SI vence por su propio timer',
      v2Despues.estado === 'BUSCANDO_CONDUCTOR',
      `estado=${v2Despues.estado}`
    );
  });

  // -- CASO 4: barrido de arranque -----------------------------------------
  // Con el timeout POR DEFECTO (10 min), no el corto: ver la nota de arriba
  // sobre la DB compartida con produccion.
  console.log('\n-- CASO 4: barrido de arranque libera una reserva vencida -----\n');

  // Viaje reservado a mano en la DB, con fecha_reserva de hace una hora. Nadie
  // le programo timer: simula el viaje que quedo reservado cuando el proceso
  // anterior se cayo.
  const vBarrido = await crearViaje(SETUP_BASE, clienteToken);
  await esperar(800);
  await prisma.viaje.update({
    where: { id_viaje: vBarrido },
    data: {
      estado: 'RESERVADO_POR_EMPRESA',
      id_empresa: empId,
      fecha_reserva: new Date(Date.now() - 60 * MIN),
    },
  });

  // Y uno reservado RECIEN, que el barrido debe REPROGRAMAR en vez de liberar.
  const vVigente = await crearViaje(SETUP_BASE, clienteToken);
  await esperar(800);
  await prisma.viaje.update({
    where: { id_viaje: vVigente },
    data: { estado: 'RESERVADO_POR_EMPRESA', id_empresa: empId, fecha_reserva: new Date() },
  });

  const previo = await estadoDe(vBarrido);
  paso(
    'CASO 4a: el viaje queda RESERVADO_POR_EMPRESA vencido, sin ningun timer',
    previo.estado === 'RESERVADO_POR_EMPRESA' && previo.fecha_reserva !== null,
    `estado=${previo.estado} fecha_reserva=${previo.fecha_reserva?.toISOString()}`
  );

  await conServer({}, 3204, async (_base, leerLog) => {
    // El barrido corre al levantar; conServer ya espero a /health.
    await esperar(2500);

    const liberado = await estadoDe(vBarrido);
    paso(
      'CASO 4b: al arrancar, el barrido libera la reserva vencida -> BUSCANDO_CONDUCTOR',
      liberado.estado === 'BUSCANDO_CONDUCTOR' &&
        liberado.id_empresa === null &&
        liberado.fecha_reserva === null,
      `estado=${liberado.estado} id_empresa=${liberado.id_empresa}`
    );

    const vigente = await estadoDe(vVigente);
    paso(
      'CASO 4c: la reserva NO vencida sobrevive al barrido (se le reprograma el timer)',
      vigente.estado === 'RESERVADO_POR_EMPRESA' && vigente.id_empresa === empId,
      `estado=${vigente.estado}`
    );

    const log = leerLog();
    const linea = log.split('\n').find((l) => l.includes('barrido de arranque')) ?? '';
    const m = linea.match(
      /(\d+) reservas activas, (\d+) liberadas por vencimiento, (\d+) con timer reprogramado/
    );
    paso(
      'CASO 4d: loguea cuantas encontro / libero / reprogramo',
      !!m && Number(m[1]) >= 2 && Number(m[2]) >= 1 && Number(m[3]) >= 1,
      linea.trim() || 'no se encontro la linea del barrido en el log'
    );

    // Limpieza: el viaje vigente queda reservado; lo soltamos para no dejar
    // basura en RESERVADO_POR_EMPRESA en la DB compartida.
    await prisma.viaje.update({
      where: { id_viaje: vVigente },
      data: { estado: 'CANCELADO', id_empresa: null, fecha_reserva: null },
    });
  });

  // -- RESUMEN -------------------------------------------------------------
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
