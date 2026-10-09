// Test del VIAJE INTERNO (Paso 2): la PyME asigna el viaje a un chofer
// vinculado, el chofer confirma o rechaza, lo inicia en el origen y lo ejecuta.
//
// NO pega contra :3000: levanta servers efimeros propios (_server-efimero.js).
//   - 3601: el principal. Ventana 60/90, ANTICIPACION 0 (para crear viajes que
//     se pueden iniciar ya), marketplace y calificaciones en false, peon 30.
//     USA GOOGLE DE VERDAD (la GOOGLE_MAPS_API_KEY del .env): desde el Paso 3 no
//     hay mock, sin Google no se puede crear un viaje. Cada viaje creado gasta
//     (paradas - 1) llamadas Pro de Routes API; el total sale al final, sumando
//     los logs [maps] de los servers efimeros.
//   - 3602: el del vencimiento por TIMER, con VENTANA_INICIO_DESPUES_MINUTOS=0.05
//     (3 segundos).
// Los dos con RESERVA_BARRIDO_ARRANQUE=0 y VENCIMIENTO_BARRIDO_ARRANQUE=0: la DB
// esta compartida con produccion y un server efimero con una ventana de segundos
// no puede barrer viajes reales.
//
// Casos:
//   1. Crear: chofer no vinculado, sin vehiculo compatible, PyME SUSPENDIDA, OK
//      (estado, metodo_cobro, historial, viaje:asignado al chofer y a la PyME).
//   2. Confirmar: vehiculo ajeno, incompatible, OK, doble, otro chofer.
//   3. Rechazar -> RECHAZADO; despues no se puede confirmar.
//   4. Iniciar fuera: antes de la ventana, lejos del origen, las dos, despues
//      (queda VENCIDO), sin confirmar.
//   5. Iniciar OK -> CARGANDO; GPS antes de iniciar rechazado; puntualidad.
//   6. Ciclo completo hasta FINALIZADO con remito; tracking en la sala de la PyME.
//   7. Chofer cancela CONFIRMADO; no puede cancelar en curso.
//   8. PyME (otro miembro) cancela en curso; Redis limpio.
//   9. Reasignar: eventos a los dos choferes, vehiculo null.
//  10. Editar CONFIRMADO -> ASIGNADO.
//  11. Vencimiento por TIMER (server 3602).
//  12. Vencimiento por chequeo PEREZOSO (lectura de la PyME, del chofer, accion).
//  13. Desvincular con 2 ASIGNADO + 1 CONFIRMADO + 1 en curso -> todos CANCELADO;
//      el viaje con la otra PyME queda intacto.
//  14. Aislamiento entre dos PyMEs que comparten chofer.
//  15. Otro miembro de la misma PyME ve el viaje.
//  16. Flags en false -> 404 (y el socket viaje:aceptar da error).
//  17. Concurrencia (5 rondas c/u): confirmar vs cancelar, confirmar vs vencer,
//      doble confirmar, reasignar vs confirmar, iniciar vs cancelar (chofer y
//      PyME), desvincular vs iniciar, crear vs desvincular, doble salir, salir vs
//      cancelar, confirmar parada vs cancelar. SUBCASOS=17b,17d corre solo esas.
//  18. Admin: la organizacion del viaje en el detalle y la lista.
//  19. Ciclo por parada (Paso 3): viaje de 4 paradas de punta a punta con
//      esperas controladas; peon y manejo reales por parada y totales exactos
//      contra las paradas y contra el historial (±1 s); orden obligatorio;
//      confirmar la ultima ya no finaliza.
//  20. Cancelar en curso guarda lo medido (manejando y en una parada).
//
// Acepta numeros de caso (el setup corre siempre):
//   node scripts/test-viaje-interno.js 17
// Y si una corrida se corto sin limpiar (la DB se cayo a la mitad):
//   node scripts/test-viaje-interno.js --restos
// Sirve para el protocolo de reversion (sacar un guard y ver el caso en rojo).
//
// LIMPIEZA: borra TODO lo que crea (viajes con su historial, paradas y
// condiciones; vinculos, invitaciones, membresias, PyMEs, vehiculos, usuarios en
// la DB y en Firebase; keys gps:{id}:* y de rate limit en Redis; los PDF de
// remito en R2) y al final verifica que no quedo nada.
import 'dotenv/config';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { io as ioClient } from 'socket.io-client';
import prisma from '../src/config/prisma.js';
import redis from '../src/config/redis.js';
import admin from '../src/config/firebase.js';
import { conServer } from './_server-efimero.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const PUERTO = 3601;
const PUERTO_TIMER = 3602;
const RONDAS = 5;

const ENV_BASE = {
  RESERVA_BARRIDO_ARRANQUE: '0',
  VENCIMIENTO_BARRIDO_ARRANQUE: '0',
  ANTICIPACION_MINIMA_MINUTOS: '0',
  VENTANA_INICIO_ANTES_MINUTOS: '60',
  VENTANA_INICIO_DESPUES_MINUTOS: '90',
  MARKETPLACE_HABILITADO: 'false',
  CALIFICACIONES_HABILITADAS: 'false',
  INVITACION_INTENTOS_MAX: '1000',
  RADIO_CONFIRMACION_METROS: '50',
  TIEMPO_PEON_MINUTOS: '30',
};

const SOLO = process.argv.slice(2).map(Number).filter(Number.isFinite);
const correr = (n) => SOLO.length === 0 || SOLO.includes(n);
// Sub-carreras del caso 17 (SUBCASOS=17b,17d): para el protocolo de reversion.
const SUBS = (process.env.SUBCASOS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const corre17 = (sub) => SUBS.length === 0 || SUBS.includes(sub);

const stamp = Date.now();
const S = String(stamp);
const PASS = 'test123456';
const LIC = '2030-01-01T00:00:00.000Z';

// Coordenadas: origen (Plaza de Mayo), destino (Recoleta) y una intermedia.
const ORIGEN = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const DESTINO = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };
const INTERMEDIA = { lat: -34.5975, lng: -58.3923, direccion: 'Tribunales, CABA' };
const TERCERA = { lat: -34.5934, lng: -58.4011, direccion: 'Plaza Vicente Lopez, CABA' };
const LEJOS = { lat: ORIGEN.lat + 0.01, lng: ORIGEN.lng }; // ~1100 m

// EJEMPLOS_JSON=ruta: guarda respuestas y payloads reales de los pasos clave
// en ese archivo (los ejemplos de API.md salen de aca, no se escriben a mano).
const EJEMPLOS = {};
const ejemplo = (nombre, valor) => {
  if (process.env.EJEMPLOS_JSON) EJEMPLOS[nombre] = valor?.data !== undefined && valor?.status !== undefined ? { status: valor.status, body: valor.data } : valor;
};
const eventoDe = (esp, ev, id_viaje) => esp.eventos.find((e) => e.ev === ev && e.d?.id_viaje === id_viaje)?.d;

const emailsCreados = [];
const orgsCreadas = new Set();
const viajesCreados = new Set();
const sockets = [];

// -- Helpers ----------------------------------------------------------------

const pasos = [];
function paso(nombre, ok, detalle = '') {
  pasos.push({ nombre, ok: Boolean(ok), detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const titulo = (t) => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 60 - t.length))}\n`);

async function getToken(email, password = PASS) {
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

let BASE = `http://localhost:${PUERTO}`;

async function api(method, path, body, token, base = BASE) {
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
    return { status: 0, data: { error: `fetch fallo: ${e.message}` }, crudo: '' };
  }
  const crudo = await res.text();
  let data;
  try {
    data = JSON.parse(crudo);
  } catch {
    data = { error: `Respuesta no-JSON (${res.status})` };
  }
  return { status: res.status, data, crudo };
}

const r2s = (r) => `${r.status} ${r.crudo.slice(0, 200)}`;
const statuses = (rs) => rs.map((r) => r.status).sort((a, b) => a - b).join(',');

const MULT = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
function cuitValido(n) {
  for (let k = 0; ; k++) {
    const base = '30' + String((Number(S.slice(-6)) * 100 + 5000 + n * 7 + k) % 1e8).padStart(8, '0');
    const suma = MULT.reduce((a, m, i) => a + m * Number(base[i]), 0);
    const dv = 11 - (suma % 11);
    if (dv === 10) continue;
    return base + (dv === 11 ? 0 : dv);
  }
}

let nUsuario = 0;
async function nuevoUsuario(tipo, etiqueta) {
  nUsuario++;
  const email = `${etiqueta}-vin-${S}-${nUsuario}@test.com`.toLowerCase();
  const dni = '7' + S.slice(-6) + String(nUsuario).padStart(2, '0');
  const datos = {
    nombre: etiqueta,
    apellido: 'Vin',
    dni,
    email,
    contrasena: PASS,
    telefono: `+54911${S.slice(-4)}${String(nUsuario).padStart(4, '0')}`,
    ...(tipo === 'conductor' ? { nro_licencia: `LVI${nUsuario}${S.slice(-4)}`, licencia_vencimiento: LIC } : {}),
  };
  emailsCreados.push(email);
  const endpoint = tipo === 'cliente' ? '/api/auth/registro-cliente' : '/api/auth/registro-conductor';
  const r = await api('POST', endpoint, datos);
  if (r.status !== 201) throw new Error(`registro ${tipo} ${email} fallo: ${r2s(r)}`);
  const token = await getToken(email);
  const u = await prisma.usuario.findUnique({ where: { email }, include: { conductor: true } });
  return { email, token, id_usuario: u.id_usuario, id_conductor: u.conductor?.id_conductor ?? null, nombre: etiqueta };
}

async function nuevosUsuarios(tipo, etiqueta, cantidad) {
  const out = [];
  for (let i = 0; i < cantidad; i += 4) {
    const lote = await Promise.all(
      Array.from({ length: Math.min(4, cantidad - i) }, (_, j) => nuevoUsuario(tipo, `${etiqueta}${i + j + 1}`))
    );
    out.push(...lote);
  }
  return out;
}

async function crearOrgOk(u, nombre, cuit) {
  const r = await api('POST', '/api/organizaciones', { nombre, cuit }, u.token);
  if (r.status !== 201) throw new Error(`crear PyME ${nombre} fallo: ${r2s(r)}`);
  orgsCreadas.add(r.data.id_organizacion);
  return r.data.id_organizacion;
}

async function invitarOk(u, idOrg, tipo) {
  const r = await api('POST', `/api/organizaciones/${idOrg}/invitaciones`, { tipo }, u.token);
  if (r.status !== 201) throw new Error(`invitar ${tipo} en ${idOrg} fallo: ${r2s(r)}`);
  return r.data;
}

async function canjearOk(u, codigo) {
  const r = await api('POST', '/api/invitaciones/canjear', { codigo }, u.token);
  if (r.status !== 200) throw new Error(`canje fallo: ${r2s(r)}`);
}

const vincular = async (responsable, idOrg, chofer) =>
  canjearOk(chofer, (await invitarOk(responsable, idOrg, 'CHOFER')).codigo);

let nPatente = 0;
async function vehiculoOk(chofer, condiciones) {
  nPatente++;
  const patente = `V${S.slice(-4)}${String(nPatente).padStart(2, '0')}`;
  const r = await api(
    'POST',
    '/api/conductores/mis-vehiculos',
    { patente, marca: 'Fiat', modelo: 'Fiorino', anio: 2020, color: 'Blanco', tipo_vehiculo: 'Utilitario', condiciones },
    chofer.token
  );
  if (r.status !== 201) throw new Error(`vehiculo fallo: ${r2s(r)}`);
  return r.data.id_vehiculo;
}

const enMin = (n) => new Date(Date.now() + n * 60000).toISOString();

// -- Acciones del ciclo -------------------------------------------------------

const crear = async (u, idOrg, { id_conductor, minutos = 2, condiciones = [], paradas = [ORIGEN, DESTINO] }, base = BASE) => {
  const r = await api(
    'POST',
    `/api/organizaciones/${idOrg}/viajes`,
    { id_conductor, fecha_programada: enMin(minutos), condiciones_requeridas: condiciones, paradas },
    u.token,
    base
  );
  if (r.status === 201) viajesCreados.add(r.data.id_viaje);
  return r;
};
async function crearOk(u, idOrg, opts, base = BASE) {
  const r = await crear(u, idOrg, opts, base);
  if (r.status !== 201) throw new Error(`crear viaje fallo: ${r2s(r)}`);
  return r.data.id_viaje;
}

