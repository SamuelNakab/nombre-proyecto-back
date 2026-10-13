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
// Viaje interno (Pasos 2 y 3), opciones m-x: la PyME crea el viaje para un
// chofer vinculado, el chofer confirma (eligiendo vehiculo) o rechaza, lo inicia
// en el origen (= llega a la parada 1) y despues recorre parada por parada: x
// (salir de la parada actual) y 6 (confirmar la llegada a la siguiente). Salir de
// la ULTIMA finaliza el viaje. La opcion 5 (PATCH /estado) NO aplica a viajes de
// PyME (da 400). Tambien cancelar como chofer o como PyME, reasignar y editar.
//
// Lugares y series (Paso 4), opciones de DOS letras: la (crear lugar), ll
// (listar lugares), lv (crear un viaje con un lugar como origen), sa (crear
// serie), sl (listar series), sv (ver serie con sus viajes) y sc (cancelar
// serie). El evento serie:asignada se ve en vivo en los dos sockets.
// Las opciones 1, 2, 7 y 8 son del marketplace: con MARKETPLACE_HABILITADO en
// false, 1 y 2 dan 404 / error.
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
  // Ciclo del viaje interno (Paso 2).
  'viaje:asignado',
  'viaje:desasignado',
  'viaje:editado',
  'viaje:confirmado',
  'viaje:rechazado',
  'viaje:cancelado',
  'viaje:vencido',
  // Series (Paso 4).
  'serie:asignada',
  'serie:cancelada',
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
  // Lugares y series (Paso 4): el ultimo lugar y la ultima serie creados.
  idLugar: null,
  idSerie: null,
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
    console.log('  ⚠  No hay id_viaje en memoria. Primero crea un viaje (opcion m, o 1 en el marketplace).');
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

// ── Acciones del viaje interno (Paso 2) ──────────────────────────────────────

const rutaViajePyme = (sufijo = '') =>
  `/api/organizaciones/${estado.idOrganizacion}/viajes/${estado.idViaje}${sufijo}`;

async function elegirChofer() {
  const choferes = await api('GET', `/api/organizaciones/${estado.idOrganizacion}/choferes`, null, estado.clienteToken);
  const lista = Array.isArray(choferes.data) ? choferes.data : [];
  if (lista.length === 0) {
    console.log('  ⚠  La PyME no tiene choferes vinculados. Genera un codigo CHOFER (d) y canjealo (f).');
    return null;
  }
  for (const c of lista) {
    const vehiculos = c.vehiculos.map((v) => `${v.patente}[${v.condiciones.join(',')}]`).join(' ') || 'ninguno';
    console.log(`    id_conductor=${c.id_conductor} — ${c.nombre} ${c.apellido} — vehiculos: ${vehiculos}`);
  }
  return preguntarNumero('  id_conductor', lista[0].id_conductor);
}

async function preguntarCondiciones() {
  const raw = await pregunta('  Condiciones separadas por coma (FRAGIL, REFRIGERADO, CARGA_PESADA, PELIGROSO, VOLUMINOSO) []: ');
  return raw ? raw.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean) : [];
}

const siONo = async (texto) => (await pregunta(`  ${texto} (s/N): `)).toLowerCase() === 's';

async function accionCrearViajePyme() {
  if (!(await requierePyme())) return;
  const id_conductor = await elegirChofer();
  if (id_conductor == null) return;
  const minutos = await preguntarNumero('  Minutos desde ahora para fecha_programada', 30);
  const condiciones_requeridas = await preguntarCondiciones();
  const r = await api('POST', `/api/organizaciones/${estado.idOrganizacion}/viajes`, {
    id_conductor,
    fecha_programada: new Date(Date.now() + minutos * 60000).toISOString(),
    condiciones_requeridas,
    paradas: [PARADA_1, PARADA_2],
  }, estado.clienteToken);
  if (r.status === 201) estado.idViaje = r.data.id_viaje;
  mostrar('POST /api/organizaciones/:id/viajes', r);
}

async function accionViajesPyme() {
  if (!(await requierePyme())) return;
  const grupo = await pregunta('  Grupo (activos / en_curso / historial, vacio = todos): ');
  const r = await api(
    'GET', `/api/organizaciones/${estado.idOrganizacion}/viajes${grupo ? '?grupo=' + grupo : ''}`, null, estado.clienteToken
  );
  if (r.status !== 200) return mostrar('GET /api/organizaciones/:id/viajes', r);
  for (const v of r.data) {
    console.log(`    #${v.id_viaje} ${v.estado.padEnd(11)} ${v.fecha_programada} chofer=${v.conductor?.nombre ?? '—'} vencido=${v.vencido}`);
  }
}

