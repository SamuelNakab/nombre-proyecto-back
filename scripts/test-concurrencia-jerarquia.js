import { io } from 'socket.io-client';
import redis from '../src/config/redis.js';
import prisma from '../src/config/prisma.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const BASE = 'http://localhost:3000';

const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

const HORA = 60 * 60 * 1000;

// ── Helpers (mismo patron que scripts/test-jerarquia.js) ───────────────────

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
  // 201 = creado; 409 = ya existia. Cualquier otra cosa es un fallo real.
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

async function crearEmpresa(gerenteToken, nombre, cuit) {
  const { status, data } = await api('POST', '/api/empresas', { nombre, cuit }, gerenteToken);
  if (status !== 201) throw new Error(`crearEmpresa fallo (${status}): ${JSON.stringify(data)}`);
  return data;
}

async function crearVehiculoFlota(gerenteToken, id_empresa, patente) {
  const { status, data } = await api(
    'POST',
    `/api/empresas/${id_empresa}/vehiculos`,
    { patente, marca: 'Iveco', modelo: 'Daily', anio: 2021, color: 'Gris', tipo_vehiculo: 'camion' },
    gerenteToken
  );
  if (status !== 201) throw new Error(`crearVehiculoFlota fallo (${status}): ${JSON.stringify(data)}`);
  return data.id_vehiculo;
}

const reservar = (token, id_viaje, id_empresa) =>
  api('POST', `/api/viajes/${id_viaje}/reservar`, { id_empresa }, token);

const asignar = (token, id_viaje, id_conductor, id_vehiculo) =>
  api('POST', `/api/viajes/${id_viaje}/asignar`, { id_conductor, id_vehiculo }, token);

const estadoDe = async (id_viaje) => await prisma.viaje.findUnique({ where: { id_viaje } });

async function conductorIdPorEmail(email) {
  const u = await prisma.usuario.findUnique({ where: { email }, include: { conductor: true } });
  return u.conductor.id_conductor;
}