const confirmar = (k, id, id_vehiculo, base = BASE) =>
  api('POST', `/api/choferes/viajes/${id}/confirmar`, { id_vehiculo }, k.token, base);
const rechazar = (k, id) => api('POST', `/api/choferes/viajes/${id}/rechazar`, null, k.token);
const iniciar = (k, id, pos = ORIGEN) =>
  api('POST', `/api/choferes/viajes/${id}/iniciar`, { lat: pos.lat, lng: pos.lng }, k.token);
const cancelarChofer = (k, id) => api('POST', `/api/choferes/viajes/${id}/cancelar`, null, k.token);
const cancelarPyme = (u, idOrg, id, motivo) =>
  api('POST', `/api/organizaciones/${idOrg}/viajes/${id}/cancelar`, motivo ? { motivo } : {}, u.token);
const reasignar = (u, idOrg, id, id_conductor) =>
  api('POST', `/api/organizaciones/${idOrg}/viajes/${id}/reasignar`, { id_conductor }, u.token);
const editar = (u, idOrg, id, body) => api('PUT', `/api/organizaciones/${idOrg}/viajes/${id}`, body, u.token);
const detallePyme = (u, idOrg, id, base = BASE) => api('GET', `/api/organizaciones/${idOrg}/viajes/${id}`, null, u.token, base);
const listaPyme = (u, idOrg, q = '') => api('GET', `/api/organizaciones/${idOrg}/viajes${q}`, null, u.token);
const listaChofer = (k, q = '') => api('GET', `/api/choferes/viajes${q}`, null, k.token);
const detalleChofer = (k, id) => api('GET', `/api/choferes/viajes/${id}`, null, k.token);
const avanzar = (k, id, estado) => api('PATCH', `/api/viajes/${id}/estado`, { estado }, k.token);
const salir = (k, id) => api('POST', `/api/choferes/viajes/${id}/salir`, null, k.token);
const paradasDb = (id) => prisma.parada.findMany({ where: { id_viaje: id }, orderBy: { orden: 'asc' } });
const filasHistorial = (id) =>
  prisma.historialEstadoViaje.findMany({ where: { id_viaje: id }, orderBy: [{ fecha: 'asc' }, { id_historial: 'asc' }] });
const HORA = 3_600_000;
const horasEntre = (a, b) => (b.getTime() - a.getTime()) / HORA;
const cerca = (a, b, tol = 1e-9) => a !== null && b !== null && Math.abs(a - b) <= tol;
const segs = (h) => (h * 3600).toFixed(2) + 's';
const confirmarParada = (k, id, id_parada, pos) =>
  api('POST', `/api/viajes/${id}/confirmar-parada`, { id_parada, lat: pos.lat, lng: pos.lng }, k.token);
const desvincular = (u, idOrg, k) => api('DELETE', `/api/organizaciones/${idOrg}/choferes/${k.id_conductor}`, null, u.token);

async function okOFalla(promesa, que) {
  const r = await promesa;
  if (r.status !== 200) throw new Error(`${que} fallo: ${r2s(r)}`);
  return r;
}

const viajeDb = (id) => prisma.viaje.findUnique({ where: { id_viaje: id } });
const historial = async (id) =>
  (
    await prisma.historialEstadoViaje.findMany({
      where: { id_viaje: id },
      orderBy: [{ fecha: 'asc' }, { id_historial: 'asc' }],
    })
  ).map((h) => `${h.estado}:${h.origen}`);
const moverFecha = (id, fecha) => prisma.viaje.update({ where: { id_viaje: id }, data: { fecha_programada: fecha } });
const haceMin = (n) => new Date(Date.now() - n * 60000);
async function keysGps(id) {
  if (redis.status !== 'ready') return -1;
  return (await redis.keys(`gps:${id}:*`)).length;
}
const nombresKeysGps = async (id) => (redis.status === 'ready' ? (await redis.keys(`gps:${id}:*`)).join(',') : '');

// -- Sockets ------------------------------------------------------------------

function conectar(base, token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { auth: { token: 'Bearer ' + token }, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`Socket connect_error: ${e.message}`)));
    setTimeout(() => reject(new Error('Timeout al conectar socket (8s)')), 8000);
  });
}

// Socket con un recolector de TODOS los eventos.
async function espia(base, token) {
  const socket = await conectar(base, token);
  sockets.push(socket);
  const eventos = [];
  socket.onAny((ev, d) => eventos.push({ ev, d }));
  return { socket, eventos };
}

const recibio = (esp, ev, id_viaje, pred = () => true) =>
  esp.eventos.some((e) => e.ev === ev && e.d?.id_viaje === id_viaje && pred(e.d));
async function esperarEvento(esp, ev, id_viaje, ms = 4000, pred) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (recibio(esp, ev, id_viaje, pred)) return true;
    await esperar(100);
  }
  return false;
}

// Ping GPS del chofer. Devuelve el 'error' que el server emita (o null).
async function pingGps(esp, id_viaje, pos) {
  const antes = esp.eventos.length;
  esp.socket.emit('conductor:ubicacion', { id_viaje, lat: pos.lat, lng: pos.lng, timestamp: Date.now() });
  await esperar(700);
  const err = esp.eventos.slice(antes).find((e) => e.ev === 'error');
  return err ? err.d : null;
}

// -- Limpieza -----------------------------------------------------------------

// `emails`: por defecto, los de ESTA corrida. Con --restos, los de cualquier
// corrida anterior que se haya cortado sin limpiar (p. ej. si la DB se cayo).
async function limpiar(emails = emailsCreados, patronRestante = `-vin-${S}-`) {
  titulo('LIMPIEZA');
  for (const s of sockets) s.disconnect();

  const usuarios = await prisma.usuario.findMany({
    where: { email: { in: emails } },
    include: { conductor: true, cliente: true, membresias: { select: { id_organizacion: true } } },
  });
  const idsUsuario = usuarios.map((u) => u.id_usuario);
  const idsConductor = usuarios.map((u) => u.conductor?.id_conductor).filter(Boolean);
  const idsCliente = usuarios.map((u) => u.cliente?.id_cliente).filter(Boolean);
  for (const u of usuarios) for (const m of u.membresias) orgsCreadas.add(m.id_organizacion);
  const idsOrg = [...orgsCreadas];

  const viajes = await prisma.viaje.findMany({
    where: {
      OR: [
        { id_viaje: { in: [...viajesCreados] } },
        { id_organizacion: { in: idsOrg } },
        { id_conductor: { in: idsConductor } },
        { id_cliente: { in: idsCliente } },
      ],
    },
    select: { id_viaje: true, estado: true },
  });
  const idsViaje = viajes.map((v) => v.id_viaje);

  // Remitos en R2 de los viajes que llegaron a FINALIZADO.
  let remitos = 0;
  const finalizados = viajes.filter((v) => v.estado === 'FINALIZADO').map((v) => v.id_viaje);
  if (finalizados.length > 0 && process.env.R2_BUCKET_NAME) {
    const r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    for (const id of finalizados) {
      try {
        await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: `remitos/${id}.pdf` }));
        remitos++;
      } catch (e) {
        console.error(`  ⚠️  R2 remito ${id}: ${e.message}`);
      }
    }
  }

  // Redis: todo gps:{id}:* de los viajes del test.
  if (redis.status === 'ready') {
    for (const id of idsViaje) {
      const keys = await redis.keys(`gps:${id}:*`);
      if (keys.length > 0) await redis.del(...keys);
    }
  }

  await prisma.historialEstadoViaje.deleteMany({ where: { id_viaje: { in: idsViaje } } });
  await prisma.parada.deleteMany({ where: { id_viaje: { in: idsViaje } } });
  await prisma.condicionRequerida.deleteMany({ where: { id_viaje: { in: idsViaje } } });
  await prisma.transaccion.deleteMany({ where: { id_viaje: { in: idsViaje } } });
  await prisma.calificacion.deleteMany({ where: { id_viaje: { in: idsViaje } } });
  await prisma.viaje.deleteMany({ where: { id_viaje: { in: idsViaje } } });

  await prisma.vinculoChofer.deleteMany({
    where: { OR: [{ id_organizacion: { in: idsOrg } }, { id_conductor: { in: idsConductor } }] },
  });
  await prisma.invitacion.deleteMany({ where: { id_organizacion: { in: idsOrg } } });
  await prisma.miembroOrganizacion.deleteMany({
    where: { OR: [{ id_organizacion: { in: idsOrg } }, { id_usuario: { in: idsUsuario } }] },
  });
  await prisma.organizacion.deleteMany({ where: { id_organizacion: { in: idsOrg } } });
  await prisma.condicionVehiculo.deleteMany({ where: { vehiculo: { id_conductor: { in: idsConductor } } } });
  await prisma.vehiculo.deleteMany({ where: { id_conductor: { in: idsConductor } } });
  await prisma.conductor.deleteMany({ where: { id_usuario: { in: idsUsuario } } });
  await prisma.cliente.deleteMany({ where: { id_usuario: { in: idsUsuario } } });
  await prisma.usuario.deleteMany({ where: { id_usuario: { in: idsUsuario } } });

  let fbBorrados = 0;
  for (const email of emails) {
    try {
      const u = await admin.auth().getUserByEmail(email);
      await admin.auth().deleteUser(u.uid);
      fbBorrados++;
    } catch (e) {
      if (e.code !== 'auth/user-not-found') console.error(`  ⚠️  Firebase ${email}: ${e.message}`);
    }
  }

  // Rate limit del canje: las keys de los usuarios y las de la IP de loopback.
  if (redis.status === 'ready') {
    const claves = idsUsuario.map((id) => `invitacion:canje:usuario:${id}`);
    let cursor = '0';
    do {
      const [sig, encontradas] = await redis.scan(cursor, 'MATCH', 'invitacion:canje:ip:*', 'COUNT', 500);
      cursor = sig;
      claves.push(...encontradas.filter((k) => /127\.0\.0\.1|::1$/.test(k)));
    } while (cursor !== '0');
    if (claves.length > 0) await redis.del(...claves);
  }

  const quedanUsuarios = await prisma.usuario.count({ where: { email: { contains: patronRestante } } });
  const quedanOrgs = await prisma.organizacion.count({ where: { id_organizacion: { in: idsOrg } } });
  const quedanViajes = await prisma.viaje.count({ where: { id_viaje: { in: idsViaje } } });
  const quedanHist = await prisma.historialEstadoViaje.count({ where: { id_viaje: { in: idsViaje } } });
  let quedanKeys = 0;
  if (redis.status === 'ready') for (const id of idsViaje) quedanKeys += (await redis.keys(`gps:${id}:*`)).length;
  console.log(
    `  viajes: ${idsViaje.length} borrados | usuarios DB: ${idsUsuario.length} | Firebase: ${fbBorrados} | ` +
      `PyMEs: ${idsOrg.length} | remitos R2: ${remitos} | quedan: usuarios=${quedanUsuarios} pymes=${quedanOrgs} ` +
      `viajes=${quedanViajes} historial=${quedanHist} keys_gps=${quedanKeys}`
  );
  return quedanUsuarios === 0 && quedanOrgs === 0 && quedanViajes === 0 && quedanHist === 0 && quedanKeys === 0;
}

// -- Casos --------------------------------------------------------------------

