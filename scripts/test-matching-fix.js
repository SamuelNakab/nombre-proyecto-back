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
async function getToken(email, pass) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, password: pass, returnSecureToken: true }) }
  );
  const d = await res.json();
  return d.idToken || null;
}
async function api(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type':'application/json',
      ...(token ? { Authorization:'Bearer '+token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: res.status, data: await res.json() };
}
function conectar(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token: 'Bearer ' + token } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', e => reject(e));
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
}
async function registrarSiNoExiste(datos, tipo) {
  const ep = tipo === 'cliente'
    ? '/api/auth/registro-cliente'
    : '/api/auth/registro-conductor';
  await api('POST', ep, datos, null);
}

async function main() {
  console.log('\n=== TEST MATCHING FIX ===\n');

  await registrarSiNoExiste({
    nombre:'Test', apellido:'Cliente', dni:'11111111',
    email:'cliente@test.com', contrasena:'test123456'
  }, 'cliente');
  await registrarSiNoExiste({
    nombre:'Conductor', apellido:'Uno', dni:'22222222',
    email:'conductor@test.com', contrasena:'test123456',
    nro_licencia:'LIC001', licencia_vencimiento:'2028-01-01T00:00:00.000Z'
  }, 'conductor');

  const clienteToken = await getToken('cliente@test.com', 'test123456');
  const conductorToken = await getToken('conductor@test.com', 'test123456');
  check('Tokens obtenidos', !!clienteToken && !!conductorToken);
  if (!clienteToken || !conductorToken) { process.exit(1); }

  // Asegurar que el conductor tiene al menos un vehiculo
  const { data: vehiculos } = await api('GET', '/api/conductores/mis-vehiculos',
    null, conductorToken);
  if (!Array.isArray(vehiculos) || vehiculos.length === 0) {
    await api('POST', '/api/conductores/mis-vehiculos', {
      patente: 'TEST001', marca: 'Ford', modelo: 'Transit',
      anio: 2020, color: 'Blanco', tipo_vehiculo: 'camioneta', condiciones: []
    }, conductorToken);
  }

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
  check('Viaje creado', sv === 201);
  if (sv !== 201) { console.log(JSON.stringify(viaje)); process.exit(1); }
  const id_viaje = viaje.id_viaje;

  // Conectar sockets
  const [sConductor, sCliente] = await Promise.all([
    conectar(conductorToken),
    conectar(clienteToken)
  ]);
  check('Sockets conectados', true);

  const eventos = {
    conductor_asignado_conductor: null,
    conductor_asignado_cliente: null,
    ya_asignado: null,
    no_disponible: null,
    error_socket: null,
    cliente_recibio_no_disponible: null,
  };

  sConductor.on('viaje:conductor_asignado', d => {
    eventos.conductor_asignado_conductor = d;
  });
  sCliente.on('viaje:conductor_asignado', d => {
    eventos.conductor_asignado_cliente = d;
  });
  sConductor.on('viaje:ya_asignado', d => { eventos.ya_asignado = d; });
  sConductor.on('viaje:no_disponible', d => { eventos.no_disponible = d; });
  sCliente.on('viaje:no_disponible', d => {
    eventos.cliente_recibio_no_disponible = d;
  });
  sConductor.on('error', d => { eventos.error_socket = d; });

  await esperar(1000);

  // TEST A: aceptar SIN id_vehiculo (debe funcionar con auto-seleccion)
  console.log('\n--- TEST A: aceptar sin id_vehiculo ---');
  sConductor.emit('viaje:aceptar', { id_viaje });
  await esperar(2000);

  check('Conductor recibe viaje:conductor_asignado', !!eventos.conductor_asignado_conductor,
    eventos.error_socket ? 'error: ' + JSON.stringify(eventos.error_socket) : '');
  check('Cliente recibe viaje:conductor_asignado', !!eventos.conductor_asignado_cliente);
  check('Cliente NO recibe viaje:no_disponible', !eventos.cliente_recibio_no_disponible);
  check('Conductor NO recibe error de id_vehiculo', !eventos.error_socket);

  if (eventos.conductor_asignado_conductor) {
    check('Payload tiene id_usuario_conductor',
      !!eventos.conductor_asignado_conductor.id_usuario_conductor);
    check('Payload tiene datos del conductor',
      !!eventos.conductor_asignado_conductor.conductor?.nombre);
  }

  // Verificar en DB
  const viajeDB = await prisma.viaje.findUnique({ where: { id_viaje } });
  check('Viaje en DB tiene estado CONDUCTOR_ASIGNADO',
    viajeDB?.estado === 'CONDUCTOR_ASIGNADO');
  check('Viaje en DB tiene id_conductor asignado', !!viajeDB?.id_conductor);
  check('Viaje en DB tiene id_vehiculo asignado', !!viajeDB?.id_vehiculo);

  // TEST B: crear otro viaje y aceptar CON id_vehiculo
  console.log('\n--- TEST B: aceptar con id_vehiculo explicito ---');

  const { data: vehiculosData } = await api('GET', '/api/conductores/mis-vehiculos',
    null, conductorToken);
  const primerVehiculo = Array.isArray(vehiculosData) ? vehiculosData[0] : null;

  if (primerVehiculo) {
    const { status: sv2, data: viaje2 } = await api('POST', '/api/viajes', {
      zona: 'CABA',
      fecha_programada: '2026-09-02T10:00:00.000Z',
      condiciones_requeridas: [],
      paradas: [
        { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo' },
        { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta' }
      ]
    }, clienteToken);

    if (sv2 === 201) {
      const eventos2 = { asignado: null, error: null };
      sConductor.on('viaje:conductor_asignado', d => { eventos2.asignado = d; });
      sConductor.on('error', d => { eventos2.error = d; });

      await esperar(500);
      sConductor.emit('viaje:aceptar', {
        id_viaje: viaje2.id_viaje,
        id_vehiculo: primerVehiculo.id_vehiculo
      });
      await esperar(2000);

      check('Aceptar con id_vehiculo explicito funciona', !!eventos2.asignado,
        eventos2.error ? JSON.stringify(eventos2.error) : '');
    }
  } else {
    console.log('i Sin vehiculos registrados — TEST B omitido');
  }

  // Resumen
  console.log('\n=== RESUMEN ===\n');
  const pasaron = checks.filter(c => c.ok).length;
  checks.forEach(c => console.log(`  ${c.ok ? '✓' : '✗'} ${c.nombre}${c.detalle ? ': '+c.detalle : ''}`));
  console.log(`\n${pasaron}/${checks.length} checks pasaron`);

  await prisma.$disconnect();
  sConductor.disconnect();
  sCliente.disconnect();
  process.exit(checks.filter(c => !c.ok).length === 0 ? 0 : 1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
