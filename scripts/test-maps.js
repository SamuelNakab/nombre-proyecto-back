// Test de la CAPA DE GOOGLE (Paso 3) contra Google DE VERDAD, con pocas
// llamadas.
//
// PARTE A — en el proceso, sin server (costo.service + Routes API):
//   A1. Rutas corta y larga en CABA y una que cruza a provincia: valores
//       distintos y coherentes (distancia, manejo, zona, precio).
//   A2. Viaje de 4 paradas: llegada_estimada creciente; peon = TIEMPO_PEON x
//       paradas EXACTO; total = manejo + peon (±1 min) = fin - inicio.
//   A3. Tabla ANTES / DESPUES de precio y duracion para las 3 rutas, en hora
//       pico y fuera de pico (solo informativa). ANTES = como lo hacia el
//       codigo viejo: Distance Matrix tramo por tramo, SIN departure_time (sin
//       trafico) y sin peon. DESPUES = Routes con trafico a la hora de salida
//       de cada tramo + peon. El PRECIO usa la misma formula en las dos
//       columnas: lo unico que cambia es el tiempo de manejo que entra.
//
// PARTE B — servers efimeros:
//   - 3702 con GOOGLE_MAPS_API_KEY INVALIDA:
//     B1. crear viaje interno -> 503 y la PyME tiene los mismos viajes que antes.
//     B2. estimar-costo -> 503.
//     B3. un viaje en curso (creado en 3701, con la key buena) pinguea GPS en
//         3702: el ETA NO se emite y el ciclo salteado queda en el log.
//   - 3701 con la key buena: solo para crear el viaje de B3.
//
// Crea sus propios usuarios / PyME / vinculo / vehiculo y borra TODO al final
// (DB, Firebase, Redis). Imprime las llamadas a Google de la corrida por SKU.
//
//   node scripts/test-maps.js
import 'dotenv/config';
import { io as ioClient } from 'socket.io-client';
import prisma from '../src/config/prisma.js';
import redis from '../src/config/redis.js';
import admin from '../src/config/firebase.js';
import { conServer } from './_server-efimero.js';
import { estimarCosto } from '../src/services/costo.service.js';
import { estadisticasMaps } from '../src/services/maps/index.js';
import { clasificarZona, repartirPorZona } from '../src/services/zona.service.js';
import { obtenerTarifas } from '../src/services/tarifa.service.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const PUERTO_OK = 3701;
const PUERTO_ROTO = 3702;
const PEON = 30;
process.env.TIEMPO_PEON_MINUTOS = String(PEON);

const ENV_BASE = {
  RESERVA_BARRIDO_ARRANQUE: '0',
  VENCIMIENTO_BARRIDO_ARRANQUE: '0',
  ANTICIPACION_MINIMA_MINUTOS: '0',
  MARKETPLACE_HABILITADO: 'false',
  INVITACION_INTENTOS_MAX: '1000',
  TIEMPO_PEON_MINUTOS: String(PEON),
};

const S = String(Date.now());
const PASS = 'test123456';

const OBELISCO = { lat: -34.6037, lng: -58.3816, direccion: 'Obelisco, CABA' };
const CONGRESO = { lat: -34.6098, lng: -58.3925, direccion: 'Congreso, CABA' };
const LINIERS = { lat: -34.642, lng: -58.523, direccion: 'Liniers, CABA' };
const CABALLITO = { lat: -34.6186, lng: -58.441, direccion: 'Caballito, CABA' };
const NUNEZ = { lat: -34.545, lng: -58.463, direccion: 'Nunez, CABA' };
const SAN_ISIDRO = { lat: -34.4708, lng: -58.5286, direccion: 'San Isidro, Buenos Aires' };
const TRIBUNALES = { lat: -34.6025, lng: -58.3845, direccion: 'Tribunales, CABA' };
const RECOLETA = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };
const PALERMO = { lat: -34.5781, lng: -58.4265, direccion: 'Palermo, CABA' };