async function casosPrincipales(ctx) {
  const { P1, P2, Q1, K1, K2, K3, K4, K5, A, B, v1a, v1b, v2, sP1, sP2, sQ1, sK1, sK2 } = ctx;

  // CASO 1 -------------------------------------------------------------------
  if (correr(1)) {
    titulo('CASO 1: crear');
    const noVinc = await crear(P1, A, { id_conductor: K3.id_conductor });
    paso('CASO 1a: chofer no vinculado → 400', noVinc.status === 400 && /no esta vinculado/.test(noVinc.data.error), r2s(noVinc));

    const sinVeh = await crear(P1, A, { id_conductor: K4.id_conductor, condiciones: ['REFRIGERADO'] });
    paso('CASO 1b: sin vehiculo compatible → 400 con las condiciones', sinVeh.status === 400 && /REFRIGERADO/.test(sinVeh.data.error), r2s(sinVeh));

    await prisma.organizacion.update({ where: { id_organizacion: A }, data: { estado: 'SUSPENDIDA' } });
    const susp = await crear(P1, A, { id_conductor: K1.id_conductor });
    await prisma.organizacion.update({ where: { id_organizacion: A }, data: { estado: 'TRIAL' } });
    paso('CASO 1c: PyME SUSPENDIDA → 403', susp.status === 403, r2s(susp));

    const sinChofer = await api('POST', `/api/organizaciones/${A}/viajes`, { fecha_programada: enMin(5), paradas: [ORIGEN, DESTINO] }, P1.token);
    paso('CASO 1d: sin id_conductor → 400', sinChofer.status === 400, r2s(sinChofer));

    const ok = await crear(P1, A, { id_conductor: K1.id_conductor, condiciones: ['FRAGIL'] });
    ejemplo('crear_201', ok);
    ejemplo('crear_400_no_vinculado', noVinc);
    ejemplo('crear_400_sin_vehiculo', sinVeh);
    ejemplo('crear_403_suspendida', susp);
    const v = ok.data;
    paso(
      'CASO 1e: OK → 201 ASIGNADO, sin vehiculo, metodo_cobro copiado, creador',
      ok.status === 201 && v.estado === 'ASIGNADO' && v.id_organizacion === A && v.id_creador === P1.id_usuario &&
        v.metodo_cobro === 'CALCULO_PLATAFORMA' && v.id_vehiculo === null && v.conductor?.id_conductor === K1.id_conductor &&
        v.organizacion?.nombre && v.vencido === false && v.precio_estimado > 0,
      ok.status === 201 ? `id ${v.id_viaje} precio ${v.precio_estimado}` : r2s(ok)
    );
    if (ok.status === 201) {
      paso('CASO 1f: historial = ASIGNADO por la PyME', (await historial(v.id_viaje)).join() === 'ASIGNADO:CLIENTE', (await historial(v.id_viaje)).join());
      const alChofer = await esperarEvento(sK1, 'viaje:asignado', v.id_viaje);
      const aOtroMiembro = await esperarEvento(sP2, 'viaje:asignado', v.id_viaje);
      paso('CASO 1g: viaje:asignado al chofer y a la sala de la PyME (otro miembro)', alChofer && aOtroMiembro, `chofer=${alChofer} miembro=${aOtroMiembro}`);
      ejemplo('evento_viaje_asignado', eventoDe(sK1, 'viaje:asignado', v.id_viaje));
      paso('CASO 1h: la otra PyME no recibe nada', !recibio(sQ1, 'viaje:asignado', v.id_viaje), '');

      // Paso 3: estimados por viaje y por parada, guardados al crear.
      const db = await viajeDb(v.id_viaje);
      const ps = await paradasDb(v.id_viaje);
      const okViaje =
        db.manejo_estimado_horas > 0 && db.peon_estimado_horas === 1 && db.distancia_estimada_km > 0 &&
        cerca(db.duracion_estimada_horas, db.manejo_estimado_horas + db.peon_estimado_horas, 1e-9);
      const okParadas =
        ps.length === 2 && ps.every((x) => x.peon_estimado_horas === 0.5) &&
        ps[0].llegada_estimada?.getTime() === db.fecha_programada.getTime() &&
        ps[0].manejo_estimado_horas === null && ps[1].manejo_estimado_horas > 0 && ps[1].distancia_estimada_km > 0 &&
        ps[1].llegada_estimada > ps[0].salida_estimada;
      paso(
        'CASO 1i: crear guarda manejo / peon / distancia estimados por viaje y por parada',
        okViaje && okParadas,
        `manejo=${db.manejo_estimado_horas?.toFixed(3)}h peon=${db.peon_estimado_horas}h total=${db.duracion_estimada_horas?.toFixed(3)}h km=${db.distancia_estimada_km}`
      );
      paso(
        'CASO 1j: la respuesta trae estimado, real null, paradas en minutos y la ruta planeada',
        v.estimado?.peon_horas === 1 && v.real === null && v.paradas?.[0]?.peon_estimado_min === 30 &&
          v.paradas?.[1]?.manejo_estimado_min !== null && v.duracion_estimada === Math.round(db.duracion_estimada_horas * 60) &&
          Array.isArray(v.ruta_planeada) && v.ruta_planeada.length > 2,
        JSON.stringify(v.estimado)
      );
    }
  }

  // CASO 2 -------------------------------------------------------------------
  if (correr(2)) {
    titulo('CASO 2: confirmar');
    const id = await crearOk(P1, A, { id_conductor: K1.id_conductor, condiciones: ['FRAGIL'] });
    const ajeno = await confirmar(K1, id, v2);
    paso('CASO 2a: vehiculo ajeno → 400', ajeno.status === 400 && /no es tuyo/.test(ajeno.data.error), r2s(ajeno));
    const incompat = await confirmar(K1, id, v1b);
    paso('CASO 2b: vehiculo incompatible → 400', incompat.status === 400 && /no cumple/.test(incompat.data.error), r2s(incompat));
    const otro = await confirmar(K2, id, v2);
    paso('CASO 2c: otro chofer → 404', otro.status === 404, r2s(otro));
    const ok = await confirmar(K1, id, v1a);
    const db = await viajeDb(id);
    paso(
      'CASO 2d: OK → CONFIRMADO con vehiculo y fecha_confirmacion',
      ok.status === 200 && db.estado === 'CONFIRMADO' && db.id_vehiculo === v1a && db.fecha_confirmacion !== null,
      r2s(ok)
    );
    paso('CASO 2e: viaje:confirmado a la PyME', await esperarEvento(sP1, 'viaje:confirmado', id), '');
    ejemplo('confirmar_200', ok);
    ejemplo('confirmar_400_ajeno', ajeno);
    ejemplo('confirmar_400_incompatible', incompat);
    ejemplo('evento_viaje_confirmado', eventoDe(sP1, 'viaje:confirmado', id));
    const doble = await confirmar(K1, id, v1a);
    paso('CASO 2f: confirmar de nuevo → 400', doble.status === 400, r2s(doble));
    ctx.confirmado = id;
  }

  // CASO 3 -------------------------------------------------------------------
  if (correr(3)) {
    titulo('CASO 3: rechazar');
    const id = await crearOk(P1, A, { id_conductor: K2.id_conductor });
    const r = await rechazar(K2, id);
    const db = await viajeDb(id);
    paso('CASO 3a: rechazar → RECHAZADO con fecha_rechazo', r.status === 200 && db.estado === 'RECHAZADO' && db.fecha_rechazo !== null, r2s(r));
    paso('CASO 3b: viaje:rechazado a la PyME', await esperarEvento(sP1, 'viaje:rechazado', id), '');
    ejemplo('rechazar_200', r);
    ejemplo('evento_viaje_rechazado', eventoDe(sP1, 'viaje:rechazado', id));
    const conf = await confirmar(K2, id, v2);
    paso('CASO 3c: confirmar un RECHAZADO → 400', conf.status === 400, r2s(conf));
    const canc = await cancelarPyme(P1, A, id);
    paso('CASO 3d: cancelar un RECHAZADO (final) → 400', canc.status === 400, r2s(canc));
  }

  // CASO 4 -------------------------------------------------------------------
  if (correr(4)) {
    titulo('CASO 4: iniciar fuera de ventana o lejos');
    const temprano = await crearOk(P1, A, { id_conductor: K1.id_conductor, minutos: 180 });
    await okOFalla(confirmar(K1, temprano, v1a), 'confirmar');
    const rA = await iniciar(K1, temprano);
    paso('CASO 4a: antes de la ventana → 400 con la hora', rA.status === 400 && /a partir de las \d\d:\d\d/.test(rA.data.error) && !/origen/.test(rA.data.error), r2s(rA));

    const ya = await crearOk(P1, A, { id_conductor: K1.id_conductor });
    await okOFalla(confirmar(K1, ya, v1a), 'confirmar');
    const rB = await iniciar(K1, ya, LEJOS);
    paso('CASO 4b: lejos del origen → 400 con los metros', rB.status === 400 && /estas a \d+m del origen/.test(rB.data.error) && !/a partir/.test(rB.data.error), r2s(rB));

    const rC = await iniciar(K1, temprano, LEJOS);
    ejemplo('iniciar_400_antes', rA);
    ejemplo('iniciar_400_lejos', rB);
    ejemplo('iniciar_400_las_dos', rC);
    paso('CASO 4c: las dos fallas → 400 con las dos', rC.status === 400 && /a partir de las/.test(rC.data.error) && /del origen/.test(rC.data.error), r2s(rC));

    const tarde = await crearOk(P1, A, { id_conductor: K1.id_conductor });
    await okOFalla(confirmar(K1, tarde, v1a), 'confirmar');
    await moverFecha(tarde, haceMin(100));
    const rD = await iniciar(K1, tarde);
    const dbD = await viajeDb(tarde);
    ejemplo('iniciar_400_despues', rD);
    paso('CASO 4d: despues de la ventana → 400 y queda VENCIDO', rD.status === 400 && /cerro/.test(rD.data.error) && dbD.estado === 'VENCIDO', `${r2s(rD)} estado=${dbD.estado}`);

    const sinConf = await crearOk(P1, A, { id_conductor: K1.id_conductor });
    const rE = await iniciar(K1, sinConf);
    paso('CASO 4e: sin confirmar → 400', rE.status === 400 && /confirmar/.test(rE.data.error), r2s(rE));
    for (const id of [temprano, ya, sinConf]) await cancelarPyme(P1, A, id);
  }

  // CASO 5 + 6 ---------------------------------------------------------------
  let enCurso = null;
  if (correr(5) || correr(6)) {
    titulo('CASO 5: iniciar OK');
    const id = await crearOk(P1, A, { id_conductor: K1.id_conductor, paradas: [ORIGEN, DESTINO] });
    await okOFalla(confirmar(K1, id, v1a), 'confirmar');
    const errAntes = await pingGps(sK1, id, ORIGEN);
    paso('CASO 5a: ping GPS en CONFIRMADO → "El viaje no fue iniciado"', errAntes?.error === 'El viaje no fue iniciado', JSON.stringify(errAntes));
    const patch = await avanzar(K1, id, 'CARGANDO');
    paso('CASO 5b: PATCH /estado no aplica a un viaje interno → 400', patch.status === 400 && /iniciar/.test(patch.data.error), r2s(patch));
    const r = await iniciar(K1, id);
    const db = await viajeDb(id);
    const [o] = await paradasDb(id);
    paso(
      'CASO 5c: iniciar en el origen → CARGANDO, fecha_inicio = fecha_llegada_origen = llegada_real de la parada 1',
      r.status === 200 && db.estado === 'CARGANDO' && db.fecha_inicio?.getTime() === db.fecha_llegada_origen?.getTime() && db.iniciado_por === 'CONDUCTOR' &&
        o.llegada_real?.getTime() === db.fecha_inicio.getTime() && o.estado === 'ENTREGADO' && o.salida_real === null,
      r2s(r)
    );
    ejemplo('iniciar_200', r);
    const det = await detallePyme(P1, A, id);
    paso(
      'CASO 5d: puntualidad A_TIEMPO y aproximacion 0 en el detalle de la PyME',
      det.data.puntualidad_inicio === 'A_TIEMPO' && det.data.duracion_aproximacion_origen === 0,
      `puntualidad=${det.data.puntualidad_inicio} aprox=${det.data.duracion_aproximacion_origen}`
    );
    paso('CASO 5e: historial ASIGNADO → CONFIRMADO → CARGANDO', (await historial(id)).join() === 'ASIGNADO:CLIENTE,CONFIRMADO:CONDUCTOR,CARGANDO:CONDUCTOR', (await historial(id)).join());
    paso('CASO 5f: viaje:iniciado a la PyME', await esperarEvento(sP2, 'viaje:iniciado', id), '');
    enCurso = id;
  }

  if (correr(6) && enCurso) {
    titulo('CASO 6: ciclo completo hasta FINALIZADO (ciclo por parada)');
    const id = enCurso;
    const err = await pingGps(sK1, id, ORIGEN);
    const trackingPyme = await esperarEvento(sP2, 'mapa:actualizar', id);
    paso('CASO 6a: ping en CARGANDO → mapa:actualizar con id_viaje en la sala de la PyME', !err && trackingPyme, JSON.stringify(err));
    paso('CASO 6b: la otra PyME no recibe el tracking', !recibio(sQ1, 'mapa:actualizar', id), '');
    ejemplo('evento_mapa_actualizar', eventoDe(sP2, 'mapa:actualizar', id));
    const patch = await avanzar(K1, id, 'EN_RUTA');
    ejemplo('patch_estado_400_interno', patch);
    paso('CASO 6c: PATCH /estado EN_RUTA en un viaje interno → 400 (se sale con "salir")', patch.status === 400 && /salir/.test(patch.data.error), r2s(patch));
    const s1 = await salir(K1, id);
    ejemplo('salir_200_en_ruta', s1);
    paso(
      'CASO 6d: salir del origen → EN_RUTA y estado_cambiado (con id_parada) a la PyME',
      s1.status === 200 && s1.data.estado === 'EN_RUTA' && s1.data.viaje_finalizado === false &&
        (await esperarEvento(sP1, 'viaje:estado_cambiado', id, 4000, (d) => d.estado_nuevo === 'EN_RUTA' && d.id_parada)),
      r2s(s1)
    );
    const det = await detallePyme(P1, A, id);
    const [p1, p2] = det.data.paradas;
    const c1 = await confirmarParada(K1, id, p1.id_parada, ORIGEN);
    paso('CASO 6e: la parada 1 ya quedo confirmada al iniciar → 400', c1.status === 400 && /ya fue confirmada/.test(c1.data.error), r2s(c1));
    // Un ping en el destino suma distancia al acumulado de Redis.
    await pingGps(sK1, id, DESTINO);
    const c2 = await confirmarParada(K1, id, p2.id_parada, DESTINO);
    ejemplo('confirmar_parada_200_interno', c2);
    paso(
      'CASO 6f: confirmar la ULTIMA ya NO finaliza → DESCARGANDO',
      c2.status === 200 && c2.data.viaje_finalizado === false && (await viajeDb(id)).estado === 'DESCARGANDO',
      r2s(c2)
    );
    const s2 = await salir(K1, id);
    ejemplo('salir_200_finaliza', s2);
    paso('CASO 6g: salir de la ultima → FINALIZADO con remito_url', s2.status === 200 && s2.data.viaje_finalizado === true && s2.data.estado === 'FINALIZADO' && Boolean(s2.data.remito_url), r2s(s2));
    paso('CASO 6h: viaje:finalizado a la PyME con estimado y real', await esperarEvento(sP2, 'viaje:finalizado', id, 4000, (d) => d.estimado && d.real && d.paradas?.length === 2), '');
    const det2 = await detallePyme(P1, A, id);
    ejemplo('detalle_pyme_finalizado', det2);
    ejemplo('evento_viaje_finalizado', eventoDe(sP2, 'viaje:finalizado', id));
    paso(
      'CASO 6i: detalle FINALIZADO con remito y metricas por etapa',
      det2.data.estado === 'FINALIZADO' && det2.data.remito_url && det2.data.duracion_carga !== null && det2.data.duracion_descarga !== null && det2.data.duracion_real !== null,
      `carga=${det2.data.duracion_carga} descarga=${det2.data.duracion_descarga} real=${det2.data.duracion_real}`
    );
    const db = await viajeDb(id);
    paso(
      'CASO 6j: guarda manejo_real, peon_real y distancia_real (del acumulado GPS)',
      db.manejo_real_horas > 0 && db.peon_real_horas > 0 && db.distancia_real_km > 1 &&
        det2.data.real?.distancia_km === db.distancia_real_km && cerca(det2.data.real.total_horas, db.manejo_real_horas + db.peon_real_horas),
      `manejo=${segs(db.manejo_real_horas)} peon=${segs(db.peon_real_horas)} km=${db.distancia_real_km?.toFixed(2)}`
    );
    const rem = await api('GET', `/api/organizaciones/${A}/viajes/${id}/remito`, null, P2.token);
    let pdf = 'sin R2_PUBLIC_URL';
    if (rem.status === 200 && process.env.R2_PUBLIC_URL) {
      const f = await fetch(rem.data.remito_url, { method: 'HEAD' }).catch(() => null);
      pdf = f ? String(f.status) : 'fetch fallo';
    }
    paso('CASO 6k: GET remito de la PyME → 200 y el PDF existe en R2', rem.status === 200 && pdf === '200', `${r2s(rem)} pdf=${pdf}`);
    const hist = await listaChofer(K1, '?grupo=historial');
    ejemplo('lista_chofer_historial_item', hist.data.find?.((v) => v.id_viaje === id));
    ejemplo('remito_pyme_200', rem);
    const enHist = hist.data.find?.((v) => v.id_viaje === id);
    paso('CASO 6l: el chofer lo ve en su historial con el nombre de la PyME', Boolean(enHist?.organizacion?.nombre), enHist?.organizacion?.nombre ?? r2s(hist));
    paso('CASO 6m: historial completo', (await historial(id)).join() === 'ASIGNADO:CLIENTE,CONFIRMADO:CONDUCTOR,CARGANDO:CONDUCTOR,EN_RUTA:CONDUCTOR,DESCARGANDO:CONDUCTOR,FINALIZADO:CONDUCTOR', (await historial(id)).join());
    paso('CASO 6n: Redis limpio al cerrar', (await keysGps(id)) === 0, `keys=${await keysGps(id)}`);
    const otra = await salir(K1, id);
    paso('CASO 6o: salir de un FINALIZADO → 400', otra.status === 400, r2s(otra));
  }

  // CASO 7 + 8 ---------------------------------------------------------------
  if (correr(7) || correr(8)) {
    titulo('CASO 7: chofer cancela');
    const id = await crearOk(P1, A, { id_conductor: K1.id_conductor });
    await okOFalla(confirmar(K1, id, v1a), 'confirmar');
    const r = await cancelarChofer(K1, id);
    const db = await viajeDb(id);
    paso('CASO 7a: chofer cancela CONFIRMADO → CANCELADO causa CHOFER', r.status === 200 && db.estado === 'CANCELADO' && db.causa_cancelacion === 'CHOFER', r2s(r));
    paso('CASO 7b: viaje:cancelado a la PyME', await esperarEvento(sP1, 'viaje:cancelado', id, 4000, (d) => d.causa === 'CHOFER'), '');

    const id2 = await crearOk(P1, A, { id_conductor: K1.id_conductor });
    await okOFalla(confirmar(K1, id2, v1a), 'confirmar');
    await okOFalla(iniciar(K1, id2), 'iniciar');
    const r2 = await cancelarChofer(K1, id2);
    ejemplo('cancelar_chofer_200', r);
    ejemplo('cancelar_chofer_400_en_curso', r2);
    paso('CASO 7c: chofer NO puede cancelar en curso → 400', r2.status === 400 && /en curso/.test(r2.data.error), r2s(r2));

    titulo('CASO 8: la PyME (otro miembro) cancela en curso');
    await pingGps(sK1, id2, ORIGEN);
    // El primer ping dispara un calculo de ETA inmediato que escribe
    // gps:{id}:eta un rato despues (va a la DB). Se espera a que exista, asi
    // 8b mide la limpieza y no la carrera (esa es 8e).
    for (let i = 0; i < 60 && !(await redis.exists(`gps:${id2}:eta`)); i++) await esperar(100);
    const antes = await keysGps(id2);
    const c = await cancelarPyme(P2, A, id2, 'cliente cancelo el pedido');
    const db2 = await viajeDb(id2);
    paso(
      'CASO 8a: PyME cancela CARGANDO → CANCELADO causa ORGANIZACION con motivo',
      c.status === 200 && db2.estado === 'CANCELADO' && db2.causa_cancelacion === 'ORGANIZACION' && db2.motivo_cancelacion === 'cliente cancelo el pedido',
      r2s(c)
    );
    paso('CASO 8b: keys gps:{id}:* borradas', antes > 0 && (await keysGps(id2)) === 0, `antes=${antes} quedan=[${await nombresKeysGps(id2)}]`);
    ejemplo('cancelar_pyme_200', c);
    ejemplo('evento_viaje_cancelado', eventoDe(sK1, 'viaje:cancelado', id2));
    paso('CASO 8c: viaje:cancelado al chofer', await esperarEvento(sK1, 'viaje:cancelado', id2, 4000, (d) => d.causa === 'ORGANIZACION'), '');
    const [o2] = await paradasDb(id2);
    paso(
      'CASO 8f: cancelado en CARGANDO → peon parcial de la parada 1, sin salida_real, manejo 0',
      db2.peon_real_horas > 0 && db2.manejo_real_horas === 0 && cerca(o2.peon_real_horas, db2.peon_real_horas) && o2.salida_real === null,
      `peon=${segs(db2.peon_real_horas ?? 0)} manejo=${db2.manejo_real_horas}`
    );
    const err = await pingGps(sK1, id2, ORIGEN);
    paso('CASO 8d: un ping despues de cancelar se ignora (sin error, sin keys)', !err && (await keysGps(id2)) === 0, JSON.stringify(err));

    // La carrera: cancelar con el calculo de ETA del primer ping todavia en
    // vuelo. Sin el guard de eta-emisor, gps:{id}:eta reaparece despues de
    // limpiarGPS y queda huerfana 24 h.
    const id3 = await crearOk(P1, A, { id_conductor: K1.id_conductor });
    await okOFalla(confirmar(K1, id3, v1a), 'confirmar');
    await okOFalla(iniciar(K1, id3), 'iniciar');
    sK1.socket.emit('conductor:ubicacion', { id_viaje: id3, lat: ORIGEN.lat, lng: ORIGEN.lng, timestamp: Date.now() });
    await esperar(300);
    await okOFalla(cancelarPyme(P1, A, id3), 'cancelar');
    await esperar(4000);
    paso('CASO 8e: cancelar con el ETA en vuelo no deja keys huerfanas', (await keysGps(id3)) === 0, `quedan=[${await nombresKeysGps(id3)}]`);
  }

  // CASO 9 -------------------------------------------------------------------
  if (correr(9)) {
    titulo('CASO 9: reasignar');
    const id = await crearOk(P1, A, { id_conductor: K1.id_conductor, condiciones: ['FRAGIL'] });
    await okOFalla(confirmar(K1, id, v1a), 'confirmar');
    const r = await reasignar(P1, A, id, K2.id_conductor);
    const db = await viajeDb(id);
    paso(
      'CASO 9a: reasignar CONFIRMADO → ASIGNADO al chofer nuevo, sin vehiculo',
      r.status === 200 && db.estado === 'ASIGNADO' && db.id_conductor === K2.id_conductor && db.id_vehiculo === null && db.fecha_confirmacion === null,
      r2s(r)
    );
    const desasig = await esperarEvento(sK1, 'viaje:desasignado', id);
    const asig = await esperarEvento(sK2, 'viaje:asignado', id);
    paso('CASO 9b: viaje:desasignado al viejo y viaje:asignado al nuevo', desasig && asig, `viejo=${desasig} nuevo=${asig}`);
    ejemplo('reasignar_200', r);
    ejemplo('evento_viaje_desasignado', eventoDe(sK1, 'viaje:desasignado', id));
    const verViejo = await detalleChofer(K1, id);
    const verNuevo = await detalleChofer(K2, id);
    paso('CASO 9c: el chofer viejo ya no lo ve (404), el nuevo si', verViejo.status === 404 && verNuevo.status === 200, `${verViejo.status} ${verNuevo.status}`);
    paso('CASO 9d: historial con el ASIGNADO de la reasignacion', (await historial(id)).join() === 'ASIGNADO:CLIENTE,CONFIRMADO:CONDUCTOR,ASIGNADO:CLIENTE', (await historial(id)).join());
    const mismo = await reasignar(P1, A, id, K2.id_conductor);
    const noVinc = await reasignar(P1, A, id, K3.id_conductor);
    paso('CASO 9e: al mismo chofer → 400; a uno no vinculado → 400', mismo.status === 400 && noVinc.status === 400, `${r2s(mismo)} | ${r2s(noVinc)}`);
    await cancelarPyme(P1, A, id);
  }

  // CASO 10 ------------------------------------------------------------------
  if (correr(10)) {
    titulo('CASO 10: editar');
    const id = await crearOk(P1, A, { id_conductor: K1.id_conductor, condiciones: ['FRAGIL'] });
    await okOFalla(confirmar(K1, id, v1a), 'confirmar');
    const r = await editar(P1, A, id, {
      paradas: [ORIGEN, INTERMEDIA, DESTINO],
      condiciones_requeridas: ['FRAGIL', 'REFRIGERADO'],
      descripcion: 'editado',
      fecha_programada: enMin(30),
    });
    const db = await viajeDb(id);
    const paradas = await prisma.parada.count({ where: { id_viaje: id } });
    const conds = (await prisma.condicionRequerida.findMany({ where: { id_viaje: id } })).map((c) => c.condicion).sort();
    paso(
      'CASO 10a: editar CONFIRMADO → ASIGNADO, sin vehiculo, paradas y condiciones nuevas',
      r.status === 200 && db.estado === 'ASIGNADO' && db.id_vehiculo === null && paradas === 3 && conds.join() === 'FRAGIL,REFRIGERADO' && db.descripcion === 'editado',
      `${r.status} estado=${db.estado} paradas=${paradas} conds=${conds}`
    );
    ejemplo('editar_200', r);
    ejemplo('evento_viaje_editado', eventoDe(sK1, 'viaje:editado', id));
    paso('CASO 10b: viaje:editado al chofer con confirmacion_anulada', await esperarEvento(sK1, 'viaje:editado', id, 4000, (d) => d.confirmacion_anulada === true), '');
    const incompat = await editar(P1, A, id, { condiciones_requeridas: ['CARGA_PESADA'] });
    paso('CASO 10c: condiciones que el chofer no cumple → 400', incompat.status === 400 && /Reasigna/.test(incompat.data.error), r2s(incompat));
    const vacio = await editar(P1, A, id, {});
    paso('CASO 10d: body vacio → 400', vacio.status === 400, r2s(vacio));

    // Paso 3: editar recalcula los estimados (por viaje y por parada).
    const ps3 = await paradasDb(id);
    paso(
      'CASO 10g: editar con 3 paradas → peon 1.5 h, 3 paradas con estimados, llegada de la 1 = la fecha nueva',
      db.peon_estimado_horas === 1.5 && ps3.length === 3 && ps3.every((x) => x.peon_estimado_horas === 0.5 && x.llegada_estimada) &&
        ps3[0].llegada_estimada.getTime() === db.fecha_programada.getTime() &&
        cerca(db.duracion_estimada_horas, db.manejo_estimado_horas + 1.5) && r.data.estimado?.peon_horas === 1.5,
      `manejo=${db.manejo_estimado_horas?.toFixed(3)} peon=${db.peon_estimado_horas}`
    );
    const nuevaFecha = enMin(45);
    const soloFecha = await editar(P1, A, id, { fecha_programada: nuevaFecha });
    const ps3b = await paradasDb(id);
    paso(
      'CASO 10h: editar solo la fecha → mismas paradas, estimados corridos a la fecha nueva',
      soloFecha.status === 200 && ps3b.length === 3 && ps3b[0].id_parada === ps3[0].id_parada &&
        ps3b[0].llegada_estimada.toISOString() === nuevaFecha && ps3b[2].llegada_estimada > ps3[2].llegada_estimada,
      r2s(soloFecha).slice(0, 80)
    );
    const reconf = await confirmar(K1, id, v1a);
    paso('CASO 10e: el chofer vuelve a confirmar con un vehiculo que cumple las condiciones nuevas', reconf.status === 200, r2s(reconf));
    await okOFalla(iniciar(K1, id), 'iniciar');
    const enCurso = await editar(P1, A, id, { descripcion: 'x' });
    paso('CASO 10f: editar en curso → 400', enCurso.status === 400, r2s(enCurso));
    await cancelarPyme(P1, A, id);
  }

  // CASO 12 ------------------------------------------------------------------
  if (correr(12)) {
    titulo('CASO 12: vencimiento por chequeo perezoso');
    const a = await crearOk(P1, A, { id_conductor: K1.id_conductor });
    await moverFecha(a, haceMin(100));
    const det = await detallePyme(P2, A, a);
    paso('CASO 12a: lectura de la PyME → VENCIDO', det.status === 200 && det.data.estado === 'VENCIDO' && det.data.vencido === true, `${det.status} ${det.data.estado}`);
    paso('CASO 12b: historial VENCIDO por SISTEMA', (await historial(a)).join() === 'ASIGNADO:CLIENTE,VENCIDO:SISTEMA', (await historial(a)).join());
    ejemplo('detalle_pyme_vencido', det);
    paso('CASO 12c: viaje:vencido al chofer', await esperarEvento(sK1, 'viaje:vencido', a, 4000, (d) => d.estado === 'VENCIDO'), '');

    ejemplo('evento_viaje_vencido', eventoDe(sK1, 'viaje:vencido', a));
    const b = await crearOk(P1, A, { id_conductor: K1.id_conductor });
    await moverFecha(b, haceMin(100));
    const lista = await listaChofer(K1, '?grupo=historial');
    paso('CASO 12d: lista del chofer → VENCIDO', lista.data.find?.((v) => v.id_viaje === b)?.estado === 'VENCIDO', '');

    const c = await crearOk(P1, A, { id_conductor: K1.id_conductor });
    await okOFalla(confirmar(K1, c, v1a), 'confirmar');
    await moverFecha(c, haceMin(100));
    const canc = await cancelarChofer(K1, c);
    paso('CASO 12e: accion sobre un CONFIRMADO vencido → 400 y queda VENCIDO', canc.status === 400 && (await viajeDb(c)).estado === 'VENCIDO', r2s(canc));

    const d = await crearOk(P1, A, { id_conductor: K1.id_conductor });
    await moverFecha(d, haceMin(89));
    const det2 = await detallePyme(P1, A, d);
    paso('CASO 12f: dentro de la ventana todavia (89 min) → sigue ASIGNADO', det2.data.estado === 'ASIGNADO' && det2.data.vencido === false, det2.data.estado);
    await cancelarPyme(P1, A, d);
  }

  // CASO 13 ------------------------------------------------------------------
  if (correr(13)) {
    titulo('CASO 13: desvincular con viajes vivos');
    const asig1 = await crearOk(P1, A, { id_conductor: K5.id_conductor });
    const asig2 = await crearOk(P1, A, { id_conductor: K5.id_conductor });
    const conf = await crearOk(P1, A, { id_conductor: K5.id_conductor });
    await okOFalla(confirmar(K5, conf, ctx.v5), 'confirmar');
    const curso = await crearOk(P1, A, { id_conductor: K5.id_conductor });
    await okOFalla(confirmar(K5, curso, ctx.v5), 'confirmar');
    await okOFalla(iniciar(K5, curso), 'iniciar');
    await pingGps(ctx.sK5, curso, ORIGEN);
    const keysAntes = await keysGps(curso);
    const otraPyme = await crearOk(Q1, B, { id_conductor: K5.id_conductor });

    const r = await desvincular(P1, A, K5);
    const ids = [asig1, asig2, conf, curso];
    const dbs = await Promise.all(ids.map(viajeDb));
    paso(
      'CASO 13a: los 4 viajes (2 ASIGNADO, CONFIRMADO, en curso) → CANCELADO por DESVINCULACION',
      r.status === 200 && r.data.viajes_cancelados?.length === 4 && dbs.every((v) => v.estado === 'CANCELADO' && v.causa_cancelacion === 'DESVINCULACION'),
      `${r2s(r)} | ${dbs.map((v) => v.estado).join(',')}`
    );
    ejemplo('desvincular_200', r);
    paso('CASO 13b: Redis del viaje en curso limpio', keysAntes > 0 && (await keysGps(curso)) === 0, `antes=${keysAntes}`);
    const dbCurso = await viajeDb(curso);
    paso('CASO 13g: el viaje en curso guarda lo medido hasta la desvinculacion', dbCurso.peon_real_horas > 0 && dbCurso.manejo_real_horas === 0, `peon=${segs(dbCurso.peon_real_horas ?? 0)}`);
    const alChofer = await Promise.all(ids.map((id) => esperarEvento(ctx.sK5, 'viaje:cancelado', id, 4000, (d) => d.causa === 'DESVINCULACION')));
    const aPyme = await Promise.all(ids.map((id) => esperarEvento(sP1, 'viaje:cancelado', id, 4000, (d) => d.causa === 'DESVINCULACION')));
    paso('CASO 13c: viaje:cancelado al chofer y a la PyME por los 4', alChofer.every(Boolean) && aPyme.every(Boolean), `chofer=${alChofer} pyme=${aPyme}`);
    paso('CASO 13d: el viaje con la OTRA PyME queda intacto', (await viajeDb(otraPyme)).estado === 'ASIGNADO', '');
    paso('CASO 13e: historial CANCELADO con el origen del actor (la PyME)', (await historial(curso)).at(-1) === 'CANCELADO:CLIENTE', (await historial(curso)).join());
    // Desde el lado del chofer: mismo servicio, origen CONDUCTOR.
    const r2 = await api('DELETE', `/api/choferes/mis-organizaciones/${B}`, null, K5.token);
    const dbB = await viajeDb(otraPyme);
    paso(
      'CASO 13f: el chofer se desvincula de la otra PyME → su viaje CANCELADO (origen CONDUCTOR)',
      r2.status === 200 && dbB.estado === 'CANCELADO' && (await historial(otraPyme)).at(-1) === 'CANCELADO:CONDUCTOR',
      r2s(r2)
    );
  }

  // CASO 14 ------------------------------------------------------------------
  if (correr(14)) {
    titulo('CASO 14: aislamiento entre dos PyMEs que comparten chofer');
    const vA = await crearOk(P1, A, { id_conductor: K1.id_conductor });
    const vB = await crearOk(Q1, B, { id_conductor: K1.id_conductor });
    const cruzA = await detallePyme(P1, A, vB);
    const cruzB = await detallePyme(Q1, B, vA);
    ejemplo('detalle_pyme_404_otra_pyme', cruzA);
    paso('CASO 14a: detalle cruzado → 404 en los dos sentidos', cruzA.status === 404 && cruzB.status === 404, `${cruzA.status} ${cruzB.status}`);
    const noMiembro = await listaPyme(Q1, A);
    paso('CASO 14b: listar la PyME ajena → 403', noMiembro.status === 403, r2s(noMiembro));
    const lA = await listaPyme(P1, A);
    const lB = await listaPyme(Q1, B);
    paso(
      'CASO 14c: cada lista tiene solo lo suyo',
      lA.data.some((v) => v.id_viaje === vA) && !lA.data.some((v) => v.id_viaje === vB) && lB.data.some((v) => v.id_viaje === vB) && !lB.data.some((v) => v.id_viaje === vA),
      ''
    );
    const lK = await listaChofer(K1, '?grupo=asignados');
    ejemplo('lista_pyme', lA);
    const nombres = [lK.data.find((v) => v.id_viaje === vA)?.organizacion?.nombre, lK.data.find((v) => v.id_viaje === vB)?.organizacion?.nombre];
    paso('CASO 14d: el chofer ve los dos, cada uno con su PyME', nombres[0] && nombres[1] && nombres[0] !== nombres[1], nombres.join(' / '));
    await esperar(800);
    paso('CASO 14e: la sala de A no recibio el viaje de B (y viceversa)', !recibio(sP1, 'viaje:asignado', vB) && !recibio(sQ1, 'viaje:asignado', vA) && recibio(sQ1, 'viaje:asignado', vB), '');
    const legacy = await api('GET', `/api/viajes/${vA}`, null, P1.token);
    const legacyChofer = await api('GET', `/api/viajes/${vA}`, null, K1.token);
    paso('CASO 14f: la ruta vieja GET /api/viajes/:id → 403 al miembro (sin scoping por usuario), 200 al chofer', legacy.status === 403 && legacyChofer.status === 200, `${legacy.status} ${legacyChofer.status}`);
    const misViajes = await api('GET', '/api/viajes/mis-viajes', null, P1.token);
    paso('CASO 14g: mis-viajes (legacy) del creador no trae viajes de PyME', misViajes.status === 200 && !misViajes.data.some((v) => v.id_viaje === vA), r2s(misViajes).slice(0, 60));
    await cancelarPyme(P1, A, vA);
    await cancelarPyme(Q1, B, vB);
  }

  // CASO 15 ------------------------------------------------------------------
  if (correr(15)) {
    titulo('CASO 15: otro miembro de la misma PyME');
    const id = await crearOk(P2, A, { id_conductor: K2.id_conductor });
    const lista = await listaPyme(P1, A, '?grupo=activos');
    const det = await detallePyme(P1, A, id);
    paso(
      'CASO 15a: el responsable ve el viaje que creo el miembro, con su creador',
      lista.data.some((v) => v.id_viaje === id) && det.data.creador?.id_usuario === P2.id_usuario,
      `creador=${det.data.creador?.nombre}`
    );
    const canc = await cancelarPyme(P1, A, id);
    paso('CASO 15b: y lo puede cancelar', canc.status === 200, r2s(canc));
  }

  // CASO 16 ------------------------------------------------------------------
  if (correr(16)) {
    titulo('CASO 16: marketplace y calificaciones en false → 404');
    const rutas = [
      ['POST', '/api/viajes', P1],
      ['GET', '/api/viajes/disponibles', K1],
      ['POST', '/api/viajes/1/reservar', P1],
      ['POST', '/api/viajes/1/asignar', P1],
      ['POST', '/api/viajes/1/reasignar', P1],
      ['POST', '/api/viajes/1/cancelar-reserva', P1],
      ['GET', '/api/empresas/mias', P1],
      ['GET', '/api/afiliaciones/mias', K1],
      ['POST', '/api/auth/registro-gerente', null],
      ['POST', '/api/viajes/1/calificacion', P1],
    ];
    // GET sin body: fetch no acepta cuerpo en un GET.
    const rs = await Promise.all(rutas.map(([m, p, u]) => api(m, p, m === 'GET' ? null : {}, u?.token)));
    const malas = rutas
      .map(([m, p], i) => ({ ruta: `${m} ${p}`, status: rs[i].status }))
      .filter((x) => x.status !== 404)
      .map((x) => `${x.ruta}=${x.status}`);
    paso('CASO 16a: todas las rutas dormidas → 404', malas.length === 0, malas.join(' | ') || `${rutas.length} rutas`);
    const sinToken = await api('POST', '/api/viajes', {}, null);
    ejemplo('flag_404', sinToken);
    paso('CASO 16b: el 404 sale antes del token (sin token tambien 404)', sinToken.status === 404, r2s(sinToken));
    const antes = sK1.eventos.length;
    sK1.socket.emit('viaje:aceptar', { id_viaje: 1 });
    await esperar(700);
    const err = sK1.eventos.slice(antes).find((e) => e.ev === 'error');
    paso('CASO 16c: socket viaje:aceptar → error "Funcion no disponible"', err?.d?.mensaje === 'Funcion no disponible', JSON.stringify(err?.d));
    const health = await api('GET', '/health', null, null);
    ejemplo('health', health);
    paso('CASO 16d: /health anuncia la capacidad viaje-interno', health.data.capacidades?.includes('viaje-interno'), JSON.stringify(health.data.capacidades));
  }

  // CASO 18 ------------------------------------------------------------------
  if (correr(18)) {
    titulo('CASO 18: admin ve la organizacion del viaje');
    let tokenAdmin = null;
    try {
      tokenAdmin = await getToken('admin-test@fleter.com', 'admintest123');
    } catch (e) {
      paso('CASO 18: login admin (correr seed-cuentas-test.js)', false, e.message);
    }
    if (tokenAdmin) {
      const id = await crearOk(P1, A, { id_conductor: K2.id_conductor });
      const det = await api('GET', `/api/admin/viajes/${id}`, null, tokenAdmin);
      const lista = await api('GET', '/api/admin/viajes?estado=ASIGNADO&limit=200', null, tokenAdmin);
      paso(
        'CASO 18a: detalle y lista del admin con organizacion; filtro por estado nuevo',
        det.data.organizacion?.id_organizacion === A && lista.status === 200 && lista.data.viajes.find((v) => v.id_viaje === id)?.organizacion?.id_organizacion === A,
        `${det.status} ${lista.status}`
      );
      const enLista = lista.data.viajes.find((v) => v.id_viaje === id);
      paso(
        'CASO 18d: admin detalle y lista con el bloque estimado; paradas con minutos',
        det.data.estimado?.peon_horas === 1 && det.data.real === null && enLista?.estimado?.peon_horas === 1 &&
          det.data.paradas?.[1]?.manejo_estimado_min !== undefined,
        JSON.stringify(det.data.estimado)
      );
      ejemplo('admin_detalle_organizacion', { status: det.status, body: { id_viaje: det.data.id_viaje, organizacion: det.data.organizacion, creador: det.data.creador, causa_cancelacion: det.data.causa_cancelacion } });
      const canc = await api('POST', `/api/admin/viajes/${id}/cancelar`, { motivo: 'admin' }, tokenAdmin);
      const db = await viajeDb(id);
      paso(
        'CASO 18b: el admin cancela → causa ADMIN y viaje:cancelado al chofer',
        canc.status === 200 && db.causa_cancelacion === 'ADMIN' && (await esperarEvento(sK2, 'viaje:cancelado', id, 4000, (d) => d.causa === 'ADMIN')),
        r2s(canc)
      );
      const est = await api('GET', '/api/admin/estadisticas', null, tokenAdmin);
      paso('CASO 18c: estadisticas cuenta los estados nuevos', est.status === 200 && 'VENCIDO' in est.data.viajes.por_estado, '');
    }
  }

  if (correr(19)) await casoCicloPorParada(ctx);
  if (correr(20)) await casoCancelarEnCurso(ctx);
}

