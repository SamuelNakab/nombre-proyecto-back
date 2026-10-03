// Test del HISTORIAL DE ESTADOS del viaje, de las metricas por etapa que salen
// de el, de la puntualidad medida en la LLEGADA al origen, y del guard atomico
// de POST /:id/iniciar.
//
// Igual que test-viajes-vencidos y test-timeout-reserva, este NO pega contra
// :3000: necesita ANTICIPACION_MINIMA_MINUTOS=0 en el PROCESO del server para
// crear viajes a minutos vista, y sobre todo necesita mandar pings GPS por
// socket. No hay adapter de Redis, asi que los sockets se conectan al puerto
// efimero (3401-3407), no a :3000.
//
// Casos:
//   1. Flujo completo -> UNA fila por transicion, en orden, con el actor
//      correcto. Es el caso que detecta un registrarCambioEstado olvidado.
//   2. Sale TEMPRANO pero llega TARDE -> puntualidad_inicio = TARDE.
//      Con la semantica vieja (medida en la salida) esto daba A_TIEMPO.
//   3. Doble "iniciar" CONCURRENTE (conductor vs gerente) -> gana exactamente
//      uno, el otro 409, y una sola fila EN_CAMINO_A_ORIGEN.
//   4. Llegada por GPS: dentro del radio la registra, un segundo ping no la
//      pisa, fuera del radio no la registra, y sin ningun ping el paso a
//      CARGANDO la rellena como respaldo.
//   5. Un fallo del insert del historial NO tumba el cambio de estado.
//   6. Viaje sin historial (los 845 que ya existian) -> metricas null.
//   7. Los SEIS canales devuelven las metricas, y el evento viaje:finalizado
//      las trae en el mismo payload.
//
// Se le pueden pasar numeros de caso para correr solo esos:
//   node scripts/test-historial-estados.js 3
// El setup corre siempre. Sirve para el protocolo de reversion (revertir el fix
// y confirmar que el caso se pone en rojo) sin bancarse la corrida completa.
import { io as ioClient } from 'socket.io-client';
import * as turf from '@turf/turf';
import prisma from '../src/config/prisma.js';
import redis from '../src/config/redis.js';
import { registrarCambioEstado } from '../src/services/historial-estado.service.js';
import { conServer } from './_server-efimero.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const SETUP_BASE = 'http://localhost:3000'; // solo para el alta de fixtures

const ADMIN = { email: 'admin-test@fleter.com', password: 'admintest123' };

const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

const ENV = { ANTICIPACION_MINIMA_MINUTOS: '0' };

const creados = [];

const SOLO = process.argv.slice(2).map(Number).filter(Number.isFinite);
const correr = (n) => SOLO.length === 0 || SOLO.includes(n);

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
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    // Un fetch que no llega (server caido, OneDrive tocando node_modules) se
    // distingue de una respuesta real: status 0.
    return { status: 0, data: { error: `fetch fallo: ${e.message}` }, crudo: '' };
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: `Respuesta no-JSON (${res.status})` };
  }
  return { status: res.status, data, crudo: text.slice(0, 300) };
}

const desc = (r) => (r.status === 200 ? '' : ` [HTTP ${r.status}: ${r.crudo || r.data.error}]`);

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

// Viaje programado dentro de `minutos`. Con ANTICIPACION_MINIMA_MINUTOS=0 en el
// server efimero podemos programarlo a minutos vista.
async function crearViaje(base, clienteToken, minutos = 20) {
  const fecha = new Date(Date.now() + minutos * 60000).toISOString();
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
  creados.push(data.id_viaje);
  return data.id_viaje;
}

const viajeDb = (id_viaje) => prisma.viaje.findUnique({ where: { id_viaje } });
const detalle = (base, token, id) => api(base, 'GET', `/api/viajes/${id}`, null, token);

// La secuencia de estados del historial, en orden. Es lo que compara el CASO 1.
const historialDe = (id_viaje) =>
  prisma.historialEstadoViaje.findMany({
    where: { id_viaje },
    orderBy: [{ fecha: 'asc' }, { id_historial: 'asc' }],
  });
