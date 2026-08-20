import { io } from 'socket.io-client';
import * as turf from '@turf/turf';
import redis from '../src/config/redis.js';
import prisma from '../src/config/prisma.js';

// Verifica la confirmacion de paradas POR PROXIMIDAD, que reemplazo al QR.
//
//   POST /api/viajes/:id/confirmar-parada  { id_parada, lat, lng }
//
// Validaciones, en el orden del contrato (API.md):
//   viaje existe (404) → conductor asignado (403) → la parada es del viaje (400)
//   → la parada no esta confirmada (400) → estado del viaje (400)
//   → distancia < RADIO_CONFIRMACION_METROS (400)
//
// El radio bajo de 200m (fijo) a RADIO_CONFIRMACION_METROS (default 50). El
// CASO 2 prueba que el radio nuevo EFECTIVAMENTE discrimina: una coordenada a
// 150m pasaba con el radio viejo y ahora tiene que fallar.

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const BASE = 'http://localhost:3000';

const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

const HORA = 60 * 60 * 1000;

// Mismo default que el backend. Si corres el server con otro valor, exportá
// RADIO_CONFIRMACION_METROS tambien en el entorno de este script.
const RADIO_METROS = parseFloat(process.env.RADIO_CONFIRMACION_METROS || '50');

// Puntos a distancia conocida de PARADA_2, generados con la misma libreria que
// usa el backend para medir (turf), asi el test no depende de una formula propia.
function aMetrosDe(parada, metros, rumbo = 90) {
  const destino = turf.destination(
    turf.point([parada.lng, parada.lat]),
    metros,
    rumbo,
    { units: 'meters' }
  );
  const [lng, lat] = destino.geometry.coordinates;
  return { lat, lng };
}

const A_150M = aMetrosDe(PARADA_2, 150);
const A_200M = aMetrosDe(PARADA_2, 200);

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
  const endpoint = tipo === 'cliente' ? '/api/auth/registro-cliente' : '/api/auth/registro-conductor';
  const { status, data } = await api('POST', endpoint, datos, null);
  if (status !== 201 && status !== 409) {
    throw new Error(`registro ${tipo} (${datos.email}) fallo: ${status} ${JSON.stringify(data)}`);
  }
}

async function crearViaje(clienteToken) {
  const fecha = new Date(Date.now() + 2 * HORA).toISOString();
  const { status, data } = await api(
    'POST',
    '/api/viajes',
    { zona: 'CABA', fecha_programada: fecha, condiciones_requeridas: [], paradas: [PARADA_1, PARADA_2] },
    clienteToken
  );
  if (status !== 201) throw new Error(`crearViaje fallo (${status}): ${JSON.stringify(data)}`);
  return data.id_viaje;
}

// Las paradas (id_parada + orden) salen del detalle del viaje: el endpoint de
// QR ya no existe.
async function paradasDe(id_viaje, token) {
  const { status, data } = await api('GET', `/api/viajes/${id_viaje}`, null, token);
  if (status !== 200) throw new Error(`GET /api/viajes/${id_viaje} fallo (${status}): ${JSON.stringify(data)}`);
  return [...data.paradas].sort((a, b) => a.orden - b.orden);
}

const confirmar = (token, id_viaje, id_parada, lat, lng) =>
  api('POST', `/api/viajes/${id_viaje}/confirmar-parada`, { id_parada, lat, lng }, token);

