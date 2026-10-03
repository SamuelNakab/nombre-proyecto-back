// ─────────────────────────────────────────────────────────────────────────────
// consola-manual.js — Herramienta de prueba manual del flujo de un viaje.
//
// Loguea un CLIENTE y un CONDUCTOR de prueba, abre dos sockets de Socket.io
// (uno por cada uno), escucha en vivo todos los eventos de negocio y expone un
// menu interactivo para disparar el flujo completo (crear / aceptar / iniciar /
// ping GPS / cambiar estado / confirmar parada / cancelar / ver estado) contra
// staging (o la API que se le indique). No depende del mobile ni del front.
//
// Identidad (Paso 1), opciones con LETRA: perfil, crear PyME, invitaciones
// (MIEMBRO / CHOFER), canje como cliente o conductor, miembros, choferes, "mis
// PyMEs" del conductor y desvincular desde los dos lados. El CLIENTE de prueba
// opera la PyME; el CONDUCTOR de prueba es el chofer.
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

// Dos paradas reales en CABA. Al confirmar, el default de lat/lng es la
// coordenada de la parada elegida (distancia 0 → siempre dentro del radio).
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
  // Identidad: la PyME del cliente (sale de /me) y el ultimo codigo generado
  // (el backend lo muestra UNA sola vez, asi que lo guardamos para canjearlo).
  idOrganizacion: null,
  ultimoCodigo: null,
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

  // Las paradas (id_parada + coords + estado) salen del detalle del viaje.
  const det = await api('GET', `/api/viajes/${estado.idViaje}`, null, estado.conductorToken);
  if (det.status !== 200 || !Array.isArray(det.data?.paradas)) {
    console.log(`  ❌ GET /:id → ${det.status}: ${JSON.stringify(det.data)}`);
    return;
  }
  const paradas = [...det.data.paradas].sort((a, b) => a.orden - b.orden);

  console.log('  Paradas:');
  for (const p of paradas) {
    console.log(`    ${p.orden}) ${p.direccion} — id_parada=${p.id_parada} estado=${p.estado}`);
  }
  const opt = await preguntarNumero('Confirmar cual parada (orden)', paradas[0].orden);
  const elegida = paradas.find((p) => p.orden === opt);
  if (!elegida) {
    console.log('  ⚠  Orden invalido.');
    return;
  }

  // Default = la coordenada exacta de la parada, para que confirme sin pelear
  // con el radio. Cambiala a mano si queres probar el rechazo por distancia.
  const lat = await preguntarNumero('lat', elegida.latitud);
  const lng = await preguntarNumero('lng', elegida.longitud);

  const { status, data } = await api(
    'POST', `/api/viajes/${estado.idViaje}/confirmar-parada`,
    { id_parada: elegida.id_parada, lat, lng }, estado.conductorToken
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

// ── Acciones de identidad (Paso 1) ───────────────────────────────────────────

function mostrar(etiqueta, { status, data }) {
  const ok = status >= 200 && status < 300;
  console.log(`  ${ok ? '✅' : '❌'} ${etiqueta} → ${status}: ${JSON.stringify(data, null, 2)}`);
}

// Refresca la PyME del cliente desde /me (organizacion null = huerfano).
async function refrescarPyme() {
  const r = await api('GET', '/api/auth/me', null, estado.clienteToken);
  estado.idOrganizacion = r.data?.organizacion?.id_organizacion ?? null;
  return r;
}

async function requierePyme() {
  if (estado.idOrganizacion == null) await refrescarPyme();
  if (estado.idOrganizacion == null) {
    console.log('  ⚠  El cliente no tiene PyME (huerfano). Crea una (c) o canjea un codigo de MIEMBRO (g).');
    return false;
  }
  return true;
}

async function accionPerfil(quien) {
  const token = quien === 'cliente' ? estado.clienteToken : estado.conductorToken;
  const r = await api('GET', '/api/auth/me', null, token);
  if (quien === 'cliente') estado.idOrganizacion = r.data?.organizacion?.id_organizacion ?? null;
  mostrar(`GET /api/auth/me (${quien})`, r);
}

async function accionCrearPyme() {
  const nombre = (await pregunta('  Nombre de la PyME: ')) || `PyME consola ${Date.now()}`;
  const cuit = await pregunta('  CUIT (11 digitos, con o sin guiones; ej. 33-69345023-9): ');
  const r = await api('POST', '/api/organizaciones', { nombre, cuit }, estado.clienteToken);
  if (r.status === 201) estado.idOrganizacion = r.data.id_organizacion;
  mostrar('POST /api/organizaciones', r);
}

async function accionCrearInvitacion() {
  if (!(await requierePyme())) return;
  const tipo = (await pregunta('  Tipo (1=CHOFER, 2=MIEMBRO) [1]: ')) === '2' ? 'MIEMBRO' : 'CHOFER';
  const r = await api('POST', `/api/organizaciones/${estado.idOrganizacion}/invitaciones`, { tipo }, estado.clienteToken);
  if (r.status === 201) {
    estado.ultimoCodigo = r.data.codigo;
    console.log(`  🔑 Codigo ${tipo}: ${r.data.codigo}  (el backend no lo vuelve a mostrar; queda guardado para canjear)`);
  }
  mostrar('POST /api/organizaciones/:id/invitaciones', r);
}

async function accionListarInvitaciones() {
  if (!(await requierePyme())) return;
  mostrar('GET /api/organizaciones/:id/invitaciones',
    await api('GET', `/api/organizaciones/${estado.idOrganizacion}/invitaciones`, null, estado.clienteToken));
}

async function accionCanjear(quien) {
  const token = quien === 'cliente' ? estado.clienteToken : estado.conductorToken;
  const sugerido = estado.ultimoCodigo ?? '';
  const raw = await pregunta(`  Codigo a canjear como ${quien} [${sugerido || 'ninguno guardado'}]: `);
  const codigo = raw || sugerido;
  if (!codigo) {
    console.log('  ⚠  No hay codigo. Genera uno con (d).');
    return;
  }
  const r = await api('POST', '/api/invitaciones/canjear', { codigo }, token);
  if (quien === 'cliente' && r.status === 200) estado.idOrganizacion = r.data.organizacion.id_organizacion;
  mostrar(`POST /api/invitaciones/canjear (${quien})`, r);
}

async function accionListarMiembros() {
  if (!(await requierePyme())) return;
  mostrar('GET /api/organizaciones/:id/miembros',
    await api('GET', `/api/organizaciones/${estado.idOrganizacion}/miembros`, null, estado.clienteToken));
}

async function accionListarChoferes() {
  if (!(await requierePyme())) return;
  mostrar('GET /api/organizaciones/:id/choferes',
    await api('GET', `/api/organizaciones/${estado.idOrganizacion}/choferes`, null, estado.clienteToken));
}

async function accionMisPymes() {
  mostrar('GET /api/choferes/mis-organizaciones',
    await api('GET', '/api/choferes/mis-organizaciones', null, estado.conductorToken));
}

async function accionDesvincularDesdePyme() {
  if (!(await requierePyme())) return;
  const choferes = await api('GET', `/api/organizaciones/${estado.idOrganizacion}/choferes`, null, estado.clienteToken);
  const lista = Array.isArray(choferes.data) ? choferes.data : [];
  lista.forEach((c) => console.log(`    id_conductor=${c.id_conductor} — ${c.nombre} ${c.apellido}`));
  const id = await preguntarNumero('  id_conductor a desvincular', lista[0]?.id_conductor ?? 0);
  mostrar('DELETE /api/organizaciones/:id/choferes/:idConductor',
    await api('DELETE', `/api/organizaciones/${estado.idOrganizacion}/choferes/${id}`, null, estado.clienteToken));
}

async function accionDesvincularme() {
  const mias = await api('GET', '/api/choferes/mis-organizaciones', null, estado.conductorToken);
  const lista = Array.isArray(mias.data) ? mias.data : [];
  lista.forEach((o) => console.log(`    id_organizacion=${o.id_organizacion} — ${o.nombre}`));
  const id = await preguntarNumero('  id_organizacion de la que desvincularse', lista[0]?.id_organizacion ?? 0);
  mostrar('DELETE /api/choferes/mis-organizaciones/:id',
    await api('DELETE', `/api/choferes/mis-organizaciones/${id}`, null, estado.conductorToken));
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
║  6) Confirmar parada     (conductor, REST)     ║
║  7) Cancelar conductor  (conductor, REST)      ║
║  8) Cancelar cliente    (cliente, REST)        ║
║  9) Ver estado del viaje(REST)                 ║
╠═════════════ IDENTIDAD (PyME: ${String(estado.idOrganizacion ?? '—').padEnd(6)}) ════════╣
║  a) Perfil del cliente      (/me)              ║
║  b) Perfil del conductor    (/me)              ║
║  c) Crear PyME              (cliente)          ║
║  d) Generar codigo          (cliente)          ║
║  e) Invitaciones pendientes (cliente)          ║
║  f) Canjear codigo          (conductor)        ║
║  g) Canjear codigo          (cliente)          ║
║  h) Miembros de la PyME     (cliente)          ║
║  i) Choferes de la PyME     (cliente)          ║
║  j) Mis PyMEs               (conductor)        ║
║  k) Desvincular chofer      (cliente)          ║
║  l) Desvincularme           (conductor)        ║
║  0) Salir                                      ║
╚══════════════════════════════════════════════╝`);
}

async function loopMenu(sCliente, sConductor) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    imprimirMenu();
    const opt = (await pregunta('> ')).trim().toLowerCase();
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
      case 'a': await accionPerfil('cliente'); break;
      case 'b': await accionPerfil('conductor'); break;
      case 'c': await accionCrearPyme(); break;
      case 'd': await accionCrearInvitacion(); break;
      case 'e': await accionListarInvitaciones(); break;
      case 'f': await accionCanjear('conductor'); break;
      case 'g': await accionCanjear('cliente'); break;
      case 'h': await accionListarMiembros(); break;
      case 'i': await accionListarChoferes(); break;
      case 'j': await accionMisPymes(); break;
      case 'k': await accionDesvincularDesdePyme(); break;
      case 'l': await accionDesvincularme(); break;
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
