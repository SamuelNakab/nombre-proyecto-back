import Redis from 'ioredis';
import {
  api, getToken, conectar, esperar, registrarSiNoExiste, crearVehiculoSiNoExiste,
  crearReporter, STRESS_USERS, PARADA_A, PARADA_B,
} from './_helpers.js';

const redis = new Redis(process.env.REDIS_URL);

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
  r.seccion('1. QR firmado correcto + GPS cercano → 200');
  const v1 = await montarViajeEnRuta(tokenCli, tokenA);
  const { data: qrs1 } = await api('GET', `/api/viajes/${v1.id_viaje}/qr-paradas`, null, tokenCli);
  const { status: sc1, data: dc1 } = await api(
    'POST', `/api/viajes/${v1.id_viaje}/confirmar-parada`,
    { qr_firmado: qrs1[0].qr_firmado, lat: PARADA_A.lat, lng: PARADA_A.lng },
    tokenA
  );
  r.paso('Confirmar parada legal → 200', sc1 === 200, `status ${sc1}`);
  r.paso('confirmada=true', sc1 === 200 && dc1.confirmada === true);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('2. QR de OTRO viaje → rechazado');
  const v2 = await montarViajeEnRuta(tokenCli, tokenA);
  const { data: qrs2 } = await api('GET', `/api/viajes/${v2.id_viaje}/qr-paradas`, null, tokenCli);
  const { status: sc2 } = await api(
    'POST', `/api/viajes/${v1.id_viaje}/confirmar-parada`,
    { qr_firmado: qrs2[0].qr_firmado, lat: PARADA_A.lat, lng: PARADA_A.lng },
    tokenA
  );
  r.paso('QR de OTRO viaje → 400', sc2 === 400, `status ${sc2}`);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('3. Firma HMAC manipulada → rechazada');
  // partes son base64(payload).hmac — manipulamos el hmac
  const partes = qrs1[1].qr_firmado.split('.');
  const fakeFirmado = partes[0] + '.deadbeef' + partes[1].slice(8);
  const { status: sc3 } = await api(
    'POST', `/api/viajes/${v1.id_viaje}/confirmar-parada`,
    { qr_firmado: fakeFirmado, lat: PARADA_A.lat, lng: PARADA_A.lng },
    tokenA
  );
  r.paso('Firma manipulada → 400', sc3 === 400, `status ${sc3}`);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('4. Conductor lejos (>200m) → rechazado');
  const { status: sc4, data: dc4 } = await api(
    'POST', `/api/viajes/${v1.id_viaje}/confirmar-parada`,
    { qr_firmado: qrs1[1].qr_firmado, lat: -34.7, lng: -58.5 },
    tokenA
  );
  r.paso('GPS lejos → 400', sc4 === 400, `status ${sc4} — ${dc4.error}`);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('5. Confirmar misma parada dos veces');
  // confirmar parada 2 legal
  const { status: sc5a } = await api(
    'POST', `/api/viajes/${v1.id_viaje}/confirmar-parada`,
    { qr_firmado: qrs1[1].qr_firmado, lat: PARADA_B.lat, lng: PARADA_B.lng },
    tokenA
  );
  // (esto cierra el viaje porque era la ultima parada)
  const { status: sc5b } = await api(
    'POST', `/api/viajes/${v1.id_viaje}/confirmar-parada`,
    { qr_firmado: qrs1[1].qr_firmado, lat: PARADA_B.lat, lng: PARADA_B.lng },
    tokenA
  );
  r.paso('1ra confirmacion → 200', sc5a === 200, `status ${sc5a}`);
  r.paso('2da confirmacion misma parada → rechazada (400)', sc5b === 400, `status ${sc5b}`);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('6. Calificar viaje NO finalizado');
  const { status: sc6, data: dc6 } = await api(
    'POST', `/api/viajes/${v2.id_viaje}/calificacion`,
    { puntuacion: 5 }, tokenCli
  );
  r.paso('Calificar viaje en EN_RUTA → 400', sc6 === 400, `status ${sc6} — ${dc6.error}`);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('7. Calificar dos veces el mismo viaje');
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
  r.seccion('8. Puntaje fuera de 1-5');
  // necesitamos otro viaje finalizado para calificar
  const v3 = await montarViajeEnRuta(tokenCli, tokenA);
  const { data: qrs3 } = await api('GET', `/api/viajes/${v3.id_viaje}/qr-paradas`, null, tokenCli);
  await api('POST', `/api/viajes/${v3.id_viaje}/confirmar-parada`,
    { qr_firmado: qrs3[0].qr_firmado, lat: PARADA_A.lat, lng: PARADA_A.lng }, tokenA);
  await api('POST', `/api/viajes/${v3.id_viaje}/confirmar-parada`,
    { qr_firmado: qrs3[1].qr_firmado, lat: PARADA_B.lat, lng: PARADA_B.lng }, tokenA);

  const { status: sc8a } = await api(
    'POST', `/api/viajes/${v3.id_viaje}/calificacion`, { puntuacion: 0 }, tokenCli
  );
  r.paso('puntuacion 0 → 400', sc8a === 400, `status ${sc8a}`);
  const { status: sc8b } = await api(
    'POST', `/api/viajes/${v3.id_viaje}/calificacion`, { puntuacion: 6 }, tokenCli
  );
  r.paso('puntuacion 6 → 400', sc8b === 400, `status ${sc8b}`);
  const { status: sc8c } = await api(
    'POST', `/api/viajes/${v3.id_viaje}/calificacion`, { puntuacion: -1 }, tokenCli
  );
  r.paso('puntuacion -1 → 400', sc8c === 400, `status ${sc8c}`);
  const { status: sc8d } = await api(
    'POST', `/api/viajes/${v3.id_viaje}/calificacion`, { puntuacion: 2.5 }, tokenCli
  );
  r.paso('puntuacion decimal (2.5) → 400', sc8d === 400, `status ${sc8d}`);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('9. Remito PDF accesible (HEAD 200)');
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
  r.seccion('10. Redis limpiado tras cierre — todas las keys gps:* del viaje 1');
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
