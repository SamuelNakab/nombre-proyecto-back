// ─────────────────────────────────────────────────────────────────────────────
// consola-manual.js — Herramienta de prueba manual del flujo de un viaje.
//
// Loguea un CLIENTE y un CONDUCTOR de prueba, abre dos sockets de Socket.io
// (uno por cada uno), escucha en vivo todos los eventos de negocio y expone un
// menu interactivo para disparar el flujo completo (crear / aceptar / iniciar /
// ping GPS / cambiar estado / confirmar parada / cancelar / ver estado) contra
// staging (o la API que se le indique). No depende del mobile ni del front.
//
// No corre en CI: es interactivo, de uso manual local. Vive en scripts/, fuera
// de los globs de lint y test.
//
// Variables de entorno (se leen de .env via dotenv, o del entorno):
//   API_URL              URL base de la API (default: staging de Railway).
//   FIREBASE_WEB_API_KEY API key WEB de Firebase (para signInWithPassword).
//   CLIENTE_EMAIL        Email del usuario de prueba con rol CLIENTE.
//   CLIENTE_PASSWORD     Password de ese cliente.
//   CONDUCTOR_EMAIL      Email del usuario de prueba con rol CONDUCTOR.
//   CONDUCTOR_PASSWORD   Password de ese conductor.
//
// Como correrlo:
//   node scripts/consola-manual.js
//
// Requiere socket.io-client (ya presente como dependencia del proyecto). Todo
// lo demas usa fetch nativo (REST) y readline nativo (menu).
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import readline from 'node:readline';
import { io } from 'socket.io-client';

// ── Configuracion ─────────────────────────────────────────────────────────────

const API_URL = process.env.API_URL || 'https://nombre-proyecto-back-staging.up.railway.app';
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
const CLIENTE_EMAIL = process.env.CLIENTE_EMAIL;
const CLIENTE_PASSWORD = process.env.CLIENTE_PASSWORD;
const CONDUCTOR_EMAIL = process.env.CONDUCTOR_EMAIL;
const CONDUCTOR_PASSWORD = process.env.CONDUCTOR_PASSWORD;

// Dos paradas reales en CABA (a <200m entre si → utiles para confirmar QR).
const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

// Estados validos para PATCH /:id/estado (segun el enum del controller).
const ESTADOS_MANUALES = ['CARGANDO', 'EN_RUTA', 'DESCARGANDO'];

// Eventos de servidor → cliente/conductor que queremos ver en vivo.
const EVENTOS = [
  'viaje:disponible',
  'viaje:conductor_asignado',
  'viaje:ya_asignado',
  'viaje:no_disponible',
  'viaje:cancelado_sin_conductor',
  'viaje:iniciado',
  'mapa:actualizar',
  'costo:actualizar',
  'eta:actualizar',
  'ruta:recalculada',
  'alerta:desvio',
  'alerta:parada',
  'viaje:estado_cambiado',
  'viaje:finalizado',
  'viaje:cancelado_por_admin',
  'error',
];

