import { io } from 'socket.io-client';

export const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
export const BASE = 'http://localhost:3000';

export const PARADA_A = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
export const PARADA_B = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

export function esperar(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export async function getToken(email, password) {
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

export async function api(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 300) }; }
  return { status: res.status, data };
}

export async function conectar(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token: 'Bearer ' + token } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', e => reject(new Error(`Socket connect_error: ${e.message}`)));
    setTimeout(() => reject(new Error('Timeout al conectar socket (8s)')), 8000);
  });
}

export async function registrarSiNoExiste(datos, tipo) {
  const endpoint = tipo === 'cliente'
    ? '/api/auth/registro-cliente'
    : '/api/auth/registro-conductor';
  await api('POST', endpoint, datos, null);
}

export async function crearVehiculoSiNoExiste(token, patente, condiciones = []) {
  await api('POST', '/api/conductores/mis-vehiculos', {
    patente,
    marca: 'Ford',
    modelo: 'Transit',
    anio: 2020,
    color: 'Blanco',
    tipo_vehiculo: 'furgon',
    condiciones,
  }, token);
}

export function crearReporter(nombre) {
  const pasos = [];
  const paso = (nombre_paso, ok, detalle = '', categoria = 'ok') => {
    pasos.push({ nombre: nombre_paso, ok, detalle, categoria });
    const icono = ok ? '✅' : (categoria === 'hueco' ? '⚠️' : '❌');
    console.log(`  ${icono} ${nombre_paso}${detalle ? '  →  ' + detalle : ''}`);
  };
  return {
    pasos,
    paso,
    seccion(titulo) {
      console.log(`\n── ${titulo} ${'─'.repeat(Math.max(0, 60 - titulo.length))}\n`);
    },
    resumen() {
      const ok = pasos.filter(p => p.ok).length;
      const fallaron = pasos.filter(p => !p.ok && p.categoria !== 'hueco');
      const huecos = pasos.filter(p => !p.ok && p.categoria === 'hueco');
      console.log(`\n  ${ok}/${pasos.length} pasos pasaron, ${fallaron.length} bugs, ${huecos.length} huecos`);
      return { nombre, total: pasos.length, ok, bugs: fallaron, huecos, todos: pasos };
    },
  };
}

// Crea un viaje basico y devuelve el id_viaje + paradas
export async function crearViaje(clienteToken, opts = {}) {
  const fechaViaje = opts.fecha || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const paradas = opts.paradas || [PARADA_A, PARADA_B];
  const r = await api('POST', '/api/viajes', {
    zona: opts.zona || 'CABA',
    fecha_programada: fechaViaje,
    condiciones_requeridas: opts.condiciones_requeridas || [],
    paradas,
  }, clienteToken);
  return r;
}

export const STRESS_USERS = {
  cliente: {
    nombre: 'Stress', apellido: 'Cliente', dni: '11111111',
    email: 'cliente@test.com', contrasena: 'test123456',
  },
  conductor: {
    nombre: 'Stress', apellido: 'Conductor', dni: '22222222',
    email: 'conductor@test.com', contrasena: 'test123456',
    nro_licencia: 'LIC001', licencia_vencimiento: '2028-01-01T00:00:00.000Z',
  },
  // Segundo conductor para tests de concurrencia
  conductor2: {
    nombre: 'Stress', apellido: 'ConductorDos', dni: '33333333',
    email: 'stress-conductor2@test.com', contrasena: 'test123456',
    nro_licencia: 'LIC002', licencia_vencimiento: '2028-01-01T00:00:00.000Z',
  },
};