const RUTAS = [
  { nombre: 'corta CABA (Obelisco -> Congreso)', paradas: [OBELISCO, CONGRESO] },
  { nombre: 'larga CABA (Liniers -> Caballito -> Nunez)', paradas: [LINIERS, CABALLITO, NUNEZ] },
  { nombre: 'cruza a provincia (Obelisco -> San Isidro)', paradas: [OBELISCO, SAN_ISIDRO] },
];

// -- Helpers ----------------------------------------------------------------

const pasos = [];
function paso(nombre, ok, detalle = '') {
  pasos.push({ nombre, ok: Boolean(ok), detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const titulo = (t) => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 60 - t.length))}\n`);
const min = (horas) => horas * 60;
const r2s = (r) => `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`;

async function getToken(email, password = PASS) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error(`Firebase login fallido para ${email}: ${data.error?.message}`);
  return data.idToken;
}

async function api(base, method, path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const texto = await res.text();
  let data;
  try {
    data = JSON.parse(texto);
  } catch {
    data = { error: `no-JSON (${res.status})` };
  }
  return { status: res.status, data };
}

// El proximo dia HABIL (manana o despues, salteando sabado y domingo) a las
// HH:MM hora LOCAL del proceso, que es la que usa esHoraPico. Habil para que
// "pico" tenga el trafico de un dia de semana.
function manana(hh, mm) {
  const d = new Date();
  do d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6);
  d.setHours(hh, mm, 0, 0);
  return d;
}

// El calculo VIEJO, replicado solo para la tabla: Distance Matrix tramo por
// tramo, sin departure_time (sin trafico) y sin peon. La key nunca se imprime.
async function estimarComoAntes(paradas, fecha) {
  let distancia_km = 0;
  let tiempo_horas = 0;
  for (let i = 0; i < paradas.length - 1; i++) {
    const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
    url.searchParams.set('origins', `${paradas[i].lat},${paradas[i].lng}`);
    url.searchParams.set('destinations', `${paradas[i + 1].lat},${paradas[i + 1].lng}`);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('key', process.env.GOOGLE_MAPS_API_KEY);
    const data = await (await fetch(url)).json();
    const el = data.rows?.[0]?.elements?.[0];
    if (data.status !== 'OK' || el?.status !== 'OK') throw new Error(`Distance Matrix: ${data.status}/${el?.status}`);
    distancia_km += el.distance.value / 1000;
    tiempo_horas += el.duration.value / 3600;
  }
  const zona = clasificarZona(paradas);
  const { tarifa_hora, tarifa_km } = obtenerTarifas(zona, fecha);
  const { tiempo_capital, distancia_provincia } = repartirPorZona({ zona, paradas, tiempo_horas, distancia_km });
  const precio = (tiempo_capital === null ? 0 : tiempo_capital * tarifa_hora) + (distancia_provincia === null ? 0 : distancia_provincia * tarifa_km);
  return { precio, tiempo_horas, distancia_km };
}

// -- Parte A ------------------------------------------------------------------

async function parteA() {
  titulo('A1: rutas corta / larga en CABA y a provincia');
  const fecha = manana(14, 0);
  const res = [];
  for (const ruta of RUTAS) {
    const r = await estimarCosto({ paradas: ruta.paradas, fecha_programada: fecha.toISOString() });
    res.push(r);
    console.log(
      `     ${ruta.nombre}: zona=${r.zona} km=${r.recorrido.totales.distancia_km.toFixed(2)} manejo=${min(r.recorrido.totales.manejo_horas).toFixed(1)}min precio=$${r.precio_estimado.toFixed(0)}`
    );
  }
  const [corta, larga, prov] = res;
  paso(
    'A1a: la larga tiene mas distancia y mas manejo que la corta',
    larga.recorrido.totales.distancia_km > corta.recorrido.totales.distancia_km * 3 &&
      larga.recorrido.totales.manejo_horas > corta.recorrido.totales.manejo_horas
  );
  paso('A1b: zonas: corta y larga CABA, la de San Isidro MIXTO', corta.zona === 'CABA' && larga.zona === 'CABA' && prov.zona === 'MIXTO');
  paso(
    'A1c: la de provincia cobra distancia en provincia y tiempo en capital (reparto MIXTO)',
    prov.desglose.distancia_provincia > 0 && prov.desglose.tiempo_capital > 0 && prov.precio_estimado > 0
  );
  paso(
    'A1d: valores coherentes (km por hora de manejo entre 5 y 90)',
    res.every((r) => {
      const v = r.recorrido.totales.distancia_km / r.recorrido.totales.manejo_horas;
      return v > 5 && v < 90;
    }),
    res.map((r) => (r.recorrido.totales.distancia_km / r.recorrido.totales.manejo_horas).toFixed(1) + 'km/h').join(' ')
  );

  titulo('A2: 4 paradas — llegadas crecientes, peon exacto, total = manejo + peon');
  const cuatro = await estimarCosto({ paradas: [OBELISCO, TRIBUNALES, RECOLETA, PALERMO], fecha_programada: manana(11, 0).toISOString() });
  const ps = cuatro.recorrido.paradas;
  const t = cuatro.recorrido.totales;
  paso(
    'A2a: llegada_estimada creciente y salida = llegada + peon en cada parada',
    ps.every((p, i) => i === 0 || p.llegada_estimada > ps[i - 1].salida_estimada) &&
      ps.every((p) => p.salida_estimada - p.llegada_estimada === PEON * 60_000),
    ps.map((p) => p.llegada_estimada.toISOString().slice(11, 19)).join(' ')
  );
  paso('A2b: peon = TIEMPO_PEON x paradas (exacto)', min(t.peon_horas) === PEON * 4, `${min(t.peon_horas)} min`);
  paso(
    'A2c: total = manejo + peon (±1 min) y = fin - inicio',
    Math.abs(min(t.total_horas) - (min(t.manejo_horas) + min(t.peon_horas))) <= 1 &&
      Math.abs((t.fin_estimado - t.inicio_estimado) / 60_000 - min(t.total_horas)) <= 1,
    `manejo=${min(t.manejo_horas).toFixed(1)} peon=${min(t.peon_horas)} total=${min(t.total_horas).toFixed(1)}`
  );
  paso('A2d: la ruta planeada concatenada arranca en el origen y termina en el destino', cuatro.recorrido.polilinea.length > 4);

  titulo('A3: tabla ANTES / DESPUES (informativa)');
  const filas = [];
  for (const ruta of RUTAS) {
    for (const [franja, fecha] of [['pico 08:30', manana(8, 30)], ['fuera de pico 14:00', manana(14, 0)]]) {
      const antes = await estimarComoAntes(ruta.paradas, fecha);
      const despues = await estimarCosto({ paradas: ruta.paradas, fecha_programada: fecha.toISOString() });
      const d = despues.recorrido.totales;
      filas.push(
        `| ${ruta.nombre} | ${franja} | $${antes.precio.toFixed(0)} | $${despues.precio_estimado.toFixed(0)} | ` +
          `${min(antes.tiempo_horas).toFixed(0)} min | ${min(d.manejo_horas).toFixed(0)} min | ${min(d.peon_horas).toFixed(0)} min | ${min(d.total_horas).toFixed(0)} min |`
      );
    }
  }
  console.log('| Ruta | Franja | Precio antes | Precio despues | Duracion antes (manejo sin trafico) | Manejo despues (con trafico) | Peon despues | Duracion despues (total) |');
  console.log('|---|---|---|---|---|---|---|---|');
  filas.forEach((f) => console.log(f));
}

// -- Parte B ------------------------------------------------------------------

const creados = { emails: [], orgs: [], viajes: [] };

async function nuevoUsuario(base, tipo) {
  const n = creados.emails.length + 1;
  const email = `maps-${tipo}-${S}-${n}@test.com`;
  const datos = {
    nombre: 'Maps',
    apellido: tipo,
    dni: '6' + S.slice(-6) + n,
    email,
    contrasena: PASS,
    ...(tipo === 'conductor' ? { nro_licencia: `LMA${S.slice(-5)}`, licencia_vencimiento: '2030-01-01T00:00:00.000Z' } : {}),
  };
  creados.emails.push(email);
  const r = await api(base, 'POST', `/api/auth/registro-${tipo}`, datos);
  if (r.status !== 201) throw new Error(`registro ${tipo} fallo: ${r2s(r)}`);
  const u = await prisma.usuario.findUnique({ where: { email }, include: { conductor: true } });
  return { email, token: await getToken(email), id_usuario: u.id_usuario, id_conductor: u.conductor?.id_conductor ?? null };
}

function cuitValido() {
  const MULT = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  for (let k = 0; ; k++) {
    const base = '30' + String((Number(S.slice(-6)) * 100 + 7000 + k) % 1e8).padStart(8, '0');
    const dv = 11 - (MULT.reduce((a, m, i) => a + m * Number(base[i]), 0) % 11);
    if (dv !== 10) return base + (dv === 11 ? 0 : dv);
  }
}

async function setup(base) {
  const P = await nuevoUsuario(base, 'cliente');
  const K = await nuevoUsuario(base, 'conductor');
  const org = await api(base, 'POST', '/api/organizaciones', { nombre: `PyME Maps ${S}`, cuit: cuitValido() }, P.token);
  if (org.status !== 201) throw new Error(`crear PyME fallo: ${r2s(org)}`);
  const A = org.data.id_organizacion;
  creados.orgs.push(A);
  const inv = await api(base, 'POST', `/api/organizaciones/${A}/invitaciones`, { tipo: 'CHOFER' }, P.token);
  const canje = await api(base, 'POST', '/api/invitaciones/canjear', { codigo: inv.data.codigo }, K.token);
  if (canje.status !== 200) throw new Error(`canje fallo: ${r2s(canje)}`);
  const veh = await api(
    base,
    'POST',
    '/api/conductores/mis-vehiculos',
    { patente: `M${S.slice(-6)}`, marca: 'Fiat', modelo: 'Fiorino', anio: 2020, color: 'Blanco', tipo_vehiculo: 'Utilitario', condiciones: [] },
    K.token
  );
  if (veh.status !== 201) throw new Error(`vehiculo fallo: ${r2s(veh)}`);
  return { P, K, A, v: veh.data.id_vehiculo };
}

const cuerpoViaje = (id_conductor) => ({
  id_conductor,
  fecha_programada: new Date(Date.now() + 2 * 60_000).toISOString(),
  paradas: [OBELISCO, CONGRESO],
});

async function parteB() {
  await conServer({ ...ENV_BASE, GOOGLE_MAPS_API_KEY: 'CLAVE_INVALIDA_TEST_MAPS' }, PUERTO_ROTO, async (roto, leerLog) => {
    titulo('B: server con GOOGLE_MAPS_API_KEY invalida (3702)');
    const { P, K, A, v } = await setup(roto);

    const antes = await prisma.viaje.count({ where: { id_organizacion: A } });
    const crear = await api(roto, 'POST', `/api/organizaciones/${A}/viajes`, cuerpoViaje(K.id_conductor), P.token);
    const despues = await prisma.viaje.count({ where: { id_organizacion: A } });
    paso(
      'B1: crear viaje interno con Google caido → 503 y no quedo nada en la DB',
      crear.status === 503 && crear.data.error === 'No se pudo calcular la ruta. Probá de nuevo en unos minutos.' && antes === despues,
      `${r2s(crear)} viajes antes=${antes} despues=${despues}`
    );
    const estimar = await api(roto, 'POST', '/api/viajes/estimar-costo', { paradas: [OBELISCO, CONGRESO] }, P.token);
    paso('B2: estimar-costo con Google caido → 503', estimar.status === 503 && /No se pudo calcular la ruta/.test(estimar.data.error), r2s(estimar));
    paso('B1-B2: la key invalida no aparece en el log', !leerLog().includes('CLAVE_INVALIDA_TEST_MAPS'));

    // B3: el viaje se crea en el server con la key buena; despues se opera en
    // el roto (confirmar e iniciar no llaman a Google; el ETA si).
    let id_viaje = null;
    await conServer(ENV_BASE, PUERTO_OK, async (ok) => {
      const r = await api(ok, 'POST', `/api/organizaciones/${A}/viajes`, cuerpoViaje(K.id_conductor), P.token);
      if (r.status !== 201) throw new Error(`crear (key buena) fallo: ${r2s(r)}`);
      id_viaje = r.data.id_viaje;
      creados.viajes.push(id_viaje);
    });
    const conf = await api(roto, 'POST', `/api/choferes/viajes/${id_viaje}/confirmar`, { id_vehiculo: v }, K.token);
    const ini = await api(roto, 'POST', `/api/choferes/viajes/${id_viaje}/iniciar`, { lat: OBELISCO.lat, lng: OBELISCO.lng }, K.token);
    if (conf.status !== 200 || ini.status !== 200) throw new Error(`confirmar/iniciar fallo: ${r2s(conf)} | ${r2s(ini)}`);

    // El chofer manda el ping; el tracking (mapa y ETA) le llega a la sala de
    // la PyME.
    const conectar = (token) =>
      new Promise((res, rej) => {
        const s = ioClient(roto, { auth: { token: 'Bearer ' + token }, reconnection: false });
        s.on('connect', () => res(s));
        s.on('connect_error', rej);
      });
    const sK = await conectar(K.token);
    const sP = await conectar(P.token);
    const eventos = [];
    sP.onAny((ev, d) => eventos.push({ ev, d }));
    await esperar(800);
    sK.emit('conductor:ubicacion', { id_viaje, lat: OBELISCO.lat, lng: OBELISCO.lng, timestamp: Date.now() });
    await esperar(5000);
    const eta = eventos.filter((e) => e.ev === 'eta:actualizar' && e.d?.id_viaje === id_viaje);
    const mapa = eventos.filter((e) => e.ev === 'mapa:actualizar' && e.d?.id_viaje === id_viaje);
    paso(
      'B3: con Google caido el ETA NO se emite (el tracking sigue) y el ciclo salteado se loguea',
      eta.length === 0 && mapa.length > 0 && /\[eta-emisor\] viaje \d+: ciclo salteado/.test(leerLog()),
      `eta=${eta.length} mapa=${mapa.length}`
    );
    sK.disconnect();
    sP.disconnect();
    await api(roto, 'POST', `/api/organizaciones/${A}/viajes/${id_viaje}/cancelar`, {}, P.token);
  });
}

// -- Limpieza -----------------------------------------------------------------

async function limpiar() {
  titulo('LIMPIEZA');
  const usuarios = await prisma.usuario.findMany({ where: { email: { in: creados.emails } }, include: { conductor: true, cliente: true } });
  const idsUsuario = usuarios.map((u) => u.id_usuario);
  const idsConductor = usuarios.map((u) => u.conductor?.id_conductor).filter(Boolean);
  const idsCliente = usuarios.map((u) => u.cliente?.id_cliente).filter(Boolean);
  const viajes = await prisma.viaje.findMany({
    where: { OR: [{ id_organizacion: { in: creados.orgs } }, { id_conductor: { in: idsConductor } }, { id_cliente: { in: idsCliente } }] },
    select: { id_viaje: true },
  });
  const idsViaje = viajes.map((x) => x.id_viaje);
  if (redis.status === 'ready') {
    for (const id of idsViaje) {
      const keys = await redis.keys(`gps:${id}:*`);
      if (keys.length) await redis.del(...keys);
    }
    const claves = idsUsuario.map((id) => `invitacion:canje:usuario:${id}`);
    if (claves.length) await redis.del(...claves);
  }
  await prisma.historialEstadoViaje.deleteMany({ where: { id_viaje: { in: idsViaje } } });
  await prisma.parada.deleteMany({ where: { id_viaje: { in: idsViaje } } });
  await prisma.condicionRequerida.deleteMany({ where: { id_viaje: { in: idsViaje } } });
  await prisma.viaje.deleteMany({ where: { id_viaje: { in: idsViaje } } });
  await prisma.vinculoChofer.deleteMany({ where: { OR: [{ id_organizacion: { in: creados.orgs } }, { id_conductor: { in: idsConductor } }] } });
  await prisma.invitacion.deleteMany({ where: { id_organizacion: { in: creados.orgs } } });
  await prisma.miembroOrganizacion.deleteMany({ where: { OR: [{ id_organizacion: { in: creados.orgs } }, { id_usuario: { in: idsUsuario } }] } });
  await prisma.organizacion.deleteMany({ where: { id_organizacion: { in: creados.orgs } } });
  await prisma.condicionVehiculo.deleteMany({ where: { vehiculo: { id_conductor: { in: idsConductor } } } });
  await prisma.vehiculo.deleteMany({ where: { id_conductor: { in: idsConductor } } });
  await prisma.conductor.deleteMany({ where: { id_usuario: { in: idsUsuario } } });
  await prisma.cliente.deleteMany({ where: { id_usuario: { in: idsUsuario } } });
  await prisma.usuario.deleteMany({ where: { id_usuario: { in: idsUsuario } } });
  for (const email of creados.emails) {
    try {
      await admin.auth().deleteUser((await admin.auth().getUserByEmail(email)).uid);
    } catch (e) {
      if (e.code !== 'auth/user-not-found') console.error(`  ⚠️  Firebase ${email}: ${e.message}`);
    }
  }
  const quedan =
    (await prisma.usuario.count({ where: { email: { in: creados.emails } } })) +
    (await prisma.viaje.count({ where: { id_viaje: { in: idsViaje } } })) +
    (await prisma.organizacion.count({ where: { id_organizacion: { in: creados.orgs } } }));
  paso('LIMPIEZA: no quedo nada de lo creado por el test', quedan === 0, `viajes=${idsViaje.length} usuarios=${idsUsuario.length}`);
}

// -- Main ---------------------------------------------------------------------

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║        TEST CAPA DE GOOGLE (PASO 3)          ║');
  console.log('╚══════════════════════════════════════════════╝');
  const key = process.env.GOOGLE_MAPS_API_KEY ?? '';
  if (!key) throw new Error('Falta GOOGLE_MAPS_API_KEY en el .env');
  console.log(`  key: largo ${key.length}, termina en ...${key.slice(-4)}`);
  try {
    await parteA();
    await parteB();
  } finally {
    await limpiar().catch((e) => paso('LIMPIEZA', false, e.message));
  }
  console.log(`\n  llamadas a Google de la parte A (este proceso, por SKU): ${JSON.stringify(estadisticasMaps().por_sku)}`);
  console.log('  (la tabla ANTES suma Distance Matrix legacy: 1 elemento por tramo; la parte B: 1 Pro en 3701)');
  const fallaron = pasos.filter((p) => !p.ok);
  console.log(`\n  ${pasos.length - fallaron.length}/${pasos.length} checks pasaron`);
  fallaron.forEach((p) => console.log(`    ❌ ${p.nombre}${p.detalle ? ': ' + p.detalle : ''}`));
  return fallaron.length === 0;
}

main()
  .then(async (ok) => {
    await prisma.$disconnect().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(ok ? 0 : 1);
  })
  .catch(async (e) => {
    console.error('\n💥 Error inesperado:', e.message, e.stack);
    await prisma.$disconnect().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(1);
  });
