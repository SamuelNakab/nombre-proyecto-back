import { io } from 'socket.io-client';

const CLIENT_TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImM5YTBjMWRlYWEyN2JjNjMyNTUzYmM4MWEyMmQ4NzY1MWM3MTMyY2IiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vZmxldGVzLThmYWJhIiwiYXVkIjoiZmxldGVzLThmYWJhIiwiYXV0aF90aW1lIjoxNzc5MTk2NjQ0LCJ1c2VyX2lkIjoidFVpU0ZoVDJNWWFheGd5TzRVWDRQSlV0ek1GMiIsInN1YiI6InRVaVNGaFQyTVlhYXhneU80VVg0UEpVdHpNRjIiLCJpYXQiOjE3NzkxOTY2NDQsImV4cCI6MTc3OTIwMDI0NCwiZW1haWwiOiJjbGllbnRlQHRlc3QuY29tIiwiZW1haWxfdmVyaWZpZWQiOmZhbHNlLCJmaXJlYmFzZSI6eyJpZGVudGl0aWVzIjp7ImVtYWlsIjpbImNsaWVudGVAdGVzdC5jb20iXX0sInNpZ25faW5fcHJvdmlkZXIiOiJwYXNzd29yZCJ9fQ.tezx5Aju2UZoMNE2_VDFwHa03yh2RBdSgu4_porhhTrTs5XE3uuGnQ3wZzFfl5I0t-zjjY2BtyM832PhBSXWfALWzWiSOINPsO2CalqH_A-yAGY9mWegRk7miYJIad1Ga8JnTSOieLpDn8qze1iPKvE94uKhCJkHYPR0yRGrnvD7xsDQBKnin6kwMsKr35bc0d8V1FuBifWxiOSDtiYtLB98otU22KFE-9_ATa2dNfuqeLrqaj_Y6ifd7tb8gi34zJAzK09PjXtQ5WPbxnv0-rMsrTVanfgz06xRux2Sbu3YTQNTcbWXowkPsJe1CwZ8yzdNLXDR3G44zCvLKd6Lgg';
const CONDUCTOR1_TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImM5YTBjMWRlYWEyN2JjNjMyNTUzYmM4MWEyMmQ4NzY1MWM3MTMyY2IiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vZmxldGVzLThmYWJhIiwiYXVkIjoiZmxldGVzLThmYWJhIiwiYXV0aF90aW1lIjoxNzc5MTk2NjQ1LCJ1c2VyX2lkIjoidUJDM0VReHIzMFdxWm82WENLamlkNGZFbWoxMyIsInN1YiI6InVCQzNFUXhyMzBXcVpvNlhDS2ppZDRmRW1qMTMiLCJpYXQiOjE3NzkxOTY2NDUsImV4cCI6MTc3OTIwMDI0NSwiZW1haWwiOiJjb25kdWN0b3JAdGVzdC5jb20iLCJlbWFpbF92ZXJpZmllZCI6ZmFsc2UsImZpcmViYXNlIjp7ImlkZW50aXRpZXMiOnsiZW1haWwiOlsiY29uZHVjdG9yQHRlc3QuY29tIl19LCJzaWduX2luX3Byb3ZpZGVyIjoicGFzc3dvcmQifX0.kDmJxrRx7z38X9c1ui3GpEs8w3a6IXkipP5nL8rZwZfhx00FHQfIJbxsjJBTrBNQdnv7Gj7nZUuzhV-RReUxoSQZiDZCry8jo0u1bl4mFKjTCA1bRimBQeVk8TlvHFPtbOEaCy1mTcCg2cEX--CxbzF9tTIkXXr-L5q0l-QGs6uL227N9ursnqGE0E5k4ulf9DxIAHQLXXo36cvkVvq6g22a7t-gDh8yNGzbMJDT9ZZ9D7zJmuJFthGrA0Ql9_Cz7kL4tmK5nmr-vFQvRw_2WB0hWuXk7TY_wACPYJYOT0sbMznGoATtKTrsjm8Fzb5-ht-5lKMBSm7JbhyLNyf9tw';
const CONDUCTOR2_TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImM5YTBjMWRlYWEyN2JjNjMyNTUzYmM4MWEyMmQ4NzY1MWM3MTMyY2IiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vZmxldGVzLThmYWJhIiwiYXVkIjoiZmxldGVzLThmYWJhIiwiYXV0aF90aW1lIjoxNzc5MTk2NjQ1LCJ1c2VyX2lkIjoiVGRRN0dxanJzMFUydnJzUnd3dVlQYXFhdjAyMiIsInN1YiI6IlRkUTdHcWpyczBVMnZyc1J3d3VZUGFxYXYwMjIiLCJpYXQiOjE3NzkxOTY2NDUsImV4cCI6MTc3OTIwMDI0NSwiZW1haWwiOiJjb25kdWN0b3IyQHRlc3QuY29tIiwiZW1haWxfdmVyaWZpZWQiOmZhbHNlLCJmaXJlYmFzZSI6eyJpZGVudGl0aWVzIjp7ImVtYWlsIjpbImNvbmR1Y3RvcjJAdGVzdC5jb20iXX0sInNpZ25faW5fcHJvdmlkZXIiOiJwYXNzd29yZCJ9fQ.clbd6rngwvmTSB9ihi-VlsA1vOmhzekyDtmBz9sRoWf1cP2gqzzrftv5L3g2IlfN3-4fBGaZtEFQR14pK4SUD5mRBm_4bgHfwKegMaRIXJsiJn7eNDRRKWk__uhNCs2beCoL-6ZWM1adxfMx3acA7HWlCD-BiN_EYWyNA0Ama2RlN-7NtRTC9w3e8wU6iS71ofoOpDsXSu2ogMvzhAdeBEYKMsKf9R7kIk9MS7N27Vp2rHa_eNIFW7gWLCFDZdtQ9MUU-V1RN4SaCQgqj85ZMO0aEEX88zEZzR1rh9XJbCYeFRMXppetQrTLpRMdQrYpDHKgOqD3EKvVomt-4T-4ww';
const BASE = 'http://localhost:3000';

