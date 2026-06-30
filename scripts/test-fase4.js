import 'dotenv/config';
import { io as socketClient } from 'socket.io-client';
import prisma from '../src/config/prisma.js';

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';

const CLIENTE_EMAIL = 'cliente@test.com';
const CLIENTE_PASS = 'test123456';
const CONDUCTOR_EMAIL = 'conductor@test.com';
const CONDUCTOR_PASS = 'test123456';

const checks = [];
function check(nombre, ok, detalle) {
  checks.push({ nombre, ok, detalle: detalle ?? '' });
  console.log((ok ? '✓' : '✗') + ' ' + nombre + (detalle ? ': ' + detalle : ''));
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function firebaseLogin(email, password) {
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FIREBASE_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await res.json();
  return data.idToken || null;
}

async function obtenerTokens() {
  let clienteToken = await firebaseLogin(CLIENTE_EMAIL, CLIENTE_PASS);
  if (!clienteToken) {
    await api('POST', '/api/auth/registro-cliente', {
      nombre: 'Cliente', apellido: 'Test', dni: '11111111',
      email: CLIENTE_EMAIL, contrasena: CLIENTE_PASS,
    });
    clienteToken = await firebaseLogin(CLIENTE_EMAIL, CLIENTE_PASS);
  }

  let conductorToken = await firebaseLogin(CONDUCTOR_EMAIL, CONDUCTOR_PASS);
  if (!conductorToken) {
    await api('POST', '/api/auth/registro-conductor', {
      nombre: 'Conductor', apellido: 'Uno', dni: '22222222',
      email: CONDUCTOR_EMAIL, contrasena: CONDUCTOR_PASS,
      nro_licencia: 'LIC001', licencia_vencimiento: '2028-01-01T00:00:00.000Z',
    });
    conductorToken = await firebaseLogin(CONDUCTOR_EMAIL, CONDUCTOR_PASS);
  }

  return { clienteToken, conductorToken };
}

function conectarSocket(token) {
  return new Promise((resolve, reject) => {
    const s = socketClient(BASE, { auth: { token: 'Bearer ' + token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('timeout socket')), 8000);
  });
}

async function main() {
  console.log('\n=== TEST FASE 4 — FLETER ===\n');

  const { clienteToken, conductorToken } = await obtenerTokens();
  if (!clienteToken || !conductorToken) {
    console.error('No se pudieron obtener los tokens.');
    process.exit(1);
  }
  console.log('Tokens obtenidos\n');

  // ── TEST A: Endpoints REST ─────────────────────────────────────────
  const fechaFutura = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const { status: s1, data: viajeCreado } = await api('POST', '/api/viajes', {
    zona: 'CABA',
    fecha_programada: fechaFutura,
    condiciones_requeridas: [],
    paradas: [
      { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo' },
      { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta' },
    ],
  }, clienteToken);

  check('Viaje creado con precio_estimado',
    s1 === 201 && viajeCreado.precio_estimado != null && viajeCreado.precio_estimado > 0,
    s1 !== 201 ? JSON.stringify(viajeCreado) : 'id=' + viajeCreado.id_viaje + ' precio=' + viajeCreado.precio_estimado);

  check('desglose_estimado presente en la respuesta del viaje',
    !!viajeCreado.desglose_estimado,
    viajeCreado.desglose_estimado ? 'ok' : 'ausente');

  if (s1 !== 201) { console.error('No se pudo crear el viaje.'); process.exit(1); }
  const id_viaje = viajeCreado.id_viaje;

  const { status: sCA0, data: dCA0 } = await api('GET', '/api/viajes/' + id_viaje + '/costo-acumulado', null, clienteToken);
  check('GET costo-acumulado devuelve 0 antes del GPS',
    sCA0 === 200 && dCA0.precio_acumulado === 0,
    'status=' + sCA0 + ' precio=' + dCA0.precio_acumulado);

  // ── TEST B: WebSocket + GPS ────────────────────────────────────────
  let sConductor;
  try {
    sConductor = await conectarSocket(conductorToken);
  } catch (e) {
    console.error('Error conectando conductor socket:', e.message);
    process.exit(1);
  }
  check('Socket conductor conectado', true);

  // Wait for unirseARoomsDisponibles to complete before emitting
  await esperar(1500);

  let sCliente;
  try {
    sCliente = await conectarSocket(clienteToken);
  } catch (e) {
    console.error('Error conectando cliente socket:', e.message);
    process.exit(1);
  }
  check('Socket cliente conectado', true);

  // Conductor is in viaje:${id_viaje} room; listen there for conductor_asignado
  let asignado = null;
  sConductor.on('viaje:conductor_asignado', (d) => { if (!asignado) asignado = d; });
  sCliente.on('viaje:conductor_asignado', (d) => { if (!asignado) asignado = d; });

  sConductor.emit('viaje:aceptar', { id_viaje });
  await esperar(3000);

  check('viaje:conductor_asignado recibido',
    asignado !== null,
    asignado ? 'ok' : 'no recibido');

  check('id_usuario_conductor presente en viaje:conductor_asignado',
    asignado?.id_usuario_conductor != null,
    asignado ? 'id=' + asignado.id_usuario_conductor : 'no recibido');

  // Listen for GPS events (only conductor socket is in the room)
  const eventos_mapa = [];
  const eventos_estado = [];
  sConductor.on('mapa:actualizar', (d) => eventos_mapa.push(d));
  sCliente.on('mapa:actualizar', (d) => eventos_mapa.push(d));
  sConductor.on('viaje:estado_cambiado', (d) => eventos_estado.push(d));
  sCliente.on('viaje:estado_cambiado', (d) => eventos_estado.push(d));

  // Send 5 normal pings along the route (state = CONDUCTOR_ASIGNADO)
  // First ping triggers auto state change to EN_CAMINO_A_ORIGEN
  const origen = { lat: -34.6037, lng: -58.3816 };
  const destino = { lat: -34.5895, lng: -58.3974 };
  const now = Date.now();

  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const lat = origen.lat + (destino.lat - origen.lat) * t;
    const lng = origen.lng + (destino.lng - origen.lng) * t;
    sConductor.emit('conductor:ubicacion', { id_viaje, lat, lng, timestamp: now + i * 15000 });
    await esperar(200);
  }
  await esperar(2000);

  check('Al menos 3 eventos mapa:actualizar recibidos',
    eventos_mapa.length >= 3,
    'recibidos: ' + eventos_mapa.length);

  const enCaminoOk = eventos_estado.some(
    (e) => e.estado_anterior === 'CONDUCTOR_ASIGNADO' && e.estado_nuevo === 'EN_CAMINO_A_ORIGEN'
  );
  check('viaje:estado_cambiado recibido (EN_CAMINO_A_ORIGEN)',
    enCaminoOk,
    enCaminoOk ? 'ok' : 'estados recibidos: ' + JSON.stringify(eventos_estado));

  // Change state to EN_RUTA so desvio/parada checks run
  await prisma.viaje.update({ where: { id_viaje }, data: { estado: 'EN_RUTA' } });
  await esperar(300);

  // Listen for alerts
  const alertas_desvio = [];
  const alertas_parada = [];
  sConductor.on('alerta:desvio', (d) => alertas_desvio.push(d));
  sCliente.on('alerta:desvio', (d) => alertas_desvio.push(d));
  sConductor.on('alerta:parada', (d) => alertas_parada.push(d));
  sCliente.on('alerta:parada', (d) => alertas_parada.push(d));

  // Send pings far from route (~111km off) to trigger alerta:desvio
  // Then same position with velocity=0 to trigger alerta:parada
  const farLat = origen.lat + 1.0;
  const farLng = origen.lng;
  const tsAlert = now + 5 * 15000;

  // Ping 1: large jump → high velocity → parada counter resets; desvio fires
  sConductor.emit('conductor:ubicacion', { id_viaje, lat: farLat, lng: farLng, timestamp: tsAlert });
  await esperar(600);

  // Ping 2: same position → velocity = 0 → parada counter = 1 → fires (0.25 min >= 0.1)
  sConductor.emit('conductor:ubicacion', { id_viaje, lat: farLat, lng: farLng, timestamp: tsAlert + 15000 });
  await esperar(600);

  // Ping 3: extra safety
  sConductor.emit('conductor:ubicacion', { id_viaje, lat: farLat, lng: farLng, timestamp: tsAlert + 30000 });
  await esperar(600);

  await esperar(2000);

  check('Al menos 1 alerta:desvio recibida',
    alertas_desvio.length >= 1,
    'recibidas: ' + alertas_desvio.length);

  check('Al menos 1 alerta:parada recibida',
    alertas_parada.length >= 1,
    'recibidas: ' + alertas_parada.length);

  // ── TEST C: Estado manual ──────────────────────────────────────────
  const { status: sCarg, data: dCarg } = await api('PATCH', '/api/viajes/' + id_viaje + '/estado', { estado: 'CARGANDO' }, conductorToken);
  check('PATCH estado CARGANDO responde 200',
    sCarg === 200,
    sCarg !== 200 ? JSON.stringify(dCarg) : 'ok');

  const { status: s403 } = await api('PATCH', '/api/viajes/' + id_viaje + '/estado', { estado: 'CARGANDO' }, clienteToken);
  check('PATCH estado como cliente da 403', s403 === 403, 'status=' + s403);

  const { status: sCA2, data: dCA2 } = await api('GET', '/api/viajes/' + id_viaje + '/costo-acumulado', null, clienteToken);
  check('GET costo-acumulado tiene precio > 0 despues del GPS',
    sCA2 === 200 && dCA2.precio_acumulado > 0,
    'precio_acumulado=' + dCA2.precio_acumulado);

  // ── RESUMEN ────────────────────────────────────────────────────────
  console.log('\n=== RESUMEN ===\n');
  const pasaron = checks.filter((c) => c.ok).length;
  const fallaron = checks.filter((c) => !c.ok);
  checks.forEach((c) => console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.nombre));
  console.log('\n' + pasaron + '/' + checks.length + ' checks pasaron');
  if (fallaron.length > 0) {
    console.log('\nFallaron:');
    fallaron.forEach((c) => console.log('  ✗ ' + c.nombre + ': ' + c.detalle));
  }

  sConductor.disconnect();
  sCliente.disconnect();
  await prisma.$disconnect();
  process.exit(fallaron.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Error fatal:', e.message);
  process.exit(1);
});
