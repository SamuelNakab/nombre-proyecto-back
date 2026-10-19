// Test de LUGARES GUARDADOS y SERIES de viajes (Paso 4).
//
// NO pega contra :3000: levanta servers efimeros propios (_server-efimero.js).
//   - 3801: el principal. ANTICIPACION 60 (para que haya ocurrencias salteadas),
//     ventana de inicio 120/90 (para poder iniciar ya un viaje programado a
//     65 min), marketplace y calificaciones en false, peon 30, tope de 10
//     paradas. USA GOOGLE DE VERDAD: cada viaje creado gasta (paradas - 1)
//     llamadas Pro; el total, y el de cada tipo de serie, sale al final.
//   - 3802: GOOGLE_MAPS_API_KEY invalida, para el todo o nada (503 y nada escrito).
// Los dos con RESERVA_BARRIDO_ARRANQUE=0 y VENCIMIENTO_BARRIDO_ARRANQUE=0 (la DB
// esta compartida con produccion).
//
// Casos:
//   1. Crear y listar lugares.
//   2. Nombre duplicado (otras mayusculas / espacios) -> 400; el mismo nombre en
//      OTRA PyME vale.
//   3. Editar: renombrar, nombre de otro activo -> 400, el propio con otras
//      mayusculas -> 200.
//   4. Borrar (soft): sale de la lista, activo false en la DB, el nombre se
//      puede reusar, borrar / editar uno borrado -> 404.
//   5. Viaje con lugar -> snapshot (direccion y coordenadas copiadas, id_lugar)
//      y la PyME ve el nombre.
//   6. Editar el lugar despues NO cambia el viaje (la PyME ve el nombre nuevo).
//   7. Lugar borrado, de otra PyME, o lugar + coordenadas -> 400.
//   8. El chofer no recibe el nombre: REST (lista, detalle, GET /api/viajes/:id),
//      sockets (viaje:asignado, viaje:editado, viaje:finalizado) y el remito PDF
//      (ciclo completo, texto del PDF descomprimido).
//   9. Aislamiento de lugares entre PyMEs.
//  10. PyME SUSPENDIDA: crear / editar lugar y crear serie -> 403; borrar lugar y
//      cancelar serie siguen permitidos.
//  11. Tope de paradas (MAX_PARADAS_POR_VIAJE=10): 11 -> 400 en viaje y serie.
//  12. Serie DIARIA de 30 viajes: fechas exactas en hora AR, ASIGNADO, id_serie,
//      historial, UN serie:asignada al chofer y a la PyME (y ningun
//      viaje:asignado), tiempo de creacion.
//  13. DIAS_SEMANA, SEMANAL y MENSUAL (dia 31 ajustado a fin de mes).
//  14. Ocurrencias salteadas (PASADA / SIN_ANTICIPACION) y serie sin viajes.
//  15. Todo o nada con Google caido (server 3802): 503, 0 series y 0 viajes.
//  16. Un viaje de la serie editado y otro reasignado: el resto y la serie igual.
//  17. El chofer confirma uno y rechaza otro de la misma serie.
//  18. Cancelar la serie: CANCELADA, los viajes intactos, doble cancelar -> 400,
//      serie:cancelada solo a la PyME; detalle y lista.
//  19. Desvincular: viajes CANCELADO y serie BORRADA; la serie ya cancelada y la
//      de otra PyME no se tocan.
//  20. Aislamiento de series entre PyMEs.
//  21. Concurrencia (5 rondas c/u): 21a crear serie vs desvincular, 21b doble
//      cancelar serie, 21c crear lugar con el mismo nombre en paralelo.
//      SUBCASOS=21a corre solo esa (protocolo de reversion).
//
// Acepta numeros de caso (el setup corre siempre):
//   node scripts/test-lugares-series.js 12 13
// Y si una corrida se corto sin limpiar:
//   node scripts/test-lugares-series.js --restos
//
// LIMPIEZA: borra TODO lo que crea (viajes con su historial, paradas y
// condiciones; series; lugares; vinculos, invitaciones, membresias, PyMEs,
// vehiculos, usuarios en la DB y en Firebase; keys gps:{id}:* y de rate limit en
// Redis; los PDF de remito en R2) y al final verifica que no quedo nada.
import 'dotenv/config';
import zlib from 'node:zlib';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { io as ioClient } from 'socket.io-client';
import prisma from '../src/config/prisma.js';
import redis from '../src/config/redis.js';
import admin from '../src/config/firebase.js';
import { conServer } from './_server-efimero.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const PUERTO = 3801;
const PUERTO_SIN_GOOGLE = 3802;
const RONDAS = 5;

const ENV_BASE = {
  RESERVA_BARRIDO_ARRANQUE: '0',
  VENCIMIENTO_BARRIDO_ARRANQUE: '0',
  ANTICIPACION_MINIMA_MINUTOS: '60',
  VENTANA_INICIO_ANTES_MINUTOS: '120',
  VENTANA_INICIO_DESPUES_MINUTOS: '90',
  MARKETPLACE_HABILITADO: 'false',
  CALIFICACIONES_HABILITADAS: 'false',
  INVITACION_INTENTOS_MAX: '1000',
  RADIO_CONFIRMACION_METROS: '50',
  TIEMPO_PEON_MINUTOS: '30',
  MAX_PARADAS_POR_VIAJE: '10',
  SERIE_CONCURRENCIA_MAPS: '4',
  SERIE_TIMEOUT_MS: '60000',
};

const SOLO = process.argv.slice(2).map(Number).filter(Number.isFinite);
const correr = (n) => SOLO.length === 0 || SOLO.includes(n);
const SUBS = (process.env.SUBCASOS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const corre21 = (sub) => SUBS.length === 0 || SUBS.includes(sub);

const stamp = Date.now();
const S = String(stamp);
const PASS = 'test123456';
const LIC = '2030-01-01T00:00:00.000Z';
// Marca de los NOMBRES de lugar de esta corrida: ninguna direccion la lleva, asi
// que si aparece en algo que recibe el chofer, es un nombre que se filtro.
const MARCA = `NOMBRE${S}`;

const ORIGEN = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const DESTINO = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };
const OTRO = { lat: -34.5975, lng: -58.3923, direccion: 'Tribunales, CABA' };

const emailsCreados = [];
const orgsCreadas = new Set();
const sockets = [];
// Todo lo que el CHOFER recibe por REST (cuerpos crudos) y por socket.
const recibidoPorChofer = [];
// [series] ... del log del server: llamadas por tipo de serie y tiempos.
const metricasSeries = [];

// -- Helpers ----------------------------------------------------------------