const secuencia = async (id) => (await historialDe(id)).map((h) => h.estado);

// Mueve fecha_programada para simular el paso del tiempo sin esperarlo. Es el
// mismo truco que ya usan test-confirmar-parada y test-iniciar-viaje para abrir
// la ventana de inicio.
const moverFechaProgramada = (id_viaje, ms) =>
  prisma.viaje.update({
    where: { id_viaje },
    data: { fecha_programada: new Date(Date.now() + ms) },
  });

// Un punto a `metros` del origen, para los pings de GPS. Usa turf para no
// reimplementar la geometria que el backend ya usa.
function puntoA(metros, desde = PARADA_1) {
  const p = turf.destination(turf.point([desde.lng, desde.lat]), metros, 90, { units: 'meters' });
  return { lat: p.geometry.coordinates[1], lng: p.geometry.coordinates[0] };
}

const ping = (socket, id_viaje, { lat, lng }) =>
  socket.emit('conductor:ubicacion', { id_viaje, lat, lng, timestamp: Date.now() });

// Lleva un viaje recien creado hasta CONDUCTOR_ASIGNADO via socket (conductor
// independiente) y despues hasta EN_CAMINO_A_ORIGEN via POST /iniciar.
async function aceptarEIniciar(base, socketCond, condToken, id_viaje) {
  socketCond.emit('viaje:aceptar', { id_viaje });
  await esperar(2000);
  await moverFechaProgramada(id_viaje, 0);
  const r = await api(base, 'POST', `/api/viajes/${id_viaje}/iniciar`, null, condToken);
  if (r.status !== 200) throw new Error(`iniciar fallo (${r.status}): ${JSON.stringify(r.data)}`);
  return r;
}

