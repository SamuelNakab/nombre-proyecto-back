// Test de deteccion de zona (CABA / PROVINCIA / MIXTO).
//
// La zona la calcula SIEMPRE el servidor a partir de las coordenadas de las
// paradas (src/services/zona.service.js, poligono real del IGN). El campo
// `zona` del body se acepta por compatibilidad con el front pero se IGNORA:
// varios casos lo mandan mal a proposito para confirmarlo.
//
// Casos 1, 2, 3 y 5 solo necesitan API + DB.
// Casos 4 y 6 ademas necesitan Redis (fijan el acumulado de GPS para cerrar el
// viaje con un tiempo/distancia conocido).
import redis from '../src/config/redis.js';
import prisma from '../src/config/prisma.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const BASE = 'http://localhost:3000';

const HORA = 60 * 60 * 1000;

// Puntos de referencia, verificados contra el poligono del IGN.
const OBELISCO = { lat: -34.6037, lng: -58.3816, direccion: 'Obelisco, CABA' };
const RECOLETA = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };
const LA_PLATA = { lat: -34.9214, lng: -57.9544, direccion: 'La Plata, PBA' };
const LA_PLATA_2 = { lat: -34.9190, lng: -57.9560, direccion: 'La Plata centro, PBA' };

// Acumulado de GPS conocido que se fija en Redis antes de cerrar.
const TIEMPO_HORAS = 4;
const DISTANCIA_KM = 100;

// ── Helpers (mismo patron que scripts/test-visibilidad-gerente.js) ──────────

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

// Crea un viaje mandando `zona` en el body. zonaBody se manda a proposito
// aunque el servidor la ignore.
async function crearViaje(clienteToken, paradas, zonaBody) {
  const fecha = new Date(Date.now() + 2 * HORA).toISOString();
  const { status, data } = await api(
    'POST',
    '/api/viajes',
    { zona: zonaBody, fecha_programada: fecha, condiciones_requeridas: [], paradas },
    clienteToken
  );
  if (status !== 201) throw new Error(`crearViaje fallo (${status}): ${JSON.stringify(data)}`);
  return data;
}

const casi = (a, b, tol = 0.01) => a !== null && a !== undefined && Math.abs(a - b) < tol;

// Lleva el viaje hasta EN_RUTA con un conductor asignado, sin pasar por el
// matching por socket (que no es lo que se esta probando aca).
async function prepararParaCierre(id_viaje, id_conductor) {
  await prisma.viaje.update({
    where: { id_viaje },
    data: { id_conductor, estado: 'EN_RUTA', fecha_programada: new Date() },
  });
}

async function fijarAcumulado(id_viaje, lat, lng) {
  await redis.set(
    `gps:${id_viaje}:acumulado`,
    JSON.stringify({
      tiempo_horas: TIEMPO_HORAS,
      distancia_km: DISTANCIA_KM,
      ultima_lat: lat,
      ultima_lng: lng,
      ultima_actualizacion: Date.now(),
    }),
    'EX',
    86400
  );
}

