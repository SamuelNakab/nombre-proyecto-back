import Redis from 'ioredis';
import {
  api, getToken, conectar, esperar, registrarSiNoExiste, crearVehiculoSiNoExiste,
  crearReporter, STRESS_USERS, PARADA_A, PARADA_B,
} from './_helpers.js';

const redis = new Redis(process.env.REDIS_URL);

// Mismo default que el backend (src/controllers/viajes.controller.js). Si el
// server corre con otro valor, exportá RADIO_CONFIRMACION_METROS tambien aca.
const RADIO_METROS = parseFloat(process.env.RADIO_CONFIRMACION_METROS || '50');

// Las paradas (id_parada + orden) salen del detalle del viaje: el endpoint de
// QR ya no existe.
async function paradasDe(id_viaje, token) {
  const { status, data } = await api('GET', `/api/viajes/${id_viaje}`, null, token);
  if (status !== 200) throw new Error(`GET /api/viajes/${id_viaje} fallo (${status}): ${JSON.stringify(data)}`);
  return [...data.paradas].sort((a, b) => a.orden - b.orden);
}

async function montarViajeEnRuta(tokenCli, tokenA) {
  const fecha = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const { data: viaje } = await api('POST', '/api/viajes', {
    zona: 'CABA', fecha_programada: fecha, condiciones_requeridas: [],
    paradas: [PARADA_A, PARADA_B],
  }, tokenCli);
  const id_viaje = viaje.id_viaje;
  const sA = await conectar(tokenA);
  await esperar(1200);
  sA.emit('viaje:aceptar', { id_viaje });
  await esperar(1500);
  sA.emit('conductor:ubicacion', {
    id_viaje, lat: PARADA_A.lat, lng: PARADA_A.lng, timestamp: Date.now(),
  });
  await esperar(1000);
  await api('PATCH', `/api/viajes/${id_viaje}/estado`, { estado: 'CARGANDO' }, tokenA);
  await api('PATCH', `/api/viajes/${id_viaje}/estado`, { estado: 'EN_RUTA' }, tokenA);
  return { id_viaje, sA };
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   STRESS — CIERRE EXHAUSTIVO (Fase 5)       ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const r = crearReporter('cierre');

  await registrarSiNoExiste(STRESS_USERS.cliente, 'cliente');
  await registrarSiNoExiste(STRESS_USERS.conductor, 'conductor');
  const tokenCli = await getToken(STRESS_USERS.cliente.email, STRESS_USERS.cliente.contrasena);
  const tokenA = await getToken(STRESS_USERS.conductor.email, STRESS_USERS.conductor.contrasena);
  await crearVehiculoSiNoExiste(tokenA, 'FLT001');
  r.paso('Tokens y vehiculo listos', true);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('1. Parada del viaje + GPS encima de la parada → 200');
  const v1 = await montarViajeEnRuta(tokenCli, tokenA);
  const paradas1 = await paradasDe(v1.id_viaje, tokenCli);
  const { status: sc1, data: dc1 } = await api(
    'POST', `/api/viajes/${v1.id_viaje}/confirmar-parada`,
    { id_parada: paradas1[0].id_parada, lat: PARADA_A.lat, lng: PARADA_A.lng },
    tokenA
  );
  r.paso('Confirmar parada legal → 200', sc1 === 200, `status ${sc1}`);
  r.paso('confirmada=true', sc1 === 200 && dc1.confirmada === true);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('2. Parada de OTRO viaje → rechazada');
  const v2 = await montarViajeEnRuta(tokenCli, tokenA);
  const paradas2 = await paradasDe(v2.id_viaje, tokenCli);
  const { status: sc2, data: dc2 } = await api(
    'POST', `/api/viajes/${v1.id_viaje}/confirmar-parada`,
    { id_parada: paradas2[0].id_parada, lat: PARADA_A.lat, lng: PARADA_A.lng },
    tokenA
  );
  r.paso('Parada de OTRO viaje → 400', sc2 === 400, `status ${sc2} — ${dc2.error}`);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion(`3. Conductor lejos (>${RADIO_METROS}m) → rechazado`);
  const { status: sc3, data: dc3 } = await api(
    'POST', `/api/viajes/${v1.id_viaje}/confirmar-parada`,
    { id_parada: paradas1[1].id_parada, lat: -34.7, lng: -58.5 },
    tokenA
  );
  r.paso('GPS lejos → 400', sc3 === 400, `status ${sc3} — ${dc3.error}`);
  r.paso('El error dice la distancia y el maximo',
    sc3 === 400 && /Estas a \d+m de la parada/.test(dc3.error ?? '') && dc3.error.includes(`${RADIO_METROS}m`),
    dc3.error ?? '');

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('4. Confirmar misma parada dos veces');
  // confirmar parada 2 legal
  const { status: sc4a } = await api(
    'POST', `/api/viajes/${v1.id_viaje}/confirmar-parada`,
    { id_parada: paradas1[1].id_parada, lat: PARADA_B.lat, lng: PARADA_B.lng },
    tokenA
  );
  // (esto cierra el viaje porque era la ultima parada)
  const { status: sc4b } = await api(
    'POST', `/api/viajes/${v1.id_viaje}/confirmar-parada`,
    { id_parada: paradas1[1].id_parada, lat: PARADA_B.lat, lng: PARADA_B.lng },
    tokenA
  );
  r.paso('1ra confirmacion → 200', sc4a === 200, `status ${sc4a}`);
  r.paso('2da confirmacion misma parada → rechazada (400)', sc4b === 400, `status ${sc4b}`);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('5. Calificar viaje NO finalizado');
  const { status: sc5, data: dc5 } = await api(
    'POST', `/api/viajes/${v2.id_viaje}/calificacion`,
    { puntuacion: 5 }, tokenCli
  );
  r.paso('Calificar viaje en EN_RUTA → 400', sc5 === 400, `status ${sc5} — ${dc5.error}`);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('6. Calificar dos veces el mismo viaje');
  const { status: scal1 } = await api(
    'POST', `/api/viajes/${v1.id_viaje}/calificacion`,
    { puntuacion: 5 }, tokenCli
  );
  const { status: scal2 } = await api(
    'POST', `/api/viajes/${v1.id_viaje}/calificacion`,
    { puntuacion: 3 }, tokenCli
  );
  r.paso('1ra calificacion → 201', scal1 === 201, `status ${scal1}`);
  r.paso('2da calificacion → 409', scal2 === 409, `status ${scal2}`);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('7. Puntaje fuera de 1-5');
  // necesitamos otro viaje finalizado para calificar
  const v3 = await montarViajeEnRuta(tokenCli, tokenA);
  const paradas3 = await paradasDe(v3.id_viaje, tokenCli);
  await api('POST', `/api/viajes/${v3.id_viaje}/confirmar-parada`,
    { id_parada: paradas3[0].id_parada, lat: PARADA_A.lat, lng: PARADA_A.lng }, tokenA);
  await api('POST', `/api/viajes/${v3.id_viaje}/confirmar-parada`,
    { id_parada: paradas3[1].id_parada, lat: PARADA_B.lat, lng: PARADA_B.lng }, tokenA);

  const { status: sc7a } = await api(
    'POST', `/api/viajes/${v3.id_viaje}/calificacion`, { puntuacion: 0 }, tokenCli
  );
  r.paso('puntuacion 0 → 400', sc7a === 400, `status ${sc7a}`);
  const { status: sc7b } = await api(
    'POST', `/api/viajes/${v3.id_viaje}/calificacion`, { puntuacion: 6 }, tokenCli
  );
  r.paso('puntuacion 6 → 400', sc7b === 400, `status ${sc7b}`);
  const { status: sc7c } = await api(
    'POST', `/api/viajes/${v3.id_viaje}/calificacion`, { puntuacion: -1 }, tokenCli
  );
  r.paso('puntuacion -1 → 400', sc7c === 400, `status ${sc7c}`);
  const { status: sc7d } = await api(
    'POST', `/api/viajes/${v3.id_viaje}/calificacion`, { puntuacion: 2.5 }, tokenCli
  );
  r.paso('puntuacion decimal (2.5) → 400', sc7d === 400, `status ${sc7d}`);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('8. Remito PDF accesible (HEAD 200)');
  const { data: rem } = await api('GET', `/api/viajes/${v1.id_viaje}/remito`, null, tokenCli);
  if (rem.remito_url) {
    try {
      const head = await fetch(rem.remito_url, { method: 'HEAD' });
      r.paso(`Remito ${rem.remito_url.slice(rem.remito_url.lastIndexOf('/'))} HEAD → 200`,
        head.status === 200, `HTTP ${head.status}`);
    } catch (e) {
      r.paso('Remito HEAD', false, e.message);
    }
  } else {
    r.paso('Remito URL presente', false, 'remito_url ausente');
  }

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('9. Redis limpiado tras cierre — todas las keys gps:* del viaje 1');
  const keys = [
    `gps:${v1.id_viaje}:ultima`,
    `gps:${v1.id_viaje}:historial`,
    `gps:${v1.id_viaje}:ruta`,
    `gps:${v1.id_viaje}:acumulado`,
    `gps:${v1.id_viaje}:pings_detenido`,
    `gps:${v1.id_viaje}:eta`,
    `gps:${v1.id_viaje}:ultimo_recalculo`,
    `gps:${v1.id_viaje}:pings_desviado`,
  ];
  const existencias = await Promise.all(keys.map(k => redis.exists(k)));
  const sobrantes = keys.filter((_, i) => existencias[i] === 1);
  r.paso('Todas las keys gps:{id_viaje}:* eliminadas',
    sobrantes.length === 0,
    sobrantes.length > 0 ? `Sobrantes: ${sobrantes.join(', ')}` : '');

  v1.sA.disconnect();
  v2.sA.disconnect();
  v3.sA.disconnect();
  await redis.quit();
  return r.resumen();
}

main().then(res => {
  console.log('\n__RESULT_JSON__' + JSON.stringify(res));
  process.exit(0);
}).catch(async e => {
  console.error('\n💥 Error inesperado:', e.message);
  try { await redis.quit(); } catch {}
  console.log('\n__RESULT_JSON__' + JSON.stringify({ nombre: 'cierre', error: e.message, total: 0, ok: 0, bugs: [], huecos: [], todos: [] }));
  process.exit(1);
});