// Afilia el conductor a la empresa y lo deja ACTIVO (pide el codigo + aprueba).
async function afiliarYAprobar(condToken, gerenteToken, codigo_afiliacion, id_empresa, id_conductor) {
  const { status: sAfi } = await api('POST', '/api/afiliaciones', { codigo_afiliacion }, condToken);
  if (sAfi !== 201 && sAfi !== 200 && sAfi !== 409) {
    throw new Error(`afiliacion fallo (${sAfi})`);
  }
  const { status: sApr } = await api(
    'POST',
    `/api/empresas/${id_empresa}/conductores/${id_conductor}/aprobar`,
    null,
    gerenteToken
  );
  if (sApr !== 200) throw new Error(`aprobar conductor fallo (${sApr})`);
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

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   TEST CONCURRENCIA — RESERVA / ASIGNACION (JERARQUIA)     ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const stamp = Date.now();
  let sConductor;

  const pass = 'test123456';
  const d = String(stamp).slice(-7);
  const lic = '2028-01-01T00:00:00.000Z';

  const U = {
    cli: { email: `cli-conc-${stamp}@test.com`, dni: d + '0', nombre: 'Cli', apellido: 'Conc' },
    conInd: {
      email: `conind-conc-${stamp}@test.com`,
      dni: d + '1',
      nombre: 'ConInd',
      apellido: 'Conc',
      nro_licencia: 'LCI' + d,
      licencia_vencimiento: lic,
    },
    ger1: {
      email: `ger1-conc-${stamp}@test.com`,
      dni: d + '2',
      nombre: 'Ger1',
      apellido: 'Conc',
      cuit_empresa: '30' + d + '10',
      nombre_empresa: `Ger1Conc ${stamp}`,
    },
    ger2: {
      email: `ger2-conc-${stamp}@test.com`,
      dni: d + '3',
      nombre: 'Ger2',
      apellido: 'Conc',
      cuit_empresa: '30' + d + '20',
      nombre_empresa: `Ger2Conc ${stamp}`,
    },
    // Dos conductores afiliados a la empresa1, para el CASO C: dos asignaciones
    // concurrentes con conductor+vehiculo DISTINTOS sobre el mismo viaje.
    conA: {
      email: `cona-conc-${stamp}@test.com`,
      dni: d + '4',
      nombre: 'ConA',
      apellido: 'Conc',
      nro_licencia: 'LCA' + d,
      licencia_vencimiento: lic,
    },
    conB: {
      email: `conb-conc-${stamp}@test.com`,
      dni: d + '5',
      nombre: 'ConB',
      apellido: 'Conc',
      nro_licencia: 'LCB' + d,
      licencia_vencimiento: lic,
    },
  };

  console.log('── SETUP: cliente, conductor independiente, 2 gerentes con empresa + flota ──\n');

  await registrar({ ...U.cli, contrasena: pass }, 'cliente');
  await registrar({ ...U.conInd, contrasena: pass }, 'conductor');
  await registrar({ ...U.ger1, contrasena: pass }, 'gerente');
  await registrar({ ...U.ger2, contrasena: pass }, 'gerente');
  await registrar({ ...U.conA, contrasena: pass }, 'conductor');
  await registrar({ ...U.conB, contrasena: pass }, 'conductor');

  const clienteToken = await getToken(U.cli.email, pass);
  const conIndToken = await getToken(U.conInd.email, pass);
  const ger1Token = await getToken(U.ger1.email, pass);
  const ger2Token = await getToken(U.ger2.email, pass);
  const conAToken = await getToken(U.conA.email, pass);
  const conBToken = await getToken(U.conB.email, pass);

  await crearVehiculoPropioSiNoExiste(conIndToken, `PI${String(stamp).slice(-5)}`);

  const emp1 = await crearEmpresa(ger1Token, `Flota Conc1 ${stamp}`, '31' + String(stamp).slice(-9));
  const emp2 = await crearEmpresa(ger2Token, `Flota Conc2 ${stamp}`, '32' + String(stamp).slice(-9));
  // empresa1 lleva DOS vehiculos de flota: el CASO C necesita asignar dos pares
  // (conductor, vehiculo) distintos en paralelo.
  const flota1A = await crearVehiculoFlota(ger1Token, emp1.id_empresa, `F1${String(stamp).slice(-5)}`);
  const flota1B = await crearVehiculoFlota(ger1Token, emp1.id_empresa, `F3${String(stamp).slice(-5)}`);
  await crearVehiculoFlota(ger2Token, emp2.id_empresa, `F2${String(stamp).slice(-5)}`);

  const conAId = await conductorIdPorEmail(U.conA.email);
  const conBId = await conductorIdPorEmail(U.conB.email);
  await afiliarYAprobar(conAToken, ger1Token, emp1.codigo_afiliacion, emp1.id_empresa, conAId);
  await afiliarYAprobar(conBToken, ger1Token, emp1.codigo_afiliacion, emp1.id_empresa, conBId);

  console.log(`  empresa1=${emp1.id_empresa} (gerente1)   empresa2=${emp2.id_empresa} (gerente2)`);
  console.log(`  flota1: vehiculos ${flota1A} y ${flota1B}   conductores ACTIVOS: ${conAId} y ${conBId}`);

  sConductor = await conectar(conIndToken);
  await esperar(1000);

  // ── CASO A: dos gerentes de dos empresas distintas reservan el MISMO viaje ─
  console.log('\n── CASO A: gerente1 vs gerente2 — Promise.all sobre POST /reservar ────\n');
  const vA = await crearViaje(clienteToken);
  await esperar(500);

  const [resA1, resA2] = await Promise.all([
    reservar(ger1Token, vA, emp1.id_empresa),
    reservar(ger2Token, vA, emp2.id_empresa),
  ]);
  await esperar(500);
  const vADb = await estadoDe(vA);

  console.log(`  gerente1 → status=${resA1.status} body=${JSON.stringify(resA1.data)}`);
  console.log(`  gerente2 → status=${resA2.status} body=${JSON.stringify(resA2.data)}`);
  console.log(`  DB final → estado=${vADb.estado} id_empresa=${vADb.id_empresa}`);

  const ganadoresA = [resA1, resA2].filter((r) => r.status === 200);
  const perdedoresA = [resA1, resA2].filter((r) => r.status !== 200);
  const idEmpresaGanadoraA = resA1.status === 200 ? emp1.id_empresa : resA2.status === 200 ? emp2.id_empresa : null;

  paso('CASO A1: exactamente un gerente gana (200)', ganadoresA.length === 1, `ganadores=${ganadoresA.length}`);
  paso(
    'CASO A2: el otro gerente recibe 409 "no disponible"',
    perdedoresA.length === 1 && perdedoresA[0].status === 409 && typeof perdedoresA[0].data.error === 'string',
    perdedoresA.length === 1 ? `status=${perdedoresA[0].status} err=${perdedoresA[0].data.error}` : 'no hubo un unico perdedor'
  );
  paso(
    'CASO A3: la DB queda RESERVADO_POR_EMPRESA con la empresa ganadora unicamente',
    vADb.estado === 'RESERVADO_POR_EMPRESA' && vADb.id_empresa === idEmpresaGanadoraA,
    `estado=${vADb.estado} id_empresa=${vADb.id_empresa} esperado=${idEmpresaGanadoraA}`
  );

  // ── CASO B: gerente reserva (REST) vs conductor independiente acepta (socket) ─
  console.log('\n── CASO B: gerente1 (REST /reservar) vs conductor independiente (socket viaje:aceptar) ──\n');
  const vB = await crearViaje(clienteToken);
  await esperar(500);

  const resultadoSocket = new Promise((resolve) => {
    sConductor.once('viaje:conductor_asignado', (d) => resolve({ tipo: 'ganado', data: d }));
    sConductor.once('viaje:ya_asignado', (d) => resolve({ tipo: 'perdido', data: d }));
    setTimeout(() => resolve({ tipo: 'timeout' }), 5000);
  });

  // Disparados sin await entre medio: el fetch de reservar() arranca en la
  // misma vuelta de sincrono en la que se emite el evento de socket.
  const [resB, resSocket] = await Promise.all([
    reservar(ger1Token, vB, emp1.id_empresa),
    (() => {
      sConductor.emit('viaje:aceptar', { id_viaje: vB });
      return resultadoSocket;
    })(),
  ]);
  await esperar(500);
  const vBDb = await estadoDe(vB);

  console.log(`  gerente1 (REST reservar) → status=${resB.status} body=${JSON.stringify(resB.data)}`);
  console.log(`  conductor independiente (socket aceptar) → ${resSocket.tipo} ${JSON.stringify(resSocket.data ?? {})}`);
  console.log(`  DB final → estado=${vBDb.estado} id_empresa=${vBDb.id_empresa} id_conductor=${vBDb.id_conductor}`);

  const gerenteGanoB = resB.status === 200;
  const conductorGanoB = resSocket.tipo === 'ganado';

  paso('CASO B1: gana exactamente uno de los dos (gerente XOR conductor)', gerenteGanoB !== conductorGanoB, `gerenteGano=${gerenteGanoB} conductorGano=${conductorGanoB} eventoSocket=${resSocket.tipo}`);
  paso(
    'CASO B2: si gano el gerente, el conductor recibe viaje:ya_asignado',
    !gerenteGanoB || resSocket.tipo === 'perdido',
    `gerenteGano=${gerenteGanoB} eventoConductor=${resSocket.tipo}`
  );
  paso(
    'CASO B3: si gano el conductor, el gerente recibe 409',
    !conductorGanoB || resB.status === 409,
    `conductorGano=${conductorGanoB} statusGerente=${resB.status}`
  );
  paso(
    'CASO B4: la DB queda en un unico estado consistente con el ganador',
    gerenteGanoB
      ? vBDb.estado === 'RESERVADO_POR_EMPRESA' && vBDb.id_empresa === emp1.id_empresa && vBDb.id_conductor === null
      : conductorGanoB
        ? vBDb.estado === 'CONDUCTOR_ASIGNADO' && vBDb.id_conductor !== null && vBDb.id_empresa === null
        : false,
    `estado=${vBDb.estado} id_empresa=${vBDb.id_empresa} id_conductor=${vBDb.id_conductor}`
  );

  // ── CASO C: doble asignacion concurrente sobre el MISMO viaje reservado ────
  //
  // Este es el caso que cubre el guard atomico de asignarViaje. Antes el
  // controller hacia un prisma.viaje.update plano sobre una lectura ya vieja:
  // las dos requests leian RESERVADO_POR_EMPRESA, las dos escribian, el ultimo
  // id_conductor/id_vehiculo pisaba al primero y los DOS conductores recibian
  // viaje:asignado — uno de ellos para un viaje que no era suyo. Con el
  // updateMany condicionado (where estado = RESERVADO_POR_EMPRESA) solo una
  // matchea la fila.
  console.log('\n── CASO C: doble POST /asignar concurrente sobre el mismo viaje ──\n');
  const vC = await crearViaje(clienteToken);
  await esperar(500);
  const resReservaC = await reservar(ger1Token, vC, emp1.id_empresa);
  if (resReservaC.status !== 200) {
    throw new Error(`CASO C: la reserva previa fallo (${resReservaC.status}): ${JSON.stringify(resReservaC.data)}`);
  }
  await esperar(300);

  // Mismo gerente, mismo viaje, pares (conductor, vehiculo) DISTINTOS —
  // disparados sin await entre medio.
  const [resC1, resC2] = await Promise.all([
    asignar(ger1Token, vC, conAId, flota1A),
    asignar(ger1Token, vC, conBId, flota1B),
  ]);
  await esperar(500);
  const vCDb = await estadoDe(vC);

  console.log(`  asignar(conA=${conAId}, veh=${flota1A}) → status=${resC1.status} body=${JSON.stringify(resC1.data)}`);
  console.log(`  asignar(conB=${conBId}, veh=${flota1B}) → status=${resC2.status} body=${JSON.stringify(resC2.data)}`);
  console.log(`  DB final → estado=${vCDb.estado} id_conductor=${vCDb.id_conductor} id_vehiculo=${vCDb.id_vehiculo}`);

  const ganadoresC = [resC1, resC2].filter((r) => r.status === 200);
  const perdedoresC = [resC1, resC2].filter((r) => r.status !== 200);

  paso(
    'CASO C1: exactamente una asignacion gana (200)',
    ganadoresC.length === 1,
    `ganadores=${ganadoresC.length} status=[${resC1.status}, ${resC2.status}]`
  );
  paso(
    'CASO C2: la perdedora recibe 409 con error explicativo',
    perdedoresC.length === 1 &&
      perdedoresC[0].status === 409 &&
      typeof perdedoresC[0].data.error === 'string',
    `status=${perdedoresC[0]?.status} err=${perdedoresC[0]?.data?.error}`
  );
  paso(
    'CASO C3: la DB queda CONDUCTOR_ASIGNADO con el par (conductor, vehiculo) del ganador',
    vCDb.estado === 'CONDUCTOR_ASIGNADO' &&
      ganadoresC.length === 1 &&
      vCDb.id_conductor === ganadoresC[0].data.id_conductor &&
      vCDb.id_vehiculo === ganadoresC[0].data.id_vehiculo,
    `estado=${vCDb.estado} db=(${vCDb.id_conductor}, ${vCDb.id_vehiculo}) ganador=(${ganadoresC[0]?.data?.id_conductor}, ${ganadoresC[0]?.data?.id_vehiculo})`
  );
  paso(
    'CASO C4: no queda un par cruzado (conductor de una request con vehiculo de la otra)',
    (vCDb.id_conductor === conAId && vCDb.id_vehiculo === flota1A) ||
      (vCDb.id_conductor === conBId && vCDb.id_vehiculo === flota1B),
    `db=(${vCDb.id_conductor}, ${vCDb.id_vehiculo}) parA=(${conAId}, ${flota1A}) parB=(${conBId}, ${flota1B})`
  );

  // ── RESUMEN ──────────────────────────────────────────────────────────────
  await cleanup([sConductor]);

  const ok = pasos.filter((p) => p.ok).length;
  const fallaron = pasos.filter((p) => !p.ok);

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                        RESUMEN                              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
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