// CASO 19: viaje de 4 paradas de punta a punta, con esperas controladas.
async function casoCicloPorParada(ctx) {
  const { P1, K1, A, v1a, sP1 } = ctx;
  titulo('CASO 19: ciclo por parada — 4 paradas de punta a punta');
  const PARADAS = [ORIGEN, INTERMEDIA, TERCERA, DESTINO];
  const id = await crearOk(P1, A, { id_conductor: K1.id_conductor, paradas: PARADAS });
  await okOFalla(confirmar(K1, id, v1a), 'confirmar');
  const ps = await paradasDb(id);
  const conf = (n) => confirmarParada(K1, id, ps[n - 1].id_parada, PARADAS[n - 1]);

  // Cada accion se cronometra del lado del cliente. El server efimero corre en
  // ESTA maquina (mismo reloj): el instante que guarda tiene que caer dentro de
  // la ventana [envio, respuesta] de su propio pedido.
  const ventanas = {};
  const medir = async (clave, promesa) => {
    const desde = Date.now();
    const r = await promesa();
    ventanas[clave] = [desde, Date.now()];
    if (r.status !== 200) throw new Error(`${clave} fallo: ${r2s(r)}`);
    return r;
  };

  await medir('llega1', () => iniciar(K1, id));
  await esperar(1500);
  await medir('sale1', () => salir(K1, id));
  const desordenada = await conf(3);
  ejemplo('confirmar_parada_400_orden', desordenada);
  paso('CASO 19a: confirmar la parada 3 sin haber pasado por la 2 → 400', desordenada.status === 400 && /parada 2/.test(desordenada.data.error), r2s(desordenada));
  await esperar(2000);
  await medir('llega2', () => conf(2));
  const enParada = await conf(3);
  ejemplo('confirmar_parada_400_en_parada', enParada);
  paso('CASO 19b: confirmar la siguiente sin salir de la actual → 400', enParada.status === 400 && /Salir/.test(enParada.data.error), r2s(enParada));
  await medir('sale2', () => salir(K1, id));
  const otraVez = await salir(K1, id);
  paso('CASO 19c: salir manejando (EN_RUTA, sin parada abierta) → 400', otraVez.status === 400 && /ninguna parada/.test(otraVez.data.error), r2s(otraVez));
  await esperar(1200);
  await medir('llega3', () => conf(3));
  await esperar(1000);
  await medir('sale3', () => salir(K1, id));
  await esperar(800);
  const ultima = await medir('llega4', () => conf(4));
  paso('CASO 19d: confirmar la ultima → DESCARGANDO, no finaliza', ultima.data.viaje_finalizado === false && ultima.data.estado === 'DESCARGANDO', r2s(ultima));
  await esperar(1000);
  const fin = await medir('sale4', () => salir(K1, id));
  paso('CASO 19e: salir de la ultima → FINALIZADO', fin.data.estado === 'FINALIZADO', r2s(fin));

  const db = await viajeDb(id);
  const pf = await paradasDb(id);
  const h = await filasHistorial(id);

  // Exactos contra los timestamps de las paradas.
  let okParadas = pf.every((p) => p.llegada_real && p.salida_real && cerca(p.peon_real_horas, horasEntre(p.llegada_real, p.salida_real)));
  for (let i = 1; i < 4; i++) okParadas &&= cerca(pf[i].manejo_real_horas, horasEntre(pf[i - 1].salida_real, pf[i].llegada_real));
  okParadas &&= pf[0].manejo_real_horas === null;
  paso(
    'CASO 19f: peon por parada = salida - llegada y manejo por tramo = llegada - salida anterior (exactos)',
    okParadas,
    pf.map((p) => `${p.orden}:peon=${segs(p.peon_real_horas)}/manejo=${p.manejo_real_horas === null ? '-' : segs(p.manejo_real_horas)}`).join(' ')
  );
  const sumaPeon = pf.reduce((a, p) => a + p.peon_real_horas, 0);
  const sumaManejo = pf.slice(1).reduce((a, p) => a + p.manejo_real_horas, 0);
  paso(
    'CASO 19g: totales del viaje = sumas; total = llegada a la 1 -> salida de la 4',
    cerca(db.peon_real_horas, sumaPeon) && cerca(db.manejo_real_horas, sumaManejo) &&
      cerca(db.peon_real_horas + db.manejo_real_horas, horasEntre(pf[0].llegada_real, pf[3].salida_real)),
    `manejo=${segs(db.manejo_real_horas)} peon=${segs(db.peon_real_horas)}`
  );

  // Contra el historial: CARGANDO, EN_RUTA, DESCARGANDO, ... FINALIZADO. Cada
  // llegada / salida coincide con su fila (±1 s; el ciclo pasa el mismo
  // instante, asi que en la practica la diferencia es 0).
  const esperados = ['ASIGNADO', 'CONFIRMADO', 'CARGANDO', 'EN_RUTA', 'DESCARGANDO', 'EN_RUTA', 'DESCARGANDO', 'EN_RUTA', 'DESCARGANDO', 'FINALIZADO'];
  const enCurso = h.slice(2).map((x) => x.fecha);
  const marcas = pf.flatMap((p) => [p.llegada_real, p.salida_real]);
  const difs = marcas.map((m, i) => Math.abs(m.getTime() - (enCurso[i]?.getTime() ?? 0)));
  paso(
    'CASO 19h: historial completo y cada llegada / salida coincide con su fila (±1 s)',
    h.map((x) => x.estado).join() === esperados.join() && difs.every((d) => d <= 1000),
    `${h.map((x) => x.estado).join(',')} | max dif ${Math.max(...difs)}ms`
  );
  // Tiempos controlados: cada instante guardado cae en la ventana de su pedido,
  // y cada intervalo medido es >= la espera que hizo el test entre los dos.
  const claves = ['llega1', 'sale1', 'llega2', 'sale2', 'llega3', 'sale3', 'llega4', 'sale4'];
  const dentro = claves.every((c, i) => marcas[i].getTime() >= ventanas[c][0] && marcas[i].getTime() <= ventanas[c][1]);
  const esperas = { 0: 1.5, 1: 2, 3: 1.2, 4: 1, 5: 0.8, 6: 1 }; // intervalo i = marcas[i] -> marcas[i+1]
  const cumplen = Object.entries(esperas).every(([i, e]) => (marcas[+i + 1] - marcas[+i]) / 1000 >= e);
  paso(
    'CASO 19i: cada llegada / salida cae dentro de la ventana de su pedido y los intervalos cubren las esperas',
    dentro && cumplen,
    marcas.slice(1).map((m, i) => ((m - marcas[i]) / 1000).toFixed(2)).join(' ')
  );
  const det = await detallePyme(P1, A, id);
  ejemplo('detalle_pyme_4_paradas', det);
  paso(
    'CASO 19j: el detalle trae real con los totales y duracion_real = real.total en minutos',
    det.data.real && cerca(det.data.real.total_horas, db.manejo_real_horas + db.peon_real_horas) &&
      det.data.duracion_real === Math.round(det.data.real.total_horas * 60) &&
      det.data.paradas.every((p) => p.llegada_real && p.diferencia_min !== null),
    JSON.stringify(det.data.real)
  );
  paso('CASO 19k: la PyME recibio estado_cambiado por cada llegada y salida', sP1.eventos.filter((e) => e.ev === 'viaje:estado_cambiado' && e.d?.id_viaje === id).length >= 7, '');
}

