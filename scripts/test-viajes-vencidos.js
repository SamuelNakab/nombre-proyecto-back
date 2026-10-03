// Test de VIAJES VENCIDOS: el flag `vencido` en el read y el evento
// viaje:vencido por socket.
//
// Un viaje en BUSCANDO_CONDUCTOR que nadie toma, o en CONDUCTOR_ASIGNADO que
// nadie inicia, se quedaba colgado sin que nadie se entere. NO se auto-cancela
// (decision de producto): lo unico que cambia es que deja de ser invisible.
//
// Igual que test-timeout-reserva, este NO pega contra :3000 para los casos de
// timer: hace falta ANTICIPACION_MINIMA_MINUTOS=0 en el PROCESO del server para
// poder crear un viaje a segundos vista, y el aviso se programa con el `io` de
// ese proceso. Levanta su propio server por caso (_server-efimero.js) en los
// puertos 3301-3307 y conecta los sockets AHI (no hay adapter de Redis: un
// socket de :3000 no recibe lo que emite un server efimero).
//
// Casos:
//   1. BUSCANDO_CONDUCTOR llega a su hora -> el CLIENTE recibe viaje:vencido;
//      el conductor NO; flag vencido=true en el detalle y en mis-viajes; el
//      viaje NO aparece en /viajes/disponibles (decision explicita).
//   2. CONDUCTOR_ASIGNADO de empresa -> lo reciben los TRES (cliente, conductor
//      y gerente); flag en /viajes/asignados y en /empresas/:id/viajes.
//   3. NEGATIVO: viaje INICIADO antes de su hora -> nadie recibe nada.
//   4. NEGATIVO: viaje CANCELADO antes de su hora -> nadie recibe nada.
//   5. Barrido de arranque: un viaje cuyo timer se perdio al bajar el proceso
//      (simula un deploy) -> el server siguiente lo reprograma al levantar y el
//      aviso llega igual.
//   6. RESERVADO_POR_EMPRESA no vence: hueco deliberado, lo cubre el timeout de
//      la reserva.
//
// Se le pueden pasar numeros de caso para correr solo esos:
//   node scripts/test-viajes-vencidos.js 3 4
// El setup corre siempre. Sirve sobre todo para el protocolo de reversion
// (revertir el fix y confirmar que el caso se pone en rojo) sin bancarse los
// minutos que tarda la corrida completa.
import { io as ioClient } from 'socket.io-client';
import prisma from '../src/config/prisma.js';
import redis from '../src/config/redis.js';
import { conServer } from './_server-efimero.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const SETUP_BASE = 'http://localhost:3000'; // solo para el alta de fixtures

const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

// Sin anticipacion minima podemos programar un viaje a segundos vista.
const ENV_SIN_ANTICIPACION = { ANTICIPACION_MINIMA_MINUTOS: '0' };

// Segundos hasta la fecha_programada de los viajes de prueba, y margen para
// mirar el resultado despues de que el aviso tendria que haber disparado.
const EN_SEGUNDOS = 10;
const MARGEN_MS = 5000;

// Los viajes que crea el script quedan en la DB compartida con produccion: se
// cancelan todos al final para no dejar basura colgada en BUSCANDO_CONDUCTOR.
const creados = [];

// Filtro de casos por argv. Sin argumentos corren todos.
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
  // El cuerpo crudo se guarda siempre: un 500 de Express devuelve HTML, y sin
  // esto un assert fallado solo muestra "undefined" y no se puede diagnosticar.
  return { status: res.status, data, crudo: text.slice(0, 300) };
}

// Resumen de una respuesta para el detalle de un paso. Vacio si salio 200.
const desc = (r) => (r.status === 200 ? '' : ` [HTTP ${r.status}: ${r.crudo || r.data.error}]`);

function conectar(base, token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { auth: { token: 'Bearer ' + token } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`Socket connect_error: ${e.message}`)));
    setTimeout(() => reject(new Error('Timeout al conectar socket (8s)')), 8000);
  });
}