// Estado en memoria compartido por el menu.
const estado = {
  idViaje: null,
  clienteToken: null,
  conductorToken: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function pregunta(texto) {
  return new Promise((resolve) => rl.question(texto, (r) => resolve(r.trim())));
}

// Login contra Firebase Identity Toolkit → devuelve el idToken (Bearer).
async function getFirebaseToken(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await res.json();
  if (!data.idToken) {
    throw new Error(`Login Firebase fallido para ${email}: ${data.error?.message || JSON.stringify(data)}`);
  }
  return data.idToken;
}

// Llamada REST generica. Devuelve { status, data }.
async function api(method, path, body, token) {
  const res = await fetch(`${API_URL}${path}`, {
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
    data = { _raw: text.slice(0, 2000) };
  }
  return { status: res.status, data };
}

function logEvento(label, evento, data) {
  // label ya viene con padding fijo para que las flechas queden alineadas.
  console.log(`\n[${label} <-] ${evento} ${JSON.stringify(data)}`);
}

// Registra en un socket TODOS los eventos de negocio, etiquetados por rol.
function registrarEventos(socket, label) {
  for (const evento of EVENTOS) {
    socket.on(evento, (data) => logEvento(label, evento, data));
  }
}

function conectarSocket(token, label) {
  return new Promise((resolve, reject) => {
    const socket = io(API_URL, { auth: { token: 'Bearer ' + token } });
    socket.on('connect', () => {
      console.log(`  [${label}] socket conectado (${socket.id})`);
      resolve(socket);
    });
    socket.on('connect_error', (err) => reject(new Error(`connect_error (${label}): ${err.message}`)));
    socket.on('disconnect', (motivo) => console.log(`  [${label}] socket desconectado (${motivo})`));
    setTimeout(() => reject(new Error(`Timeout conectando socket ${label} (10s)`)), 10000);
  });
}

// Pide un numero con default si el input queda vacio o es invalido.
async function preguntarNumero(texto, valorDefault) {
  const raw = await pregunta(`${texto} [${valorDefault}]: `);
  if (raw === '') return valorDefault;
  const n = Number(raw);
  return Number.isNaN(n) ? valorDefault : n;
}

// ── Acciones del menu ───────────────────────────────────────────────────────

async function accionCrearViaje(sCliente) {
  void sCliente;
  const minutos = await preguntarNumero(
    'Minutos desde ahora para fecha_programada (el backend exige > ~60)',
    90
  );
  const fecha_programada = new Date(Date.now() + minutos * 60 * 1000).toISOString();

  const { status, data } = await api('POST', '/api/viajes', {
    zona: 'CABA',
    fecha_programada,
    condiciones_requeridas: [],
    paradas: [PARADA_1, PARADA_2],
  }, estado.clienteToken);

  if (status === 201) {
    estado.idViaje = data.id_viaje;
    console.log(`  ✅ Viaje creado id=${data.id_viaje} (fecha_programada=${fecha_programada})`);
  } else {
    console.log(`  ❌ POST /api/viajes → ${status}: ${JSON.stringify(data)}`);
  }
}

function requiereViaje() {
  if (estado.idViaje == null) {
    console.log('  ⚠  No hay id_viaje en memoria. Primero crea un viaje (opcion 1).');
    return false;
  }
  return true;
}

function accionAceptar(sConductor) {
  if (!requiereViaje()) return;
  sConductor.emit('viaje:aceptar', { id_viaje: estado.idViaje });
  console.log(`  → CONDUCTOR emitio viaje:aceptar { id_viaje: ${estado.idViaje} } (respuesta llega por evento)`);
}

async function accionIniciar() {
  if (!requiereViaje()) return;
  const { status, data } = await api('POST', `/api/viajes/${estado.idViaje}/iniciar`, null, estado.conductorToken);
  console.log(`  ${status === 200 ? '✅' : '❌'} POST /:id/iniciar → ${status}: ${JSON.stringify(data)}`);
}

async function accionPingGPS(sConductor) {
  if (!requiereViaje()) return;
  const lat = await preguntarNumero('lat', PARADA_1.lat);
  const lng = await preguntarNumero('lng', PARADA_1.lng);
  const payload = { id_viaje: estado.idViaje, lat, lng, timestamp: Date.now() };
  sConductor.emit('conductor:ubicacion', payload);
  console.log(`  → CONDUCTOR emitio conductor:ubicacion ${JSON.stringify(payload)}`);
}

async function accionCambiarEstado() {
  if (!requiereViaje()) return;
  console.log('  Estados: ' + ESTADOS_MANUALES.map((e, i) => `${i + 1}) ${e}`).join('  '));
  const opt = await preguntarNumero('Elegi estado', 1);
  const nuevoEstado = ESTADOS_MANUALES[opt - 1];
  if (!nuevoEstado) {
    console.log('  ⚠  Opcion invalida.');
    return;
  }
  const { status, data } = await api(
    'PATCH', `/api/viajes/${estado.idViaje}/estado`, { estado: nuevoEstado }, estado.conductorToken
  );
  console.log(`  ${status === 200 ? '✅' : '❌'} PATCH /:id/estado {${nuevoEstado}} → ${status}: ${JSON.stringify(data)}`);
}

async function accionConfirmarParada() {
  if (!requiereViaje()) return;

  // 1) tokens QR (rol CLIENTE)
  const qr = await api('GET', `/api/viajes/${estado.idViaje}/qr-paradas`, null, estado.clienteToken);
  if (qr.status !== 200 || !Array.isArray(qr.data)) {
    console.log(`  ❌ GET /:id/qr-paradas → ${qr.status}: ${JSON.stringify(qr.data)}`);
    return;
  }
  const qrs = qr.data.sort((a, b) => a.orden - b.orden);

  // 2) coords de las paradas (del detalle del viaje) para default de lat/lng
  const det = await api('GET', `/api/viajes/${estado.idViaje}`, null, estado.clienteToken);
  const paradasDet = Array.isArray(det.data?.paradas) ? det.data.paradas : [];

  console.log('  Paradas:');
  for (const q of qrs) {
    const p = paradasDet.find((x) => x.orden === q.orden);
    console.log(`    ${q.orden}) ${q.direccion} — estado=${p?.estado ?? '?'}`);
  }
  const opt = await preguntarNumero('Confirmar cual parada (orden)', qrs[0].orden);
  const elegida = qrs.find((q) => q.orden === opt);
  if (!elegida) {
    console.log('  ⚠  Orden invalido.');
    return;
  }
  const pDet = paradasDet.find((x) => x.orden === opt);
  const lat = await preguntarNumero('lat', pDet?.latitud ?? PARADA_1.lat);
  const lng = await preguntarNumero('lng', pDet?.longitud ?? PARADA_1.lng);

  const { status, data } = await api(
    'POST', `/api/viajes/${estado.idViaje}/confirmar-parada`,
    { qr_firmado: elegida.qr_firmado, lat, lng }, estado.conductorToken
  );
  console.log(`  ${status === 200 ? '✅' : '❌'} POST /:id/confirmar-parada → ${status}: ${JSON.stringify(data)}`);
}

async function accionCancelarConductor() {
  if (!requiereViaje()) return;
  const { status, data } = await api('POST', `/api/viajes/${estado.idViaje}/cancelar-conductor`, null, estado.conductorToken);
  console.log(`  ${status === 200 ? '✅' : '❌'} POST /:id/cancelar-conductor → ${status}: ${JSON.stringify(data)}`);
}

async function accionCancelarCliente() {
  if (!requiereViaje()) return;
  const { status, data } = await api('POST', `/api/viajes/${estado.idViaje}/cancelar-cliente`, null, estado.clienteToken);
  console.log(`  ${status === 200 ? '✅' : '❌'} POST /:id/cancelar-cliente → ${status}: ${JSON.stringify(data)}`);
}

async function accionVerEstado() {
  if (!requiereViaje()) return;
  const { status, data } = await api('GET', `/api/viajes/${estado.idViaje}`, null, estado.clienteToken);
  if (status !== 200) {
    console.log(`  ❌ GET /:id → ${status}: ${JSON.stringify(data)}`);
    return;
  }
  console.log(`  Viaje ${data.id_viaje}: estado=${data.estado} fecha_inicio=${data.fecha_inicio} ` +
    `puntualidad=${data.puntualidad_inicio} precio_real=${data.precio_real}`);
  console.log(`  Detalle completo: ${JSON.stringify(data)}`);
}

// ── Menu ──────────────────────────────────────────────────────────────────────

function imprimirMenu() {
  console.log(`
╔══════════════════════════════════════════════╗
║   CONSOLA MANUAL — FLETER (viaje: ${String(estado.idViaje ?? '—').padEnd(6)})     ║
╠══════════════════════════════════════════════╣
║  1) Crear viaje         (cliente, REST)        ║
║  2) Aceptar             (conductor, socket)    ║
║  3) Iniciar             (conductor, REST)      ║
║  4) Ping GPS            (conductor, socket)    ║
║  5) Cambiar estado      (conductor, REST)      ║
║  6) Confirmar parada QR (cliente+conductor)    ║
║  7) Cancelar conductor  (conductor, REST)      ║
║  8) Cancelar cliente    (cliente, REST)        ║
║  9) Ver estado del viaje(REST)                 ║
║  0) Salir                                      ║
╚══════════════════════════════════════════════╝`);
}

async function loopMenu(sCliente, sConductor) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    imprimirMenu();
    const opt = (await pregunta('> ')).trim();
    switch (opt) {
      case '1': await accionCrearViaje(sCliente); break;
      case '2': accionAceptar(sConductor); break;
      case '3': await accionIniciar(); break;
      case '4': await accionPingGPS(sConductor); break;
      case '5': await accionCambiarEstado(); break;
      case '6': await accionConfirmarParada(); break;
      case '7': await accionCancelarConductor(); break;
      case '8': await accionCancelarCliente(); break;
      case '9': await accionVerEstado(); break;
      case '0':
        console.log('  Cerrando…');
        try { sCliente.disconnect(); } catch { /* noop */ }
        try { sConductor.disconnect(); } catch { /* noop */ }
        rl.close();
        process.exit(0);
        break;
      default:
        console.log('  ⚠  Opcion invalida.');
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function validarEnv() {
  const faltantes = [];
  if (!FIREBASE_WEB_API_KEY) faltantes.push('FIREBASE_WEB_API_KEY');
  if (!CLIENTE_EMAIL) faltantes.push('CLIENTE_EMAIL');
  if (!CLIENTE_PASSWORD) faltantes.push('CLIENTE_PASSWORD');
  if (!CONDUCTOR_EMAIL) faltantes.push('CONDUCTOR_EMAIL');
  if (!CONDUCTOR_PASSWORD) faltantes.push('CONDUCTOR_PASSWORD');
  if (faltantes.length > 0) {
    console.error(`Faltan variables de entorno: ${faltantes.join(', ')}`);
    console.error('Definilas en .env (ver comentario al inicio de este archivo).');
    process.exit(1);
  }
}

async function main() {
  validarEnv();
  console.log(`\nConsola manual Fleter — API: ${API_URL}\n`);

  console.log('Autenticando cliente y conductor en Firebase…');
  estado.clienteToken = await getFirebaseToken(CLIENTE_EMAIL, CLIENTE_PASSWORD);
  estado.conductorToken = await getFirebaseToken(CONDUCTOR_EMAIL, CONDUCTOR_PASSWORD);
  console.log('  Tokens obtenidos.');

  console.log('Conectando sockets…');
  const sCliente = await conectarSocket(estado.clienteToken, 'CLIENTE  ');
  const sConductor = await conectarSocket(estado.conductorToken, 'CONDUCTOR');

  registrarEventos(sCliente, 'CLIENTE  ');
  registrarEventos(sConductor, 'CONDUCTOR');
  console.log('  Escuchando eventos en vivo en ambos sockets.');

  // Salida limpia con Ctrl+C.
  process.on('SIGINT', () => {
    console.log('\n  SIGINT — cerrando…');
    try { sCliente.disconnect(); } catch { /* noop */ }
    try { sConductor.disconnect(); } catch { /* noop */ }
    try { rl.close(); } catch { /* noop */ }
    process.exit(0);
  });

  await loopMenu(sCliente, sConductor);
}

main().catch((e) => {
  console.error('\n💥 Error fatal:', e.message);
  try { rl.close(); } catch { /* noop */ }
  process.exit(1);
});
