import { io } from 'socket.io-client';
import redis from '../src/config/redis.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const BASE = 'http://localhost:3000';

// Coordenadas reales de CABA (dentro de 200m entre si para el test)
const PARADA_1 = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const PARADA_2 = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };

// ── Helpers ───────────────────────────────────────────────────────────────────

const pasos = [];

function paso(nombre, ok, detalle = '') {
  pasos.push({ nombre, ok, detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}

function esperar(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getToken(email, password) {
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

async function api(method, path, body, token) {
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
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: `Respuesta no-JSON (${res.status}): ${text.slice(0, 3000)}` };
  }
  return { status: res.status, data };
}

async function conectar(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token: 'Bearer ' + token } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', e => reject(new Error(`Socket connect_error: ${e.message}`)));
    setTimeout(() => reject(new Error('Timeout al conectar socket (8s)')), 8000);
  });
}

async function registrarSiNoExiste(datos, tipo) {
  const endpoint = tipo === 'cliente'
    ? '/api/auth/registro-cliente'
    : '/api/auth/registro-conductor';
  await api('POST', endpoint, datos, null);
}

async function crearVehiculoSiNoExiste(token, patente) {
  await api('POST', '/api/conductores/mis-vehiculos', {
    patente,
    marca: 'Ford',
    modelo: 'Transit',
    anio: 2020,
    color: 'Blanco',
    tipo_vehiculo: 'furgon',
  }, token);
  // 409 = ya existe, ambos casos son OK para el test
}