// Confirma las paradas por proximidad. Antes de la ULTIMA fija el acumulado,
// asi el cierre lee un tiempo/distancia conocido.
async function cerrarConfirmandoParadas(id_viaje, clienteToken, conductorToken, paradas) {
  const { data: det } = await api('GET', `/api/viajes/${id_viaje}`, null, clienteToken);
  const ordenadas = [...det.paradas].sort((a, b) => a.orden - b.orden);

  for (let i = 0; i < ordenadas.length; i++) {
    const esUltima = i === ordenadas.length - 1;
    if (esUltima) await fijarAcumulado(id_viaje, paradas[i].lat, paradas[i].lng);

    const { status, data } = await api(
      'POST',
      `/api/viajes/${id_viaje}/confirmar-parada`,
      { id_parada: ordenadas[i].id_parada, lat: paradas[i].lat, lng: paradas[i].lng },
      conductorToken
    );
    if (esUltima) return { status, data };
    if (status !== 200) throw new Error(`confirmar-parada ${i + 1} fallo (${status}): ${JSON.stringify(data)}`);
  }
}

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
  console.log('║      TEST DETECCION DE ZONA — FLETER         ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const clienteToken = await getToken('cliente@test.com', 'test123456');
  const conductorToken = await getToken('conductor@test.com', 'test123456');

  const usuarioConductor = await prisma.usuario.findUnique({
    where: { email: 'conductor@test.com' },
    include: { conductor: true },
  });
  const id_conductor = usuarioConductor.conductor.id_conductor;

  // ── CASO 1: todas las paradas en CABA, el body miente ────────────────────
  console.log('── CASO 1: paradas CABA + body zona=PROVINCIA ─────────────────\n');
  const v1 = await crearViaje(clienteToken, [OBELISCO, RECOLETA], 'PROVINCIA');
  paso(
    'CASO 1: zona persistida = CABA (se ignora el body)',
    v1.zona === 'CABA',
    `body mandaba PROVINCIA, persistio ${v1.zona} (viaje ${v1.id_viaje})`
  );

  // ── CASO 2: todas en Provincia ───────────────────────────────────────────
  console.log('\n── CASO 2: paradas Provincia + body zona=CABA ─────────────────\n');
  const v2 = await crearViaje(clienteToken, [LA_PLATA, LA_PLATA_2], 'CABA');
  paso(
    'CASO 2: zona persistida = PROVINCIA (se ignora el body)',
    v2.zona === 'PROVINCIA',
    `body mandaba CABA, persistio ${v2.zona} (viaje ${v2.id_viaje})`
  );

  // ── CASO 3: una en CABA y otra en Provincia ──────────────────────────────
  console.log('\n── CASO 3: 1 parada CABA + 1 Provincia ────────────────────────\n');
  const v3 = await crearViaje(clienteToken, [OBELISCO, LA_PLATA], 'CABA');
  paso(
    'CASO 3: zona persistida = MIXTO',
    v3.zona === 'MIXTO',
    `body mandaba CABA, persistio ${v3.zona} (viaje ${v3.id_viaje})`
  );

  // ── CASO 5: estimar-costo calcula la zona de las paradas ─────────────────
  console.log('\n── CASO 5: POST /estimar-costo con paradas mixtas ─────────────\n');
  const { status: s5, data: est } = await api(
    'POST',
    '/api/viajes/estimar-costo',
    { zona: 'CABA', paradas: [OBELISCO, LA_PLATA] },
    clienteToken
  );
  paso('CASO 5a: 200 y zona = MIXTO (no la del body)', s5 === 200 && est.zona === 'MIXTO', `status=${s5} zona=${est.zona}`);
  paso(
    'CASO 5b: fraccion_caba = 0.5 (1 de 2 paradas en CABA)',
    casi(est.desglose?.fraccion_caba, 0.5),
    `fraccion_caba=${est.desglose?.fraccion_caba}`
  );
  paso(
    'CASO 5c: el precio NO es tiempo_total + distancia_total (sin doble cobro)',
    casi(est.desglose?.tiempo_capital, est.desglose?.tiempo_horas * 0.5) &&
      casi(est.desglose?.distancia_provincia, est.desglose?.distancia_km * 0.5),
    `tiempo ${est.desglose?.tiempo_horas?.toFixed(3)}→${est.desglose?.tiempo_capital?.toFixed(3)} | dist ${est.desglose?.distancia_km?.toFixed(3)}→${est.desglose?.distancia_provincia?.toFixed(3)}`
  );

  // ── CASO 4: cierre de un MIXTO, reparto proporcional ─────────────────────
  console.log('\n── CASO 4: cierre MIXTO → reparto proporcional ────────────────\n');
  const v4 = await crearViaje(clienteToken, [OBELISCO, LA_PLATA], 'CABA');
  await prepararParaCierre(v4.id_viaje, id_conductor);
  const cierre4 = await cerrarConfirmandoParadas(v4.id_viaje, clienteToken, conductorToken, [OBELISCO, LA_PLATA]);
  const viaje4 = await prisma.viaje.findUnique({
    where: { id_viaje: v4.id_viaje },
    select: { zona: true, estado: true, tiempo_capital: true, distancia_provincia: true, precio_real: true, tarifa_hora: true, tarifa_km: true },
  });

  paso('CASO 4a: el viaje cerro (FINALIZADO)', cierre4.status === 200 && viaje4.estado === 'FINALIZADO', `status=${cierre4.status} estado=${viaje4.estado}`);
  paso(
    `CASO 4b: tiempo_capital = ${TIEMPO_HORAS} × 0.5 = ${TIEMPO_HORAS * 0.5} (NO el total ${TIEMPO_HORAS})`,
    casi(viaje4.tiempo_capital, TIEMPO_HORAS * 0.5),
    `tiempo_capital=${viaje4.tiempo_capital}`
  );
  paso(
    `CASO 4c: distancia_provincia = ${DISTANCIA_KM} × 0.5 = ${DISTANCIA_KM * 0.5} (NO el total ${DISTANCIA_KM})`,
    casi(viaje4.distancia_provincia, DISTANCIA_KM * 0.5),
    `distancia_provincia=${viaje4.distancia_provincia}`
  );
  paso(
    'CASO 4d: precio_real = tiempo_capital×tarifa_hora + distancia_provincia×tarifa_km',
    casi(viaje4.precio_real, viaje4.tiempo_capital * viaje4.tarifa_hora + viaje4.distancia_provincia * viaje4.tarifa_km, 0.5),
    `precio_real=${viaje4.precio_real?.toFixed(2)}`
  );
  paso(
    'CASO 4e: precio_real MENOR al doble cobro viejo (total×hora + total×km)',
    viaje4.precio_real < TIEMPO_HORAS * viaje4.tarifa_hora + DISTANCIA_KM * viaje4.tarifa_km,
    `nuevo=${viaje4.precio_real?.toFixed(2)} vs viejo=${(TIEMPO_HORAS * viaje4.tarifa_hora + DISTANCIA_KM * viaje4.tarifa_km).toFixed(2)}`
  );

  // ── CASO 6: CABA puro y PROVINCIA puro no cambian ────────────────────────
  console.log('\n── CASO 6: CABA puro / PROVINCIA puro sin cambios ─────────────\n');

  const v6a = await crearViaje(clienteToken, [OBELISCO, RECOLETA], 'CABA');
  await prepararParaCierre(v6a.id_viaje, id_conductor);
  await cerrarConfirmandoParadas(v6a.id_viaje, clienteToken, conductorToken, [OBELISCO, RECOLETA]);
  const viaje6a = await prisma.viaje.findUnique({
    where: { id_viaje: v6a.id_viaje },
    select: { zona: true, tiempo_capital: true, distancia_provincia: true, precio_real: true, tarifa_hora: true },
  });

  paso(
    `CASO 6a: CABA puro → tiempo_capital = total (${TIEMPO_HORAS}) y distancia_provincia = null`,
    viaje6a.zona === 'CABA' && casi(viaje6a.tiempo_capital, TIEMPO_HORAS) && viaje6a.distancia_provincia === null,
    `zona=${viaje6a.zona} tiempo_capital=${viaje6a.tiempo_capital} distancia_provincia=${viaje6a.distancia_provincia}`
  );
  paso(
    'CASO 6b: CABA puro → precio_real = tiempo_total × tarifa_hora',
    casi(viaje6a.precio_real, TIEMPO_HORAS * viaje6a.tarifa_hora, 0.5),
    `precio_real=${viaje6a.precio_real?.toFixed(2)}`
  );

  const v6b = await crearViaje(clienteToken, [LA_PLATA, LA_PLATA_2], 'PROVINCIA');
  await prepararParaCierre(v6b.id_viaje, id_conductor);
  await cerrarConfirmandoParadas(v6b.id_viaje, clienteToken, conductorToken, [LA_PLATA, LA_PLATA_2]);
  const viaje6b = await prisma.viaje.findUnique({
    where: { id_viaje: v6b.id_viaje },
    select: { zona: true, tiempo_capital: true, distancia_provincia: true, precio_real: true, tarifa_km: true },
  });

  paso(
    `CASO 6c: PROVINCIA puro → distancia_provincia = total (${DISTANCIA_KM}) y tiempo_capital = null`,
    viaje6b.zona === 'PROVINCIA' && casi(viaje6b.distancia_provincia, DISTANCIA_KM) && viaje6b.tiempo_capital === null,
    `zona=${viaje6b.zona} distancia_provincia=${viaje6b.distancia_provincia} tiempo_capital=${viaje6b.tiempo_capital}`
  );
  paso(
    'CASO 6d: PROVINCIA puro → precio_real = distancia_total × tarifa_km',
    casi(viaje6b.precio_real, DISTANCIA_KM * viaje6b.tarifa_km, 0.5),
    `precio_real=${viaje6b.precio_real?.toFixed(2)}`
  );

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
