import { io } from 'socket.io-client';
import prisma from '../src/config/prisma.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const BASE = 'http://localhost:3000';

const checks = [];
function check(nombre, ok, detalle = '') {
  checks.push({ nombre, ok, detalle });
  console.log(`${ok ? '✓' : '✗'} ${nombre}${detalle ? ': ' + detalle : ''}`);
}
function esperar(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getToken(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  const data = await res.json();
  return data.idToken || null;
}

async function api(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: res.status, data: await res.json() };
}

async function conectar(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token: 'Bearer ' + token } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', e => reject(e));
    setTimeout(() => reject(new Error('timeout conexion')), 5000);
  });
}

async function registrarSiNoExiste(datos, tipo) {
  const endpoint = tipo === 'cliente'
    ? '/api/auth/registro-cliente'
    : '/api/auth/registro-conductor';
  await api('POST', endpoint, datos, null);
}

async function main() {
  console.log('\n=== TEST BUGS 2 — FLETER ===\n');

  // Registrar usuarios si no existen
  await registrarSiNoExiste({
    nombre:'Test', apellido:'Cliente', dni:'11111111',
    email:'cliente@test.com', contrasena:'test123456'
  }, 'cliente');

  await registrarSiNoExiste({
    nombre:'Conductor', apellido:'Uno', dni:'22222222',
    email:'conductor@test.com', contrasena:'test123456',
    nro_licencia:'LIC001', licencia_vencimiento:'2028-01-01T00:00:00.000Z'
  }, 'conductor');

  await registrarSiNoExiste({
    nombre:'Conductor', apellido:'Dos', dni:'33333333',
    email:'conductor2@test.com', contrasena:'test123456',
    nro_licencia:'LIC002', licencia_vencimiento:'2028-01-01T00:00:00.000Z'
  }, 'conductor');

  // Obtener tokens
  const clienteToken = await getToken('cliente@test.com', 'test123456');
  const conductor1Token = await getToken('conductor@test.com', 'test123456');
  const conductor2Token = await getToken('conductor2@test.com', 'test123456');

  check('Tokens obtenidos', !!clienteToken && !!conductor1Token && !!conductor2Token);
  if (!clienteToken || !conductor1Token || !conductor2Token) {
    console.log('No se pudieron obtener los tokens. Abortando.');
    process.exit(1);
  }

  // TEST BUG 1 — endpoint GET /api/viajes/disponibles
  console.log('\n--- TEST BUG 1: endpoint viajes disponibles ---');

  const { status: s1, data: d1 } = await api('GET', '/api/viajes/disponibles', null, conductor1Token);
  check('GET /api/viajes/disponibles responde 200', s1 === 200,
    s1 !== 200 ? JSON.stringify(d1) : '');
  check('Respuesta es un array', Array.isArray(d1),
    !Array.isArray(d1) ? typeof d1 : '');

  // Verificar que el endpoint rechaza a un cliente
  const { status: s1b } = await api('GET', '/api/viajes/disponibles', null, clienteToken);
  check('GET /api/viajes/disponibles rechaza rol CLIENTE con 403', s1b === 403);

  // TEST BUG 2 — race condition en matching
  console.log('\n--- TEST BUG 2: race condition en matching ---');

  // Crear viaje
  const { status: sv, data: viaje } = await api('POST', '/api/viajes', {
    zona: 'CABA',
    fecha_programada: '2026-09-01T10:00:00.000Z',
    condiciones_requeridas: [],
    paradas: [
      { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo' },
      { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta' }
    ]
  }, clienteToken);

  check('Viaje creado', sv === 201, sv !== 201 ? JSON.stringify(viaje) : '');
  if (sv !== 201) { console.log('No se pudo crear viaje. Abortando.'); process.exit(1); }

  const id_viaje = viaje.id_viaje;

  // Conectar sockets
  const [sC1, sC2, sCliente] = await Promise.all([
    conectar(conductor1Token),
    conectar(conductor2Token),
    conectar(clienteToken)
  ]);
  check('Tres sockets conectados', true);

  // Registrar eventos recibidos
  const eventos = {
    c1_asignado: null,
    c1_ya_asignado: null,
    c1_no_disponible: null,
    c2_asignado: null,
    c2_ya_asignado: null,
    c2_no_disponible: null,
    cliente_asignado: null
  };

  sC1.on('viaje:conductor_asignado', d => { eventos.c1_asignado = d; });
  sC1.on('viaje:ya_asignado', d => { eventos.c1_ya_asignado = d; });
  sC1.on('viaje:no_disponible', d => { eventos.c1_no_disponible = d; });
  sC2.on('viaje:conductor_asignado', d => { eventos.c2_asignado = d; });
  sC2.on('viaje:ya_asignado', d => { eventos.c2_ya_asignado = d; });
  sC2.on('viaje:no_disponible', d => { eventos.c2_no_disponible = d; });
  sCliente.on('viaje:conductor_asignado', d => { eventos.cliente_asignado = d; });

  await esperar(1500);

  // Ambos conductores aceptan al mismo tiempo
  sC1.emit('viaje:aceptar', { id_viaje });
  sC2.emit('viaje:aceptar', { id_viaje });

  await esperar(3000);

  // Verificar que exactamente UNO recibio conductor_asignado
  const ganadores = [eventos.c1_asignado, eventos.c2_asignado].filter(Boolean).length;
  check('Exactamente 1 conductor recibio viaje:conductor_asignado', ganadores === 1,
    `${ganadores} conductores recibieron el evento`);

  // Verificar que exactamente UNO recibio ya_asignado
  const perdedores = [eventos.c1_ya_asignado, eventos.c2_ya_asignado].filter(Boolean).length;
  check('Exactamente 1 conductor recibio viaje:ya_asignado', perdedores === 1,
    `${perdedores} conductores recibieron el evento`);

  // Verificar que NO se mandaron ambos eventos al mismo conductor
  const c1GanoYPerdio = eventos.c1_asignado && eventos.c1_ya_asignado;
  const c2GanoYPerdio = eventos.c2_asignado && eventos.c2_ya_asignado;
  check('Ningun conductor recibio ambos eventos a la vez',
    !c1GanoYPerdio && !c2GanoYPerdio);

  // Verificar viaje:no_disponible
  const noDisponible = eventos.c1_no_disponible || eventos.c2_no_disponible;
  const ganadorRecibioNoDisponible =
    (eventos.c1_asignado && eventos.c1_no_disponible) ||
    (eventos.c2_asignado && eventos.c2_no_disponible);
  check('Se emitio viaje:no_disponible', !!noDisponible);
  check('El conductor ganador NO recibio viaje:no_disponible',
    !ganadorRecibioNoDisponible);

  // Verificar que el viaje quedo asignado en la DB
  const viajeDB = await prisma.viaje.findUnique({ where: { id_viaje } });
  check('El viaje quedo en estado CONDUCTOR_ASIGNADO en la DB',
    viajeDB?.estado === 'CONDUCTOR_ASIGNADO',
    viajeDB?.estado || 'no encontrado');
  check('El viaje tiene id_conductor asignado en la DB',
    viajeDB?.id_conductor !== null);

  // Resumen
  console.log('\n=== RESUMEN ===\n');
  const pasaron = checks.filter(c => c.ok).length;
  const fallaron = checks.filter(c => !c.ok);
  checks.forEach(c => console.log(`  ${c.ok ? '✓' : '✗'} ${c.nombre}`));
  console.log(`\n${pasaron}/${checks.length} checks pasaron`);
  if (fallaron.length > 0) {
    console.log('\nFallaron:');
    fallaron.forEach(c => console.log(`  ✗ ${c.nombre}${c.detalle ? ': ' + c.detalle : ''}`));
  }

  await prisma.$disconnect();
  sC1.disconnect();
  sC2.disconnect();
  sCliente.disconnect();
  process.exit(fallaron.length === 0 ? 0 : 1);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
