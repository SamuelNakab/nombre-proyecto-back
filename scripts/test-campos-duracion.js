import { io } from 'socket.io-client';
import redis from '../src/config/redis.js';
import prisma from '../src/config/prisma.js';

// Campos que el front consumia "inferidos" y ahora la API expone explicitamente:
//   - duracion_real      (minutos) en GET /api/viajes/mis-viajes
//   - duracion_estimada  (minutos) + vehiculo asignado en GET /api/viajes/:id
//   - tiempo_capital / distancia_provincia en el evento viaje:finalizado y en
//     el desglose de la estimacion, en las TRES zonas (CABA/PROVINCIA/MIXTO).
//
// Mismo patron que scripts/test-fase5.js y scripts/test-jerarquia.js.

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const BASE = 'http://localhost:3000';

const HORA = 60 * 60 * 1000;

// Verificadas contra src/services/zona.service.js (ver el poligono del IGN).
const PLAZA_MAYO = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const RECOLETA = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };
const AVELLANEDA = { lat: -34.6634, lng: -58.3644, direccion: 'Avellaneda, PBA' };
const LANUS = { lat: -34.7069, lng: -58.3925, direccion: 'Lanus, PBA' };

const ZONAS = [
  { zona: 'CABA', paradas: [PLAZA_MAYO, RECOLETA] },
  { zona: 'PROVINCIA', paradas: [AVELLANEDA, LANUS] },
  { zona: 'MIXTO', paradas: [PLAZA_MAYO, AVELLANEDA] },
];

// ── Helpers ───────────────────────────────────────────────────────────────

const pasos = [];
function paso(nombre, ok, detalle = '') {
  pasos.push({ nombre, ok, detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}
function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    data = { error: `Respuesta no-JSON (${res.status}): ${text.slice(0, 500)}` };
  }
  return { status: res.status, data };
}

function conectar(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token: 'Bearer ' + token } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`Socket connect_error: ${e.message}`)));
    setTimeout(() => reject(new Error('Timeout al conectar socket (8s)')), 8000);
  });
}

async function registrar(datos, tipo) {
  const endpoint =
    tipo === 'cliente' ? '/api/auth/registro-cliente' : '/api/auth/registro-conductor';
  const { status, data } = await api('POST', endpoint, datos, null);
  if (status !== 201 && status !== 409) {
    throw new Error(`registro ${tipo} fallo: ${status} ${JSON.stringify(data)}`);
  }
}

async function cleanup(sockets) {
  for (const s of sockets) {
    try {
      s?.disconnect();
    } catch {
      /* noop */
    }
  }
  try {
    await prisma.$disconnect();
  } catch {
    /* noop */
  }
  try {
    await redis.quit();
  } catch {
    /* noop */
  }
}

