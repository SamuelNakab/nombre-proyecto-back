import 'dotenv/config';
import { io as ioClient } from 'socket.io-client';
import { createClient } from 'redis';

// Reducir umbral para que alerta:parada se dispare con 4 pings a 0 km/h
process.env.PARADA_SOSPECHOSA_MINUTOS = '0.05';

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';

const CLIENTE_EMAIL = 'cliente@test.com';
const CLIENTE_PASS = 'test123456';
const CONDUCTOR_EMAIL = 'conductor@test.com';
const CONDUCTOR_PASS = 'test123456';

const checks = [];
function check(nombre, ok, detalle) {
  checks.push({ nombre, ok, detalle: detalle ?? '' });
  const d = detalle ? ': ' + detalle : '';
  console.log((ok ? '✓' : '✗') + ' ' + nombre + d);
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

async function verificarRedis() {
  const client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  try {
    await client.connect();
    await client.ping();
    await client.disconnect();
    return true;
  } catch {
    return false;
  }
}

function conectarSocket(token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE, { auth: { token: 'Bearer ' + token } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('timeout socket')), 8000);
  });
}

async function main() {
  console.log('\n=== TEST FASE 4 — FLETER ===\n');

  const redisOk = await verificarRedis();
  if (!redisOk) {
    console.error('Redis no disponible. Levantá Redis antes de correr el test.');
    process.exit(1);
  }
  console.log('Redis disponible\n');

  const { clienteToken, conductorToken } = await obtenerTokens();
  if (!clienteToken || !conductorToken) {
    console.error('No se pudieron obtener los tokens de Firebase.');
    process.exit(1);
  }
  console.log('Tokens obtenidos\n');

  // ── TEST A ────────────────────────────────────────────────────────────────
  console.log('--- TEST A: Endpoints REST de Fase 4 ---');

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

  check(
    'Viaje creado con precio_estimado y desglose',
    s1 === 201 && viajeCreado.precio_estimado != null && viajeCreado.desglose_estimado != null,
    s1 !== 201 ? JSON.stringify(viajeCreado) : 'id=' + viajeCreado.id_viaje + ' precio=' + viajeCreado.precio_estimado
  );

  if (s1 !== 201) { process.exit(1); }
  const id_viaje = viajeCreado.id_viaje;

  const { status: sCA0, data: dCA0 } = await api('GET', '/api/viajes/' + id_viaje + '/costo-acumulado', null, clienteToken);
  check('GET costo-acumulado devuelve 0 antes del GPS',
    sCA0 === 200 && dCA0.precio_acumulado === 0,
    'status=' + sCA0 + ' precio=' + dCA0.precio_acumulado);

  const { status: sCA403 } = await api('GET', '/api/viajes/' + id_viaje + '/costo-acumulado', null, conductorToken);
  check('costo-acumulado con token de conductor (sin acceso) da 403', sCA403 === 403, 'status=' + sCA403);

  // ── TEST B ────────────────────────────────────────────────────────────────
  console.log('\n--- TEST B: GPS via WebSocket ---');

  let sConductor, sCliente;
  try {
    [sConductor, sCliente] = await Promise.all([
      conectarSocket(conductorToken),
      conectarSocket(clienteToken),
    ]);
  } catch (e) {
    console.error('Error conectando sockets:', e.message);
    process.exit(1);
  }
  check('Conductor conectado al WebSocket', true);
  check('Cliente conectado al WebSocket', true);

  let asignado = null;
  sCliente.on('viaje:conductor_asignado', (d) => { asignado = d; });
  sConductor.on('viaje:conductor_asignado', (d) => { if (!asignado) asignado = d; });
  sConductor.emit('viaje:aceptar', { id_viaje });
  await esperar(2500);

  check(
    'viaje:conductor_asignado recibido con id_usuario_conductor',
    asignado !== null && asignado.id_usuario_conductor != null,
    asignado ? 'id_usuario_conductor=' + asignado.id_usuario_conductor : 'no recibido'
  );

  const eventos_mapa = [];
  const eventos_costo = [];
  const eventos_estado = [];
  const alertas_desvio = [];
  const alertas_parada = [];

  for (const s of [sConductor, sCliente]) {
    s.on('mapa:actualizar', (d) => eventos_mapa.push(d));
    s.on('costo:actualizar', (d) => eventos_costo.push(d));
    s.on('viaje:estado_cambiado', (d) => eventos_estado.push(d));
    s.on('alerta:desvio', (d) => alertas_desvio.push(d));
    s.on('alerta:parada', (d) => alertas_parada.push(d));
  }

  const paradas = (viajeCreado.paradas ?? []).sort((a, b) => a.orden - b.orden);
  const origen = paradas[0] ?? { latitud: -34.6037, longitud: -58.3816 };
  const destino = paradas[paradas.length - 1] ?? { latitud: -34.5895, longitud: -58.3974 };
  const now = Date.now();

  for (let i = 0; i < 10; i++) {
    let lat, lng;
    if (i < 5) {
      const t = i / 4;
      lat = origen.latitud + (destino.latitud - origen.latitud) * t;
      lng = origen.longitud + (destino.longitud - origen.longitud) * t;
    } else if (i === 5) {
      lat = origen.latitud + 0.05;
      lng = origen.longitud + 0.05;
    } else {
      lat = -34.65;
      lng = -58.45;
    }
    sConductor.emit('conductor:ubicacion', { id_viaje, lat, lng, timestamp: now + i * 500 });
    await esperar(500);
  }
  await esperar(2000);

  check('Al menos 5 eventos mapa:actualizar recibidos', eventos_mapa.length >= 5, 'recibidos: ' + eventos_mapa.length);

  const cambioEstadoOk = eventos_estado.some(
    (e) => e.estado_anterior === 'CONDUCTOR_ASIGNADO' && e.estado_nuevo === 'EN_CAMINO_A_ORIGEN'
  );
  check(
    'viaje:estado_cambiado recibido (CONDUCTOR_ASIGNADO → EN_CAMINO_A_ORIGEN)',
    cambioEstadoOk,
    cambioEstadoOk ? 'ok' : 'estados: ' + JSON.stringify(eventos_estado)
  );

  check('Al menos 1 evento alerta:desvio recibido', alertas_desvio.length >= 1, 'recibidos: ' + alertas_desvio.length);
  check('Al menos 1 evento alerta:parada recibido', alertas_parada.length >= 1, 'recibidos: ' + alertas_parada.length);

  // ── TEST C ────────────────────────────────────────────────────────────────
  console.log('\n--- TEST C: Endpoints de cambio de estado ---');

  const { status: sCarg, data: dCarg } = await api('PATCH', '/api/viajes/' + id_viaje + '/estado', { estado: 'CARGANDO' }, conductorToken);
  check('PATCH estado CARGANDO responde 200', sCarg === 200, sCarg !== 200 ? JSON.stringify(dCarg) : 'ok');

  const { status: sDesc, data: dDesc } = await api('PATCH', '/api/viajes/' + id_viaje + '/estado', { estado: 'DESCARGANDO' }, conductorToken);
  check('PATCH estado DESCARGANDO responde 200', sDesc === 200, sDesc !== 200 ? JSON.stringify(dDesc) : 'ok');

  const { status: s403 } = await api('PATCH', '/api/viajes/' + id_viaje + '/estado', { estado: 'CARGANDO' }, clienteToken);
  check('PATCH estado como cliente da 403', s403 === 403, 'status=' + s403);

  const { status: sCA2, data: dCA2 } = await api('GET', '/api/viajes/' + id_viaje + '/costo-acumulado', null, clienteToken);
  check('GET costo-acumulado tiene precio > 0 despues del GPS',
    sCA2 === 200 && dCA2.precio_acumulado > 0,
    'precio_acumulado=' + dCA2.precio_acumulado);

  // ── RESUMEN ───────────────────────────────────────────────────────────────
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
  process.exit(fallaron.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Error fatal:', e.message);
  process.exit(1);
});