// CASO 20: cancelar en curso guarda lo medido.
async function casoCancelarEnCurso(ctx) {
  const { P1, K1, A, v1a } = ctx;
  titulo('CASO 20: cancelar en curso guarda lo parcial');

  // Manejando: salio del origen y no llego al destino.
  const a = await crearOk(P1, A, { id_conductor: K1.id_conductor });
  await okOFalla(confirmar(K1, a, v1a), 'confirmar');
  await okOFalla(iniciar(K1, a), 'iniciar');
  await esperar(1000);
  await okOFalla(salir(K1, a), 'salir');
  await esperar(1500);
  // El fin de lo medido es el instante de la cancelacion: tiene que caer en la
  // ventana [envio, respuesta] del pedido (mismo reloj: server local).
  const desdeA = Date.now();
  await okOFalla(cancelarPyme(P1, A, a), 'cancelar');
  const hastaA = Date.now();
  const dbA = await viajeDb(a);
  const [oa, da] = await paradasDb(a);
  const hA = await filasHistorial(a);
  const cancA = hA.find((x) => x.estado === 'CANCELADO').fecha;
  const finA = oa.salida_real.getTime() + dbA.manejo_real_horas * HORA;
  paso(
    'CASO 20a: cancelado manejando → peon del origen + manejo parcial hasta la cancelacion',
    cerca(dbA.peon_real_horas, oa.peon_real_horas) && da.llegada_real === null && da.manejo_real_horas === null &&
      finA >= desdeA && finA <= hastaA && Math.abs(finA - cancA.getTime()) <= 1000 && dbA.manejo_real_horas * 3600 >= 1.5,
    `peon=${segs(dbA.peon_real_horas)} manejo=${segs(dbA.manejo_real_horas)} (fin dentro de la ventana del cancelar: ${finA >= desdeA && finA <= hastaA})`
  );
  const detA = await detallePyme(P1, A, a);
  ejemplo('detalle_pyme_cancelado_en_curso', detA);
  paso('CASO 20b: el detalle de un CANCELADO en curso trae real con lo medido', detA.data.real && detA.data.real.manejo_horas === dbA.manejo_real_horas, JSON.stringify(detA.data.real));

  // En una parada: llego al destino y no salio.
  const b = await crearOk(P1, A, { id_conductor: K1.id_conductor });
  await okOFalla(confirmar(K1, b, v1a), 'confirmar');
  await okOFalla(iniciar(K1, b), 'iniciar');
  await okOFalla(salir(K1, b), 'salir');
  const pb = await paradasDb(b);
  await okOFalla(confirmarParada(K1, b, pb[1].id_parada, DESTINO), 'confirmar destino');
  await esperar(1500);
  const desdeB = Date.now();
  await okOFalla(cancelarPyme(P1, A, b), 'cancelar');
  const hastaB = Date.now();
  const dbB = await viajeDb(b);
  const [, db2] = await paradasDb(b);
  const finB = db2.llegada_real.getTime() + db2.peon_real_horas * HORA;
  paso(
    'CASO 20c: cancelado EN una parada → la parada abierta se cierra en la cancelacion (sin salida_real)',
    db2.salida_real === null && db2.peon_real_horas * 3600 >= 1.5 && finB >= desdeB && finB <= hastaB &&
      db2.manejo_real_horas > 0 && cerca(dbB.manejo_real_horas, db2.manejo_real_horas),
    `peon destino=${segs(db2.peon_real_horas ?? 0)} manejo=${segs(dbB.manejo_real_horas ?? 0)}`
  );
}