async function accionVerViajePyme() {
  if (!(await requierePyme()) || !requiereViaje()) return;
  mostrar('GET /api/organizaciones/:id/viajes/:idViaje', await api('GET', rutaViajePyme(), null, estado.clienteToken));
}

async function accionMisViajesChofer() {
  const grupo = await pregunta('  Grupo (asignados / confirmados / en_curso / historial, vacio = todos): ');
  const r = await api('GET', `/api/choferes/viajes${grupo ? '?grupo=' + grupo : ''}`, null, estado.conductorToken);
  if (r.status !== 200) return mostrar('GET /api/choferes/viajes', r);
  for (const v of r.data) {
    console.log(`    #${v.id_viaje} ${v.estado.padEnd(11)} ${v.fecha_programada} PyME=${v.organizacion?.nombre}`);
  }
}

async function accionConfirmarViaje() {
  if (!requiereViaje()) return;
  const vehiculos = await api('GET', '/api/conductores/mis-vehiculos', null, estado.conductorToken);
  const lista = Array.isArray(vehiculos.data) ? vehiculos.data : [];
  for (const v of lista) {
    const condiciones = (v.condiciones ?? []).map((c) => c.condicion ?? c).join(',');
    console.log(`    id_vehiculo=${v.id_vehiculo} — ${v.patente} [${condiciones}]`);
  }
  const id_vehiculo = await preguntarNumero('  id_vehiculo', lista[0]?.id_vehiculo ?? 0);
  mostrar('POST /api/choferes/viajes/:id/confirmar',
    await api('POST', `/api/choferes/viajes/${estado.idViaje}/confirmar`, { id_vehiculo }, estado.conductorToken));
}

async function accionRechazarViaje() {
  if (!requiereViaje()) return;
  mostrar('POST /api/choferes/viajes/:id/rechazar',
    await api('POST', `/api/choferes/viajes/${estado.idViaje}/rechazar`, null, estado.conductorToken));
}

async function accionIniciarViajePyme() {
  if (!requiereViaje()) return;
  // Default = el origen exacto (distancia 0). Cambialo para probar "lejos del origen".
  const lat = await preguntarNumero('  lat', PARADA_1.lat);
  const lng = await preguntarNumero('  lng', PARADA_1.lng);
  mostrar('POST /api/choferes/viajes/:id/iniciar',
    await api('POST', `/api/choferes/viajes/${estado.idViaje}/iniciar`, { lat, lng }, estado.conductorToken));
}

// Ciclo por parada (Paso 3): sale de la parada actual. Si era la ultima,
// finaliza el viaje (remito, precio real, tiempos reales).
async function accionSalirDeParada() {
  if (!requiereViaje()) return;
  mostrar('POST /api/choferes/viajes/:id/salir',
    await api('POST', `/api/choferes/viajes/${estado.idViaje}/salir`, null, estado.conductorToken));
}

async function accionCancelarComoChofer() {
  if (!requiereViaje()) return;
  mostrar('POST /api/choferes/viajes/:id/cancelar',
    await api('POST', `/api/choferes/viajes/${estado.idViaje}/cancelar`, null, estado.conductorToken));
}

async function accionCancelarComoPyme() {
  if (!(await requierePyme()) || !requiereViaje()) return;
  const motivo = await pregunta('  Motivo (opcional): ');
  mostrar('POST /api/organizaciones/:id/viajes/:idViaje/cancelar',
    await api('POST', rutaViajePyme('/cancelar'), motivo ? { motivo } : {}, estado.clienteToken));
}

async function accionReasignar() {
  if (!(await requierePyme()) || !requiereViaje()) return;
  const id_conductor = await elegirChofer();
  if (id_conductor == null) return;
  mostrar('POST /api/organizaciones/:id/viajes/:idViaje/reasignar',
    await api('POST', rutaViajePyme('/reasignar'), { id_conductor }, estado.clienteToken));
}

async function accionEditar() {
  if (!(await requierePyme()) || !requiereViaje()) return;
  const body = {};
  const minutos = await pregunta('  Nueva fecha: minutos desde ahora (vacio = no cambiar): ');
  if (minutos) body.fecha_programada = new Date(Date.now() + Number(minutos) * 60000).toISOString();
  if (await siONo('Cambiar condiciones?')) body.condiciones_requeridas = await preguntarCondiciones();
  if (await siONo('Invertir las paradas?')) body.paradas = [PARADA_2, PARADA_1];
  const descripcion = await pregunta('  Descripcion (vacio = no cambiar): ');
  if (descripcion) body.descripcion = descripcion;
  mostrar('PUT /api/organizaciones/:id/viajes/:idViaje', await api('PUT', rutaViajePyme(), body, estado.clienteToken));
}

