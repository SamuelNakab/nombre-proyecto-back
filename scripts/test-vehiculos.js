import 'dotenv/config';
import { io as ioClient } from 'socket.io-client';

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const FIREBASE_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';

const TS = Date.now();
const CLIENTE_EMAIL = `cliente_veh_${TS}@test.com`;
const CLIENTE_PASS = 'test123456';
const CONDUCTOR_EMAIL = `conductor_veh_${TS}@test.com`;
const CONDUCTOR_PASS = 'test123456';
const CONDUCTOR2_EMAIL = `conductor2_veh_${TS}@test.com`;
const CONDUCTOR2_PASS = 'test123456';

const checks = {};
function check(nombre, ok, detalle) {
  checks[nombre] = ok;
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
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function firebaseSignup(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await res.json();
  return data.idToken || null;
}

async function firebaseLogin(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await res.json();
  return data.idToken || null;
}

async function registrarYLogin(tipo, email, password, extra = {}) {
  const endpoint = `/api/auth/registro-${tipo}`;
  const base = {
    nombre: tipo.charAt(0).toUpperCase() + tipo.slice(1),
    apellido: 'Test',
    dni: String(Math.floor(10000000 + Math.random() * 89999999)),
    email,
    contrasena: password,
  };
  await api('POST', endpoint, { ...base, ...extra });
  return firebaseLogin(email, password);
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
  console.log('\n=== TEST VEHICULOS DE CONDUCTORES — FLETER ===\n');

  // ─── SETUP ───────────────────────────────────────────────────────────────────
  console.log('--- SETUP ---');
  const [clienteToken, conductorToken, conductor2Token] = await Promise.all([
    registrarYLogin('cliente', CLIENTE_EMAIL, CLIENTE_PASS),
    registrarYLogin('conductor', CONDUCTOR_EMAIL, CONDUCTOR_PASS, {
      nro_licencia: `LIC_VEH_${TS}`,
      licencia_vencimiento: '2030-01-01T00:00:00.000Z',
    }),
    registrarYLogin('conductor', CONDUCTOR2_EMAIL, CONDUCTOR2_PASS, {
      nro_licencia: `LIC_VEH2_${TS}`,
      licencia_vencimiento: '2030-01-01T00:00:00.000Z',
    }),
  ]);

  if (!clienteToken || !conductorToken || !conductor2Token) {
    console.error('ERROR: No se pudo obtener tokens. Verificar que el servidor esta corriendo.');
    process.exit(1);
  }

  // ─── TEST A — CRUD DE VEHICULOS ───────────────────────────────────────────────
  console.log('\n--- TEST A: CRUD de vehiculos ---');

  const patente = `TST${TS.toString().slice(-5)}`;

  // A1: Registrar vehiculo valido
  const rA1 = await api('POST', '/api/conductores/mis-vehiculos', {
    patente,
    marca: 'Ford',
    modelo: 'Transit',
    anio: 2022,
    color: 'Blanco',
    tipo_vehiculo: 'furgon',
    condiciones: ['REFRIGERADO'],
  }, conductorToken);
  const vehiculoId = rA1.data?.id_vehiculo;
  check(
    'Vehiculo registrado correctamente',
    rA1.status === 201 && vehiculoId,
    `status=${rA1.status} id=${vehiculoId}`
  );

  // A2: Patente duplicada
  const rA2 = await api('POST', '/api/conductores/mis-vehiculos', {
    patente,
    marca: 'Toyota',
    modelo: 'Hilux',
    anio: 2021,
    color: 'Negro',
    tipo_vehiculo: 'camioneta',
  }, conductorToken);
  check('Patente duplicada da 409', rA2.status === 409, `status=${rA2.status}`);

  // A3: Datos invalidos (anio 1800)
  const rA3 = await api('POST', '/api/conductores/mis-vehiculos', {
    patente: 'OTRO01',
    marca: 'Ford',
    modelo: 'F100',
    anio: 1800,
    color: 'Rojo',
    tipo_vehiculo: 'camion',
  }, conductorToken);
  check('Datos invalidos dan 400', rA3.status === 400, `status=${rA3.status}`);

  // A4: GET mis-vehiculos
  const rA4 = await api('GET', '/api/conductores/mis-vehiculos', undefined, conductorToken);
  const tieneMiVehiculo = rA4.data?.some?.((v) => v.id_vehiculo === vehiculoId);
  check(
    'GET mis-vehiculos devuelve el vehiculo',
    rA4.status === 200 && tieneMiVehiculo,
    `status=${rA4.status} cantidad=${rA4.data?.length}`
  );

  // A5: PUT actualizar color
  const rA5 = await api('PUT', `/api/conductores/mis-vehiculos/${vehiculoId}`, {
    color: 'Rojo',
  }, conductorToken);
  check(
    'PUT actualiza el vehiculo',
    rA5.status === 200 && rA5.data?.color === 'Rojo',
    `status=${rA5.status} color=${rA5.data?.color}`
  );

  // A6: Agregar condicion FRAGIL
  const rA6 = await api(
    'POST',
    `/api/conductores/mis-vehiculos/${vehiculoId}/condiciones/FRAGIL`,
    undefined,
    conductorToken
  );
  const tieneFragil = rA6.data?.condiciones?.some?.((c) => c.condicion === 'FRAGIL');
  check(
    'Agregar condicion funciona',
    rA6.status === 201 && tieneFragil,
    `status=${rA6.status}`
  );

  // A7: Condicion duplicada
  const rA7 = await api(
    'POST',
    `/api/conductores/mis-vehiculos/${vehiculoId}/condiciones/FRAGIL`,
    undefined,
    conductorToken
  );
  check('Condicion duplicada da 409', rA7.status === 409, `status=${rA7.status}`);

  // A8: Quitar condicion FRAGIL
  const rA8 = await api(
    'DELETE',
    `/api/conductores/mis-vehiculos/${vehiculoId}/condiciones/FRAGIL`,
    undefined,
    conductorToken
  );
  const sinFragil = !rA8.data?.condiciones?.some?.((c) => c.condicion === 'FRAGIL');
  check(
    'Quitar condicion funciona',
    rA8.status === 200 && sinFragil,
    `status=${rA8.status}`
  );

  // ─── TEST B — ELEGIBILIDAD Y VIAJES DISPONIBLES ───────────────────────────────
  console.log('\n--- TEST B: Elegibilidad y viajes disponibles ---');

  // El vehiculo del conductor ya tiene REFRIGERADO (desde A1, sin FRAGIL porque se quito)
  const fechaFutura = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const fechaFutura2 = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

  // B2: Crear viaje que requiere REFRIGERADO
  const rB2 = await api('POST', '/api/viajes', {
    zona: 'CABA',
    paradas: [
      { lat: -34.6037, lng: -58.3816, direccion: 'Parada 1' },
      { lat: -34.59, lng: -58.38, direccion: 'Parada 2' },
    ],
    fecha_programada: fechaFutura,
    condiciones_requeridas: ['REFRIGERADO'],
  }, clienteToken);
  const viajeRefrigeradoId = rB2.data?.id_viaje;
  check(
    'Viaje REFRIGERADO creado',
    rB2.status === 201 && viajeRefrigeradoId,
    `status=${rB2.status} id=${viajeRefrigeradoId}`
  );

  // B3: Crear viaje que requiere FRAGIL
  const rB3 = await api('POST', '/api/viajes', {
    zona: 'CABA',
    paradas: [
      { lat: -34.6037, lng: -58.3816, direccion: 'Parada 1' },
      { lat: -34.59, lng: -58.38, direccion: 'Parada 2' },
    ],
    fecha_programada: fechaFutura2,
    condiciones_requeridas: ['FRAGIL'],
  }, clienteToken);
  const viajeFragilId = rB3.data?.id_viaje;

  // B4: GET viajes disponibles para el conductor
  await esperar(500);
  const rB4 = await api('GET', '/api/viajes/disponibles', undefined, conductorToken);
  const tieneRefrigerado = rB4.data?.some?.((v) => v.id_viaje === viajeRefrigeradoId);
  const tieneFragilEnDisponibles = rB4.data?.some?.((v) => v.id_viaje === viajeFragilId);

  check(
    'Viaje con REFRIGERADO aparece en disponibles',
    rB4.status === 200 && tieneRefrigerado,
    `status=${rB4.status} encontrado=${tieneRefrigerado}`
  );
  check(
    'Viaje con FRAGIL NO aparece en disponibles',
    rB4.status === 200 && !tieneFragilEnDisponibles,
    `status=${rB4.status} encontrado=${tieneFragilEnDisponibles}`
  );

  // ─── TEST C — ACEPTAR VIAJE CON VEHICULO (WEBSOCKET) ─────────────────────────
  console.log('\n--- TEST C: Aceptar viaje con vehiculo (WebSocket) ---');

  // Obtener id del vehiculo del conductor2
  const rC_veh2 = await api('POST', '/api/conductores/mis-vehiculos', {
    patente: `C2_${TS.toString().slice(-5)}`,
    marca: 'Renault',
    modelo: 'Kangoo',
    anio: 2020,
    color: 'Gris',
    tipo_vehiculo: 'furgon',
  }, conductor2Token);
  const vehiculo2Id = rC_veh2.data?.id_vehiculo;

  // Crear viaje sin condiciones para el test WebSocket
  const fechaFuturaWS = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
  const rCViaje = await api('POST', '/api/viajes', {
    zona: 'CABA',
    paradas: [
      { lat: -34.6037, lng: -58.3816, direccion: 'Origen WS' },
      { lat: -34.59, lng: -58.38, direccion: 'Destino WS' },
    ],
    fecha_programada: fechaFuturaWS,
  }, clienteToken);
  const viajeWSId = rCViaje.data?.id_viaje;

  if (!viajeWSId) {
    console.log('No se pudo crear viaje para test WebSocket');
    check('Aceptar sin id_vehiculo da error', false, 'no se pudo crear viaje');
    check('Aceptar con vehiculo de otro da error', false, 'no se pudo crear viaje');
    check('Aceptar con vehiculo correcto asigna el viaje', false, 'no se pudo crear viaje');
    check('El viaje en DB tiene id_vehiculo asignado', false, 'no se pudo crear viaje');
  } else {
    let socketConductor, socketCliente;
    try {
      [socketConductor, socketCliente] = await Promise.all([
        conectarSocket(conductorToken),
        conectarSocket(clienteToken),
      ]);

      socketConductor.emit('unirse:viaje', { id_viaje: viajeWSId });
      socketCliente.emit('unirse:viaje', { id_viaje: viajeWSId });
      await esperar(500);

      // C3: Intentar aceptar SIN id_vehiculo
      const errorSinVehiculo = await new Promise((resolve) => {
        socketConductor.once('error', (e) => resolve(e));
        socketConductor.emit('viaje:aceptar', { id_viaje: viajeWSId });
        setTimeout(() => resolve(null), 3000);
      });
      check(
        'Aceptar sin id_vehiculo da error',
        errorSinVehiculo?.error === 'Debes seleccionar un vehiculo',
        `error=${JSON.stringify(errorSinVehiculo)}`
      );

      // C4: Intentar aceptar con vehiculo de otro conductor
      const errorOtroVehiculo = await new Promise((resolve) => {
        socketConductor.once('error', (e) => resolve(e));
        socketConductor.emit('viaje:aceptar', { id_viaje: viajeWSId, id_vehiculo: vehiculo2Id });
        setTimeout(() => resolve(null), 3000);
      });
      check(
        'Aceptar con vehiculo de otro da error',
        errorOtroVehiculo?.error === 'Este vehiculo no te pertenece',
        `error=${JSON.stringify(errorOtroVehiculo)}`
      );

      // C5: Aceptar con el vehiculo correcto
      const asignado = await new Promise((resolve) => {
        socketConductor.once('viaje:conductor_asignado', (e) => resolve(e));
        socketConductor.emit('viaje:aceptar', { id_viaje: viajeWSId, id_vehiculo: vehiculoId });
        setTimeout(() => resolve(null), 5000);
      });
      check(
        'Aceptar con vehiculo correcto asigna el viaje',
        asignado?.id_viaje === viajeWSId,
        `data=${JSON.stringify(asignado)}`
      );

      // Verificar que el viaje en DB tiene id_vehiculo
      await esperar(500);
      const rCVerif = await api('GET', `/api/viajes/${viajeWSId}`, undefined, conductorToken);
      check(
        'El viaje en DB tiene id_vehiculo asignado',
        rCVerif.data?.id_vehiculo === vehiculoId,
        `id_vehiculo=${rCVerif.data?.id_vehiculo} esperado=${vehiculoId}`
      );
    } catch (err) {
      console.log('Error en test WebSocket:', err.message);
      check('Aceptar sin id_vehiculo da error', false, err.message);
      check('Aceptar con vehiculo de otro da error', false, err.message);
      check('Aceptar con vehiculo correcto asigna el viaje', false, err.message);
      check('El viaje en DB tiene id_vehiculo asignado', false, err.message);
    } finally {
      socketConductor?.disconnect();
      socketCliente?.disconnect();
    }
  }

  // ─── TEST D — ELIMINAR VEHICULO ───────────────────────────────────────────────
  console.log('\n--- TEST D: Eliminar vehiculo ---');

  // D1: Intentar eliminar vehiculo en viaje activo (vehiculoId esta asignado al viajeWS)
  const rD1 = await api('DELETE', `/api/conductores/mis-vehiculos/${vehiculoId}`, undefined, conductorToken);
  check(
    'Eliminar vehiculo en uso da 400',
    rD1.status === 400,
    `status=${rD1.status} msg=${rD1.data?.error}`
  );

  // D2/D3: Crear y eliminar vehiculo nuevo
  const rD2 = await api('POST', '/api/conductores/mis-vehiculos', {
    patente: `DEL${TS.toString().slice(-5)}`,
    marca: 'VW',
    modelo: 'Crafter',
    anio: 2019,
    color: 'Azul',
    tipo_vehiculo: 'camion',
  }, conductorToken);
  const vehiculoLibreId = rD2.data?.id_vehiculo;

  if (vehiculoLibreId) {
    const rD3 = await api('DELETE', `/api/conductores/mis-vehiculos/${vehiculoLibreId}`, undefined, conductorToken);
    check('Eliminar vehiculo libre funciona', rD3.status === 200, `status=${rD3.status}`);
  } else {
    check('Eliminar vehiculo libre funciona', false, 'no se pudo crear vehiculo libre');
  }

  // ─── RESUMEN FINAL ────────────────────────────────────────────────────────────
  console.log('\n=== RESUMEN FINAL ===\n');

  const ordered = [
    'Vehiculo registrado correctamente',
    'Patente duplicada da 409',
    'Datos invalidos dan 400',
    'GET mis-vehiculos devuelve el vehiculo',
    'PUT actualiza el vehiculo',
    'Agregar condicion funciona',
    'Condicion duplicada da 409',
    'Quitar condicion funciona',
    'Viaje con REFRIGERADO aparece en disponibles',
    'Viaje con FRAGIL NO aparece en disponibles',
    'Aceptar sin id_vehiculo da error',
    'Aceptar con vehiculo de otro da error',
    'Aceptar con vehiculo correcto asigna el viaje',
    'El viaje en DB tiene id_vehiculo asignado',
    'Eliminar vehiculo en uso da 400',
    'Eliminar vehiculo libre funciona',
  ];

  let todosPasan = true;
  for (const nombre of ordered) {
    const ok = checks[nombre] ?? false;
    if (!ok) todosPasan = false;
    console.log((ok ? '✓' : '✗') + ' ' + nombre);
  }

  console.log();
  if (todosPasan) {
    console.log('Todos los checks pasan ✓');
    process.exit(0);
  } else {
    console.log('Algunos checks fallaron ✗');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error inesperado:', err);
  process.exit(1);
});