const paradaDb = (id_parada) => prisma.parada.findUnique({ where: { id_parada } });
const viajeDb = (id_viaje) => prisma.viaje.findUnique({ where: { id_viaje } });

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
  console.log('║  TEST CONFIRMAR PARADA (proximidad, sin QR)  ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const stamp = Date.now();
  let sCliente, sConA;

  console.log('── SETUP: usuarios, vehiculo, viajes ──────────────────────────\n');

  const pass = 'test123456';
  const d = String(stamp).slice(-7);
  const lic = '2028-01-01T00:00:00.000Z';
  const U = {
    cli: { email: `cli-conf-${stamp}@test.com`, dni: d + '0', nombre: 'Cli', apellido: 'Conf' },
    conA: { email: `cona-conf-${stamp}@test.com`, dni: d + '1', nombre: 'ConA', apellido: 'Conf', nro_licencia: 'LCA' + d, licencia_vencimiento: lic },
    conB: { email: `conb-conf-${stamp}@test.com`, dni: d + '2', nombre: 'ConB', apellido: 'Conf', nro_licencia: 'LCB' + d, licencia_vencimiento: lic },
  };

  await registrar({ ...U.cli, contrasena: pass }, 'cliente');
  await registrar({ ...U.conA, contrasena: pass }, 'conductor');
  await registrar({ ...U.conB, contrasena: pass }, 'conductor');

  const tCli = await getToken(U.cli.email, pass);
  const tConA = await getToken(U.conA.email, pass);
  const tConB = await getToken(U.conB.email, pass);

  // Solo conA necesita vehiculo: es el unico que acepta un viaje. conB existe
  // nada mas que para probar el 403 del CASO 5.
  await api('POST', '/api/conductores/mis-vehiculos', {
    patente: `CF${String(stamp).slice(-5)}`, marca: 'Ford', modelo: 'Transit',
    anio: 2020, color: 'Blanco', tipo_vehiculo: 'furgon',
  }, tConA);

  paso('SETUP: el radio configurado discrimina el punto de 150m',
    RADIO_METROS < 150,
    `RADIO_CONFIRMACION_METROS=${RADIO_METROS} (con el viejo fijo de 200m, 150m pasaba)`);

  sCliente = await conectar(tCli);
  sConA = await conectar(tConA);
  await esperar(1000);

  // V_OTRO queda en BUSCANDO_CONDUCTOR: solo se usa para tomarle prestada una
  // parada en el CASO 4.
  const vOtro = await crearViaje(tCli);
  const paradasOtro = await paradasDe(vOtro, tCli);

  // V es el viaje bajo prueba. El listener de viaje:finalizado se engancha antes
  // de arrancar el flujo; la espera con timeout va recien en el CASO 6.
  const v = await crearViaje(tCli);
  let eventoFinalizado = null;
  sCliente.on('viaje:finalizado', (x) => {
    if (x.id_viaje === v) eventoFinalizado = x;
  });

  await esperar(1200);
  sConA.emit('viaje:aceptar', { id_viaje: v });
  await esperar(2000);

  // La ventana de inicio se abre VENTANA_INICIO_MINUTOS antes de la fecha
  // programada: la traemos a "ahora" para poder iniciar.
  await prisma.viaje.update({ where: { id_viaje: v }, data: { fecha_programada: new Date() } });
  const { status: sIni } = await api('POST', `/api/viajes/${v}/iniciar`, null, tConA);
  await api('PATCH', `/api/viajes/${v}/estado`, { estado: 'CARGANDO' }, tConA);
  const { status: sEnRuta } = await api('PATCH', `/api/viajes/${v}/estado`, { estado: 'EN_RUTA' }, tConA);

  const paradas = await paradasDe(v, tConA);
  paso('SETUP: viaje EN_RUTA con conductor asignado y 2 paradas',
    sIni === 200 && sEnRuta === 200 && paradas.length === 2,
    `viaje=${v} iniciar=${sIni} en_ruta=${sEnRuta} paradas=${paradas.length} otro_viaje=${vOtro}`);

  // ── CASO 1: dentro del radio → 200 ─────────────────────────────────────────
  console.log('\n── CASO 1: confirmar dentro del radio ─────────────────────────\n');

  const { status: s1, data: d1 } = await confirmar(tConA, v, paradas[0].id_parada, PARADA_1.lat, PARADA_1.lng);
  const p1Db = await paradaDb(paradas[0].id_parada);

  paso('CASO 1a: confirmar parada 1 parado encima de ella → 200',
    s1 === 200 && d1.confirmada === true && d1.viaje_finalizado === false,
    `status=${s1} ${JSON.stringify(d1)}`);
  paso('CASO 1b: la parada quedo con fecha_entrega seteada y estado ENTREGADO',
    p1Db.fecha_entrega !== null && p1Db.estado === 'ENTREGADO',
    `fecha_entrega=${p1Db.fecha_entrega?.toISOString()} estado=${p1Db.estado}`);

  // ── CASO 2: fuera del radio → 400 ──────────────────────────────────────────
  console.log('\n── CASO 2: confirmar fuera del radio ──────────────────────────\n');

  const { status: s2a, data: d2a } = await confirmar(tConA, v, paradas[1].id_parada, A_200M.lat, A_200M.lng);
  paso('CASO 2a: a 200m de la parada → 400', s2a === 400, `status=${s2a} err=${d2a.error}`);
  paso('CASO 2b: el error dice a cuantos metros esta y cual es el maximo',
    s2a === 400 && /Estas a \d+m de la parada/.test(d2a.error ?? '') && (d2a.error ?? '').includes(`${RADIO_METROS}m`),
    d2a.error ?? '');

  // El punto clave: 150m PASABA con el radio viejo de 200m. Con el nuevo falla.
  const { status: s2c, data: d2c } = await confirmar(tConA, v, paradas[1].id_parada, A_150M.lat, A_150M.lng);
  paso('CASO 2c: a 150m → 400 (con el radio viejo de 200m esto pasaba)',
    s2c === 400, `status=${s2c} err=${d2c.error}`);

  const p2Tras2 = await paradaDb(paradas[1].id_parada);
  paso('CASO 2d: los rechazos por distancia NO confirmaron la parada',
    p2Tras2.fecha_entrega === null && p2Tras2.estado === 'PENDIENTE',
    `fecha_entrega=${p2Tras2.fecha_entrega} estado=${p2Tras2.estado}`);

  // ── CASO 3: parada ya confirmada → 400 ─────────────────────────────────────
  console.log('\n── CASO 3: confirmar una parada ya confirmada ─────────────────\n');

  const { status: s3, data: d3 } = await confirmar(tConA, v, paradas[0].id_parada, PARADA_1.lat, PARADA_1.lng);
  paso('CASO 3: reconfirmar la parada 1 → 400', s3 === 400, `status=${s3} err=${d3.error}`);

  // ── CASO 4: parada de OTRO viaje → 400 ─────────────────────────────────────
  console.log('\n── CASO 4: confirmar una parada de otro viaje ─────────────────\n');

  const { status: s4, data: d4 } = await confirmar(tConA, v, paradasOtro[0].id_parada, PARADA_1.lat, PARADA_1.lng);
  paso('CASO 4: parada del viaje ajeno sobre este viaje → 400 (no 404)',
    s4 === 400, `status=${s4} err=${d4.error} id_parada_ajena=${paradasOtro[0].id_parada}`);

  // ── CASO 5: conductor que no es el asignado → 403 ──────────────────────────
  console.log('\n── CASO 5: confirmar como otro conductor ──────────────────────\n');

  const { status: s5, data: d5 } = await confirmar(tConB, v, paradas[1].id_parada, PARADA_2.lat, PARADA_2.lng);
  paso('CASO 5a: conductor NO asignado → 403', s5 === 403, `status=${s5} err=${d5.error}`);

  const p2Tras5 = await paradaDb(paradas[1].id_parada);
  paso('CASO 5b: el 403 no confirmo nada', p2Tras5.fecha_entrega === null, `fecha_entrega=${p2Tras5.fecha_entrega}`);

  // ── CASO 6: ultima parada pendiente → cierre del viaje ─────────────────────
  console.log('\n── CASO 6: confirmar la ULTIMA parada pendiente ───────────────\n');

  const { status: s6, data: d6 } = await confirmar(tConA, v, paradas[1].id_parada, PARADA_2.lat, PARADA_2.lng);
  paso('CASO 6a: confirmar la ultima parada → 200 con viaje_finalizado=true',
    s6 === 200 && d6.confirmada === true && d6.viaje_finalizado === true,
    `status=${s6} ${JSON.stringify({ confirmada: d6.confirmada, viaje_finalizado: d6.viaje_finalizado })}`);
  paso('CASO 6b: la respuesta trae precio_real y remito_url',
    typeof d6.precio_real === 'number' && d6.precio_real >= 0 &&
    typeof d6.remito_url === 'string' && d6.remito_url.startsWith('http'),
    `precio_real=${d6.precio_real} remito=${d6.remito_url ?? '(vacio)'}`);

  const vDb = await viajeDb(v);
  paso('CASO 6c: el viaje quedo FINALIZADO con precio_real en la base',
    vDb.estado === 'FINALIZADO' && typeof vDb.precio_real === 'number',
    `estado=${vDb.estado} precio_real=${vDb.precio_real}`);

  const { status: sRem, data: dRem } = await api('GET', `/api/viajes/${v}/remito`, null, tCli);
  paso('CASO 6d: GET /:id/remito → 200 con remito_url',
    sRem === 200 && typeof dRem.remito_url === 'string',
    `status=${sRem} url=${dRem.remito_url ?? '(vacio)'}`);

  // El evento viaje:finalizado viaja al room viaje:{id}, donde el cliente entro
  // al publicarse el viaje. La espera arranca recien aca, tras el cierre.
  for (let i = 0; i < 30 && eventoFinalizado === null; i++) await esperar(500);
  paso('CASO 6e: se emitio viaje:finalizado al room del viaje',
    eventoFinalizado !== null,
    eventoFinalizado ? JSON.stringify(eventoFinalizado) : 'no llego en 15s');

  // ── CASO 7: el endpoint del QR ya no existe ────────────────────────────────
  console.log('\n── CASO 7: GET /:id/qr-paradas eliminado ──────────────────────\n');

  const { status: s7 } = await api('GET', `/api/viajes/${v}/qr-paradas`, null, tCli);
  paso('CASO 7: GET /api/viajes/:id/qr-paradas → 404 (ruta inexistente)', s7 === 404, `status=${s7}`);

  // ── RESUMEN ────────────────────────────────────────────────────────────────
  await cleanup([sCliente, sConA]);

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
  // La causa importa: "fetch failed" a secas no dice si se cayo el server, si
  // se reinicio node --watch a mitad de un request, o si fallo la red.
  console.error('\n💥 Error inesperado:', e.message, e.cause ? `| causa: ${e.cause.code ?? ''} ${e.cause.message ?? ''}` : '', '\n', e.stack);
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