async function cleanup(sConductor, sCliente) {
  try { sConductor?.disconnect(); } catch {}
  try { sCliente?.disconnect(); } catch {}
  try { await redis.quit(); } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║        TEST FASE 5 — FLETER                 ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  let clienteToken, conductorToken;
  let sConductor = null, sCliente = null;
  let id_viaje, qrs, conf2;

  // ──────────────────────────────────────────────────────────────────────────
  // PASO 1: Autenticacion
  // ──────────────────────────────────────────────────────────────────────────
  console.log('── PASO 1: Autenticacion ──────────────────────────────────────\n');

  await registrarSiNoExiste({
    nombre: 'Test', apellido: 'Cliente', dni: '11111111',
    email: 'cliente@test.com', contrasena: 'test123456',
  }, 'cliente');

  await registrarSiNoExiste({
    nombre: 'Conductor', apellido: 'Uno', dni: '22222222',
    email: 'conductor@test.com', contrasena: 'test123456',
    nro_licencia: 'LIC001', licencia_vencimiento: '2028-01-01T00:00:00.000Z',
  }, 'conductor');

  clienteToken = await getToken('cliente@test.com', 'test123456');
  conductorToken = await getToken('conductor@test.com', 'test123456');

  paso('Tokens obtenidos (cliente y conductor)', true);

  // Vehiculo requerido por matching socket para poder aceptar viajes
  await crearVehiculoSiNoExiste(conductorToken, 'FLT001');
  paso('Vehiculo del conductor disponible (FLT001)', true);

  // ──────────────────────────────────────────────────────────────────────────
  // PASO 2: Crear viaje
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n── PASO 2: Crear viaje ────────────────────────────────────────\n');

  const fechaViaje = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const { status: sv, data: viajeData } = await api('POST', '/api/viajes', {
    zona: 'CABA',
    fecha_programada: fechaViaje,
    condiciones_requeridas: [],
    paradas: [PARADA_1, PARADA_2],
  }, clienteToken);

  paso('POST /api/viajes → 201', sv === 201, sv !== 201 ? JSON.stringify(viajeData) : '');
  if (sv !== 201) { await cleanup(sConductor, sCliente); process.exit(1); }

  id_viaje = viajeData.id_viaje;
  const paradas = viajeData.paradas ?? [];

  paso(`Viaje creado con id ${id_viaje}`, !!id_viaje, '');
  paso('Viaje tiene 2 paradas con qr_token',
    paradas.length === 2 && paradas.every(p => p.qr_token),
    paradas.map(p => `#${p.id_parada} token=${p.qr_token?.slice(0, 8)}...`).join(' | '));

  // ──────────────────────────────────────────────────────────────────────────
  // PASO 3: Conductor acepta via WebSocket
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n── PASO 3: Conductor acepta via WebSocket ─────────────────────\n');

  sConductor = await conectar(conductorToken);
  sCliente = await conectar(clienteToken);

  let eventoAsignado = null;
  let eventoFinalizado = null;
  sConductor.on('viaje:conductor_asignado', d => { eventoAsignado = d; });
  sCliente.on('viaje:finalizado', d => { eventoFinalizado = d; });

  // Esperar a que el conductor se una al room del viaje
  await esperar(1500);

  sConductor.emit('viaje:aceptar', { id_viaje });
  await esperar(2500);

  const { data: viajeAsig } = await api('GET', `/api/viajes/${id_viaje}`, null, clienteToken);
  paso('Viaje en estado CONDUCTOR_ASIGNADO',
    viajeAsig.estado === 'CONDUCTOR_ASIGNADO', viajeAsig.estado);
  paso('Conductor asignado tiene id_conductor en DB',
    !!viajeAsig.conductor?.id_conductor, JSON.stringify(viajeAsig.conductor?.id_conductor));

  if (viajeAsig.estado !== 'CONDUCTOR_ASIGNADO') {
    await cleanup(sConductor, sCliente); process.exit(1);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PASO 4: GPS pings (5 pings)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n── PASO 4: GPS pings ──────────────────────────────────────────\n');

  const pingCoords = [
    { lat: -34.6037, lng: -58.3816 }, // Plaza de Mayo
    { lat: -34.6010, lng: -58.3800 },
    { lat: -34.5980, lng: -58.3830 },
    { lat: -34.5940, lng: -58.3890 },
    { lat: -34.5895, lng: -58.3974 }, // Recoleta
  ];

  // Timestamps con 3 segundos de diferencia para acumular tiempo real
  const tsBase = Date.now();
  for (let i = 0; i < pingCoords.length; i++) {
    sConductor.emit('conductor:ubicacion', {
      id_viaje,
      lat: pingCoords[i].lat,
      lng: pingCoords[i].lng,
      timestamp: tsBase + i * 3000,
    });
    await esperar(400); // pequeña pausa entre pings
  }
  await esperar(1500);

  const { data: viajeGPS } = await api('GET', `/api/viajes/${id_viaje}`, null, clienteToken);
  paso('Primer GPS ping → estado EN_CAMINO_A_ORIGEN',
    viajeGPS.estado === 'EN_CAMINO_A_ORIGEN', viajeGPS.estado);

  const acumuladoRaw = await redis.get(`gps:${id_viaje}:acumulado`);
  const acumulado = acumuladoRaw ? JSON.parse(acumuladoRaw) : null;
  paso('Redis tiene GPS acumulado con distancia_km > 0',
    acumulado !== null && typeof acumulado.distancia_km === 'number' && acumulado.distancia_km > 0,
    acumulado
      ? `distancia_km=${acumulado.distancia_km.toFixed(3)} km, tiempo_horas=${acumulado.tiempo_horas.toFixed(5)} h`
      : 'null — no hay datos en Redis');

  // ──────────────────────────────────────────────────────────────────────────
  // PASO 5: Cambiar estado a EN_RUTA
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n── PASO 5: Transicion de estados hacia EN_RUTA ───────────────\n');

  const { status: spCarg } = await api(
    'PATCH', `/api/viajes/${id_viaje}/estado`, { estado: 'CARGANDO' }, conductorToken
  );
  paso('PATCH estado CARGANDO → 200', spCarg === 200, `status ${spCarg}`);

  const { status: spEnRuta, data: enRutaData } = await api(
    'PATCH', `/api/viajes/${id_viaje}/estado`, { estado: 'EN_RUTA' }, conductorToken
  );
  paso('PATCH estado EN_RUTA → 200',
    spEnRuta === 200 && enRutaData.estado_nuevo === 'EN_RUTA',
    spEnRuta !== 200 ? JSON.stringify(enRutaData) : enRutaData.estado_nuevo);

  if (enRutaData.estado_nuevo !== 'EN_RUTA') {
    await cleanup(sConductor, sCliente); process.exit(1);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PASO 6: GET /api/viajes/:id/qr-paradas
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n── PASO 6: GET qr-paradas ────────────────────────────────────\n');

  const { status: sqr, data: qrData } = await api(
    'GET', `/api/viajes/${id_viaje}/qr-paradas`, null, clienteToken
  );
  paso('GET /api/viajes/:id/qr-paradas → 200', sqr === 200, sqr !== 200 ? JSON.stringify(qrData) : '');
  if (sqr !== 200) { await cleanup(sConductor, sCliente); process.exit(1); }

  paso('Respuesta tiene 2 QRs', Array.isArray(qrData) && qrData.length === 2, `${qrData?.length ?? 0} QRs`);
  paso('Cada QR tiene id_parada, orden, direccion y qr_firmado',
    qrData.every(q => q.id_parada && q.orden && q.direccion && q.qr_firmado), '');

  qrs = qrData.sort((a, b) => a.orden - b.orden);
  console.log(`  QR parada 1 (orden ${qrs[0].orden}): ${qrs[0].qr_firmado.slice(0, 50)}...`);
  console.log(`  QR parada 2 (orden ${qrs[1].orden}): ${qrs[1].qr_firmado.slice(0, 50)}...`);

  // Verificar que cliente rechaza a conductor con 403
  const { status: sqrCond } = await api(
    'GET', `/api/viajes/${id_viaje}/qr-paradas`, null, conductorToken
  );
  paso('GET qr-paradas rechaza al conductor con 403', sqrCond === 403, `status ${sqrCond}`);

  // ──────────────────────────────────────────────────────────────────────────
  // PASO 7: Confirmar primera parada
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n── PASO 7: Confirmar primera parada ──────────────────────────\n');

  const { status: sc1, data: conf1 } = await api(
    'POST', `/api/viajes/${id_viaje}/confirmar-parada`,
    {
      qr_firmado: qrs[0].qr_firmado,
      lat: PARADA_1.lat,
      lng: PARADA_1.lng,
    },
    conductorToken
  );
  paso('POST confirmar-parada 1 → 200', sc1 === 200, sc1 !== 200 ? JSON.stringify(conf1) : '');
  if (sc1 !== 200) { await cleanup(sConductor, sCliente); process.exit(1); }

  paso('confirmada=true, viaje_finalizado=false',
    conf1.confirmada === true && conf1.viaje_finalizado === false,
    JSON.stringify(conf1));

  // Verificar que QR invalido da 400
  const { status: scQRInv } = await api(
    'POST', `/api/viajes/${id_viaje}/confirmar-parada`,
    { qr_firmado: 'token.invalido', lat: PARADA_1.lat, lng: PARADA_1.lng },
    conductorToken
  );
  paso('QR invalido rechazado con 400', scQRInv === 400, `status ${scQRInv}`);

  // Verificar que reconfirmar la misma parada da 400
  const { status: scDup } = await api(
    'POST', `/api/viajes/${id_viaje}/confirmar-parada`,
    { qr_firmado: qrs[0].qr_firmado, lat: PARADA_1.lat, lng: PARADA_1.lng },
    conductorToken
  );
  paso('Reconfirmar parada ya ENTREGADO rechazado con 400', scDup === 400, `status ${scDup}`);

  // ──────────────────────────────────────────────────────────────────────────
  // PASO 8: Confirmar ultima parada → cierre del viaje
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n── PASO 8: Confirmar ultima parada → cierre del viaje ────────\n');

  const { status: sc2, data: conf2Data } = await api(
    'POST', `/api/viajes/${id_viaje}/confirmar-parada`,
    {
      qr_firmado: qrs[1].qr_firmado,
      lat: PARADA_2.lat,
      lng: PARADA_2.lng,
    },
    conductorToken
  );
  conf2 = conf2Data;
  paso('POST confirmar-parada 2 → 200', sc2 === 200, sc2 !== 200 ? JSON.stringify(conf2) : '');
  if (sc2 !== 200) { await cleanup(sConductor, sCliente); process.exit(1); }

  paso('confirmada=true, viaje_finalizado=true',
    conf2.confirmada === true && conf2.viaje_finalizado === true,
    JSON.stringify({ confirmada: conf2.confirmada, viaje_finalizado: conf2.viaje_finalizado }));
  paso('precio_real es un numero positivo',
    typeof conf2.precio_real === 'number' && conf2.precio_real >= 0,
    `precio_real = $${conf2.precio_real}`);
  paso('remito_url presente y comienza con http',
    typeof conf2.remito_url === 'string' && conf2.remito_url.startsWith('http'),
    conf2.remito_url ?? '(vacío — verificar config R2)');

  // ──────────────────────────────────────────────────────────────────────────
  // PASO 9: Verificar remito en R2 y evento WebSocket
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n── PASO 9: Remito PDF y evento viaje:finalizado ──────────────\n');

  if (conf2.remito_url && conf2.remito_url.startsWith('http')) {
    try {
      const resRemito = await fetch(conf2.remito_url, { method: 'HEAD' });
      paso('remito_url accesible en R2 (HEAD → 200)', resRemito.status === 200,
        `HTTP ${resRemito.status} — ${conf2.remito_url}`);
    } catch (e) {
      paso('remito_url accesible en R2 (HEAD → 200)', false, e.message);
    }
  } else {
    paso('remito_url accesible en R2 (HEAD → 200)', false,
      'remito_url ausente — verificar variables R2_ACCOUNT_ID, R2_PUBLIC_URL en .env');
  }

  await esperar(800);
  paso('Evento viaje:finalizado recibido por cliente via WebSocket',
    eventoFinalizado !== null && eventoFinalizado.id_viaje === id_viaje,
    eventoFinalizado
      ? `precio_real=${eventoFinalizado.precio_real}, remito_url=${eventoFinalizado.remito_url?.slice(0, 40)}...`
      : 'evento no recibido (cliente puede no estar en el room)');

  // ──────────────────────────────────────────────────────────────────────────
  // PASO 10: Calificar viaje
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n── PASO 10: Calificacion ─────────────────────────────────────\n');

  const { status: scal, data: calData } = await api(
    'POST', `/api/viajes/${id_viaje}/calificacion`,
    { puntuacion: 5, comentario: 'Test automatico Fase 5' },
    clienteToken
  );
  paso('POST calificacion → 201', scal === 201, scal !== 201 ? JSON.stringify(calData) : '');
  if (scal === 201) {
    paso('Respuesta tiene id_calificacion, puntuacion=5 y comentario',
      calData.id_calificacion > 0 && calData.puntuacion === 5 && calData.comentario === 'Test automatico Fase 5',
      JSON.stringify(calData));
  }

  // Calificacion duplicada debe dar 409
  const { status: scal2 } = await api(
    'POST', `/api/viajes/${id_viaje}/calificacion`,
    { puntuacion: 3 },
    clienteToken
  );
  paso('Calificacion duplicada rechazada con 409', scal2 === 409, `status ${scal2}`);

  // Solo el cliente puede calificar (conductor debe dar 403)
  const { status: scalCond } = await api(
    'POST', `/api/viajes/${id_viaje}/calificacion`,
    { puntuacion: 4 },
    conductorToken
  );
  paso('Conductor no puede calificar (403)', scalCond === 403, `status ${scalCond}`);

  // ──────────────────────────────────────────────────────────────────────────
  // PASO 11: Estado final del viaje en DB
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n── PASO 11: Estado final del viaje ───────────────────────────\n');

  const { status: sfinal, data: viajeFinal } = await api(
    'GET', `/api/viajes/${id_viaje}`, null, clienteToken
  );
  paso('GET /api/viajes/:id → 200', sfinal === 200, sfinal !== 200 ? JSON.stringify(viajeFinal) : '');
  paso('estado = FINALIZADO', viajeFinal.estado === 'FINALIZADO', viajeFinal.estado ?? 'undefined');
  paso('precio_real tiene valor numerico',
    typeof viajeFinal.precio_real === 'number' && viajeFinal.precio_real >= 0,
    `$${viajeFinal.precio_real}`);
  paso('calificacion incluida en respuesta con puntaje=5',
    viajeFinal.calificacion?.puntaje === 5,
    viajeFinal.calificacion ? JSON.stringify(viajeFinal.calificacion) : 'null');
  paso('Todas las paradas en estado ENTREGADO',
    Array.isArray(viajeFinal.paradas) && viajeFinal.paradas.every(p => p.estado === 'ENTREGADO'),
    viajeFinal.paradas?.map(p => `#${p.id_parada}:${p.estado}`).join(', ') ?? 'sin paradas');

  // ──────────────────────────────────────────────────────────────────────────
  // PASO 12: Redis limpiado
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n── PASO 12: Limpieza de Redis ─────────────────────────────────\n');

  const keysGPS = [
    `gps:${id_viaje}:ultima`,
    `gps:${id_viaje}:historial`,
    `gps:${id_viaje}:ruta`,
    `gps:${id_viaje}:acumulado`,
    `gps:${id_viaje}:pings_detenido`,
  ];
  const existencias = await Promise.all(keysGPS.map(k => redis.exists(k)));
  const keysPresentes = keysGPS.filter((_, i) => existencias[i] === 1);
  paso('Todas las keys GPS del viaje eliminadas de Redis',
    keysPresentes.length === 0,
    keysPresentes.length > 0 ? `Aun presentes: ${keysPresentes.join(', ')}` : '');

  // GET remito endpoint como verificacion extra
  const { status: srem, data: remData } = await api(
    'GET', `/api/viajes/${id_viaje}/remito`, null, clienteToken
  );
  paso('GET /api/viajes/:id/remito → 200',
    srem === 200 && remData.remito_url?.startsWith('http'),
    srem !== 200 ? JSON.stringify(remData) : remData.remito_url);

  // ──────────────────────────────────────────────────────────────────────────
  // RESUMEN
  // ──────────────────────────────────────────────────────────────────────────
  await cleanup(sConductor, sCliente);

  const ok = pasos.filter(p => p.ok).length;
  const fallaron = pasos.filter(p => !p.ok);

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║                  RESUMEN                    ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  pasos.forEach(p => console.log(`  ${p.ok ? '✅' : '❌'} ${p.nombre}`));
  console.log(`\n  ${ok}/${pasos.length} pasos pasaron`);

  if (fallaron.length > 0) {
    console.log('\n  Fallaron:');
    fallaron.forEach(p => console.log(`    ❌ ${p.nombre}${p.detalle ? ': ' + p.detalle : ''}`));
  }

  process.exit(fallaron.length === 0 ? 0 : 1);
}

main().catch(async e => {
  console.error('\n💥 Error inesperado:', e.message);
  try { await redis.quit(); } catch {}
  process.exit(1);
});