async function cleanup(sockets = []) {
  for (const s of sockets) {
    try {
      s?.disconnect();
    } catch {
      /* noop */
    }
  }
  // La DB esta compartida con produccion: no dejamos viajes de prueba colgados.
  try {
    if (creados.length > 0) {
      await prisma.viaje.updateMany({
        where: { id_viaje: { in: creados }, estado: { notIn: ['FINALIZADO', 'CANCELADO'] } },
        data: { estado: 'CANCELADO', motivo_cancelacion: 'limpieza test-historial-estados' },
      });
    }
  } catch (e) {
    console.error('  ⚠️  no se pudieron limpiar los viajes de prueba:', e.message);
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
  console.log('║      TEST HISTORIAL DE ESTADOS — FLETER      ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  if (SOLO.length > 0) console.log(`  (solo los casos ${SOLO.join(', ')})\n`);

  const stamp = Date.now();
  const pass = 'test123456';
  const d = String(stamp).slice(-7);
  const lic = '2028-01-01T00:00:00.000Z';

  console.log('-- SETUP: usuarios, empresa, afiliacion, flota ----------------\n');

  const U = {
    cli: { email: `cli-hst-${stamp}@test.com`, dni: d + '0', nombre: 'Cli', apellido: 'Hst' },
    con: {
      email: `con-hst-${stamp}@test.com`,
      dni: d + '1',
      nombre: 'Con',
      apellido: 'Hst',
      nro_licencia: 'LH' + d,
      licencia_vencimiento: lic,
    },
    ger: {
      email: `ger-hst-${stamp}@test.com`,
      dni: d + '2',
      nombre: 'Ger',
      apellido: 'Hst',
      cuit_empresa: '30' + d + '41',
      nombre_empresa: `GerHst ${stamp}`,
    },
  };

  await registrar({ ...U.cli, contrasena: pass }, 'cliente');
  await registrar({ ...U.con, contrasena: pass }, 'conductor');
  await registrar({ ...U.ger, contrasena: pass }, 'gerente');

  const clienteToken = await getToken(U.cli.email, pass);
  const condToken = await getToken(U.con.email, pass);
  const gerenteToken = await getToken(U.ger.email, pass);

  let adminToken = null;
  try {
    adminToken = await getToken(ADMIN.email, ADMIN.password);
  } catch {
    console.log('  ⚠️  sin admin de test: el canal admin del CASO 7 se saltea\n');
  }

  // Vehiculo propio del conductor: lo necesita para ser elegible.
  const veh = await api(
    SETUP_BASE,
    'POST',
    '/api/conductores/mis-vehiculos',
    {
      patente: ('H' + d).slice(0, 7),
      marca: 'Ford',
      modelo: 'Cargo',
      anio: 2020,
      color: 'Blanco',
      tipo_vehiculo: 'CAMION',
    },
    condToken
  );
  if (veh.status !== 201 && veh.status !== 409) {
    throw new Error(`alta de vehiculo fallo: ${veh.status} ${JSON.stringify(veh.data)}`);
  }

  // Empresa del gerente + afiliacion del conductor + vehiculo de flota.
  const emp = await api(SETUP_BASE, 'GET', '/api/empresas/mias', null, gerenteToken);
  const empresa = emp.data?.[0];
  if (!empresa) throw new Error(`el gerente no tiene empresa: ${JSON.stringify(emp.data)}`);
  const empId = empresa.id_empresa;

  await api(
    SETUP_BASE,
    'POST',
    '/api/afiliaciones',
    { codigo_afiliacion: empresa.codigo_afiliacion },
    condToken
  );
  const conductorDb = await prisma.conductor.findFirst({
    where: { usuario: { email: U.con.email } },
  });
  await api(
    SETUP_BASE,
    'POST',
    `/api/empresas/${empId}/conductores/${conductorDb.id_conductor}/aprobar`,
    null,
    gerenteToken
  );

  const flota = await api(
    SETUP_BASE,
    'POST',
    `/api/empresas/${empId}/vehiculos`,
    {
      patente: ('F' + d).slice(0, 7),
      marca: 'Iveco',
      modelo: 'Daily',
      anio: 2021,
      color: 'Azul',
      tipo_vehiculo: 'CAMION',
    },
    gerenteToken
  );
  const flotaId = flota.data?.id_vehiculo;

  const usuarioCliente = await prisma.usuario.findUnique({ where: { email: U.cli.email } });
  const usuarioCond = await prisma.usuario.findUnique({ where: { email: U.con.email } });

  console.log(`  setup ok (empresa=${empId}, conductor=${conductorDb.id_conductor}, flota=${flotaId})`);

  // Se comparte entre los casos 1 y 6: el viaje finalizado del CASO 1.
  let viajeFinalizado = null;

  // ── CASO 1: una fila por transicion, en orden ───────────────────────────
  if (correr(1)) {
    await conServer(ENV, 3401, async (base) => {
      console.log('\n-- CASO 1: flujo completo -> una fila por transicion ----------\n');

      const sCond = await conectar(base, condToken);
      await esperar(800);

      const v = await crearViaje(base, clienteToken);
      await esperar(1200);

      const trasCrear = await secuencia(v);
      paso(
        'CASO 1a: al crear el viaje ya hay una fila BUSCANDO_CONDUCTOR',
        JSON.stringify(trasCrear) === JSON.stringify(['BUSCANDO_CONDUCTOR']),
        `historial=[${trasCrear.join(', ')}]`
      );

      await aceptarEIniciar(base, sCond, condToken, v);

      for (const estado of ['CARGANDO', 'EN_RUTA', 'DESCARGANDO']) {
        const r = await api(base, 'PATCH', `/api/viajes/${v}/estado`, { estado }, condToken);
        if (r.status !== 200) throw new Error(`PATCH ${estado} fallo: ${r.status} ${r.crudo}`);
      }

      // Confirmar las dos paradas, exactamente sobre sus coordenadas.
      const det = await detalle(base, condToken, v);
      const paradas = [...det.data.paradas].sort((a, b) => a.orden - b.orden);
      for (const p of paradas) {
        const r = await api(
          base,
          'POST',
          `/api/viajes/${v}/confirmar-parada`,
          { id_parada: p.id_parada, lat: p.latitud, lng: p.longitud },
          condToken
        );
        if (r.status !== 200) {
          throw new Error(`confirmar parada ${p.orden} fallo: ${r.status} ${r.crudo}`);
        }
      }

      const esperada = [
        'BUSCANDO_CONDUCTOR',
        'CONDUCTOR_ASIGNADO',
        'EN_CAMINO_A_ORIGEN',
        'CARGANDO',
        'EN_RUTA',
        'DESCARGANDO',
        'FINALIZADO',
      ];
      const real = await secuencia(v);

      paso(
        'CASO 1b: la secuencia del historial es exactamente la del flujo, sin huecos ni duplicados',
        JSON.stringify(real) === JSON.stringify(esperada),
        `esperada=[${esperada.join(', ')}] real=[${real.join(', ')}]`
      );

      const filas = await historialDe(v);
      const fechas = filas.map((f) => new Date(f.fecha).getTime());
      paso(
        'CASO 1c: las fechas son monotonas crecientes',
        fechas.every((f, i) => i === 0 || f >= fechas[i - 1]),
        `filas=${fechas.length}`
      );

      const porEstado = Object.fromEntries(filas.map((f) => [f.estado, f]));
      paso(
        'CASO 1d: cada fila guarda quien la disparo',
        porEstado.BUSCANDO_CONDUCTOR?.origen === 'CLIENTE' &&
          porEstado.BUSCANDO_CONDUCTOR?.id_usuario === usuarioCliente.id_usuario &&
          porEstado.CONDUCTOR_ASIGNADO?.origen === 'CONDUCTOR' &&
          porEstado.CONDUCTOR_ASIGNADO?.id_usuario === usuarioCond.id_usuario &&
          porEstado.EN_CAMINO_A_ORIGEN?.origen === 'CONDUCTOR' &&
          porEstado.FINALIZADO?.origen === 'CONDUCTOR',
        `crear=${porEstado.BUSCANDO_CONDUCTOR?.origen}/${porEstado.BUSCANDO_CONDUCTOR?.id_usuario} ` +
          `aceptar=${porEstado.CONDUCTOR_ASIGNADO?.origen}/${porEstado.CONDUCTOR_ASIGNADO?.id_usuario} ` +
          `iniciar=${porEstado.EN_CAMINO_A_ORIGEN?.origen} cerrar=${porEstado.FINALIZADO?.origen}`
      );

      const detFin = await detalle(base, clienteToken, v);
      const m = detFin.data;
      paso(
        'CASO 1e: el detalle trae las metricas por etapa (enteros >= 0)',
        Number.isInteger(m.duracion_carga) &&
          m.duracion_carga >= 0 &&
          Number.isInteger(m.duracion_descarga) &&
          m.duracion_descarga >= 0 &&
          Number.isInteger(m.duracion_real) &&
          m.duracion_real >= 0 &&
          Object.hasOwn(m, 'duracion_aproximacion_origen'),
        `carga=${m.duracion_carga} descarga=${m.duracion_descarga} real=${m.duracion_real} ` +
          `aprox=${m.duracion_aproximacion_origen}${desc(detFin)}`
      );

      viajeFinalizado = v;
      sCond.disconnect();
    });
  }

  // ── CASO 2: sale temprano, llega tarde -> TARDE ─────────────────────────
  if (correr(2)) {
    await conServer(ENV, 3402, async (base) => {
      console.log('\n-- CASO 2: sale TEMPRANO pero llega TARDE ---------------------\n');

      const sCond = await conectar(base, condToken);
      await esperar(800);

      // fecha_programada dentro de 20 min: la ventana de inicio (30 min antes)
      // ya esta abierta, asi que el conductor sale 20 minutos ANTES de hora.
      // Con la semantica vieja eso era A_TIEMPO sin discusion.
      const v = await crearViaje(base, clienteToken, 20);
      await esperar(1200);
      sCond.emit('viaje:aceptar', { id_viaje: v });
      await esperar(2000);

      const rIni = await api(base, 'POST', `/api/viajes/${v}/iniciar`, null, condToken);
      paso(
        'CASO 2a: el conductor sale 20 min ANTES de la hora programada',
        rIni.status === 200,
        `status=${rIni.status}${desc(rIni)}`
      );

      paso(
        'CASO 2b: la respuesta de /iniciar ya NO devuelve puntualidad_inicio',
        !Object.hasOwn(rIni.data, 'puntualidad_inicio'),
        `campos=[${Object.keys(rIni.data).join(', ')}]`
      );

      const vTrasIniciar = await viajeDb(v);
      paso(
        'CASO 2c: la columna MUERTA puntualidad_inicio no se escribio',
        vTrasIniciar.puntualidad_inicio === null,
        `columna=${vTrasIniciar.puntualidad_inicio}`
      );

      // Simulamos que la llegada ocurre 45 min DESPUES de la hora programada:
      // movemos fecha_programada 45 min hacia atras y recien ahi mandamos el
      // ping. Mover la fecha es el mismo truco que usan los otros scripts para
      // no esperar en tiempo real.
      await moverFechaProgramada(v, -45 * 60000);
      ping(sCond, v, PARADA_1);
      await esperar(2500);

      const vTrasLlegar = await viajeDb(v);
      paso(
        'CASO 2d: el ping dentro del radio registro la llegada al origen',
        vTrasLlegar.fecha_llegada_origen !== null,
        `fecha_llegada_origen=${vTrasLlegar.fecha_llegada_origen}`
      );

      const det = await detalle(base, clienteToken, v);
      paso(
        'CASO 2e: puntualidad_inicio = TARDE (medida en la LLEGADA, no en la salida)',
        det.data.puntualidad_inicio === 'TARDE',
        `puntualidad=${det.data.puntualidad_inicio} ` +
          `(con la semantica vieja habria dado A_TIEMPO)${desc(det)}`
      );

      sCond.disconnect();
    });
  }

  // ── CASO 3: doble iniciar concurrente ───────────────────────────────────
  if (correr(3)) {
    await conServer(ENV, 3403, async (base) => {
      console.log('\n-- CASO 3: doble "iniciar" concurrente (conductor vs gerente) -\n');

      const v = await crearViaje(base, clienteToken, 20);
      await esperar(800);

      const rRes = await api(
        base,
        'POST',
        `/api/viajes/${v}/reservar`,
        { id_empresa: empId },
        gerenteToken
      );
      const rAsig = await api(
        base,
        'POST',
        `/api/viajes/${v}/asignar`,
        { id_conductor: conductorDb.id_conductor, id_vehiculo: flotaId },
        gerenteToken
      );
      paso(
        'CASO 3a: el gerente reserva y asigna',
        rRes.status === 200 && rAsig.status === 200,
        `reservar=${rRes.status} asignar=${rAsig.status}${desc(rRes)}${desc(rAsig)}`
      );

      await moverFechaProgramada(v, 0);

      // Los dos fetch arrancan en el MISMO tick: sin await entre ellos. Es la
      // carrera real — el endpoint autoriza al conductor asignado Y al gerente.
      const iniciar = (tok) => api(base, 'POST', `/api/viajes/${v}/iniciar`, null, tok);
      const [r1, r2] = await Promise.all([iniciar(condToken), iniciar(gerenteToken)]);
      await esperar(600);

      const ganadores = [r1, r2].filter((r) => r.status === 200);
      const perdedores = [r1, r2].filter((r) => r.status !== 200);

      paso(
        'CASO 3b: exactamente UNO gana',
        ganadores.length === 1,
        `ganadores=${ganadores.length} status=[${r1.status}, ${r2.status}]`
      );

      paso(
        'CASO 3c: el perdedor recibe 409 con un error string',
        perdedores.length === 1 &&
          perdedores[0].status === 409 &&
          typeof perdedores[0].data.error === 'string',
        `status=${perdedores[0]?.status} error=${perdedores[0]?.data?.error}`
      );

      const vDb = await viajeDb(v);
      paso(
        'CASO 3d: la DB coincide con el ganador (iniciado_por no quedo pisado)',
        vDb.estado === 'EN_CAMINO_A_ORIGEN' &&
          vDb.iniciado_por === ganadores[0]?.data?.iniciado_por,
        `estado=${vDb.estado} db.iniciado_por=${vDb.iniciado_por} ` +
          `ganador=${ganadores[0]?.data?.iniciado_por}`
      );

      const filas = (await historialDe(v)).filter((f) => f.estado === 'EN_CAMINO_A_ORIGEN');
      paso(
        'CASO 3e: hay UNA sola fila EN_CAMINO_A_ORIGEN en el historial',
        filas.length === 1,
        `filas=${filas.length}`
      );
    });
  }

  // ── CASO 4: llegada por GPS y su respaldo ───────────────────────────────
  if (correr(4)) {
    await conServer(ENV, 3404, async (base) => {
      console.log('\n-- CASO 4: llegada por GPS, y el respaldo de CARGANDO ---------\n');

      const sCond = await conectar(base, condToken);
      await esperar(800);

      const vA = await crearViaje(base, clienteToken, 20);
      await esperar(1200);
      await aceptarEIniciar(base, sCond, condToken, vA);

      ping(sCond, vA, puntoA(500));
      await esperar(2000);
      const lejos = await viajeDb(vA);
      paso(
        'CASO 4a: un ping a 500m del origen NO registra la llegada',
        lejos.fecha_llegada_origen === null,
        `fecha_llegada_origen=${lejos.fecha_llegada_origen}`
      );

      ping(sCond, vA, puntoA(20));
      await esperar(2000);
      const cerca = await viajeDb(vA);
      paso(
        'CASO 4b: un ping a 20m SI la registra',
        cerca.fecha_llegada_origen !== null,
        `fecha_llegada_origen=${cerca.fecha_llegada_origen}`
      );

      // Un segundo ping, todavia mas cerca, NO tiene que pisarla. Hay DOS
      // guards redundantes a proposito: el chequeo en memoria
      // (viaje.fecha_llegada_origen === null) y el WHERE del updateMany.
      // Verificado quitandolos: sacando CUALQUIERA de los dos este assert sigue
      // verde (el otro alcanza); sacando LOS DOS se pone rojo y la llegada se
      // corre. El del WHERE es el que cubre la carrera entre dos pings
      // simultaneos, que este test secuencial no puede observar.
      ping(sCond, vA, PARADA_1);
      await esperar(2000);
      const segunda = await viajeDb(vA);
      paso(
        'CASO 4c: un segundo ping mas cercano NO pisa la llegada ya registrada',
        segunda.fecha_llegada_origen?.getTime() === cerca.fecha_llegada_origen?.getTime(),
        `primera=${cerca.fecha_llegada_origen?.toISOString()} ` +
          `despues=${segunda.fecha_llegada_origen?.toISOString()}`
      );

      // Respaldo: un viaje sin ningun ping, que pasa a CARGANDO.
      const vB = await crearViaje(base, clienteToken, 20);
      await esperar(1200);
      await aceptarEIniciar(base, sCond, condToken, vB);

      const sinPing = await viajeDb(vB);
      paso(
        'CASO 4d: sin pings, la llegada sigue sin registrarse',
        sinPing.fecha_llegada_origen === null,
        `fecha_llegada_origen=${sinPing.fecha_llegada_origen}`
      );

      const rCarga = await api(
        base,
        'PATCH',
        `/api/viajes/${vB}/estado`,
        { estado: 'CARGANDO' },
        condToken
      );
      const conRespaldo = await viajeDb(vB);
      paso(
        'CASO 4e: el paso a CARGANDO rellena la llegada como respaldo de ultimo recurso',
        rCarga.status === 200 && conRespaldo.fecha_llegada_origen !== null,
        `status=${rCarga.status} fecha_llegada_origen=${conRespaldo.fecha_llegada_origen}`
      );

      sCond.disconnect();
    });
  }

  // ── CASO 5: un fallo del historial no tumba el cambio de estado ─────────
  if (correr(5)) {
    console.log('\n-- CASO 5: un fallo del historial NO rompe el cambio de estado -\n');

    // Se prueba la funcion directo con un id_viaje inexistente: el insert viola
    // la FK y falla de verdad. NO se renombra la tabla para forzar el error
    // porque la DB de Neon esta COMPARTIDA con produccion y un crash del script
    // entre el rename y el restore la dejaria rota.
    //
    // Esto es exactamente la garantia que importa: como registrarCambioEstado
    // no puede tirar, ninguno de los 12 callers que la await-ean se puede
    // romper por un fallo del historial.
    let tiro = false;
    let devolvio = null;
    try {
      devolvio = await registrarCambioEstado({
        id_viaje: 999999999,
        estado: 'CANCELADO',
        id_usuario: null,
        origen: 'SISTEMA',
      });
    } catch {
      tiro = true;
    }

    paso('CASO 5a: un insert que falla NO tira la excepcion hacia el caller', !tiro, `tiro=${tiro}`);
    paso(
      'CASO 5b: devuelve false para que el caller pueda seguir',
      devolvio === false,
      `devolvio=${devolvio}`
    );
  }

  // ── CASO 6: viaje sin historial -> metricas null ────────────────────────
  if (correr(6)) {
    await conServer(ENV, 3406, async (base) => {
      console.log('\n-- CASO 6: viaje SIN historial (los 845 que ya existian) ------\n');

      if (!viajeFinalizado) {
        paso(
          'CASO 6: SALTEADO (necesita el viaje finalizado del CASO 1)',
          true,
          'correr sin filtro, o con "1 6"'
        );
        return;
      }

      // Simula un viaje anterior a este cambio: existe y esta FINALIZADO, pero
      // no tiene ni una fila de historial.
      await prisma.historialEstadoViaje.deleteMany({ where: { id_viaje: viajeFinalizado } });

      const det = await detalle(base, clienteToken, viajeFinalizado);
      const m = det.data;
      paso(
        'CASO 6a: sin historial, las tres duraciones que dependen de el son null',
        m.duracion_real === null && m.duracion_carga === null && m.duracion_descarga === null,
        `real=${m.duracion_real} carga=${m.duracion_carga} descarga=${m.duracion_descarga}${desc(det)}`
      );

      // La aproximacion NO depende del historial (sale de dos escalares), asi
      // que sigue estando: es el unico dato que un viaje viejo puede conservar
      // si llego a registrar la llegada.
      paso(
        'CASO 6b: el campo duracion_aproximacion_origen sigue presente en el contrato',
        Object.hasOwn(m, 'duracion_aproximacion_origen'),
        `aprox=${m.duracion_aproximacion_origen}`
      );
    });
  }

  // ── CASO 7: los seis canales ────────────────────────────────────────────
  if (correr(7)) {
    await conServer(ENV, 3407, async (base) => {
      console.log('\n-- CASO 7: los SEIS canales exponen las metricas --------------\n');

      const sCond = await conectar(base, condToken);
      await esperar(800);

      // Viaje DE EMPRESA para que tambien aparezca en /empresas/:id/viajes.
      const v = await crearViaje(base, clienteToken, 20);
      await esperar(1200);
      await api(base, 'POST', `/api/viajes/${v}/reservar`, { id_empresa: empId }, gerenteToken);
      await api(
        base,
        'POST',
        `/api/viajes/${v}/asignar`,
        { id_conductor: conductorDb.id_conductor, id_vehiculo: flotaId },
        gerenteToken
      );

      // El cliente se conecta DESPUES de que el viaje existe: unirseARoomsCliente
      // engancha los rooms en el CONNECT, asi que un socket conectado antes no
      // estaria en viaje:{id} y no recibiria viaje:finalizado.
      const sCli = await conectar(base, clienteToken);
      let eventoFinalizado = null;
      sCli.on('viaje:finalizado', (dd) => (eventoFinalizado = dd));
      await esperar(800);

      await moverFechaProgramada(v, 0);
      await api(base, 'POST', `/api/viajes/${v}/iniciar`, null, condToken);

      ping(sCond, v, PARADA_1);
      await esperar(1500);

      for (const estado of ['CARGANDO', 'EN_RUTA', 'DESCARGANDO']) {
        await api(base, 'PATCH', `/api/viajes/${v}/estado`, { estado }, condToken);
      }
      const det0 = await detalle(base, condToken, v);
      for (const p of [...det0.data.paradas].sort((a, b) => a.orden - b.orden)) {
        await api(
          base,
          'POST',
          `/api/viajes/${v}/confirmar-parada`,
          { id_parada: p.id_parada, lat: p.latitud, lng: p.longitud },
          condToken
        );
      }
      for (let i = 0; i < 20 && eventoFinalizado === null; i++) await esperar(300);

      const CAMPOS = [
        'duracion_real',
        'duracion_carga',
        'duracion_descarga',
        'duracion_aproximacion_origen',
        'puntualidad_inicio',
      ];
      const faltantes = (o) => CAMPOS.filter((c) => !Object.hasOwn(o ?? {}, c));
      const tieneTodos = (o) => !!o && faltantes(o).length === 0;

      const c1 = await detalle(base, clienteToken, v);
      paso('CASO 7a: GET /api/viajes/:id', tieneTodos(c1.data), `faltan=[${faltantes(c1.data)}]${desc(c1)}`);

      const c2 = await api(base, 'GET', '/api/viajes/mis-viajes', null, clienteToken);
      const v2 = c2.data?.find?.((x) => x.id_viaje === v);
      paso('CASO 7b: GET /api/viajes/mis-viajes', tieneTodos(v2), `faltan=[${faltantes(v2)}]${desc(c2)}`);

      const c3 = await api(base, 'GET', '/api/viajes/mis-viajes-conductor', null, condToken);
      const v3 = c3.data?.find?.((x) => x.id_viaje === v);
      paso(
        'CASO 7c: GET /api/viajes/mis-viajes-conductor',
        tieneTodos(v3),
        `faltan=[${faltantes(v3)}]${desc(c3)}`
      );

      const c4 = await api(base, 'GET', `/api/empresas/${empId}/viajes`, null, gerenteToken);
      const v4 = c4.data?.find?.((x) => x.id_viaje === v);
      paso(
        'CASO 7d: GET /api/empresas/:id/viajes (el canal del gerente)',
        tieneTodos(v4),
        `faltan=[${faltantes(v4)}]${desc(c4)}`
      );

      if (adminToken) {
        const c5 = await api(base, 'GET', `/api/admin/viajes/${v}`, null, adminToken);
        paso(
          'CASO 7e: GET /api/admin/viajes/:id',
          tieneTodos(c5.data),
          `faltan=[${faltantes(c5.data)}]${desc(c5)}`
        );
      } else {
        paso('CASO 7e: GET /api/admin/viajes/:id — SALTEADO (sin admin de test)', true, '');
      }

      paso(
        'CASO 7f: el evento viaje:finalizado trae las metricas en el mismo payload',
        tieneTodos(eventoFinalizado),
        eventoFinalizado
          ? `carga=${eventoFinalizado.duracion_carga} descarga=${eventoFinalizado.duracion_descarga} ` +
            `real=${eventoFinalizado.duracion_real} puntualidad=${eventoFinalizado.puntualidad_inicio}`
          : 'no llego el evento'
      );

      sCond.disconnect();
      sCli.disconnect();
    });
  }

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