// ── Lugares y series (Paso 4) ────────────────────────────────────────────────

const rutaPyme = (sufijo) => `/api/organizaciones/${estado.idOrganizacion}${sufijo}`;

async function accionCrearLugar() {
  if (!(await requierePyme())) return;
  const nombre = (await pregunta('  Nombre [Deposito Plaza de Mayo]: ')) || 'Deposito Plaza de Mayo';
  const direccion = (await pregunta(`  Direccion [${PARADA_1.direccion}]: `)) || PARADA_1.direccion;
  const r = await api('POST', rutaPyme('/lugares'), { nombre, direccion, lat: PARADA_1.lat, lng: PARADA_1.lng }, estado.clienteToken);
  if (r.status === 201) estado.idLugar = r.data.id_lugar;
  mostrar('POST /api/organizaciones/:id/lugares', r);
}

async function accionListarLugares() {
  if (!(await requierePyme())) return;
  const r = await api('GET', rutaPyme('/lugares'), null, estado.clienteToken);
  if (r.status !== 200) return mostrar('GET /api/organizaciones/:id/lugares', r);
  if (r.data.length === 0) console.log('    (sin lugares)');
  for (const l of r.data) console.log(`    #${l.id_lugar} ${l.nombre} — ${l.direccion} (${l.lat}, ${l.lng})`);
}

// El ORIGEN sale de un lugar guardado (snapshot): el chofer ve la direccion,
// nunca el nombre.
async function accionCrearViajeConLugar() {
  if (!(await requierePyme())) return;
  const id_lugar = await preguntarNumero('  id_lugar del origen', estado.idLugar ?? 0);
  const id_conductor = await elegirChofer();
  if (id_conductor == null) return;
  const minutos = await preguntarNumero('  Minutos desde ahora para fecha_programada', 70);
  const r = await api('POST', rutaPyme('/viajes'), {
    id_conductor,
    fecha_programada: new Date(Date.now() + minutos * 60000).toISOString(),
    paradas: [{ id_lugar }, PARADA_2],
  }, estado.clienteToken);
  if (r.status === 201) estado.idViaje = r.data.id_viaje;
  mostrar('POST /api/organizaciones/:id/viajes (con lugar)', r);
}

// Fecha local de Buenos Aires (UTC-3) en YYYY-MM-DD.
const fechaLocal = (dias = 0) => new Date(Date.now() - 3 * 3600000 + dias * 86400000).toISOString().slice(0, 10);

async function accionCrearSerie() {
  if (!(await requierePyme())) return;
  const id_conductor = await elegirChofer();
  if (id_conductor == null) return;
  const frecuencia = ((await pregunta('  Frecuencia (DIARIA / DIAS_SEMANA / SEMANAL / MENSUAL) [DIARIA]: ')) || 'DIARIA').toUpperCase();
  const body = { id_conductor, frecuencia };
  if (frecuencia === 'DIAS_SEMANA') {
    const raw = (await pregunta('  Dias (1 = lunes ... 7 = domingo, separados por coma) [1,3,5]: ')) || '1,3,5';
    body.dias_semana = raw.split(',').map((d) => Number(d.trim()));
  } else if (frecuencia === 'SEMANAL') {
    body.dia_semana = await preguntarNumero('  Dia de la semana (1 = lunes ... 7 = domingo)', 1);
  } else if (frecuencia === 'MENSUAL') {
    body.dia_mes = await preguntarNumero('  Dia del mes (29-31 se ajusta a fin de mes)', 1);
  }
  body.hora = (await pregunta('  Hora local HH:MM [09:00]: ')) || '09:00';
  body.fecha_desde = (await pregunta(`  fecha_desde YYYY-MM-DD [${fechaLocal(1)}]: `)) || fechaLocal(1);
  const hasta = await pregunta('  fecha_hasta YYYY-MM-DD (vacio = desde + 30 dias): ');
  if (hasta) body.fecha_hasta = hasta;
  const usarLugar = estado.idLugar != null && (await siONo(`Usar el lugar #${estado.idLugar} como origen`));
  body.paradas = [usarLugar ? { id_lugar: estado.idLugar } : PARADA_1, PARADA_2];
  body.condiciones_requeridas = await preguntarCondiciones();
  console.log('  Creando la serie (una estimacion de Google por viaje, puede tardar unos segundos)...');
  const r = await api('POST', rutaPyme('/series'), body, estado.clienteToken);
  if (r.status !== 201) return mostrar('POST /api/organizaciones/:id/series', r);
  estado.idSerie = r.data.serie.id_serie;
  console.log(`  ✅ serie #${estado.idSerie}: ${r.data.viajes.length} viajes`);
  for (const v of r.data.viajes) console.log(`    #${v.id_viaje} ${v.fecha_programada} ${v.estado}`);
  for (const o of r.data.salteadas) console.log(`    salteada ${o.fecha}: ${o.motivo}`);
  for (const o of r.data.ajustadas) console.log(`    ajustada ${o.fecha}: ${o.motivo}`);
}