const checks = [];
function check(nombre, ok, detalle = '') {
  checks.push({ nombre, ok, detalle });
  console.log(`${ok ? '✓' : '✗'} ${nombre}${detalle ? ': ' + detalle : ''}`);
}

function esperar(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
}

async function main() {
  console.log('\n=== TEST BUGS — FLETER ===\n');

  console.log('--- TEST 1: condiciones_req en respuestas ---');
  const { status: s1, data: viaje } = await api('POST', '/api/viajes', {
    zona: 'CABA',
    fecha_programada: '2026-09-01T10:00:00.000Z',
    condiciones_requeridas: ['FRAGIL', 'REFRIGERADO'],
    paradas: [
      { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo' },
      { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta' }
    ]
  }, CLIENT_TOKEN);

  check('Viaje creado correctamente', s1 === 201);
  const tieneCondiciones = viaje.condiciones_req &&
    Array.isArray(viaje.condiciones_req) &&
    viaje.condiciones_req.length === 2;
  check('condiciones_req presentes en respuesta de crear viaje',
    tieneCondiciones,
    tieneCondiciones
      ? viaje.condiciones_req.map(c => c.condicion).join(', ')
      : 'condiciones_req: ' + JSON.stringify(viaje.condiciones_req));

  const viajeId = viaje.id_viaje;

  console.log('\n--- Conectando sockets ---');
  const [sCliente, sConductor1, sConductor2] = await Promise.all([
    conectar(CLIENT_TOKEN),
    conectar(CONDUCTOR1_TOKEN),
    conectar(CONDUCTOR2_TOKEN)
  ]);
  console.log('Los tres sockets conectados');

  let viaje_disponible_c1 = null;
  let viaje_disponible_c2 = null;
  sConductor1.on('viaje:disponible', d => { viaje_disponible_c1 = d; });
  sConductor2.on('viaje:disponible', d => { viaje_disponible_c2 = d; });

  await esperar(2000);

  check('viaje:disponible recibido por conductor 1', viaje_disponible_c1 !== null);
  check('viaje:disponible recibido por conductor 2', viaje_disponible_c2 !== null);

  if (viaje_disponible_c1) {
    const tieneCondEv = viaje_disponible_c1.condiciones_req &&
      Array.isArray(viaje_disponible_c1.condiciones_req) &&
      viaje_disponible_c1.condiciones_req.length === 2;
    check('condiciones_req presentes en evento viaje:disponible',
      tieneCondEv,
      tieneCondEv
        ? viaje_disponible_c1.condiciones_req.map(c => c.condicion).join(', ')
        : JSON.stringify(viaje_disponible_c1.condiciones_req));
  }

  console.log('\n--- TEST 2: solo el conductor que acepta queda asignado ---');

  let c1_evento = null;
  let c2_evento = null;
  let cliente_evento = null;
  sConductor1.on('viaje:conductor_asignado', d => { c1_evento = d; });
  sConductor2.on('viaje:conductor_asignado', d => { c2_evento = d; });
  sCliente.on('viaje:conductor_asignado', d => { cliente_evento = d; });

  sConductor1.emit('viaje:aceptar', { id_viaje: viajeId });
  await esperar(2000);

  check('viaje:conductor_asignado recibido por conductor 1', c1_evento !== null);
  check('viaje:conductor_asignado recibido por el cliente', cliente_evento !== null);
  check('id_usuario_conductor presente en el evento',
    c1_evento !== null && c1_evento.id_usuario_conductor != null,
    c1_evento ? 'id: ' + c1_evento.id_usuario_conductor : 'evento no recibido');

  if (c1_evento && c2_evento) {
    check('Ambos conductores reciben el mismo id_usuario_conductor',
      c1_evento.id_usuario_conductor === c2_evento.id_usuario_conductor,
      `c1 recibio: ${c1_evento.id_usuario_conductor}, c2 recibio: ${c2_evento.id_usuario_conductor}`);
  }

  const { status: s2, data: disponibles } = await api(
    'GET', '/api/viajes/disponibles', null, CONDUCTOR1_TOKEN);
  if (s2 === 200 && Array.isArray(disponibles) && disponibles.length > 0) {
    const primero = disponibles[0];
    check('condiciones_req presentes en GET /api/viajes/disponibles',
      primero.condiciones_req !== undefined && Array.isArray(primero.condiciones_req),
      JSON.stringify(primero.condiciones_req));
  } else {
    console.log('i GET /api/viajes/disponibles: sin viajes para verificar');
  }

  console.log('\n=== RESUMEN ===\n');
  const pasaron = checks.filter(c => c.ok).length;
  const fallaron = checks.filter(c => !c.ok);
  checks.forEach(c => console.log(`  ${c.ok ? '✓' : '✗'} ${c.nombre}`));
  console.log(`\n${pasaron}/${checks.length} checks pasaron`);
  if (fallaron.length > 0) {
    console.log('\nFallaron:');
    fallaron.forEach(c => console.log(`  ✗ ${c.nombre}: ${c.detalle}`));
  }

  sCliente.disconnect();
  sConductor1.disconnect();
  sConductor2.disconnect();
  process.exit(fallaron.length === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