// Conecta el socket y le engancha un recolector de viaje:vencido.
async function espia(base, token) {
  const socket = await conectar(base, token);
  const vencidos = new Map();
  socket.on('viaje:vencido', (d) => vencidos.set(d.id_viaje, d));
  return { socket, vencidos };
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

// Crea un viaje que vence dentro de `segundos`. Requiere un server levantado con
// ANTICIPACION_MINIMA_MINUTOS=0.
async function crearViajePorVencer(base, clienteToken, segundos = EN_SEGUNDOS) {
  const fecha = new Date(Date.now() + segundos * 1000).toISOString();
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
  return { id_viaje: data.id_viaje, respuesta: data };
}

const estadoDe = (id_viaje) => prisma.viaje.findUnique({ where: { id_viaje } });
const detalle = (base, token, id) => api(base, 'GET', `/api/viajes/${id}`, null, token);

async function cleanup(sockets = []) {
  for (const s of sockets) {
    try {
      s?.disconnect();
    } catch {
      /* noop */
    }
  }
  // La DB esta compartida con produccion: no dejamos viajes de prueba colgados
  // en BUSCANDO_CONDUCTOR, que es justo el estado que este test genera.
  try {
    if (creados.length > 0) {
      await prisma.viaje.updateMany({
        where: { id_viaje: { in: creados }, estado: { notIn: ['FINALIZADO', 'CANCELADO'] } },
        data: { estado: 'CANCELADO', motivo_cancelacion: 'limpieza test-viajes-vencidos' },
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
  console.log('║        TEST VIAJES VENCIDOS — FLETER         ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  if (SOLO.length > 0) console.log(`  (solo los casos ${SOLO.join(', ')})\n`);

  const stamp = Date.now();
  const pass = 'test123456';
  const d = String(stamp).slice(-7);
  const lic = '2028-01-01T00:00:00.000Z';

  console.log('-- SETUP: usuarios, empresa, afiliacion, flota ----------------\n');

  const U = {
    cli: { email: `cli-vnc-${stamp}@test.com`, dni: d + '0', nombre: 'Cli', apellido: 'Vnc' },
    con: { email: `con-vnc-${stamp}@test.com`, dni: d + '1', nombre: 'Con', apellido: 'Vnc', nro_licencia: 'LV' + d, licencia_vencimiento: lic },
    ger: { email: `ger-vnc-${stamp}@test.com`, dni: d + '2', nombre: 'Ger', apellido: 'Vnc', cuit_empresa: '30' + d + '40', nombre_empresa: `GerVnc ${stamp}` },
  };

  await registrar({ ...U.cli, contrasena: pass }, 'cliente');
  await registrar({ ...U.con, contrasena: pass }, 'conductor');
  await registrar({ ...U.ger, contrasena: pass }, 'gerente');

  const clienteToken = await getToken(U.cli.email, pass);
  const condToken = await getToken(U.con.email, pass);
  const gerenteToken = await getToken(U.ger.email, pass);

  // Vehiculo propio del conductor: lo necesita para ser elegible en el mercado
  // abierto (el CASO 1h mira /viajes/disponibles con su token).
  await api(
    SETUP_BASE,
    'POST',
    '/api/conductores/mis-vehiculos',
    { patente: `VN${String(stamp).slice(-5)}`, marca: 'Ford', modelo: 'Transit', anio: 2020, color: 'Blanco', tipo_vehiculo: 'furgon' },
    condToken
  );

  const condId = (
    await prisma.usuario.findUnique({ where: { email: U.con.email }, include: { conductor: true } })
  ).conductor.id_conductor;

  const { data: emp } = await api(
    SETUP_BASE,
    'POST',
    '/api/empresas',
    { nombre: `Flota Vencidos ${stamp}`, cuit: '30' + String(stamp).slice(-9) },
    gerenteToken
  );
  const empId = emp.id_empresa;

  await api(SETUP_BASE, 'POST', '/api/afiliaciones', { codigo_afiliacion: emp.codigo_afiliacion }, condToken);
  await api(SETUP_BASE, 'POST', `/api/empresas/${empId}/conductores/${condId}/aprobar`, null, gerenteToken);

  const { data: flotaVeh } = await api(
    SETUP_BASE,
    'POST',
    `/api/empresas/${empId}/vehiculos`,
    { patente: `FV${String(stamp).slice(-5)}`, marca: 'Iveco', modelo: 'Daily', anio: 2021, color: 'Gris', tipo_vehiculo: 'camion' },
    gerenteToken
  );
  const flotaVehId = flotaVeh.id_vehiculo;

  console.log(`  setup ok: empresa=${empId} conductor=${condId} vehiculo_flota=${flotaVehId}`);

  // -- CASO 1: BUSCANDO_CONDUCTOR vence -------------------------------------
  if (correr(1)) await conServer(ENV_SIN_ANTICIPACION, 3301, async (base) => {
    console.log('\n-- CASO 1: BUSCANDO_CONDUCTOR llega a su hora ----------------\n');

    const cli = await espia(base, clienteToken);
    const con = await espia(base, condToken);

    const { id_viaje, respuesta } = await crearViajePorVencer(base, clienteToken);

    paso(
      'CASO 1a: POST /api/viajes devuelve vencido=false al crear',
      respuesta.vencido === false,
      `vencido=${respuesta.vencido}`
    );

    // Todavia dentro de la ventana: ni flag ni evento.
    const rAntes = await detalle(base, clienteToken, id_viaje);
    paso(
      'CASO 1b: antes de su hora, vencido=false y nadie recibio el evento',
      rAntes.data.vencido === false && !cli.vencidos.has(id_viaje),
      `vencido=${rAntes.data.vencido} evento=${cli.vencidos.has(id_viaje)}${desc(rAntes)}`
    );

    await esperar(EN_SEGUNDOS * 1000 + MARGEN_MS);

    const ev = cli.vencidos.get(id_viaje);
    paso(
      'CASO 1c: el CLIENTE recibe viaje:vencido con el payload completo',
      !!ev && ev.estado === 'BUSCANDO_CONDUCTOR' && !!ev.fecha_programada,
      ev ? `estado=${ev.estado} fecha=${ev.fecha_programada}` : 'NO recibido'
    );

    paso(
      'CASO 1d: el conductor NO lo recibe (en BUSCANDO_CONDUCTOR solo va al cliente)',
      !con.vencidos.has(id_viaje),
      con.vencidos.has(id_viaje) ? 'lo recibio (mal)' : 'ok'
    );

    const enDb = await estadoDe(id_viaje);
    paso(
      'CASO 1e: el viaje NO cambio de estado (no se auto-cancela)',
      enDb.estado === 'BUSCANDO_CONDUCTOR',
      `estado=${enDb.estado}`
    );

    const rDespues = await detalle(base, clienteToken, id_viaje);
    paso(
      'CASO 1f: GET /api/viajes/:id devuelve vencido=true',
      rDespues.data.vencido === true,
      `vencido=${rDespues.data.vencido}${desc(rDespues)}`
    );

    const rMis = await api(base, 'GET', '/api/viajes/mis-viajes', null, clienteToken);
    const enMis = rMis.data.find?.((v) => v.id_viaje === id_viaje);
    paso(
      'CASO 1g: GET /api/viajes/mis-viajes lo marca vencido=true',
      enMis?.vencido === true,
      `vencido=${enMis?.vencido}${desc(rMis)}`
    );

    const rDisp = await api(base, 'GET', '/api/viajes/disponibles', null, condToken);
    paso(
      'CASO 1h: NO aparece en /viajes/disponibles (decision explicita: el filtro se queda)',
      Array.isArray(rDisp.data) && !rDisp.data.some((v) => v.id_viaje === id_viaje),
      `viajes en la lista=${rDisp.data.length}${desc(rDisp)}`
    );

    cli.socket.disconnect();
    con.socket.disconnect();
  });

  // -- CASO 2: CONDUCTOR_ASIGNADO de empresa vence --------------------------
  if (correr(2)) await conServer(ENV_SIN_ANTICIPACION, 3302, async (base) => {
    console.log('\n-- CASO 2: CONDUCTOR_ASIGNADO de empresa llega a su hora -----\n');

    const cli = await espia(base, clienteToken);
    const con = await espia(base, condToken);
    const ger = await espia(base, gerenteToken);

    const SEGUNDOS = 15;
    const { id_viaje } = await crearViajePorVencer(base, clienteToken, SEGUNDOS);
    await api(base, 'POST', `/api/viajes/${id_viaje}/reservar`, { id_empresa: empId }, gerenteToken);
    const rAsg = await api(
      base,
      'POST',
      `/api/viajes/${id_viaje}/asignar`,
      { id_conductor: condId, id_vehiculo: flotaVehId },
      gerenteToken
    );
    const asignado = await estadoDe(id_viaje);
    paso(
      'CASO 2a: reservar + asignar -> CONDUCTOR_ASIGNADO',
      rAsg.status === 200 && asignado.estado === 'CONDUCTOR_ASIGNADO',
      `estado=${asignado.estado}${desc(rAsg)}`
    );

    await esperar(SEGUNDOS * 1000 + MARGEN_MS);

    const ev = cli.vencidos.get(id_viaje);
    paso(
      'CASO 2b: los TRES reciben viaje:vencido (cliente, conductor y gerente)',
      cli.vencidos.has(id_viaje) && con.vencidos.has(id_viaje) && ger.vencidos.has(id_viaje),
      `cliente=${cli.vencidos.has(id_viaje)} conductor=${con.vencidos.has(id_viaje)} gerente=${ger.vencidos.has(id_viaje)}`
    );
    paso(
      'CASO 2c: el payload dice CONDUCTOR_ASIGNADO',
      ev?.estado === 'CONDUCTOR_ASIGNADO',
      `estado=${ev?.estado}`
    );

    const rAsig = await api(base, 'GET', '/api/viajes/asignados', null, condToken);
    const enAsignados = rAsig.data.find?.((v) => v.id_viaje === id_viaje);
    paso(
      'CASO 2d: GET /api/viajes/asignados lo marca vencido=true para el conductor',
      enAsignados?.vencido === true,
      `vencido=${enAsignados?.vencido}${desc(rAsig)}`
    );

    const rEmp = await api(base, 'GET', `/api/empresas/${empId}/viajes`, null, gerenteToken);
    const enEmpresa = rEmp.data.find?.((v) => v.id_viaje === id_viaje);
    paso(
      'CASO 2e: GET /api/empresas/:id/viajes lo marca vencido=true para el gerente',
      enEmpresa?.vencido === true,
      `vencido=${enEmpresa?.vencido}${desc(rEmp)}`
    );

    const enDb = await estadoDe(id_viaje);
    paso(
      'CASO 2f: sigue en CONDUCTOR_ASIGNADO con su conductor (no se toco nada)',
      enDb.estado === 'CONDUCTOR_ASIGNADO' && enDb.id_conductor === condId,
      `estado=${enDb.estado} id_conductor=${enDb.id_conductor}`
    );

    cli.socket.disconnect();
    con.socket.disconnect();
    ger.socket.disconnect();
  });

  // -- CASO 3 (NEGATIVO): iniciado antes de su hora -------------------------
  if (correr(3)) await conServer(ENV_SIN_ANTICIPACION, 3303, async (base) => {
    console.log('\n-- CASO 3 (NEGATIVO): el viaje se INICIA antes de su hora ----\n');

    const cli = await espia(base, clienteToken);
    const con = await espia(base, condToken);
    const ger = await espia(base, gerenteToken);

    const SEGUNDOS = 15;
    const { id_viaje } = await crearViajePorVencer(base, clienteToken, SEGUNDOS);
    await api(base, 'POST', `/api/viajes/${id_viaje}/reservar`, { id_empresa: empId }, gerenteToken);
    await api(
      base,
      'POST',
      `/api/viajes/${id_viaje}/asignar`,
      { id_conductor: condId, id_vehiculo: flotaVehId },
      gerenteToken
    );

    // La ventana de inicio abre VENTANA_INICIO_MINUTOS (30) antes de la fecha,
    // asi que ya se puede iniciar.
    const rIni = await api(base, 'POST', `/api/viajes/${id_viaje}/iniciar`, null, condToken);
    const iniciado = await estadoDe(id_viaje);
    paso(
      'CASO 3a: iniciar antes de la hora -> 200 y EN_CAMINO_A_ORIGEN',
      rIni.status === 200 && iniciado.estado === 'EN_CAMINO_A_ORIGEN',
      `estado=${iniciado.estado}${desc(rIni)}`
    );

    await esperar(SEGUNDOS * 1000 + MARGEN_MS);

    paso(
      'CASO 3b: pasada la hora NADIE recibe viaje:vencido',
      !cli.vencidos.has(id_viaje) && !con.vencidos.has(id_viaje) && !ger.vencidos.has(id_viaje),
      `cliente=${cli.vencidos.has(id_viaje)} conductor=${con.vencidos.has(id_viaje)} gerente=${ger.vencidos.has(id_viaje)}`
    );

    const rDet = await detalle(base, clienteToken, id_viaje);
    paso(
      'CASO 3c: el detalle devuelve vencido=false (el viaje avanzo)',
      rDet.data.vencido === false && rDet.data.estado === 'EN_CAMINO_A_ORIGEN',
      `vencido=${rDet.data.vencido} estado=${rDet.data.estado}${desc(rDet)}`
    );

    cli.socket.disconnect();
    con.socket.disconnect();
    ger.socket.disconnect();
  });

  // -- CASO 4 (NEGATIVO): cancelado antes de su hora ------------------------
  if (correr(4)) await conServer(ENV_SIN_ANTICIPACION, 3304, async (base) => {
    console.log('\n-- CASO 4 (NEGATIVO): el cliente CANCELA antes de su hora ----\n');

    const cli = await espia(base, clienteToken);
    const con = await espia(base, condToken);

    const { id_viaje } = await crearViajePorVencer(base, clienteToken);

    const rCan = await api(base, 'POST', `/api/viajes/${id_viaje}/cancelar-cliente`, null, clienteToken);
    const cancelado = await estadoDe(id_viaje);
    paso(
      'CASO 4a: cancelar-cliente antes de la hora -> 200 y CANCELADO',
      rCan.status === 200 && cancelado.estado === 'CANCELADO',
      `estado=${cancelado.estado}${desc(rCan)}`
    );

    await esperar(EN_SEGUNDOS * 1000 + MARGEN_MS);

    paso(
      'CASO 4b: pasada la hora NADIE recibe viaje:vencido',
      !cli.vencidos.has(id_viaje) && !con.vencidos.has(id_viaje),
      `cliente=${cli.vencidos.has(id_viaje)} conductor=${con.vencidos.has(id_viaje)}`
    );

    const rDet = await detalle(base, clienteToken, id_viaje);
    paso(
      'CASO 4c: el detalle devuelve vencido=false (CANCELADO no es vencible)',
      rDet.data.vencido === false && rDet.data.estado === 'CANCELADO',
      `vencido=${rDet.data.vencido} estado=${rDet.data.estado}${desc(rDet)}`
    );

    cli.socket.disconnect();
    con.socket.disconnect();
  });

  // -- CASO 5: barrido de arranque ------------------------------------------
  // Un deploy pierde los timers, que viven en memoria. Se simula creando el
  // viaje en un server que despues se baja, y comprobando que el siguiente le
  // reprograma el aviso al levantar y lo emite igual.
  if (correr(5)) {
    console.log('\n-- CASO 5: barrido de arranque (un deploy no pierde el aviso) -\n');

    let vBarrido;
    await conServer(ENV_SIN_ANTICIPACION, 3305, async (base) => {
      // 75s: tiene que sobrevivir a la bajada de este server y al arranque del
      // siguiente (que espera a /health, con Prisma, Redis y sockets).
      const creado = await crearViajePorVencer(base, clienteToken, 75);
      vBarrido = creado.id_viaje;
      console.log(`  viaje ${vBarrido} creado en :3305, que se baja sin haber avisado`);
    });

    const trasCaida = await estadoDe(vBarrido);
    paso(
      'CASO 5a: el viaje queda BUSCANDO_CONDUCTOR, con su hora por delante y sin ningun proceso que lo tenga en memoria',
      trasCaida.estado === 'BUSCANDO_CONDUCTOR' && trasCaida.fecha_programada.getTime() > Date.now(),
      `estado=${trasCaida.estado} faltan=${Math.round((trasCaida.fecha_programada.getTime() - Date.now()) / 1000)}s`
    );

    await conServer(ENV_SIN_ANTICIPACION, 3306, async (base, leerLog) => {
      const cli = await espia(base, clienteToken);

      const linea =
        leerLog()
          .split('\n')
          .find((l) => l.includes('[viaje-vencido] barrido de arranque')) ?? '';
      const m = linea.match(/(\d+) viajes pre-inicio con aviso programado/);
      paso(
        'CASO 5b: al arrancar, el barrido reprograma los avisos pendientes y lo loguea',
        !!m && Number(m[1]) >= 1,
        linea.trim() || 'no se encontro la linea del barrido en el log'
      );

      const faltan = trasCaida.fecha_programada.getTime() - Date.now();
      console.log(`  esperando ${Math.round(faltan / 1000)}s a que venza...`);
      await esperar(Math.max(0, faltan) + MARGEN_MS);

      paso(
        'CASO 5c: el aviso llega igual, con el timer reconstruido por el barrido',
        cli.vencidos.has(vBarrido),
        cli.vencidos.has(vBarrido) ? 'ok' : 'NO recibido'
      );

      const rDet = await detalle(base, clienteToken, vBarrido);
      paso(
        'CASO 5d: y el flag acompaña (vencido=true)',
        rDet.data.vencido === true,
        `vencido=${rDet.data.vencido}${desc(rDet)}`
      );

      cli.socket.disconnect();
    });
  }

  // -- CASO 6: RESERVADO_POR_EMPRESA no vence -------------------------------
  if (correr(6)) await conServer(ENV_SIN_ANTICIPACION, 3307, async (base) => {
    console.log('\n-- CASO 6: RESERVADO_POR_EMPRESA no vence (hueco deliberado) -\n');

    const cli = await espia(base, clienteToken);
    const ger = await espia(base, gerenteToken);

    const { id_viaje } = await crearViajePorVencer(base, clienteToken);
    const rRes = await api(base, 'POST', `/api/viajes/${id_viaje}/reservar`, { id_empresa: empId }, gerenteToken);
    paso('CASO 6a: el gerente reserva y no asigna', rRes.status === 200, `status=${rRes.status}`);

    await esperar(EN_SEGUNDOS * 1000 + MARGEN_MS);

    const enDb = await estadoDe(id_viaje);
    paso(
      'CASO 6b: pasada la hora, con el viaje todavia reservado, nadie recibe el aviso',
      enDb.estado === 'RESERVADO_POR_EMPRESA' &&
        !cli.vencidos.has(id_viaje) &&
        !ger.vencidos.has(id_viaje),
      `estado=${enDb.estado} cliente=${cli.vencidos.has(id_viaje)} gerente=${ger.vencidos.has(id_viaje)}`
    );

    const rDet = await detalle(base, clienteToken, id_viaje);
    paso(
      'CASO 6c: y vencido=false (ese caso lo cubre el timeout de la reserva)',
      rDet.data.vencido === false,
      `vencido=${rDet.data.vencido}${desc(rDet)}`
    );

    cli.socket.disconnect();
    ger.socket.disconnect();
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