async function accionListarSeries() {
  if (!(await requierePyme())) return;
  const r = await api('GET', rutaPyme('/series'), null, estado.clienteToken);
  if (r.status !== 200) return mostrar('GET /api/organizaciones/:id/series', r);
  if (r.data.length === 0) console.log('    (sin series)');
  for (const se of r.data) {
    console.log(
      `    #${se.id_serie} ${se.estado.padEnd(9)} ${se.frecuencia} ${se.hora} ${se.fecha_desde}..${se.fecha_hasta} ` +
        `chofer=${se.conductor?.nombre ?? '—'} viajes=${JSON.stringify(se.resumen_viajes.por_estado)}`
    );
  }
}

async function accionVerSerie() {
  if (!(await requierePyme())) return;
  const id = await preguntarNumero('  id_serie', estado.idSerie ?? 0);
  const r = await api('GET', rutaPyme(`/series/${id}`), null, estado.clienteToken);
  if (r.status !== 200) return mostrar('GET /api/organizaciones/:id/series/:idSerie', r);
  console.log(`  serie #${r.data.id_serie} ${r.data.estado} ${r.data.frecuencia} ${r.data.hora} (${r.data.zona_horaria})`);
  for (const v of r.data.viajes) console.log(`    #${v.id_viaje} ${v.fecha_programada} ${v.estado} chofer=${v.conductor?.nombre ?? '—'}`);
}

async function accionCancelarSerie() {
  if (!(await requierePyme())) return;
  const id = await preguntarNumero('  id_serie a cancelar (sus viajes NO se tocan)', estado.idSerie ?? 0);
  mostrar('POST /api/organizaciones/:id/series/:idSerie/cancelar', await api('POST', rutaPyme(`/series/${id}/cancelar`), null, estado.clienteToken));
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
╠═════════════ VIAJE DE PyME (Pasos 2-3) ════════╣
║  m) Crear viaje para un chofer (cliente)       ║
║  n) Viajes de la PyME          (cliente)       ║
║  o) Mis viajes                 (conductor)     ║
║  p) Confirmar (elige vehiculo) (conductor)     ║
║  q) Rechazar                   (conductor)     ║
║  r) Iniciar en el origen       (conductor)     ║
║  x) Salir de la parada actual  (conductor)     ║
║     → llegar a la siguiente: 6 (5 no aplica)   ║
║  s) Cancelar como chofer       (conductor)     ║
║  t) Cancelar como PyME         (cliente)       ║
║  u) Reasignar a otro chofer    (cliente)       ║
║  v) Editar                     (cliente)       ║
║  w) Ver viaje de la PyME       (cliente)       ║
╠═════════════ LUGARES Y SERIES (Paso 4) ════════╣
║  la) Crear lugar               (cliente)       ║
║  ll) Listar lugares            (cliente)       ║
║  lv) Crear viaje con un lugar  (cliente)       ║
║  sa) Crear serie               (cliente)       ║
║  sl) Listar series             (cliente)       ║
║  sv) Ver serie y sus viajes    (cliente)       ║
║  sc) Cancelar serie            (cliente)       ║
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
      case 'm': await accionCrearViajePyme(); break;
      case 'n': await accionViajesPyme(); break;
      case 'o': await accionMisViajesChofer(); break;
      case 'p': await accionConfirmarViaje(); break;
      case 'q': await accionRechazarViaje(); break;
      case 'r': await accionIniciarViajePyme(); break;
      case 's': await accionCancelarComoChofer(); break;
      case 't': await accionCancelarComoPyme(); break;
      case 'u': await accionReasignar(); break;
      case 'v': await accionEditar(); break;
      case 'w': await accionVerViajePyme(); break;
      case 'x': await accionSalirDeParada(); break;
      case 'la': await accionCrearLugar(); break;
      case 'll': await accionListarLugares(); break;
      case 'lv': await accionCrearViajeConLugar(); break;
      case 'sa': await accionCrearSerie(); break;
      case 'sl': await accionListarSeries(); break;
      case 'sv': await accionVerSerie(); break;
      case 'sc': await accionCancelarSerie(); break;
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