// Lleva un viaje de la creacion al cierre y devuelve todo lo que hace falta
// para verificar: el desglose de la estimacion, el payload de viaje:finalizado
// y el detalle post-asignacion.
async function completarViaje({ paradas, clienteToken, conductorToken, sConductor, sCliente }) {
  const fecha = new Date(Date.now() + 2 * HORA).toISOString();
  const { status: sCrear, data: viaje } = await api(
    'POST',
    '/api/viajes',
    { zona: 'CABA', fecha_programada: fecha, condiciones_requeridas: [], paradas },
    clienteToken
  );
  if (sCrear !== 201) throw new Error(`crearViaje fallo (${sCrear}): ${JSON.stringify(viaje)}`);
  const id_viaje = viaje.id_viaje;

  // viaje:finalizado llega al room viaje:{id}, donde el cliente ya entro al
  // publicarse el viaje. El listener se engancha ANTES de arrancar el flujo (el
  // evento se emite en el confirmar-parada final), pero la espera con timeout se
  // hace DESPUES de confirmar: si el timeout se contara desde aca, un flujo lento
  // — la primera vuelta paga las llamadas frias a Google Maps — lo agotaria antes
  // de que el viaje llegue siquiera a cerrarse.
  let eventoFinalizadoRecibido = null;
  const onFin = (d) => {
    if (d.id_viaje === id_viaje) eventoFinalizadoRecibido = d;
  };
  sCliente.on('viaje:finalizado', onFin);

  await esperar(1200);
  sConductor.emit('viaje:aceptar', { id_viaje });
  await esperar(2000);

  // Detalle con el conductor ya asignado: es donde se miran duracion_estimada y
  // el vehiculo.
  const { data: detalle } = await api('GET', `/api/viajes/${id_viaje}`, null, clienteToken);

  // La ventana de inicio se abre VENTANA_INICIO_MINUTOS antes de la fecha
  // programada: la traemos a "ahora" para poder iniciar (igual que test-fase5).
  await prisma.viaje.update({ where: { id_viaje }, data: { fecha_programada: new Date() } });
  const { status: sIniciar, data: dIniciar } = await api(
    'POST',
    `/api/viajes/${id_viaje}/iniciar`,
    null,
    conductorToken
  );
  if (sIniciar !== 200) throw new Error(`iniciar fallo (${sIniciar}): ${JSON.stringify(dIniciar)}`);

  // Pings GPS interpolados entre las dos paradas, con 3s de separacion, para
  // que el acumulado tenga tiempo y distancia > 0.
  const tsBase = Date.now();
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    sConductor.emit('conductor:ubicacion', {
      id_viaje,
      lat: paradas[0].lat + (paradas[1].lat - paradas[0].lat) * t,
      lng: paradas[0].lng + (paradas[1].lng - paradas[0].lng) * t,
      timestamp: tsBase + i * 3000,
    });
    await esperar(400);
  }
  await esperar(1200);

  await api('PATCH', `/api/viajes/${id_viaje}/estado`, { estado: 'CARGANDO' }, conductorToken);
  await api('PATCH', `/api/viajes/${id_viaje}/estado`, { estado: 'EN_RUTA' }, conductorToken);

  const { data: qrs } = await api('GET', `/api/viajes/${id_viaje}/qr-paradas`, null, clienteToken);
  const ordenados = [...qrs].sort((a, b) => a.orden - b.orden);

  for (let i = 0; i < ordenados.length; i++) {
    const { status, data } = await api(
      'POST',
      `/api/viajes/${id_viaje}/confirmar-parada`,
      { qr_firmado: ordenados[i].qr_firmado, lat: paradas[i].lat, lng: paradas[i].lng },
      conductorToken
    );
    if (status !== 200) {
      throw new Error(`confirmar-parada ${i + 1} fallo (${status}): ${JSON.stringify(data)}`);
    }
  }

  // Recien ahora arranca la ventana de espera del evento: hasta 15s desde que
  // se confirmo la ultima parada.
  for (let i = 0; i < 30 && eventoFinalizadoRecibido === null; i++) {
    await esperar(500);
  }
  sCliente.off('viaje:finalizado', onFin);

  return {
    id_viaje,
    desglose_estimado: viaje.desglose_estimado,
    zona_persistida: viaje.zona,
    detalle,
    eventoFinalizado: eventoFinalizadoRecibido,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   TEST CAMPOS — duracion_real / duracion_estimada / zona  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const stamp = Date.now();
  const pass = 'test123456';
  const d = String(stamp).slice(-7);
  let sConductor = null;
  let sCliente = null;

  console.log('── SETUP: cliente + conductor con vehiculo ────────────────────\n');

  const emailCli = `cli-dur-${stamp}@test.com`;
  const emailCon = `con-dur-${stamp}@test.com`;

  await registrar(
    { nombre: 'Cli', apellido: 'Dur', dni: d + '0', email: emailCli, contrasena: pass },
    'cliente'
  );
  await registrar(
    {
      nombre: 'Con',
      apellido: 'Dur',
      dni: d + '1',
      email: emailCon,
      contrasena: pass,
      nro_licencia: 'LD' + d,
      licencia_vencimiento: '2028-01-01T00:00:00.000Z',
    },
    'conductor'
  );

  const clienteToken = await getToken(emailCli, pass);
  const conductorToken = await getToken(emailCon, pass);

  const { status: sVeh, data: veh } = await api(
    'POST',
    '/api/conductores/mis-vehiculos',
    {
      patente: `DU${String(stamp).slice(-5)}`,
      marca: 'Ford',
      modelo: 'Transit',
      anio: 2020,
      color: 'Blanco',
      tipo_vehiculo: 'furgon',
    },
    conductorToken
  );
  if (sVeh !== 201) throw new Error(`crear vehiculo fallo (${sVeh}): ${JSON.stringify(veh)}`);
  console.log(`  vehiculo del conductor: id=${veh.id_vehiculo} patente=${veh.patente}`);

  sConductor = await conectar(conductorToken);
  sCliente = await conectar(clienteToken);
  await esperar(1000);

  // ── CASO 1: desglose_estimado y viaje:finalizado en las TRES zonas ────────
  console.log('\n── CASO 1: tiempo_capital / distancia_provincia en las 3 zonas ──\n');

  const completados = {};

  for (const { zona, paradas } of ZONAS) {
    console.log(`\n  ── zona ${zona} ──`);
    const r = await completarViaje({
      paradas,
      clienteToken,
      conductorToken,
      sConductor,
      sCliente,
    });
    completados[zona] = r;

    paso(
      `CASO 1.${zona}: el servidor clasifica la zona como ${zona}`,
      r.zona_persistida === zona,
      `zona=${r.zona_persistida}`
    );

    // desglose_estimado (POST /api/viajes) — el MISMO objeto que estimar-costo
    // devuelve bajo la clave `desglose`.
    const de = r.desglose_estimado;
    paso(
      `CASO 1.${zona}: desglose_estimado trae las claves tiempo_capital y distancia_provincia`,
      de != null &&
        Object.hasOwn(de, 'tiempo_capital') &&
        Object.hasOwn(de, 'distancia_provincia'),
      de ? `claves=[${Object.keys(de).join(', ')}]` : 'desglose_estimado ausente'
    );

    // Forma esperada por zona (ver repartirPorZona en zona.service.js):
    //   CABA      -> tiempo_capital = tiempo total, distancia_provincia = null
    //   PROVINCIA -> tiempo_capital = null,         distancia_provincia = distancia total
    //   MIXTO     -> los dos con valor, prorrateados
    const formaOk = (obj) =>
      zona === 'CABA'
        ? typeof obj.tiempo_capital === 'number' && obj.distancia_provincia === null
        : zona === 'PROVINCIA'
          ? obj.tiempo_capital === null && typeof obj.distancia_provincia === 'number'
          : typeof obj.tiempo_capital === 'number' &&
            typeof obj.distancia_provincia === 'number';

    paso(
      `CASO 1.${zona}: desglose_estimado con la forma correcta para ${zona}`,
      formaOk(de),
      `tiempo_capital=${de?.tiempo_capital} distancia_provincia=${de?.distancia_provincia}`
    );

    // viaje:finalizado
    const ev = r.eventoFinalizado;
    paso(
      `CASO 1.${zona}: llega viaje:finalizado con desglose`,
      ev != null && ev.desglose != null,
      ev ? 'ok' : 'no llego el evento (timeout 12s)'
    );
    paso(
      `CASO 1.${zona}: viaje:finalizado.desglose trae tiempo_capital y distancia_provincia`,
      ev?.desglose != null &&
        Object.hasOwn(ev.desglose, 'tiempo_capital') &&
        Object.hasOwn(ev.desglose, 'distancia_provincia'),
      ev?.desglose ? `claves=[${Object.keys(ev.desglose).join(', ')}]` : 'sin desglose'
    );
    paso(
      `CASO 1.${zona}: viaje:finalizado.desglose con la forma correcta para ${zona}`,
      ev?.desglose != null && formaOk(ev.desglose),
      `tiempo_capital=${ev?.desglose?.tiempo_capital} distancia_provincia=${ev?.desglose?.distancia_provincia}`
    );
  }

  // ── CASO 2: detalle con duracion_estimada + vehiculo ──────────────────────
  console.log('\n── CASO 2: GET /api/viajes/:id → duracion_estimada + vehiculo ──\n');

  const rCaba = completados.CABA;
  const det = rCaba.detalle;

  paso(
    'CASO 2a: el detalle trae duracion_estimada',
    Object.hasOwn(det, 'duracion_estimada'),
    `duracion_estimada=${det.duracion_estimada}`
  );
  paso(
    'CASO 2b: duracion_estimada es un entero de minutos > 0',
    Number.isInteger(det.duracion_estimada) && det.duracion_estimada > 0,
    `valor=${det.duracion_estimada}`
  );
  paso(
    'CASO 2c: duracion_estimada = round(duracion_estimada_horas * 60) — misma magnitud, otra unidad',
    det.duracion_estimada === Math.round(det.duracion_estimada_horas * 60),
    `horas=${det.duracion_estimada_horas} minutos=${det.duracion_estimada}`
  );
  paso(
    'CASO 2d: duracion_estimada coincide con desglose_estimado.tiempo_horas de la creacion',
    det.duracion_estimada === Math.round(rCaba.desglose_estimado.tiempo_horas * 60),
    `tiempo_horas=${rCaba.desglose_estimado.tiempo_horas} → ${Math.round(rCaba.desglose_estimado.tiempo_horas * 60)} min`
  );
  paso(
    'CASO 2e: el detalle trae el vehiculo asignado (no null) con patente',
    det.vehiculo != null && typeof det.vehiculo.patente === 'string',
    `vehiculo=${JSON.stringify(det.vehiculo)}`
  );
  paso(
    'CASO 2f: el vehiculo del detalle es el que el conductor uso al aceptar',
    det.vehiculo?.id_vehiculo === veh.id_vehiculo,
    `detalle=${det.vehiculo?.id_vehiculo} esperado=${veh.id_vehiculo}`
  );

  // Un viaje sin conductor todavia no tiene vehiculo: debe venir null, no faltar.
  const fechaFutura = new Date(Date.now() + 3 * HORA).toISOString();
  const { data: vSinAsignar } = await api(
    'POST',
    '/api/viajes',
    {
      zona: 'CABA',
      fecha_programada: fechaFutura,
      condiciones_requeridas: [],
      paradas: [PLAZA_MAYO, RECOLETA],
    },
    clienteToken
  );
  const { data: detSinAsignar } = await api(
    'GET',
    `/api/viajes/${vSinAsignar.id_viaje}`,
    null,
    clienteToken
  );
  paso(
    'CASO 2g: viaje sin conductor → vehiculo null (presente, no ausente)',
    Object.hasOwn(detSinAsignar, 'vehiculo') && detSinAsignar.vehiculo === null,
    `vehiculo=${JSON.stringify(detSinAsignar.vehiculo)}`
  );

  // ── CASO 3: duracion_real en mis-viajes ──────────────────────────────────
  console.log('\n── CASO 3: GET /api/viajes/mis-viajes → duracion_real ──────────\n');

  const { status: sMis, data: misViajes } = await api(
    'GET',
    '/api/viajes/mis-viajes',
    null,
    clienteToken
  );
  paso('CASO 3a: GET /api/viajes/mis-viajes → 200', sMis === 200, `status=${sMis}`);

  const finCaba = misViajes.find((v) => v.id_viaje === rCaba.id_viaje);
  paso(
    'CASO 3b: el viaje finalizado aparece en mis-viajes con duracion_real presente',
    finCaba != null && Object.hasOwn(finCaba, 'duracion_real'),
    `duracion_real=${finCaba?.duracion_real}`
  );
  paso(
    'CASO 3c: duracion_real es un entero de minutos >= 0 (no null en FINALIZADO)',
    Number.isInteger(finCaba?.duracion_real) && finCaba.duracion_real >= 0,
    `estado=${finCaba?.estado} duracion_real=${finCaba?.duracion_real}`
  );

  const sinFinalizar = misViajes.find((v) => v.id_viaje === vSinAsignar.id_viaje);
  paso(
    'CASO 3d: un viaje NO finalizado trae duracion_real null',
    sinFinalizar != null &&
      Object.hasOwn(sinFinalizar, 'duracion_real') &&
      sinFinalizar.duracion_real === null,
    `estado=${sinFinalizar?.estado} duracion_real=${sinFinalizar?.duracion_real}`
  );

  // El flujo del test dura segundos, asi que duracion_real redondea a 0 y no
  // prueba la aritmetica. Atrasamos fecha_inicio 45 minutos contra la ultima
  // fecha_entrega real y verificamos que el valor sale exacto.
  const paradasCaba = await prisma.parada.findMany({
    where: { id_viaje: rCaba.id_viaje },
    select: { fecha_entrega: true },
  });
  const ultimaEntrega = Math.max(...paradasCaba.map((p) => new Date(p.fecha_entrega).getTime()));
  await prisma.viaje.update({
    where: { id_viaje: rCaba.id_viaje },
    data: { fecha_inicio: new Date(ultimaEntrega - 45 * 60000) },
  });

  const { data: misViajes2 } = await api('GET', '/api/viajes/mis-viajes', null, clienteToken);
  const finCaba2 = misViajes2.find((v) => v.id_viaje === rCaba.id_viaje);
  paso(
    'CASO 3e: con fecha_inicio 45 min antes de la ultima entrega → duracion_real = 45',
    finCaba2?.duracion_real === 45,
    `duracion_real=${finCaba2?.duracion_real} (esperado 45)`
  );

  // La ultima fecha_entrega se toma con max(), no por el orden de la parada:
  // adelantar la entrega de la parada de mayor `orden` no debe acortar el viaje.
  const paradasOrden = await prisma.parada.findMany({
    where: { id_viaje: rCaba.id_viaje },
    orderBy: { orden: 'asc' },
    select: { id_parada: true, orden: true, fecha_entrega: true },
  });
  const ultimaPorOrden = paradasOrden[paradasOrden.length - 1];
  await prisma.parada.update({
    where: { id_parada: ultimaPorOrden.id_parada },
    data: { fecha_entrega: new Date(ultimaEntrega - 30 * 60000) },
  });
  const { data: misViajes3 } = await api('GET', '/api/viajes/mis-viajes', null, clienteToken);
  const finCaba3 = misViajes3.find((v) => v.id_viaje === rCaba.id_viaje);
  paso(
    'CASO 3f: duracion_real usa max(fecha_entrega), no la parada de mayor orden',
    finCaba3?.duracion_real === 45,
    `duracion_real=${finCaba3?.duracion_real} (esperado 45: la parada de orden ${ultimaPorOrden.orden} se adelanto 30 min pero otra sigue siendo la ultima)`
  );

  // ── RESUMEN ──────────────────────────────────────────────────────────────
  await cleanup([sConductor, sCliente]);

  const ok = pasos.filter((p) => p.ok).length;
  const fallaron = pasos.filter((p) => !p.ok);

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                        RESUMEN                            ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  pasos.forEach((p) => console.log(`  ${p.ok ? '✅' : '❌'} ${p.nombre}`));
  console.log(`\n  ${ok}/${pasos.length} checks pasaron`);
  if (fallaron.length > 0) {
    console.log('\n  Fallaron:');
    fallaron.forEach((p) => console.log(`    ❌ ${p.nombre}${p.detalle ? ': ' + p.detalle : ''}`));
  }

  process.exit(fallaron.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n💥 Error inesperado:', e.message, e.stack);
  try {
    await prisma.$disconnect();
  } catch {
    /* noop */
  }
  try {
    await redis.quit();
  } catch {
    /* noop */
  }
  process.exit(1);
});