// CASO 11: vencimiento por TIMER, en un server propio con ventana de 3 s.
async function casoTimer(ctx) {
  titulo('CASO 11: vencimiento por timer (server 3602, VENTANA_INICIO_DESPUES_MINUTOS=0.05)');
  const { P1, K1, A, v1a } = ctx;
  await conServer({ ...ENV_BASE, VENTANA_INICIO_DESPUES_MINUTOS: '0.05' }, PUERTO_TIMER, async (base, leerLog) => {
    const sP = await espia(base, P1.token);
    const sK = await espia(base, K1.token);
    await esperar(1000);
    const fecha = new Date(Date.now() + 8000).toISOString();
    const mk = async () => {
      const r = await api('POST', `/api/organizaciones/${A}/viajes`, { id_conductor: K1.id_conductor, fecha_programada: fecha, paradas: [ORIGEN, DESTINO] }, P1.token, base);
      if (r.status !== 201) throw new Error(`crear (timer) fallo: ${r2s(r)}`);
      viajesCreados.add(r.data.id_viaje);
      return r.data.id_viaje;
    };
    const asig = await mk();
    const conf = await mk();
    const rc = await confirmar(K1, conf, v1a, base);
    if (rc.status !== 200) throw new Error(`confirmar (timer) fallo: ${r2s(rc)}`);
    // fecha + 3 s de ventana + margen. Sin NINGUNA lectura por API en el medio:
    // se lee directo de la DB, asi que no puede ser el chequeo perezoso.
    await esperar(8000 + 3000 + 3000);
    const [dbA, dbC] = await Promise.all([viajeDb(asig), viajeDb(conf)]);
    paso('CASO 11a: ASIGNADO y CONFIRMADO → VENCIDO por el timer', dbA.estado === 'VENCIDO' && dbC.estado === 'VENCIDO', `${dbA.estado} ${dbC.estado}`);
    paso('CASO 11b: historial VENCIDO por SISTEMA', (await historial(conf)).join() === 'ASIGNADO:CLIENTE,CONFIRMADO:CONDUCTOR,VENCIDO:SISTEMA', (await historial(conf)).join());
    const evChofer = (await esperarEvento(sK, 'viaje:vencido', asig)) && (await esperarEvento(sK, 'viaje:vencido', conf));
    const evPyme = (await esperarEvento(sP, 'viaje:vencido', asig)) && (await esperarEvento(sP, 'viaje:vencido', conf, 4000, (d) => d.estado_anterior === 'CONFIRMADO'));
    paso('CASO 11c: viaje:vencido al chofer y a la PyME', evChofer && evPyme, `chofer=${evChofer} pyme=${evPyme}`);
    sP.socket.disconnect();
    sK.socket.disconnect();
    sumarLlamadasMaps(leerLog());
  });
}