const pasos = [];
function paso(nombre, ok, detalle = '') {
  pasos.push({ nombre, ok: Boolean(ok), detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const titulo = (t) => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 60 - t.length))}\n`);

async function getToken(email, password = PASS) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
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
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
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

// Request del CHOFER: el cuerpo queda registrado para el chequeo global.
async function apiChofer(method, path, body, k, base = BASE) {
  const r = await api(method, path, body, k.token, base);
  recibidoPorChofer.push(r.crudo);
  return r;
}

const r2s = (r) => `${r.status} ${r.crudo.slice(0, 220)}`;
const statuses = (rs) => rs.map((r) => r.status).sort((a, b) => a - b).join(',');

const MULT = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
function cuitValido(n) {
  for (let k = 0; ; k++) {
    const base = '30' + String((Number(S.slice(-6)) * 100 + 7000 + n * 7 + k) % 1e8).padStart(8, '0');
    const suma = MULT.reduce((a, m, i) => a + m * Number(base[i]), 0);
    const dv = 11 - (suma % 11);
    if (dv === 10) continue;
    return base + (dv === 11 ? 0 : dv);
  }
}

let nUsuario = 0;
async function nuevoUsuario(tipo, etiqueta) {
  nUsuario++;
  const email = `${etiqueta}-lys-${S}-${nUsuario}@test.com`.toLowerCase();
  const dni = '6' + S.slice(-6) + String(nUsuario).padStart(2, '0');
  const datos = {
    nombre: etiqueta,
    apellido: 'Lys',
    dni,
    email,
    contrasena: PASS,
    telefono: `+54911${S.slice(-4)}${String(nUsuario).padStart(4, '0')}`,
    ...(tipo === 'conductor' ? { nro_licencia: `LLS${nUsuario}${S.slice(-4)}`, licencia_vencimiento: LIC } : {}),
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
  const patente = `L${S.slice(-4)}${String(nPatente).padStart(2, '0')}`;
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

// -- Fechas, calculadas SIN el codigo del server ------------------------------
// Argentina es UTC-3 fijo (sin horario de verano desde 2009): las expectativas
// salen de la aritmetica de aca, no de serie-fechas.js.
const AR_MS = 3 * 3_600_000;
const fechaAr = (ms) => new Date(ms - AR_MS).toISOString().slice(0, 10);
const hoyAr = () => fechaAr(Date.now());
const sumarDias = (fecha, n) => new Date(Date.parse(`${fecha}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const instanteAr = (fecha, hora) => new Date(`${fecha}T${hora}:00-03:00`);
const diaIso = (fecha) => {
  const d = new Date(`${fecha}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};
const diasDelMes = (anio, mes) => new Date(Date.UTC(anio, mes, 0)).getUTCDate();
function fechasEntre(desde, hasta) {
  const out = [];
  for (let f = desde; f <= hasta; f = sumarDias(f, 1)) out.push(f);
  return out;
}
const horaAr = (ms) => new Date(ms - AR_MS).toISOString().slice(11, 16);

// -- Acciones -------------------------------------------------------------------

const crearLugar = (u, idOrg, body) => api('POST', `/api/organizaciones/${idOrg}/lugares`, body, u.token);
async function crearLugarOk(u, idOrg, body) {
  const r = await crearLugar(u, idOrg, body);
  if (r.status !== 201) throw new Error(`crear lugar fallo: ${r2s(r)}`);
  return r.data;
}
const editarLugar = (u, idOrg, id, body) => api('PUT', `/api/organizaciones/${idOrg}/lugares/${id}`, body, u.token);
const borrarLugar = (u, idOrg, id) => api('DELETE', `/api/organizaciones/${idOrg}/lugares/${id}`, null, u.token);
const listarLugares = (u, idOrg) => api('GET', `/api/organizaciones/${idOrg}/lugares`, null, u.token);

const crearViaje = (u, idOrg, body) => api('POST', `/api/organizaciones/${idOrg}/viajes`, body, u.token);
const detallePyme = (u, idOrg, id) => api('GET', `/api/organizaciones/${idOrg}/viajes/${id}`, null, u.token);
const editarViaje = (u, idOrg, id, body) => api('PUT', `/api/organizaciones/${idOrg}/viajes/${id}`, body, u.token);
const reasignar = (u, idOrg, id, id_conductor) =>
  api('POST', `/api/organizaciones/${idOrg}/viajes/${id}/reasignar`, { id_conductor }, u.token);
const desvincular = (u, idOrg, k) => api('DELETE', `/api/organizaciones/${idOrg}/choferes/${k.id_conductor}`, null, u.token);

const confirmar = (k, id, id_vehiculo) => apiChofer('POST', `/api/choferes/viajes/${id}/confirmar`, { id_vehiculo }, k);
const rechazar = (k, id) => apiChofer('POST', `/api/choferes/viajes/${id}/rechazar`, null, k);
const iniciar = (k, id, pos) => apiChofer('POST', `/api/choferes/viajes/${id}/iniciar`, { lat: pos.lat, lng: pos.lng }, k);
const salir = (k, id) => apiChofer('POST', `/api/choferes/viajes/${id}/salir`, null, k);
const confirmarParada = (k, id, id_parada, pos) =>
  apiChofer('POST', `/api/viajes/${id}/confirmar-parada`, { id_parada, lat: pos.lat, lng: pos.lng }, k);

const cuerpoSerie = (k, extra) => ({
  id_conductor: k.id_conductor,
  hora: '09:00',
  paradas: [ORIGEN, DESTINO],
  ...extra,
});
const crearSerie = (u, idOrg, body, base = BASE) => api('POST', `/api/organizaciones/${idOrg}/series`, body, u.token, base);
async function crearSerieOk(u, idOrg, body) {
  const t = Date.now();
  const r = await crearSerie(u, idOrg, body);
  if (r.status !== 201) throw new Error(`crear serie fallo: ${r2s(r)}`);
  r.ms = Date.now() - t;
  return r;
}
const detalleSerie = (u, idOrg, id) => api('GET', `/api/organizaciones/${idOrg}/series/${id}`, null, u.token);
const listarSeries = (u, idOrg, q = '') => api('GET', `/api/organizaciones/${idOrg}/series${q}`, null, u.token);
const cancelarSerie = (u, idOrg, id) => api('POST', `/api/organizaciones/${idOrg}/series/${id}/cancelar`, null, u.token);

const paradasDb = (id) => prisma.parada.findMany({ where: { id_viaje: id }, orderBy: { orden: 'asc' } });
const viajesDeSerie = (id_serie) =>
  prisma.viaje.findMany({ where: { id_serie }, orderBy: [{ fecha_programada: 'asc' }, { id_viaje: 'asc' }] });
const fotoViajes = async (id_serie) =>
  (await viajesDeSerie(id_serie)).map((v) => ({
    id: v.id_viaje,
    estado: v.estado,
    fecha: v.fecha_programada.toISOString(),
    conductor: v.id_conductor,
    descripcion: v.descripcion,
  }));

// -- Sockets ------------------------------------------------------------------

function conectar(base, token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { auth: { token: 'Bearer ' + token }, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`Socket connect_error: ${e.message}`)));
    setTimeout(() => reject(new Error('Timeout al conectar socket (8s)')), 8000);
  });
}

async function espia(base, token, { chofer = false } = {}) {
  const socket = await conectar(base, token);
  sockets.push(socket);
  const eventos = [];
  socket.onAny((ev, d) => {
    eventos.push({ ev, d });
    if (chofer) recibidoPorChofer.push(JSON.stringify({ ev, d }));
  });
  return { socket, eventos };
}

const eventos = (esp, ev, pred = () => true) => esp.eventos.filter((e) => e.ev === ev && pred(e.d)).map((e) => e.d);
async function esperarEvento(esp, ev, pred, ms = 5000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    const e = eventos(esp, ev, pred)[0];
    if (e) return e;
    await esperar(100);
  }
  return null;
}

// -- Remito -------------------------------------------------------------------

// Texto de un PDF de pdfkit: descomprime cada stream (FlateDecode) y junta los
// strings de texto (hex <...> y literales (...)). Alcanza para buscar si un
// texto esta o no; el control positivo (la direccion SI esta) prueba que el
// metodo lee el texto de verdad.
function textoDePdf(buf) {
  const bin = buf.toString('latin1');
  let texto = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(bin))) {
    let contenido;
    try {
      contenido = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      contenido = m[1];
    }
    for (const h of contenido.matchAll(/<([0-9a-fA-F]+)>/g)) texto += Buffer.from(h[1], 'hex').toString('latin1');
    for (const p of contenido.matchAll(/\(((?:\\.|[^\\)])*)\)/g)) texto += p[1];
    texto += '\n';
  }
  return texto;
}
const sinEspacios = (t) => t.replace(/\s+/g, '');

// -- Limpieza -----------------------------------------------------------------

async function limpiar(emails = emailsCreados, patronRestante = `-lys-${S}-`) {
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
        { id_organizacion: { in: idsOrg } },
        { id_conductor: { in: idsConductor } },
        { id_cliente: { in: idsCliente } },
      ],
    },
    select: { id_viaje: true, estado: true },
  });
  const idsViaje = viajes.map((v) => v.id_viaje);

  let remitos = 0;
  const finalizados = viajes.filter((v) => v.estado === 'FINALIZADO').map((v) => v.id_viaje);
  if (finalizados.length > 0 && process.env.R2_BUCKET_NAME) {
    const r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
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

  const filtroSeries = {
    OR: [{ id_organizacion: { in: idsOrg } }, { id_conductor: { in: idsConductor } }, { id_creador: { in: idsUsuario } }],
  };
  const filtroLugares = { OR: [{ id_organizacion: { in: idsOrg } }, { id_creador: { in: idsUsuario } }] };
  const seriesBorradas = (await prisma.serieViaje.deleteMany({ where: filtroSeries })).count;
  const lugaresBorrados = (await prisma.lugar.deleteMany({ where: filtroLugares })).count;

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
  const quedanSeries = await prisma.serieViaje.count({ where: { id_organizacion: { in: idsOrg } } });
  const quedanLugares = await prisma.lugar.count({ where: { id_organizacion: { in: idsOrg } } });
  let quedanKeys = 0;
  if (redis.status === 'ready') for (const id of idsViaje) quedanKeys += (await redis.keys(`gps:${id}:*`)).length;
  console.log(
    `  viajes: ${idsViaje.length} | series: ${seriesBorradas} | lugares: ${lugaresBorrados} | usuarios DB: ` +
      `${idsUsuario.length} | Firebase: ${fbBorrados} | PyMEs: ${idsOrg.length} | remitos R2: ${remitos} | quedan: ` +
      `usuarios=${quedanUsuarios} pymes=${quedanOrgs} viajes=${quedanViajes} historial=${quedanHist} ` +
      `series=${quedanSeries} lugares=${quedanLugares} keys_gps=${quedanKeys}`
  );
  return (
    quedanUsuarios === 0 &&
    quedanOrgs === 0 &&
    quedanViajes === 0 &&
    quedanHist === 0 &&
    quedanSeries === 0 &&
    quedanLugares === 0 &&
    quedanKeys === 0
  );
}

// -- Casos: lugares -------------------------------------------------------------

async function casosLugares(ctx) {
  const { P1, P2, Q1, K1, A, B, vK1, sP1, sK1 } = ctx;
  const nombre = (t) => `${t} ${MARCA}`;

  // CASO 1 -------------------------------------------------------------------
  if (correr(1) || correr(5) || correr(6) || correr(7) || correr(8)) {
    titulo('CASO 1: crear y listar lugares');
    const r = await crearLugar(P1, A, {
      nombre: `  Deposito   Pilar ${MARCA} `,
      direccion: 'Ruta 8 km 50, Pilar',
      lat: ORIGEN.lat,
      lng: ORIGEN.lng,
    });
    paso(
      'CASO 1a: crear → 201, nombre normalizado, lat/lng',
      r.status === 201 && r.data.nombre === `Deposito Pilar ${MARCA}` && r.data.lat === ORIGEN.lat && r.data.activo === true,
      r2s(r)
    );
    ctx.L1 = r.data;
    const r2 = await crearLugar(P2, A, { nombre: nombre('Cliente Recoleta'), direccion: 'Av. Alvear 1800, CABA', lat: DESTINO.lat, lng: DESTINO.lng });
    paso('CASO 1b: otro miembro (no responsable) tambien crea → 201', r2.status === 201, r2s(r2));
    ctx.L2 = r2.data;
    const lista = await listarLugares(P1, A);
    paso(
      'CASO 1c: listar → los dos, ordenados por nombre',
      lista.status === 200 && lista.data.length === 2 && lista.data[0].id_lugar === ctx.L2.id_lugar,
      r2s(lista)
    );
    const malo = await crearLugar(P1, A, { nombre: 'X', direccion: 'Y', lat: 120, lng: 0 });
    paso('CASO 1d: lat fuera de rango → 400', malo.status === 400, r2s(malo));
  }

  // CASO 2 -------------------------------------------------------------------
  if (correr(2)) {
    titulo('CASO 2: nombre duplicado');
    const dup = await crearLugar(P2, A, { nombre: `deposito PILAR   ${MARCA}`, direccion: 'Otra', lat: OTRO.lat, lng: OTRO.lng });
    paso('CASO 2a: mismo nombre con otras mayusculas y espacios → 400', dup.status === 400 && dup.data.error === 'Ya existe un lugar con ese nombre', r2s(dup));
    const otraPyme = await crearLugar(Q1, B, { nombre: `Deposito Pilar ${MARCA}`, direccion: 'Otra', lat: OTRO.lat, lng: OTRO.lng });
    paso('CASO 2b: el mismo nombre en OTRA PyME → 201', otraPyme.status === 201, r2s(otraPyme));
    ctx.LB = otraPyme.data;
  }

  // CASO 3 -------------------------------------------------------------------
  if (correr(3)) {
    titulo('CASO 3: editar lugar');
    const L = await crearLugarOk(P1, A, { nombre: nombre('Galpon Norte'), direccion: 'Calle 1', lat: OTRO.lat, lng: OTRO.lng });
    const ren = await editarLugar(P1, A, L.id_lugar, { nombre: nombre('Galpon Sur'), direccion: 'Calle 2' });
    paso('CASO 3a: renombrar y cambiar direccion → 200', ren.status === 200 && ren.data.nombre === nombre('Galpon Sur') && ren.data.direccion === 'Calle 2', r2s(ren));
    const choca = await editarLugar(P1, A, L.id_lugar, { nombre: ctx.L1.nombre.toUpperCase() });
    paso('CASO 3b: renombrar al nombre de otro activo → 400', choca.status === 400, r2s(choca));
    const propio = await editarLugar(P1, A, L.id_lugar, { nombre: nombre('GALPON SUR') });
    paso('CASO 3c: el propio nombre con otras mayusculas → 200', propio.status === 200, r2s(propio));
    const vacio = await editarLugar(P1, A, L.id_lugar, {});
    paso('CASO 3d: sin campos → 400', vacio.status === 400, r2s(vacio));
    ctx.L3 = L;
  }

  // CASO 4 -------------------------------------------------------------------
  if (correr(4) || correr(7)) {
    titulo('CASO 4: borrar (soft)');
    const L = await crearLugarOk(P1, A, { nombre: nombre('Para Borrar'), direccion: 'Calle 9', lat: OTRO.lat, lng: OTRO.lng });
    const b = await borrarLugar(P2, A, L.id_lugar);
    const fila = await prisma.lugar.findUnique({ where: { id_lugar: L.id_lugar } });
    paso('CASO 4a: borrar → 200 y en la DB activo=false con fecha_baja y quien', b.status === 200 && fila.activo === false && fila.fecha_baja && fila.baja_por_id_usuario === P2.id_usuario, r2s(b));
    const lista = await listarLugares(P1, A);
    paso('CASO 4b: ya no aparece en la lista', lista.status === 200 && !lista.data.some((l) => l.id_lugar === L.id_lugar), '');
    const re = await crearLugar(P1, A, { nombre: nombre('Para Borrar'), direccion: 'Calle 10', lat: OTRO.lat, lng: OTRO.lng });
    paso('CASO 4c: el nombre de un borrado se puede reusar → 201', re.status === 201, r2s(re));
    const b2 = await borrarLugar(P1, A, L.id_lugar);
    const e2 = await editarLugar(P1, A, L.id_lugar, { nombre: 'X' });
    paso('CASO 4d: borrar / editar uno borrado → 404, 404', b2.status === 404 && e2.status === 404, `${r2s(b2)} | ${r2s(e2)}`);
    ctx.LBorrado = L;
  }

  // CASO 5 -------------------------------------------------------------------
  if (correr(5) || correr(6) || correr(8)) {
    titulo('CASO 5: viaje con lugar → snapshot');
    const r = await crearViaje(P1, A, {
      id_conductor: K1.id_conductor,
      fecha_programada: enMin(65),
      paradas: [{ id_lugar: ctx.L1.id_lugar }, DESTINO],
    });
    paso('CASO 5a: crear viaje con { id_lugar } → 201', r.status === 201, r2s(r));
    const id = r.data.id_viaje;
    ctx.viajeLugar = id;
    const p = await paradasDb(id);
    paso(
      'CASO 5b: la parada copia direccion y coordenadas del lugar y guarda id_lugar',
      p[0].direccion === 'Ruta 8 km 50, Pilar' && p[0].latitud === ORIGEN.lat && p[0].longitud === ORIGEN.lng && p[0].id_lugar === ctx.L1.id_lugar && p[1].id_lugar === null,
      JSON.stringify(p.map((x) => [x.direccion, x.id_lugar]))
    );
    paso(
      'CASO 5c: la respuesta de crear (PyME) trae el lugar con nombre',
      r.data.paradas[0].lugar?.nombre === ctx.L1.nombre && r.data.paradas[1].lugar === null,
      JSON.stringify(r.data.paradas[0].lugar)
    );
    const det = await detallePyme(P2, A, id);
    paso('CASO 5d: detalle de la PyME (otro miembro) con el nombre del lugar', det.status === 200 && det.data.paradas[0].lugar?.nombre === ctx.L1.nombre, r2s(det));
  }

  // CASO 6 -------------------------------------------------------------------
  if (correr(6)) {
    titulo('CASO 6: editar el lugar no cambia el viaje');
    const id = ctx.viajeLugar;
    const antes = await paradasDb(id);
    const ed = await editarLugar(P1, A, ctx.L1.id_lugar, {
      nombre: `Deposito Pilar Nuevo ${MARCA}`,
      direccion: 'Ruta 8 km 52, Pilar',
      lat: OTRO.lat,
      lng: OTRO.lng,
    });
    ctx.L1 = ed.data;
    const despues = await paradasDb(id);
    paso(
      'CASO 6a: la parada del viaje conserva direccion y coordenadas viejas',
      ed.status === 200 && despues[0].direccion === antes[0].direccion && despues[0].latitud === antes[0].latitud && despues[0].longitud === antes[0].longitud,
      `${r2s(ed)} | ${despues[0].direccion}`
    );
    const det = await detallePyme(P1, A, id);
    paso('CASO 6b: la PyME ve el nombre ACTUAL del lugar (join, no snapshot)', det.data.paradas[0].lugar?.nombre === `Deposito Pilar Nuevo ${MARCA}`, JSON.stringify(det.data.paradas[0].lugar));
    // Se vuelve a las coordenadas del origen: el ciclo del CASO 8 inicia ahi.
    await editarLugar(P1, A, ctx.L1.id_lugar, { lat: ORIGEN.lat, lng: ORIGEN.lng });
  }

  // CASO 7 -------------------------------------------------------------------
  if (correr(7)) {
    titulo('CASO 7: lugar invalido');
    const base = { id_conductor: K1.id_conductor, fecha_programada: enMin(70) };
    const inactivo = await crearViaje(P1, A, { ...base, paradas: [{ id_lugar: ctx.LBorrado.id_lugar }, DESTINO] });
    paso('CASO 7a: lugar borrado → 400', inactivo.status === 400 && /no existe o no esta activo/.test(inactivo.data.error), r2s(inactivo));
    const ajeno = await crearViaje(P1, A, { ...base, paradas: [{ id_lugar: ctx.LB?.id_lugar ?? 999999999 }, DESTINO] });
    paso('CASO 7b: lugar de OTRA PyME → el mismo 400', ajeno.status === 400 && /no existe o no esta activo/.test(ajeno.data.error), r2s(ajeno));
    const ambos = await crearViaje(P1, A, { ...base, paradas: [{ id_lugar: ctx.L1.id_lugar, lat: 1, lng: 1 }, DESTINO] });
    paso('CASO 7c: id_lugar + coordenadas → 400', ambos.status === 400, r2s(ambos));
    const serieMala = await crearSerie(P1, A, cuerpoSerie(K1, { frecuencia: 'DIARIA', fecha_desde: sumarDias(hoyAr(), 1), paradas: [{ id_lugar: ctx.LBorrado.id_lugar }, DESTINO] }));
    paso('CASO 7d: serie con lugar borrado → 400', serieMala.status === 400, r2s(serieMala));
    const ed = await editarViaje(P1, A, ctx.viajeLugar ?? 0, { paradas: [{ id_lugar: ctx.LBorrado.id_lugar }, DESTINO] });
    paso('CASO 7e: editar viaje con lugar borrado → 400', ed.status === 400, r2s(ed));
  }

  // CASO 8 -------------------------------------------------------------------
  if (correr(8)) {
    titulo('CASO 8: el chofer no recibe el nombre del lugar');
    const id = ctx.viajeLugar;
    const asignado = await esperarEvento(sK1, 'viaje:asignado', (d) => d.id_viaje === id);
    paso('CASO 8a: viaje:asignado le llego al chofer, sin lugar', asignado && !JSON.stringify(asignado).includes(MARCA) && !('lugar' in asignado.paradas[0]), JSON.stringify(asignado?.paradas?.[0]));

    // viaje:editado: nuevas paradas con dos lugares.
    const ed = await editarViaje(P1, A, id, { paradas: [{ id_lugar: ctx.L1.id_lugar }, { id_lugar: ctx.L2.id_lugar }] });
    const editado = await esperarEvento(sK1, 'viaje:editado', (d) => d.id_viaje === id);
    paso('CASO 8b: editar con lugares → 200; viaje:editado al chofer sin nombres', ed.status === 200 && editado && !JSON.stringify(editado).includes(MARCA), r2s(ed));
    paso('CASO 8c: la respuesta de editar (PyME) si trae los nombres', ed.data.paradas?.[1]?.lugar?.nombre === ctx.L2.nombre, '');

    const lista = await apiChofer('GET', '/api/choferes/viajes', null, K1);
    const enLista = lista.data.find?.((v) => v.id_viaje === id);
    const det = await apiChofer('GET', `/api/choferes/viajes/${id}`, null, K1);
    const legacy = await apiChofer('GET', `/api/viajes/${id}`, null, K1);
    const sinLugar = (paradas) => paradas?.length > 0 && paradas.every((p) => !('lugar' in p) && !('id_lugar' in p) && p.direccion);
    paso('CASO 8d: lista del chofer sin lugar ni id_lugar', lista.status === 200 && sinLugar(enLista?.paradas), JSON.stringify(enLista?.paradas?.[0]));
    paso('CASO 8e: detalle del chofer sin lugar ni id_lugar', det.status === 200 && sinLugar(det.data.paradas), JSON.stringify(det.data.paradas?.[0]));
    paso('CASO 8f: GET /api/viajes/:id (chofer) sin lugar ni id_lugar', legacy.status === 200 && sinLugar(legacy.data.paradas), JSON.stringify(legacy.data.paradas?.[0]));

    // Ciclo completo hasta el remito: L1 esta en ORIGEN y L2 en DESTINO.
    const c = await confirmar(K1, id, vK1);
    const i = await iniciar(K1, id, ORIGEN);
    const s1 = await salir(K1, id);
    const paradas = await paradasDb(id);
    const cp = await confirmarParada(K1, id, paradas[1].id_parada, DESTINO);
    const s2 = await salir(K1, id);
    paso(
      'CASO 8g: ciclo completo → FINALIZADO con remito',
      c.status === 200 && i.status === 200 && s1.status === 200 && cp.status === 200 && s2.status === 200 && s2.data.estado === 'FINALIZADO',
      [c, i, s1, cp, s2].map((r) => r.status).join(',') + ' ' + r2s(s2)
    );
    const fin = await esperarEvento(sP1, 'viaje:finalizado', (d) => d.id_viaje === id);
    paso('CASO 8h: viaje:finalizado (el payload de la sala del viaje) sin nombres', fin && !JSON.stringify(fin).includes(MARCA), '');

    if (s2.data.remito_url && process.env.R2_PUBLIC_URL) {
      let buf = null;
      for (let intento = 0; intento < 5 && !buf; intento++) {
        const res = await fetch(s2.data.remito_url).catch(() => null);
        if (res?.ok) buf = Buffer.from(await res.arrayBuffer());
        else await esperar(1000);
      }
      const texto = buf ? textoDePdf(buf) : '';
      const crudo = buf ? buf.toString('latin1') : '';
      // La edicion del CASO 8b re-snapshoteo L1: su direccion ACTUAL es la del viaje.
      const control = sinEspacios(texto).includes(sinEspacios(ctx.L1.direccion));
      paso(
        'CASO 8i: el remito tiene la direccion (control) y NO el nombre del lugar',
        buf && control && !sinEspacios(texto).includes(MARCA) && !crudo.includes(MARCA),
        `pdf=${buf ? buf.length + 'B' : 'no se pudo bajar'} direccion=${control}`
      );
    } else {
      paso('CASO 8i: remito (necesita R2_PUBLIC_URL)', false, 'sin R2_PUBLIC_URL o sin remito_url');
    }
  }

  // CASO 9 -------------------------------------------------------------------
  if (correr(9)) {
    titulo('CASO 9: aislamiento de lugares');
    const L = ctx.L2 ?? (await crearLugarOk(P1, A, { nombre: nombre('Aislado'), direccion: 'X', lat: OTRO.lat, lng: OTRO.lng }));
    const ajenoLista = await listarLugares(Q1, A);
    paso('CASO 9a: listar los lugares de otra PyME → 403', ajenoLista.status === 403, r2s(ajenoLista));
    const viaSuya = await editarLugar(Q1, B, L.id_lugar, { nombre: 'Robado' });
    const borraSuya = await borrarLugar(Q1, B, L.id_lugar);
    paso('CASO 9b: editar / borrar un lugar de A desde la ruta de B → 404, 404', viaSuya.status === 404 && borraSuya.status === 404, `${r2s(viaSuya)} | ${r2s(borraSuya)}`);
    const listaB = await listarLugares(Q1, B);
    paso('CASO 9c: la lista de B no tiene lugares de A', listaB.status === 200 && listaB.data.every((l) => l.id_organizacion === B), '');
    const chofer = await api('GET', `/api/organizaciones/${A}/lugares`, null, K1.token);
    paso('CASO 9d: el chofer no tiene acceso a los lugares → 403', chofer.status === 403, r2s(chofer));
  }

  // CASO 10 ------------------------------------------------------------------
  if (correr(10)) {
    titulo('CASO 10: PyME SUSPENDIDA');
    const L = await crearLugarOk(P1, A, { nombre: nombre('Suspendida'), direccion: 'X', lat: OTRO.lat, lng: OTRO.lng });
    const serie = await prisma.serieViaje.create({
      data: {
        id_organizacion: A,
        id_creador: P1.id_usuario,
        id_conductor: K1.id_conductor,
        frecuencia: 'DIARIA',
        hora: '09:00',
        fecha_desde: new Date(`${sumarDias(hoyAr(), 1)}T00:00:00Z`),
        fecha_hasta: new Date(`${sumarDias(hoyAr(), 2)}T00:00:00Z`),
        paradas: [],
      },
    });
    await prisma.organizacion.update({ where: { id_organizacion: A }, data: { estado: 'SUSPENDIDA' } });
    try {
      const c = await crearLugar(P1, A, { nombre: nombre('Nuevo'), direccion: 'X', lat: OTRO.lat, lng: OTRO.lng });
      const e = await editarLugar(P1, A, L.id_lugar, { direccion: 'Y' });
      const s = await crearSerie(P1, A, cuerpoSerie(K1, { frecuencia: 'DIARIA', fecha_desde: sumarDias(hoyAr(), 1) }));
      paso('CASO 10a: crear lugar, editar lugar y crear serie → 403', c.status === 403 && e.status === 403 && s.status === 403, `${c.status},${e.status},${s.status} ${c.data.error}`);
      const b = await borrarLugar(P1, A, L.id_lugar);
      const cs = await cancelarSerie(P1, A, serie.id_serie);
      paso('CASO 10b: borrar lugar y cancelar serie siguen permitidos → 200, 200', b.status === 200 && cs.status === 200, `${r2s(b)} | ${r2s(cs)}`);
    } finally {
      await prisma.organizacion.update({ where: { id_organizacion: A }, data: { estado: 'TRIAL' } });
    }
  }

  // CASO 11 ------------------------------------------------------------------
  if (correr(11)) {
    titulo('CASO 11: tope de paradas (10)');
    const once = Array.from({ length: 11 }, (_, i) => ({ lat: ORIGEN.lat + i * 0.001, lng: ORIGEN.lng }));
    const v = await crearViaje(P1, A, { id_conductor: K1.id_conductor, fecha_programada: enMin(70), paradas: once });
    const s = await crearSerie(P1, A, cuerpoSerie(K1, { frecuencia: 'DIARIA', fecha_desde: sumarDias(hoyAr(), 1), paradas: once }));
    const e = await api('POST', '/api/viajes/estimar-costo', { paradas: once }, P1.token);
    const msj = 'Un viaje puede tener como máximo 10 paradas';
    paso('CASO 11a: 11 paradas → 400 en viaje, serie y estimar-costo', [v, s, e].every((r) => r.status === 400 && r.data.error === msj), `${v.status},${s.status},${e.status} ${v.data.error}`);
  }
}

// -- Casos: series --------------------------------------------------------------

function registrarMetricaSerie(leerLog, id_serie, tipo, msCliente) {
  const linea = [...leerLog().matchAll(new RegExp(`\\[series\\] serie ${id_serie}: ([^\\n]*)`, 'g'))].at(-1);
  const m = linea?.[1].match(/(\d+) viajes, (\d+) llamadas Pro, estimacion (\d+)ms, tx (\d+)ms, total (\d+)ms/);
  if (m) {
    metricasSeries.push({ tipo, viajes: +m[1], llamadas: +m[2], estimacion: +m[3], tx: +m[4], total: +m[5], cliente: msCliente });
  }
}

async function casosSeries(ctx, leerLog) {
  const { P1, P2, Q1, K1, K2, K3, A, B, vK1, sP1, sP2, sK1, sK2 } = ctx;
  const manana = sumarDias(hoyAr(), 1);

  // CASO 12 ------------------------------------------------------------------
  if (correr(12) || correr(16) || correr(17) || correr(18)) {
    titulo('CASO 12: serie DIARIA de 30 viajes');
    const L = ctx.L2 ?? (await crearLugarOk(P1, A, { nombre: `Serie ${MARCA}`, direccion: 'Av. Alvear 1800, CABA', lat: DESTINO.lat, lng: DESTINO.lng }));
    const hasta = sumarDias(manana, 29);
    const antesEventos = sK1.eventos.length;
    const r = await crearSerieOk(
      P1,
      A,
      cuerpoSerie(K1, { frecuencia: 'DIARIA', fecha_desde: manana, fecha_hasta: hasta, paradas: [ORIGEN, { id_lugar: L.id_lugar }], condiciones_requeridas: ['FRAGIL'], descripcion: 'Reparto diario' })
    );
    registrarMetricaSerie(leerLog, r.data.serie.id_serie, 'DIARIA x30 (2 paradas)', r.ms);
    const { serie, viajes } = r.data;
    ctx.serieDiaria = serie.id_serie;
    const esperadas = fechasEntre(manana, hasta).map((f) => instanteAr(f, '09:00').toISOString());
    paso(
      'CASO 12a: 201 con 30 viajes, todos a las 9:00 hora AR de cada dia',
      viajes.length === 30 && viajes.every((v, i) => new Date(v.fecha_programada).toISOString() === esperadas[i]),
      `viajes=${viajes.length} primero=${viajes[0]?.fecha_programada} ultimo=${viajes.at(-1)?.fecha_programada} (${r.ms}ms)`
    );
    paso(
      'CASO 12b: la serie: ACTIVA, ventana, hora, plantilla con el nombre del lugar (PyME)',
      serie.estado === 'ACTIVA' && serie.fecha_desde === manana && serie.fecha_hasta === hasta && serie.hora === '09:00' && serie.paradas[1].lugar?.nombre === L.nombre && serie.zona_horaria === 'America/Argentina/Buenos_Aires',
      JSON.stringify({ ...serie, paradas: undefined })
    );
    const db = await viajesDeSerie(serie.id_serie);
    paso(
      'CASO 12c: en la DB: 30 ASIGNADO, id_serie, el chofer, precio y estimado propios',
      db.length === 30 && db.every((v) => v.estado === 'ASIGNADO' && v.id_conductor === K1.id_conductor && v.precio_estimado > 0 && v.duracion_estimada_horas > 0 && v.id_organizacion === A),
      `${db.length} filas`
    );
    const hist = await prisma.historialEstadoViaje.findMany({ where: { id_viaje: { in: db.map((v) => v.id_viaje) } } });
    paso('CASO 12d: una fila de historial ASIGNADO (CLIENTE) por viaje', hist.length === 30 && hist.every((h) => h.estado === 'ASIGNADO' && h.origen === 'CLIENTE' && h.id_usuario === P1.id_usuario), `${hist.length} filas`);
    const cond = await prisma.condicionRequerida.count({ where: { id_viaje: { in: db.map((v) => v.id_viaje) } } });
    const paradas = await prisma.parada.findMany({ where: { id_viaje: { in: db.map((v) => v.id_viaje) } } });
    paso(
      'CASO 12e: 60 paradas (snapshot del lugar en la 2) con estimado, 30 condiciones',
      paradas.length === 60 && paradas.filter((p) => p.orden === 2).every((p) => p.id_lugar === L.id_lugar && p.direccion === L.direccion && p.llegada_estimada) && cond === 30,
      `paradas=${paradas.length} condiciones=${cond}`
    );
    const ev = await esperarEvento(sK1, 'serie:asignada', (d) => d.id_serie === serie.id_serie);
    await esperar(500);
    const evPyme = eventos(sP2, 'serie:asignada', (d) => d.id_serie === serie.id_serie);
    const asignadosSerie = sK1.eventos.slice(antesEventos).filter((e) => e.ev === 'viaje:asignado' && db.some((v) => v.id_viaje === e.d.id_viaje));
    paso(
      'CASO 12f: UN serie:asignada al chofer y a la PyME (otro miembro), con los 30 viajes, y ningun viaje:asignado',
      ev && ev.viajes.length === 30 && eventos(sK1, 'serie:asignada', (d) => d.id_serie === serie.id_serie).length === 1 && evPyme.length === 1 && asignadosSerie.length === 0,
      `chofer=${ev?.viajes?.length} pyme=${evPyme.length} viaje:asignado=${asignadosSerie.length}`
    );
    paso('CASO 12g: serie:asignada sin el nombre del lugar (direccion si)', ev && !JSON.stringify(ev).includes(MARCA) && ev.viajes[0].paradas[1].direccion === L.direccion, '');
    const listaChofer = await apiChofer('GET', '/api/choferes/viajes?grupo=asignados', null, K1);
    const deLaSerie = listaChofer.data.filter?.((v) => v.id_serie === serie.id_serie) ?? [];
    paso('CASO 12h: el chofer ve los 30 como viajes normales con id_serie', deLaSerie.length === 30, `${deLaSerie.length}`);
    const llamadas = metricasSeries.at(-1);
    paso('CASO 12i: 30 llamadas Pro (una por viaje de 2 paradas)', llamadas?.llamadas === 30, JSON.stringify(llamadas));
    ctx.viajesDiaria = db.map((v) => v.id_viaje);
  }

  // CASO 13 ------------------------------------------------------------------
  if (correr(13)) {
    titulo('CASO 13: DIAS_SEMANA, SEMANAL y MENSUAL');
    const hasta = sumarDias(manana, 30);
    const ventana = fechasEntre(manana, hasta);

    const ds = await crearSerieOk(P1, A, cuerpoSerie(K2, { frecuencia: 'DIAS_SEMANA', dias_semana: [1, 3, 5], fecha_desde: manana, hora: '07:30' }));
    registrarMetricaSerie(leerLog, ds.data.serie.id_serie, 'DIAS_SEMANA lun/mie/vie', ds.ms);
    const espDs = ventana.filter((f) => [1, 3, 5].includes(diaIso(f))).map((f) => instanteAr(f, '07:30').toISOString());
    const obtDs = ds.data.viajes.map((v) => new Date(v.fecha_programada).toISOString());
    paso('CASO 13a: DIAS_SEMANA lun/mie/vie 7:30 AR → fechas exactas', JSON.stringify(obtDs) === JSON.stringify(espDs), `${obtDs.length} viajes, esperados ${espDs.length}`);

    const se = await crearSerieOk(P1, A, cuerpoSerie(K2, { frecuencia: 'SEMANAL', dia_semana: 2, fecha_desde: manana, hora: '18:45' }));
    registrarMetricaSerie(leerLog, se.data.serie.id_serie, 'SEMANAL martes', se.ms);
    const espSe = ventana.filter((f) => diaIso(f) === 2).map((f) => instanteAr(f, '18:45').toISOString());
    const obtSe = se.data.viajes.map((v) => new Date(v.fecha_programada).toISOString());
    paso('CASO 13b: SEMANAL martes 18:45 AR → fechas exactas', JSON.stringify(obtSe) === JSON.stringify(espSe), `${obtSe.join(', ')}`);

    // MENSUAL 31: una ventana que arranca el 10 de un mes de menos de 31 dias,
    // dentro de los 90 dias. Su unica ocurrencia es el ultimo dia de ese mes.
    let desde = null;
    for (let f = manana; f <= sumarDias(hoyAr(), 90); f = sumarDias(f, 1)) {
      const [anio, mes, dia] = f.split('-').map(Number);
      if (dia === 10 && diasDelMes(anio, mes) < 31) {
        desde = f;
        break;
      }
    }
    const [anio, mes] = desde.split('-').map(Number);
    const ultimo = `${desde.slice(0, 8)}${String(diasDelMes(anio, mes)).padStart(2, '0')}`;
    const me = await crearSerieOk(P1, A, cuerpoSerie(K2, { frecuencia: 'MENSUAL', dia_mes: 31, fecha_desde: desde, hora: '23:30' }));
    registrarMetricaSerie(leerLog, me.data.serie.id_serie, 'MENSUAL dia 31', me.ms);
    paso(
      `CASO 13c: MENSUAL dia 31 desde ${desde} → un viaje el ${ultimo} 23:30 AR, en ajustadas FIN_DE_MES`,
      me.data.viajes.length === 1 &&
        new Date(me.data.viajes[0].fecha_programada).toISOString() === instanteAr(ultimo, '23:30').toISOString() &&
        JSON.stringify(me.data.ajustadas) === JSON.stringify([{ fecha: ultimo, motivo: 'FIN_DE_MES' }]),
      `${me.data.viajes[0]?.fecha_programada} ${JSON.stringify(me.data.ajustadas)}`
    );
    paso('CASO 13d: 23:30 AR cae al dia siguiente en UTC (02:30Z)', new Date(me.data.viajes[0].fecha_programada).toISOString().endsWith('T02:30:00.000Z'), '');
    const malo = await crearSerie(P1, A, cuerpoSerie(K2, { frecuencia: 'DIAS_SEMANA', dias_semana: [1, 1], fecha_desde: manana }));
    const sinDia = await crearSerie(P1, A, cuerpoSerie(K2, { frecuencia: 'MENSUAL', fecha_desde: manana }));
    const ventanaLarga = await crearSerie(P1, A, cuerpoSerie(K2, { frecuencia: 'DIARIA', fecha_desde: manana, fecha_hasta: sumarDias(manana, 31) }));
    const hora = await crearSerie(P1, A, cuerpoSerie(K2, { frecuencia: 'DIARIA', fecha_desde: manana, hora: '24:00' }));
    paso(
      'CASO 13e: dias repetidos, MENSUAL sin dia_mes, ventana de 32 dias, hora 24:00 → 400',
      [malo, sinDia, ventanaLarga, hora].every((r) => r.status === 400),
      [malo, sinDia, ventanaLarga, hora].map((r) => `${r.status} ${r.data.error}`).join(' | ')
    );
  }

  // CASO 14 ------------------------------------------------------------------
  if (correr(14)) {
    titulo('CASO 14: ocurrencias salteadas');
    // Hora = ahora + 30 min (local): la de ese dia no llega a los 60 de
    // anticipacion. Las expectativas se calculan aca con UTC-3 fijo.
    const ahora = Date.now();
    const hora = horaAr(ahora + 30 * 60000);
    const desde = hoyAr();
    const hasta = sumarDias(desde, 2);
    const r = await crearSerie(P1, A, cuerpoSerie(K2, { frecuencia: 'DIARIA', fecha_desde: desde, fecha_hasta: hasta, hora }));
    const tReq = Date.now();
    const esperado = { viajes: [], salteadas: [] };
    for (const f of fechasEntre(desde, hasta)) {
      const t = instanteAr(f, hora).getTime();
      if (t <= tReq - 60000) esperado.salteadas.push(`${f}:PASADA`);
      else if (t <= ahora + 60 * 60000) esperado.salteadas.push(`${f}:SIN_ANTICIPACION`);
      else esperado.viajes.push(f);
    }
    const obt = {
      viajes: (r.data.viajes ?? []).map((v) => fechaAr(new Date(v.fecha_programada).getTime())),
      salteadas: (r.data.salteadas ?? []).map((s) => `${s.fecha}:${s.motivo}`),
    };
    paso(
      'CASO 14a: hora = ahora + 30 min → la ocurrencia sin anticipacion sale en salteadas con su motivo',
      r.status === 201 && JSON.stringify(obt) === JSON.stringify(esperado) && obt.salteadas.some((s) => s.endsWith('SIN_ANTICIPACION')),
      `${r.status} ${JSON.stringify(obt)} esperado ${JSON.stringify(esperado)}`
    );
    if (r.status === 201) registrarMetricaSerie(leerLog, r.data.serie.id_serie, 'DIARIA x2-3 (salteadas)', 0);

    const pasada = horaAr(ahora - 90 * 60000);
    const r2 = await crearSerie(P1, A, cuerpoSerie(K2, { frecuencia: 'DIARIA', fecha_desde: desde, fecha_hasta: desde, hora: pasada }));
    const fechaPasada = fechaAr(ahora - 90 * 60000);
    if (fechaPasada === desde) {
      paso(
        'CASO 14b: la unica ocurrencia ya paso → 400 "no genera ningun viaje" con salteadas PASADA, y no se creo nada',
        r2.status === 400 && /no genera ningun viaje/.test(r2.data.error) && r2.data.salteadas?.[0]?.motivo === 'PASADA',
        r2s(r2)
      );
    } else {
      paso('CASO 14b: (pasada la medianoche AR hace menos de 90 min: se saltea el chequeo)', true, r2s(r2));
    }
  }

  // CASO 15 ------------------------------------------------------------------
  if (correr(15)) {
    titulo('CASO 15: todo o nada con Google caido (server 3802)');
    const contar = async () => ({
      series: await prisma.serieViaje.count({ where: { id_organizacion: A } }),
      viajes: await prisma.viaje.count({ where: { id_organizacion: A } }),
      historial: await prisma.historialEstadoViaje.count({ where: { viaje: { id_organizacion: A } } }),
    });
    const antes = await contar();
    await conServer({ ...ENV_BASE, GOOGLE_MAPS_API_KEY: 'clave-invalida-de-test' }, PUERTO_SIN_GOOGLE, async (base) => {
      const r = await crearSerie(P1, A, cuerpoSerie(K1, { frecuencia: 'DIARIA', fecha_desde: manana }), base);
      const despues = await contar();
      paso(
        'CASO 15a: 503 y no se escribio NADA (0 series, 0 viajes, 0 historial nuevos)',
        r.status === 503 && JSON.stringify(antes) === JSON.stringify(despues),
        `${r2s(r)} antes=${JSON.stringify(antes)} despues=${JSON.stringify(despues)}`
      );
    });
  }

  // CASO 16 ------------------------------------------------------------------
  if (correr(16) && ctx.serieDiaria) {
    titulo('CASO 16: editar y reasignar viajes de la serie');
    const [v1, v2] = ctx.viajesDiaria;
    const antes = await fotoViajes(ctx.serieDiaria);
    const nuevaFecha = new Date(new Date(antes[0].fecha).getTime() + 3_600_000).toISOString();
    const ed = await editarViaje(P1, A, v1, { fecha_programada: nuevaFecha, descripcion: 'Solo este' });
    const re = await reasignar(P1, A, v2, K2.id_conductor);
    const despues = await fotoViajes(ctx.serieDiaria);
    const resto = (f) => f.filter((v) => v.id !== v1 && v.id !== v2);
    paso('CASO 16a: editar uno → 200 y reasignar otro → 200', ed.status === 200 && re.status === 200, `${r2s(ed)} | ${r2s(re)}`);
    paso(
      'CASO 16b: el editado y el reasignado cambiaron y siguen en la serie',
      despues.find((v) => v.id === v1).fecha === nuevaFecha && despues.find((v) => v.id === v1).descripcion === 'Solo este' && despues.find((v) => v.id === v2).conductor === K2.id_conductor && despues.length === 30,
      ''
    );
    paso('CASO 16c: los otros 28 viajes quedaron identicos', JSON.stringify(resto(antes)) === JSON.stringify(resto(despues)), '');
    const serie = await prisma.serieViaje.findUnique({ where: { id_serie: ctx.serieDiaria } });
    paso('CASO 16d: la serie no cambio (chofer, descripcion, estado)', serie.id_conductor === K1.id_conductor && serie.descripcion === 'Reparto diario' && serie.estado === 'ACTIVA', '');
    const evK2 = await esperarEvento(sK2, 'viaje:asignado', (d) => d.id_viaje === v2);
    paso('CASO 16e: el chofer nuevo recibe viaje:asignado (con id_serie) del reasignado', evK2?.id_serie === ctx.serieDiaria, JSON.stringify(evK2?.id_serie));
  }

  // CASO 17 ------------------------------------------------------------------
  if (correr(17) && ctx.serieDiaria) {
    titulo('CASO 17: el chofer confirma uno y rechaza otro');
    const [, , v3, v4] = ctx.viajesDiaria;
    const antes = await fotoViajes(ctx.serieDiaria);
    const c = await confirmar(K1, v3, vK1);
    const r = await rechazar(K1, v4);
    const despues = await fotoViajes(ctx.serieDiaria);
    const resto = (f) => f.filter((v) => v.id !== v3 && v.id !== v4);
    paso(
      'CASO 17a: confirmar → CONFIRMADO, rechazar → RECHAZADO',
      c.status === 200 && r.status === 200 && despues.find((v) => v.id === v3).estado === 'CONFIRMADO' && despues.find((v) => v.id === v4).estado === 'RECHAZADO',
      `${r2s(c)} | ${r2s(r)}`
    );
    paso('CASO 17b: el resto de la serie no cambio', JSON.stringify(resto(antes)) === JSON.stringify(resto(despues)), '');
  }

  // CASO 18 ------------------------------------------------------------------
  if (correr(18) && ctx.serieDiaria) {
    titulo('CASO 18: cancelar la serie');
    const antes = await fotoViajes(ctx.serieDiaria);
    const antesK1 = sK1.eventos.length;
    const c = await cancelarSerie(P2, A, ctx.serieDiaria);
    const despues = await fotoViajes(ctx.serieDiaria);
    const fila = await prisma.serieViaje.findUnique({ where: { id_serie: ctx.serieDiaria } });
    paso('CASO 18a: cancelar (otro miembro) → 200 y CANCELADA con quien y cuando', c.status === 200 && fila.estado === 'CANCELADA' && fila.baja_por_id_usuario === P2.id_usuario && fila.fecha_baja, r2s(c));
    paso('CASO 18b: los 30 viajes quedaron identicos', JSON.stringify(antes) === JSON.stringify(despues), '');
    const doble = await cancelarSerie(P1, A, ctx.serieDiaria);
    paso('CASO 18c: cancelar otra vez → 400', doble.status === 400, r2s(doble));
    const ev = await esperarEvento(sP1, 'serie:cancelada', (d) => d.id_serie === ctx.serieDiaria);
    await esperar(300);
    paso('CASO 18d: serie:cancelada a la PyME y NO al chofer', ev && !sK1.eventos.slice(antesK1).some((e) => e.ev === 'serie:cancelada'), '');
    const det = await detalleSerie(P1, A, ctx.serieDiaria);
    const porEstado = {};
    for (const v of despues) porEstado[v.estado] = (porEstado[v.estado] ?? 0) + 1;
    paso(
      'CASO 18e: detalle: la serie CANCELADA con sus 30 viajes y el estado de cada uno',
      det.status === 200 && det.data.estado === 'CANCELADA' && det.data.viajes.length === 30 && det.data.viajes.every((v) => v.id_serie === ctx.serieDiaria && v.estado),
      r2s(det).slice(0, 120)
    );
    const lista = await listarSeries(P1, A, '?estado=CANCELADA');
    const enLista = lista.data.find?.((s) => s.id_serie === ctx.serieDiaria);
    paso('CASO 18f: lista con filtro y resumen por estado', lista.status === 200 && enLista?.resumen_viajes.total === 30 && JSON.stringify(enLista.resumen_viajes.por_estado) === JSON.stringify(porEstado) && lista.data.every((s) => s.estado === 'CANCELADA'), JSON.stringify(enLista?.resumen_viajes));
  }

  // CASO 19 ------------------------------------------------------------------
  if (correr(19)) {
    titulo('CASO 19: desvincular → viajes cancelados y serie BORRADA');
    const activa = await crearSerieOk(P1, A, cuerpoSerie(K3, { frecuencia: 'DIARIA', fecha_desde: manana, fecha_hasta: sumarDias(manana, 2) }));
    registrarMetricaSerie(leerLog, activa.data.serie.id_serie, 'DIARIA x3', activa.ms);
    const otraPyme = await crearSerieOk(Q1, B, cuerpoSerie(K3, { frecuencia: 'DIARIA', fecha_desde: manana, fecha_hasta: manana }));
    registrarMetricaSerie(leerLog, otraPyme.data.serie.id_serie, 'DIARIA x1', otraPyme.ms);
    const yaCancelada = await prisma.serieViaje.create({
      data: { id_organizacion: A, id_creador: P1.id_usuario, id_conductor: K3.id_conductor, frecuencia: 'SEMANAL', dia_semana: 1, hora: '09:00', fecha_desde: new Date(`${manana}T00:00:00Z`), fecha_hasta: new Date(`${manana}T00:00:00Z`), paradas: [], estado: 'CANCELADA' },
    });
    const idActiva = activa.data.serie.id_serie;
    const d = await desvincular(P1, A, K3);
    const viajes = await viajesDeSerie(idActiva);
    const [sActiva, sCancelada, sOtra] = await Promise.all(
      [idActiva, yaCancelada.id_serie, otraPyme.data.serie.id_serie].map((id) => prisma.serieViaje.findUnique({ where: { id_serie: id } }))
    );
    paso(
      'CASO 19a: desvincular → 200 con series_borradas y los viajes de la serie en viajes_cancelados',
      d.status === 200 && JSON.stringify(d.data.series_borradas) === JSON.stringify([idActiva]) && viajes.every((v) => d.data.viajes_cancelados.includes(v.id_viaje)),
      r2s(d)
    );
    paso('CASO 19b: los 3 viajes CANCELADO con causa DESVINCULACION', viajes.length === 3 && viajes.every((v) => v.estado === 'CANCELADO' && v.causa_cancelacion === 'DESVINCULACION'), viajes.map((v) => v.estado).join(','));
    paso('CASO 19c: la serie BORRADA (con quien y cuando)', sActiva.estado === 'BORRADA' && sActiva.baja_por_id_usuario === P1.id_usuario && sActiva.fecha_baja, sActiva.estado);
    paso('CASO 19d: la que ya estaba CANCELADA sigue CANCELADA', sCancelada.estado === 'CANCELADA', sCancelada.estado);
    const viajesOtra = await viajesDeSerie(sOtra.id_serie);
    paso('CASO 19e: la serie del mismo chofer con OTRA PyME sigue ACTIVA con sus viajes', sOtra.estado === 'ACTIVA' && viajesOtra.every((v) => v.estado === 'ASIGNADO'), `${sOtra.estado} ${viajesOtra.map((v) => v.estado)}`);
    const cancelarBorrada = await cancelarSerie(P1, A, idActiva);
    paso('CASO 19f: cancelar una serie BORRADA → 400', cancelarBorrada.status === 400, r2s(cancelarBorrada));
  }

  // CASO 20 ------------------------------------------------------------------
  if (correr(20)) {
    titulo('CASO 20: aislamiento de series');
    const serie = await prisma.serieViaje.create({
      data: { id_organizacion: A, id_creador: P1.id_usuario, id_conductor: K1.id_conductor, frecuencia: 'DIARIA', hora: '09:00', fecha_desde: new Date(`${manana}T00:00:00Z`), fecha_hasta: new Date(`${manana}T00:00:00Z`), paradas: [] },
    });
    const ajena = await api('GET', `/api/organizaciones/${A}/series/${serie.id_serie}`, null, Q1.token);
    const viaB = await api('GET', `/api/organizaciones/${B}/series/${serie.id_serie}`, null, Q1.token);
    const cancelB = await cancelarSerie(Q1, B, serie.id_serie);
    const listaB = await listarSeries(Q1, B);
    paso('CASO 20a: otra PyME: 403 por la ruta de A, 404 por la suya (detalle y cancelar)', ajena.status === 403 && viaB.status === 404 && cancelB.status === 404, `${ajena.status},${viaB.status},${cancelB.status}`);
    paso('CASO 20b: la lista de B no trae series de A', listaB.status === 200 && listaB.data.every((s) => s.id_organizacion === B), '');
    const chofer = await api('GET', `/api/organizaciones/${A}/series`, null, K1.token);
    paso('CASO 20c: el chofer no tiene rutas de series → 403', chofer.status === 403, r2s(chofer));
    const sigue = await prisma.serieViaje.findUnique({ where: { id_serie: serie.id_serie } });
    paso('CASO 20d: la serie sigue ACTIVA', sigue.estado === 'ACTIVA', '');
  }
}

// -- Casos: concurrencia --------------------------------------------------------

async function casosConcurrencia(ctx, leerLog) {
  if (!correr(21)) return;
  const { P1, A, K4, K1 } = ctx;
  const manana = sumarDias(hoyAr(), 1);

  if (corre21('21a')) {
    titulo('CASO 21a: crear serie vs desvincular (5 rondas)');
    // El desvincular sale con un retraso distinto en cada ronda, para caer a
    // veces durante las estimaciones (el crear tiene que ver el vinculo cortado
    // en su tx) y a veces despues del commit (la serie queda BORRADA).
    const RETRASOS = [50, 150, 300, 700, 1500];
    const resultados = [];
    let invariante = true;
    for (let i = 0; i < RONDAS; i++) {
      await vincular(P1, A, K4);
      const pCrear = crearSerie(P1, A, cuerpoSerie(K4, { frecuencia: 'DIARIA', fecha_desde: manana, fecha_hasta: manana }));
      await esperar(RETRASOS[i]);
      const d = await desvincular(P1, A, K4);
      const c = await pCrear;
      if (c.status === 201) registrarMetricaSerie(leerLog, c.data.serie.id_serie, 'DIARIA x1 (carrera)', 0);
      const activas = await prisma.serieViaje.count({ where: { id_organizacion: A, id_conductor: K4.id_conductor, estado: 'ACTIVA' } });
      const vivos = await prisma.viaje.count({ where: { id_organizacion: A, id_conductor: K4.id_conductor, estado: { in: ['ASIGNADO', 'CONFIRMADO'] } } });
      const vinculoActivo = await prisma.vinculoChofer.count({ where: { id_organizacion: A, id_conductor: K4.id_conductor, activo: true } });
      const ok = d.status === 200 && [201, 400].includes(c.status) && activas === 0 && vivos === 0 && vinculoActivo === 0;
      if (!ok) invariante = false;
      resultados.push(`r${i + 1}: crear=${c.status} desv=${d.status} activas=${activas} vivos=${vivos}`);
    }
    paso('CASO 21a: nunca una serie ACTIVA ni un viaje vivo con el vinculo cortado', invariante, resultados.join(' | '));
  }

  if (corre21('21b')) {
    titulo('CASO 21b: doble cancelar serie (5 rondas)');
    const resultados = [];
    let ok = true;
    for (let i = 0; i < RONDAS; i++) {
      const serie = await prisma.serieViaje.create({
        data: { id_organizacion: A, id_creador: P1.id_usuario, id_conductor: K1.id_conductor, frecuencia: 'DIARIA', hora: '09:00', fecha_desde: new Date(`${manana}T00:00:00Z`), fecha_hasta: new Date(`${manana}T00:00:00Z`), paradas: [] },
      });
      const rs = await Promise.all([cancelarSerie(P1, A, serie.id_serie), cancelarSerie(ctx.P2, A, serie.id_serie)]);
      const n200 = rs.filter((r) => r.status === 200).length;
      const otro = rs.find((r) => r.status !== 200);
      if (n200 !== 1 || ![409, 400].includes(otro?.status)) ok = false;
      resultados.push(statuses(rs));
    }
    paso('CASO 21b: exactamente un 200 por ronda (el otro 409, o 400 si llego tarde)', ok, resultados.join(' | '));
  }

  if (corre21('21c')) {
    titulo('CASO 21c: crear lugar con el mismo nombre en paralelo (5 rondas)');
    const resultados = [];
    let ok = true;
    for (let i = 0; i < RONDAS; i++) {
      const base = `Carrera ${i} ${MARCA}`;
      const rs = await Promise.all(
        [base, base.toLowerCase(), `  ${base.toUpperCase()} `].map((nombre) =>
          crearLugar(P1, A, { nombre, direccion: 'X', lat: OTRO.lat, lng: OTRO.lng })
        )
      );
      const activos = await prisma.$queryRaw`
        SELECT count(*)::int AS n FROM lugares
        WHERE id_organizacion = ${A} AND activo = true AND lower(nombre) = lower(${base})`;
      const n201 = rs.filter((r) => r.status === 201).length;
      if (n201 !== 1 || rs.filter((r) => r.status === 400).length !== 2 || activos[0].n !== 1) ok = false;
      resultados.push(`${statuses(rs)} activos=${activos[0].n}`);
    }
    paso('CASO 21c: un 201 y dos 400 por ronda, 1 solo lugar activo con ese nombre', ok, resultados.join(' | '));
  }
}

// -- Main ---------------------------------------------------------------------

async function limpiarRestos() {
  const usuarios = await prisma.usuario.findMany({
    where: { email: { contains: '-lys-', endsWith: '@test.com' } },
    select: { email: true },
  });
  console.log(`\n  restos: ${usuarios.length} usuarios de corridas anteriores`);
  return limpiar(usuarios.map((u) => u.email), '-lys-');
}

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
  console.log('║  TEST LUGARES Y SERIES (PASO 4) — FLETER     ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  if (SOLO.length > 0) console.log(`  (solo los casos ${SOLO.join(', ')})\n`);
  if (!process.env.INVITACION_SECRETO) throw new Error('Falta INVITACION_SECRETO en el .env local');

  let limpio = false;
  try {
    await conServer(ENV_BASE, PUERTO, async (base, leerLog) => {
      BASE = base;
      titulo('SETUP');
      const [P1, P2, Q1] = await nuevosUsuarios('cliente', 'Pym', 3);
      const [K1, K2, K3, K4] = await nuevosUsuarios('conductor', 'Cho', 4);
      const A = await crearOrgOk(P1, `PyME LA ${S}`, cuitValido(1));
      const B = await crearOrgOk(Q1, `PyME LB ${S}`, cuitValido(2));
      await canjearOk(P2, (await invitarOk(P1, A, 'MIEMBRO')).codigo);
      const vK1 = await vehiculoOk(K1, ['FRAGIL']);
      await vehiculoOk(K2, ['FRAGIL']);
      await vehiculoOk(K3, []);
      await vehiculoOk(K4, []);
      for (const k of [K1, K2, K3]) await vincular(P1, A, k);
      await vincular(Q1, B, K3);
      const [sP1, sP2] = await Promise.all([P1, P2].map((u) => espia(base, u.token)));
      const [sK1, sK2, sK3] = await Promise.all([K1, K2, K3].map((u) => espia(base, u.token, { chofer: true })));
      await esperar(1000);
      console.log(`  ${nUsuario} usuarios, PyMEs ${A} y ${B}, sockets conectados`);
      const ctx = { P1, P2, Q1, K1, K2, K3, K4, A, B, vK1, sP1, sP2, sK1, sK2, sK3 };

      await casosLugares(ctx);
      await casosSeries(ctx, leerLog);
      await casosConcurrencia(ctx, leerLog);

      if (SOLO.length === 0 || SOLO.some((n) => [8, 12].includes(n))) {
        titulo('CHEQUEO GLOBAL: lo que recibio el chofer');
        const todo = recibidoPorChofer.join('\n');
        paso(
          `CHOFER: ningun cuerpo REST ni evento de socket contiene un nombre de lugar (${recibidoPorChofer.length} mensajes)`,
          recibidoPorChofer.length > 0 && !todo.includes(MARCA),
          todo.includes(MARCA) ? todo.slice(Math.max(0, todo.indexOf(MARCA) - 200), todo.indexOf(MARCA) + 50) : ''
        );
      }
      sumarLlamadasMaps(leerLog());
    });
  } finally {
    try {
      limpio = await limpiar();
    } catch (e) {
      console.error('  ⚠️  la limpieza fallo:', e.message);
    }
  }
  paso('LIMPIEZA: no quedo nada de lo creado por el test', limpio, '');

  const ok = pasos.filter((p) => p.ok).length;
  const fallaron = pasos.filter((p) => !p.ok);
  console.log(`\n  llamadas a Google (por SKU, server 3801): ${JSON.stringify(llamadasMaps)}`);
  if (metricasSeries.length > 0) {
    console.log('\n  series creadas (del log [series] del server):');
    console.log('  tipo                          viajes  llamadas Pro  estimacion  tx      total   (cliente)');
    for (const m of metricasSeries) {
      console.log(
        `  ${m.tipo.padEnd(30)}${String(m.viajes).padStart(6)}${String(m.llamadas).padStart(14)}` +
          `${String(m.estimacion + 'ms').padStart(12)}${String(m.tx + 'ms').padStart(8)}${String(m.total + 'ms').padStart(8)}` +
          `   ${m.cliente ? m.cliente + 'ms' : '-'}`
      );
    }
  }
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
