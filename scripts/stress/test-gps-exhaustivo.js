import Redis from 'ioredis';
import {
  api, getToken, conectar, esperar, registrarSiNoExiste, crearVehiculoSiNoExiste,
  crearReporter, STRESS_USERS, PARADA_A, PARADA_B,
} from './_helpers.js';

const redis = new Redis(process.env.REDIS_URL);

async function crearViajeNuevo(clienteToken) {
  const fecha = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const { data } = await api('POST', '/api/viajes', {
    zona: 'CABA', fecha_programada: fecha, condiciones_requeridas: [],
    paradas: [PARADA_A, PARADA_B],
  }, clienteToken);
  return data;
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   STRESS — GPS EXHAUSTIVO (Fase 4)          ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const r = crearReporter('gps');

  await registrarSiNoExiste(STRESS_USERS.cliente, 'cliente');
  await registrarSiNoExiste(STRESS_USERS.conductor, 'conductor');
  await registrarSiNoExiste(STRESS_USERS.conductor2, 'conductor');
  const tokenCli = await getToken(STRESS_USERS.cliente.email, STRESS_USERS.cliente.contrasena);
  const tokenA = await getToken(STRESS_USERS.conductor.email, STRESS_USERS.conductor.contrasena);
  const tokenB = await getToken(STRESS_USERS.conductor2.email, STRESS_USERS.conductor2.contrasena);
  await crearVehiculoSiNoExiste(tokenA, 'FLT001');
  await crearVehiculoSiNoExiste(tokenB, 'FLT002');
  r.paso('Tokens y vehiculos listos', true);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('1. Ping GPS valido → mapa:actualizar + EN_CAMINO_A_ORIGEN');

  const viaje1 = await crearViajeNuevo(tokenCli);
  const id1 = viaje1.id_viaje;
  const sA = await conectar(tokenA);
  const sCli = await conectar(tokenCli);
  let mapaCount = 0;
  sCli.on('mapa:actualizar', () => { mapaCount++; });

  await esperar(1200);
  sA.emit('viaje:aceptar', { id_viaje: id1 });
  await esperar(1500);

  sA.emit('conductor:ubicacion', {
    id_viaje: id1, lat: PARADA_A.lat, lng: PARADA_A.lng, timestamp: Date.now(),
  });
  await esperar(1500);

  const { data: v1state } = await api('GET', `/api/viajes/${id1}`, null, tokenCli);
  r.paso('Primer ping → estado EN_CAMINO_A_ORIGEN',
    v1state.estado === 'EN_CAMINO_A_ORIGEN', v1state.estado);
  r.paso('Cliente recibe mapa:actualizar', mapaCount > 0, `${mapaCount} eventos`);

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('2. Coordenadas fuera de rango (lat=200, lng=500)');

  let serverCrash = false;
  let errorRecibido = false;
  let errorMsg = null;
  sA.on('error', (e) => { errorRecibido = true; errorMsg = e?.error; });

  sA.emit('conductor:ubicacion', {
    id_viaje: id1, lat: 200, lng: 500, timestamp: Date.now(),
  });
  await esperar(1500);

  // Ver si el server sigue vivo
  const { status: sCheck } = await api('GET', `/api/viajes/${id1}`, null, tokenCli);
  serverCrash = sCheck !== 200;
  r.paso('Servidor sigue respondiendo tras lat=200/lng=500',
    !serverCrash, serverCrash ? `status ${sCheck}` : '');

  // Verificar en Redis si guardo el ping invalido (esto seria un BUG)
  const ultimaRaw = await redis.get(`gps:${id1}:ultima`);
  const ultima = ultimaRaw ? JSON.parse(ultimaRaw) : null;
  const guardoInvalida = ultima && (ultima.lat === 200 || ultima.lng === 500);
  r.paso('No guarda coordenada invalida en Redis',
    !guardoInvalida,
    guardoInvalida ? `Redis guardo lat=${ultima.lat}/lng=${ultima.lng}` : `ultima=${ultima ? `${ultima.lat},${ultima.lng}` : 'null'}`,
    guardoInvalida ? 'bug' : 'ok');

  r.paso("Conductor recibe error 'Coordenadas fuera de rango'",
    errorRecibido && errorMsg === 'Coordenadas fuera de rango',
    errorRecibido ? `error recibido: "${errorMsg}"` : 'no se recibio ningun error');

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('2b. Limites exactos de coordenadas (casos borde inclusivos)');

  // Viaje aislado para no contaminar el acumulado de id1
  const viajeBorde = await crearViajeNuevo(tokenCli);
  const idB = viajeBorde.id_viaje;
  await esperar(300);
  sA.emit('viaje:aceptar', { id_viaje: idB });
  await esperar(1500);

  // Manda un ping y devuelve lo que quedo en gps:{idB}:ultima
  async function pingYUltima(lat, lng) {
    sA.emit('conductor:ubicacion', { id_viaje: idB, lat, lng, timestamp: Date.now() });
    await esperar(700);
    const raw = await redis.get(`gps:${idB}:ultima`);
    return raw ? JSON.parse(raw) : null;
  }

  // Limites validos (inclusive) → deben ACEPTARSE y guardarse en Redis
  const lim1 = await pingYUltima(90, 180);
  r.paso('lat=90 / lng=180 (limite) se acepta y guarda en Redis',
    !!lim1 && lim1.lat === 90 && lim1.lng === 180,
    lim1 ? `ultima=${lim1.lat},${lim1.lng}` : 'null');

  const lim2 = await pingYUltima(-90, -180);
  r.paso('lat=-90 / lng=-180 (limite) se acepta y guarda en Redis',
    !!lim2 && lim2.lat === -90 && lim2.lng === -180,
    lim2 ? `ultima=${lim2.lat},${lim2.lng}` : 'null');

  // Apenas fuera de rango → deben RECHAZARSE (Redis :ultima no cambia a la invalida)
  const trasLatInv = await pingYUltima(90.0001, 0);
  r.paso('lat=90.0001 se rechaza (Redis no guarda la coord invalida)',
    !!trasLatInv && trasLatInv.lat !== 90.0001,
    trasLatInv ? `ultima sigue en ${trasLatInv.lat},${trasLatInv.lng}` : 'null');

  const trasLngInv = await pingYUltima(0, 180.0001);
  r.paso('lng=180.0001 se rechaza (Redis no guarda la coord invalida)',
    !!trasLngInv && trasLngInv.lng !== 180.0001,
    trasLngInv ? `ultima sigue en ${trasLngInv.lat},${trasLngInv.lng}` : 'null');

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('2c. Ping invalido NO contamina el acumulado del ping valido siguiente');

  const viajeCont = await crearViajeNuevo(tokenCli);
  const idC = viajeCont.id_viaje;
  await esperar(300);
  sA.emit('viaje:aceptar', { id_viaje: idC });
  await esperar(1500);

  const tBase = Date.now();
  // Ping valido 1 (ancla en PARADA_A)
  sA.emit('conductor:ubicacion', { id_viaje: idC, lat: PARADA_A.lat, lng: PARADA_A.lng, timestamp: tBase });
  await esperar(700);
  // Ping INVALIDO (lat=200/lng=500) — debe ignorarse por completo
  sA.emit('conductor:ubicacion', { id_viaje: idC, lat: 200, lng: 500, timestamp: tBase + 3000 });
  await esperar(700);
  // Ping valido 2 (PARADA_B)
  sA.emit('conductor:ubicacion', { id_viaje: idC, lat: PARADA_B.lat, lng: PARADA_B.lng, timestamp: tBase + 6000 });
  await esperar(900);

  const acumContRaw = await redis.get(`gps:${idC}:acumulado`);
  const acumCont = acumContRaw ? JSON.parse(acumContRaw) : null;
  // Distancia real PARADA_A → PARADA_B ~2.4 km. Si el ping invalido hubiera
  // contaminado, el acumulado saltaria a miles de km (distancia desde lat=200).
  const distOk = !!acumCont && Number.isFinite(acumCont.distancia_km) &&
    acumCont.distancia_km > 0 && acumCont.distancia_km < 50;
  r.paso('Acumulado tras [valido, invalido, valido] es la distancia real (no contaminado)',
    distOk,
    acumCont ? `distancia_km=${acumCont.distancia_km.toFixed(3)} (esperado ~2.4, no miles)` : 'null',
    distOk ? 'ok' : 'bug');

  const ultContRaw = await redis.get(`gps:${idC}:ultima`);
  const ultCont = ultContRaw ? JSON.parse(ultContRaw) : null;
  r.paso('Ultima coord guardada es el ping valido (PARADA_B), no la invalida',
    !!ultCont && ultCont.lat !== 200 && Math.abs(ultCont.lat - PARADA_B.lat) < 0.001,
    ultCont ? `ultima=${ultCont.lat},${ultCont.lng}` : 'null');

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('3. 10 pings en 1 segundo — burst');

  // Reset velocidad/acumulado contando desde un ping ancla
  const tsBase = Date.now();
  for (let i = 0; i < 10; i++) {
    sA.emit('conductor:ubicacion', {
      id_viaje: id1,
      lat: PARADA_A.lat + i * 0.0001,
      lng: PARADA_A.lng + i * 0.0001,
      timestamp: tsBase + i * 100,
    });
  }
  await esperar(2500);

  const acumRaw = await redis.get(`gps:${id1}:acumulado`);
  const acum = acumRaw ? JSON.parse(acumRaw) : null;
  r.paso('Acumulado existe tras burst de 10 pings', !!acum,
    acum ? `dist=${acum.distancia_km?.toFixed(4)}km, t=${acum.tiempo_horas?.toFixed(6)}h` : 'null');
  r.paso('Acumulado no tiene NaN ni Infinity',
    !!acum && Number.isFinite(acum.distancia_km) && Number.isFinite(acum.tiempo_horas) &&
    !Number.isNaN(acum.distancia_km) && !Number.isNaN(acum.tiempo_horas),
    acum ? `valores numericos finitos` : 'sin acumulado');

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('4. Ping de conductor NO asignado → debe rechazarse (B-003)');

  const sB = await conectar(tokenB);
  let errorB = null;
  sB.on('error', (e) => { errorB = e?.error; });
  await esperar(800);

  // Coordenada VALIDA pero distintiva: pasa el chequeo de rango, asi el unico
  // motivo de rechazo posible es la verificacion de propiedad (B-003).
  const COORD_INTRUSO = { lat: -34.6100, lng: -58.4050 };
  const mapaCountAntes = mapaCount;
  const ultimaAntesRaw = await redis.get(`gps:${id1}:ultima`);

  sB.emit('conductor:ubicacion', {
    id_viaje: id1, lat: COORD_INTRUSO.lat, lng: COORD_INTRUSO.lng, timestamp: Date.now(),
  });
  await esperar(1500);

  const mapaCountDespues = mapaCount;
  const ultimaDespuesRaw = await redis.get(`gps:${id1}:ultima`);
  const ultimaDespues = ultimaDespuesRaw ? JSON.parse(ultimaDespuesRaw) : null;

  const noEmitio = mapaCountDespues === mapaCountAntes;
  const noGuardoCoordIntrusa = !ultimaDespues || ultimaDespues.lat !== COORD_INTRUSO.lat;
  const redisIntacto = ultimaAntesRaw === ultimaDespuesRaw;

  r.paso('Conductor no asignado: NO se emite mapa:actualizar',
    noEmitio, `mapa antes=${mapaCountAntes}, despues=${mapaCountDespues}`,
    noEmitio ? 'ok' : 'bug');
  r.paso('Conductor no asignado: su coordenada NO se guarda en Redis',
    noGuardoCoordIntrusa && redisIntacto,
    ultimaDespues ? `ultima sigue en ${ultimaDespues.lat},${ultimaDespues.lng}` : 'null',
    (noGuardoCoordIntrusa && redisIntacto) ? 'ok' : 'bug');
  r.paso("Conductor no asignado recibe error 'No autorizado para este viaje'",
    errorB === 'No autorizado para este viaje',
    errorB ? `error recibido: "${errorB}"` : 'no se recibio ningun error',
    errorB === 'No autorizado para este viaje' ? 'ok' : 'bug');

  // El conductor LEGITIMO (A, asignado) debe seguir pudiendo mandar sus pings
  const mapaCountPreA = mapaCount;
  const COORD_LEGIT = { lat: PARADA_A.lat + 0.0009, lng: PARADA_A.lng + 0.0009 };
  sA.emit('conductor:ubicacion', {
    id_viaje: id1, lat: COORD_LEGIT.lat, lng: COORD_LEGIT.lng, timestamp: Date.now(),
  });
  await esperar(1500);
  const ultimaLegitRaw = await redis.get(`gps:${id1}:ultima`);
  const ultimaLegit = ultimaLegitRaw ? JSON.parse(ultimaLegitRaw) : null;
  const aEmitio = mapaCount > mapaCountPreA;
  const aGuardo = !!ultimaLegit && Math.abs(ultimaLegit.lat - COORD_LEGIT.lat) < 0.00001;
  r.paso('Conductor asignado (A) SI puede mandar pings (sin regresion)',
    aEmitio && aGuardo,
    `mapa +${mapaCount - mapaCountPreA}, ultima=${ultimaLegit ? `${ultimaLegit.lat},${ultimaLegit.lng}` : 'null'}`,
    (aEmitio && aGuardo) ? 'ok' : 'bug');

  sB.disconnect();

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('5. Cambio de estado invalido (CARGANDO → FINALIZADO directo)');

  // Forzar el viaje a CARGANDO primero
  await api('PATCH', `/api/viajes/${id1}/estado`, { estado: 'CARGANDO' }, tokenA);
  const { status: sInv, data: dInv } = await api(
    'PATCH', `/api/viajes/${id1}/estado`, { estado: 'FINALIZADO' }, tokenA
  );
  r.paso('PATCH a FINALIZADO (no permitido manualmente) → 400 con error claro',
    sInv === 400, `status ${sInv} — ${dInv.error}`);

  // Tambien probamos volver atras de EN_RUTA a CARGANDO (regresion)
  await api('PATCH', `/api/viajes/${id1}/estado`, { estado: 'EN_RUTA' }, tokenA);
  const { status: sBack, data: dBack } = await api(
    'PATCH', `/api/viajes/${id1}/estado`, { estado: 'CARGANDO' }, tokenA
  );
  if (sBack === 200) {
    r.paso('Backend bloquea retroceso EN_RUTA → CARGANDO',
      false, 'Acepto el retroceso de estado (BUG potencial)', 'bug');
  } else if (sBack === 400) {
    r.paso('Backend rechaza retroceso EN_RUTA → CARGANDO', true, `status ${sBack}`);
  } else {
    r.paso('Backend rechaza retroceso EN_RUTA → CARGANDO',
      false, `status ${sBack} — ${dBack.error}`, 'bug');
  }

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('6. Deteccion de desvio → alerta:desvio');

  const viaje2 = await crearViajeNuevo(tokenCli);
  const id2 = viaje2.id_viaje;
  // Aceptar y poner EN_RUTA con conductor A
  sA.emit('viaje:aceptar', { id_viaje: id2 });
  await esperar(1500);
  // primer ping en origen para activar EN_CAMINO_A_ORIGEN
  sA.emit('conductor:ubicacion', {
    id_viaje: id2, lat: PARADA_A.lat, lng: PARADA_A.lng, timestamp: Date.now(),
  });
  await esperar(1000);
  await api('PATCH', `/api/viajes/${id2}/estado`, { estado: 'CARGANDO' }, tokenA);
  await api('PATCH', `/api/viajes/${id2}/estado`, { estado: 'EN_RUTA' }, tokenA);

  // Conectar cliente al room del viaje 2 (ya esta en su usuario:* room)
  let desvioRecibido = false;
  sCli.on('alerta:desvio', () => { desvioRecibido = true; });

  // Mandar pings MUY lejos de la ruta (en Patagonia)
  for (let i = 0; i < 2; i++) {
    sA.emit('conductor:ubicacion', {
      id_viaje: id2, lat: -41.1335 + i * 0.001, lng: -71.3103 + i * 0.001,
      timestamp: Date.now() + i * 1000,
    });
    await esperar(800);
  }
  await esperar(2000);
  r.paso('alerta:desvio emitida tras pings lejanos',
    desvioRecibido, desvioRecibido ? 'evento recibido' : 'no se recibio');

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('7. Parada sospechosa — pings repetidos casi sin moverse');

  // En el codigo, el contador se basa en INCR y umbral=5min => 20 pings (15s c/u).
  // Mandamos muchos para gatillar.
  let paradaSospechosa = false;
  sCli.on('alerta:parada', () => { paradaSospechosa = true; });

  const lugar = { lat: -34.65, lng: -58.50 }; // lejos de las paradas (no aplica exencion)
  for (let i = 0; i < 25; i++) {
    sA.emit('conductor:ubicacion', {
      id_viaje: id2,
      lat: lugar.lat + (i % 2) * 0.0000001,
      lng: lugar.lng + (i % 2) * 0.0000001,
      timestamp: Date.now() + i * 200,
    });
    await esperar(120);
  }
  await esperar(2000);
  r.paso('alerta:parada emitida tras muchos pings detenidos',
    paradaSospechosa, paradaSospechosa ? 'evento recibido' : 'no recibido');

  // ────────────────────────────────────────────────────────────────────────
  // Cleanup
  sA.disconnect(); sCli.disconnect();
  await redis.quit();
  return r.resumen();
}

main().then(res => {
  console.log('\n__RESULT_JSON__' + JSON.stringify(res));
  process.exit(0);
}).catch(async e => {
  console.error('\n💥 Error inesperado:', e.message);
  try { await redis.quit(); } catch {}
  console.log('\n__RESULT_JSON__' + JSON.stringify({ nombre: 'gps', error: e.message, total: 0, ok: 0, bugs: [], huecos: [], todos: [] }));
  process.exit(1);
});