// CASO 17: concurrencia.
async function casosConcurrencia(ctx) {
  if (!correr(17)) return;
  const { P1, K1, K2, A, v1a, v2, K6 } = ctx;
  const fila = (h, estado) => h.filter((x) => x.startsWith(estado + ':')).length;

  if (corre17('17a')) titulo('CASO 17a: confirmar vs cancelar (PyME)');
  if (corre17('17a')) {
    let ok = true;
    const det = [];
    for (let r = 0; r < RONDAS; r++) {
      const id = await crearOk(P1, A, { id_conductor: K2.id_conductor });
      const [conf, canc] = await Promise.all([confirmar(K2, id, v2), cancelarPyme(P1, A, id)]);
      const db = await viajeDb(id);
      const h = await historial(id);
      const coherente = db.estado === 'CANCELADO' && canc.status === 200 && fila(h, 'CANCELADO') === 1 &&
        (conf.status === 200 ? h.join() === 'ASIGNADO:CLIENTE,CONFIRMADO:CONDUCTOR,CANCELADO:CLIENTE' : fila(h, 'CONFIRMADO') === 0);
      ok &&= coherente;
      det.push(`r${r + 1}:${conf.status}/${canc.status}/${db.estado}`);
    }
    paso('CASO 17a: siempre termina CANCELADO; si confirmo, el historial lo muestra antes', ok, det.join(' '));
  }

  if (corre17('17b')) titulo('CASO 17b: confirmar vs vencer');
  if (corre17('17b')) {
    let ok = true;
    const det = [];
    for (let r = 0; r < RONDAS; r++) {
      const id = await crearOk(P1, A, { id_conductor: K2.id_conductor });
      // La ventana cerro hace instantes; el timer del server sigue armado para
      // la fecha original (lejana): solo el chequeo perezoso o el guard de tiempo
      // del confirmar lo pueden frenar.
      await moverFecha(id, haceMin(90.1));
      // El confirmar sale primero y la lectura perezosa con un desfasaje distinto
      // por ronda: en las primeras compiten, en las ultimas el confirmar actua
      // solo sobre un viaje ya vencido (ahi lo frena su propio guard de fecha).
      const desfasaje = r * 150;
      const [conf, lectura] = await Promise.all([
        confirmar(K2, id, v2),
        esperar(desfasaje).then(() => detallePyme(P1, A, id)),
      ]);
      const db = await viajeDb(id);
      const h = await historial(id);
      const coherente = conf.status !== 200 && db.estado === 'VENCIDO' && fila(h, 'VENCIDO') === 1 && fila(h, 'CONFIRMADO') === 0;
      ok &&= coherente;
      det.push(`r${r + 1}(+${desfasaje}ms):${conf.status}/${lectura.status}/${db.estado}/venc=${fila(h, 'VENCIDO')}`);
    }
    paso('CASO 17b: nunca se confirma un viaje vencido; una sola fila VENCIDO', ok, det.join(' '));
  }

  if (corre17('17c')) titulo('CASO 17c: doble confirmar');
  if (corre17('17c')) {
    let ok = true;
    const det = [];
    for (let r = 0; r < RONDAS; r++) {
      const id = await crearOk(P1, A, { id_conductor: K1.id_conductor });
      const rs = await Promise.all([confirmar(K1, id, v1a), confirmar(K1, id, v1a)]);
      const h = await historial(id);
      const ganadores = rs.filter((x) => x.status === 200).length;
      ok &&= ganadores === 1 && fila(h, 'CONFIRMADO') === 1;
      det.push(`r${r + 1}:${statuses(rs)}/filas=${fila(h, 'CONFIRMADO')}`);
      await cancelarPyme(P1, A, id);
    }
    paso('CASO 17c: un solo ganador y una sola fila CONFIRMADO', ok, det.join(' '));
  }

  if (corre17('17d')) titulo('CASO 17d: reasignar vs confirmar');
  if (corre17('17d')) {
    let ok = true;
    const det = [];
    for (let r = 0; r < RONDAS; r++) {
      const id = await crearOk(P1, A, { id_conductor: K1.id_conductor });
      // El reasignar sale primero y el confirmar con un desfasaje distinto por
      // ronda: asi se intercalan los dos ordenes (confirmar lee antes del commit
      // de la reasignacion y escribe despues). Sin desfasaje el confirmar, mas
      // corto, gana siempre y el guard del chofer nunca se ejercita.
      const desfasaje = r * 150;
      const [reas, conf] = await Promise.all([
        reasignar(P1, A, id, K2.id_conductor),
        esperar(desfasaje).then(() => confirmar(K1, id, v1a)),
      ]);
      const db = await viajeDb(id);
      const coherente = reas.status === 200 && db.estado === 'ASIGNADO' && db.id_conductor === K2.id_conductor && db.id_vehiculo === null;
      ok &&= coherente;
      det.push(`r${r + 1}(+${desfasaje}ms):${conf.status}/${reas.status}/${db.estado}/k=${db.id_conductor === K2.id_conductor ? 'nuevo' : 'viejo'}/veh=${db.id_vehiculo}`);
      await cancelarPyme(P1, A, id);
    }
    paso('CASO 17d: termina ASIGNADO al chofer nuevo sin vehiculo (nunca CONFIRMADO con el vehiculo del viejo)', ok, det.join(' '));
  }

  if (corre17('17e')) titulo('CASO 17e: iniciar vs cancelar');
  if (corre17('17e')) {
    let ok = true;
    const det = [];
    for (let r = 0; r < RONDAS; r++) {
      const id = await crearOk(P1, A, { id_conductor: K1.id_conductor });
      await okOFalla(confirmar(K1, id, v1a), 'confirmar');
      const [ini, canc] = await Promise.all([iniciar(K1, id), cancelarChofer(K1, id)]);
      const db = await viajeDb(id);
      const ganadores = [ini, canc].filter((x) => x.status === 200).length;
      const coherente = ganadores === 1 && db.estado === (ini.status === 200 ? 'CARGANDO' : 'CANCELADO');
      ok &&= coherente;
      det.push(`r${r + 1}:${ini.status}/${canc.status}/${db.estado}`);
      if (db.estado !== 'CANCELADO') await cancelarPyme(P1, A, id);
    }
    paso('CASO 17e: chofer — iniciar y cancelar son excluyentes', ok, det.join(' '));

    let ok2 = true;
    const det2 = [];
    for (let r = 0; r < RONDAS; r++) {
      const id = await crearOk(P1, A, { id_conductor: K1.id_conductor });
      await okOFalla(confirmar(K1, id, v1a), 'confirmar');
      const [ini, canc] = await Promise.all([iniciar(K1, id), cancelarPyme(P1, A, id)]);
      const db = await viajeDb(id);
      const h = await historial(id);
      const coherente = canc.status === 200 && db.estado === 'CANCELADO' && fila(h, 'CANCELADO') === 1 &&
        (ini.status === 200 ? h.at(-2) === 'CARGANDO:CONDUCTOR' : fila(h, 'CARGANDO') === 0);
      ok2 &&= coherente;
      det2.push(`r${r + 1}:${ini.status}/${canc.status}/${db.estado}`);
    }
    paso('CASO 17e: PyME — siempre termina CANCELADO, coherente con el historial', ok2, det2.join(' '));
  }

  if (corre17('17f')) titulo('CASO 17f: desvincular vs iniciar');
  if (corre17('17f')) {
    let ok = true;
    const det = [];
    for (let r = 0; r < RONDAS; r++) {
      await vincular(P1, A, K6);
      const id = await crearOk(P1, A, { id_conductor: K6.id_conductor });
      await okOFalla(confirmar(K6, id, ctx.v6), 'confirmar');
      const [ini, des] = await Promise.all([iniciar(K6, id), desvincular(P1, A, K6)]);
      const db = await viajeDb(id);
      const h = await historial(id);
      const vivos = await prisma.viaje.count({
        where: { id_organizacion: A, id_conductor: K6.id_conductor, estado: { notIn: ['FINALIZADO', 'CANCELADO', 'RECHAZADO', 'VENCIDO'] } },
      });
      const coherente = des.status === 200 && db.estado === 'CANCELADO' && db.causa_cancelacion === 'DESVINCULACION' && vivos === 0 &&
        (ini.status === 200 ? h.at(-2) === 'CARGANDO:CONDUCTOR' : fila(h, 'CARGANDO') === 0);
      ok &&= coherente;
      det.push(`r${r + 1}:${ini.status}/${des.status}/${db.estado}`);
    }
    paso('CASO 17f: siempre termina CANCELADO por DESVINCULACION, sin viajes vivos', ok, det.join(' '));
  }

  if (corre17('17g')) titulo('CASO 17g: crear vs desvincular');
  if (corre17('17g')) {
    const { K7 } = ctx;
    let ok = true;
    const det = [];
    for (let r = 0; r < RONDAS; r++) {
      await vincular(P1, A, K7);
      // La desvinculacion sale con un desfasaje distinto por ronda para caer
      // entre la validacion previa del crear y su transaccion.
      const desfasaje = r * 100;
      const [cre, des] = await Promise.all([
        crear(P1, A, { id_conductor: K7.id_conductor }),
        esperar(desfasaje).then(() => desvincular(P1, A, K7)),
      ]);
      const vivos = await prisma.viaje.count({
        where: { id_organizacion: A, id_conductor: K7.id_conductor, estado: { notIn: ['FINALIZADO', 'CANCELADO', 'RECHAZADO', 'VENCIDO'] } },
      });
      ok &&= des.status === 200 && vivos === 0 && [201, 400].includes(cre.status);
      det.push(`r${r + 1}(+${desfasaje}ms):crear=${cre.status}/desv=${des.status}/vivos=${vivos}`);
    }
    paso('CASO 17g: nunca queda un viaje vivo con un chofer desvinculado', ok, det.join(' '));
  }

  // Un viaje de 2 paradas ya iniciado (CARGANDO, en la parada 1).
  const iniciado = async () => {
    const id = await crearOk(P1, A, { id_conductor: K1.id_conductor });
    await okOFalla(confirmar(K1, id, v1a), 'confirmar');
    await okOFalla(iniciar(K1, id), 'iniciar');
    return id;
  };

  if (corre17('17h')) titulo('CASO 17h: doble salir');
  if (corre17('17h')) {
    let ok = true;
    const det = [];
    for (let r = 0; r < RONDAS; r++) {
      const id = await iniciado();
      // Rondas pares: doble salir del origen; impares: doble salir de la ultima.
      const deLaUltima = r % 2 === 1;
      if (deLaUltima) {
        await okOFalla(salir(K1, id), 'salir');
        const ps = await paradasDb(id);
        await okOFalla(confirmarParada(K1, id, ps[1].id_parada, DESTINO), 'confirmar destino');
      }
      const rs = await Promise.all([salir(K1, id), salir(K1, id)]);
      const db = await viajeDb(id);
      const h = await historial(id);
      const destino = deLaUltima ? 'FINALIZADO' : 'EN_RUTA';
      const ganadores = rs.filter((x) => x.status === 200).length;
      ok &&= ganadores === 1 && db.estado === destino && fila(h, destino) === 1;
      det.push(`r${r + 1}(${deLaUltima ? 'ultima' : 'origen'}):${statuses(rs)}/${db.estado}/filas=${fila(h, destino)}`);
      if (!deLaUltima) await cancelarPyme(P1, A, id);
    }
    paso('CASO 17h: un solo ganador y una sola fila (EN_RUTA o FINALIZADO)', ok, det.join(' '));
  }

  if (corre17('17i')) titulo('CASO 17i: salir vs cancelar (PyME)');
  if (corre17('17i')) {
    let ok = true;
    const det = [];
    for (let r = 0; r < RONDAS; r++) {
      const id = await iniciado();
      const [sal, canc] = await Promise.all([salir(K1, id), cancelarPyme(P1, A, id)]);
      const db = await viajeDb(id);
      const h = await historial(id);
      const [o] = await paradasDb(id);
      const coherente = canc.status === 200 && db.estado === 'CANCELADO' && fila(h, 'CANCELADO') === 1 &&
        (sal.status === 200 ? h.at(-2) === 'EN_RUTA:CONDUCTOR' && o.salida_real !== null : fila(h, 'EN_RUTA') === 0 && o.salida_real === null);
      ok &&= coherente;
      det.push(`r${r + 1}:${sal.status}/${canc.status}/${db.estado}`);
    }
    paso('CASO 17i: siempre termina CANCELADO; la salida existe solo si el salir gano', ok, det.join(' '));
  }

  if (corre17('17j')) titulo('CASO 17j: confirmar parada vs cancelar (PyME)');
  if (corre17('17j')) {
    let ok = true;
    const det = [];
    for (let r = 0; r < RONDAS; r++) {
      const id = await iniciado();
      await okOFalla(salir(K1, id), 'salir');
      const ps = await paradasDb(id);
      const [conf, canc] = await Promise.all([
        confirmarParada(K1, id, ps[1].id_parada, DESTINO),
        cancelarPyme(P1, A, id),
      ]);
      const db = await viajeDb(id);
      const h = await historial(id);
      const [, d] = await paradasDb(id);
      const coherente = canc.status === 200 && db.estado === 'CANCELADO' && fila(h, 'CANCELADO') === 1 &&
        (conf.status === 200 ? h.at(-2) === 'DESCARGANDO:CONDUCTOR' && d.llegada_real !== null : fila(h, 'DESCARGANDO') === 0 && d.llegada_real === null);
      ok &&= coherente;
      det.push(`r${r + 1}:${conf.status}/${canc.status}/${db.estado}`);
    }
    paso('CASO 17j: siempre termina CANCELADO; la llegada existe solo si el confirmar gano', ok, det.join(' '));
  }
}

// -- Main ---------------------------------------------------------------------

// node scripts/test-viaje-interno.js --restos
// Borra lo que haya dejado cualquier corrida anterior cortada a la mitad: todo
// usuario *-vin-*@test.com y lo que cuelga de el (viajes, PyMEs, vinculos...).
async function limpiarRestos() {
  const usuarios = await prisma.usuario.findMany({
    where: { email: { contains: '-vin-', endsWith: '@test.com' } },
    select: { email: true },
  });
  console.log(`\n  restos: ${usuarios.length} usuarios de corridas anteriores`);
  return limpiar(usuarios.map((u) => u.email), '-vin-');
}

// Llamadas a Google por SKU: el ultimo contador que loguea cada server efimero
// ("[maps] ... (PRO=12 ESSENTIALS=3)").
const llamadasMaps = {};
function sumarLlamadasMaps(log) {
  const ultimos = [...log.matchAll(/\[maps\][^\n]*\(([A-Z]+=\d+(?: [A-Z]+=\d+)*)\)/g)].at(-1);
  if (!ultimos) return;
  for (const par of ultimos[1].split(' ')) {
    const [sku, n] = par.split('=');
    llamadasMaps[sku] = (llamadasMaps[sku] ?? 0) + Number(n);
  }
}

async function main() {
  if (process.argv.includes('--restos')) return limpiarRestos();
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   TEST VIAJE INTERNO (PASOS 2 y 3) — FLETER  ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  if (SOLO.length > 0) console.log(`  (solo los casos ${SOLO.join(', ')})\n`);
  if (!process.env.INVITACION_SECRETO) throw new Error('Falta INVITACION_SECRETO en el .env local');

  let limpio = false;
  try {
    await conServer(ENV_BASE, PUERTO, async (base, leerLog) => {
      BASE = base;
      titulo('SETUP');
      const [P1, P2, Q1] = await nuevosUsuarios('cliente', 'Pym', 3);
      const [K1, K2, K3, K4, K5, K6, K7] = await nuevosUsuarios('conductor', 'Cho', 7);
      const A = await crearOrgOk(P1, `PyME A ${S}`, cuitValido(1));
      const B = await crearOrgOk(Q1, `PyME B ${S}`, cuitValido(2));
      await canjearOk(P2, (await invitarOk(P1, A, 'MIEMBRO')).codigo);
      const v1a = await vehiculoOk(K1, ['FRAGIL', 'REFRIGERADO']);
      const v1b = await vehiculoOk(K1, []);
      const v2 = await vehiculoOk(K2, ['FRAGIL']);
      await vehiculoOk(K3, ['FRAGIL']);
      await vehiculoOk(K4, []);
      const v5 = await vehiculoOk(K5, ['FRAGIL']);
      const v6 = await vehiculoOk(K6, ['FRAGIL']);
      await vehiculoOk(K7, ['FRAGIL']);
      for (const k of [K1, K2, K4, K5]) await vincular(P1, A, k);
      for (const k of [K1, K5]) await vincular(Q1, B, k);
      // Sockets DESPUES del setup: al conectarse, el CLIENTE entra a la sala de
      // cada PyME donde es miembro activo.
      const [sP1, sP2, sQ1, sK1, sK2, sK5] = await Promise.all(
        [P1, P2, Q1, K1, K2, K5].map((u) => espia(base, u.token))
      );
      await esperar(1000);
      console.log(`  ${nUsuario} usuarios, PyMEs ${A} y ${B}, sockets conectados`);
      const ctx = { P1, P2, Q1, K1, K2, K3, K4, K5, K6, K7, A, B, v1a, v1b, v2, v5, v6, sP1, sP2, sQ1, sK1, sK2, sK5 };
      await casosPrincipales(ctx);
      await casosConcurrencia(ctx);
      sumarLlamadasMaps(leerLog());
      if (correr(11)) await casoTimer(ctx);
    });
  } finally {
    try {
      limpio = await limpiar();
    } catch (e) {
      console.error('  ⚠️  la limpieza fallo:', e.message);
    }
  }
  paso('LIMPIEZA: no quedo nada de lo creado por el test', limpio, '');
  if (process.env.EJEMPLOS_JSON) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.EJEMPLOS_JSON, JSON.stringify(EJEMPLOS, null, 2));
    console.log(`  ejemplos JSON: ${Object.keys(EJEMPLOS).length} en ${process.env.EJEMPLOS_JSON}`);
  }

  const ok = pasos.filter((p) => p.ok).length;
  const fallaron = pasos.filter((p) => !p.ok);
  console.log(`\n  llamadas a Google (por SKU): ${JSON.stringify(llamadasMaps)}`);
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║                  RESUMEN                     ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`  ${ok}/${pasos.length} checks pasaron`);
  if (fallaron.length > 0) {
    console.log('\n  Fallaron:');
    fallaron.forEach((p) => console.log(`    ❌ ${p.nombre}${p.detalle ? ': ' + p.detalle : ''}`));
  }
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
    try {
      await limpiar();
    } catch {
      /* ya se intento */
    }
    await prisma.$disconnect().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(1);
  });
