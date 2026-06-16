import {
  api, getToken, conectar, esperar, registrarSiNoExiste, crearVehiculoSiNoExiste,
  crearReporter, STRESS_USERS, PARADA_A, PARADA_B,
} from './_helpers.js';

async function crearViajeNuevo(tokenCli) {
  const fecha = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const { data } = await api('POST', '/api/viajes', {
    zona: 'CABA', fecha_programada: fecha, condiciones_requeridas: [],
    paradas: [PARADA_A, PARADA_B],
  }, tokenCli);
  return data;
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   STRESS — CONCURRENCIA Y CASOS EXTREMOS    ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const r = crearReporter('concurrencia');

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
  r.seccion('1. UN conductor acepta DOS viajes en simultaneo');

  const va = await crearViajeNuevo(tokenCli);
  const vb = await crearViajeNuevo(tokenCli);
  r.paso(`Creados 2 viajes (${va.id_viaje}, ${vb.id_viaje})`, true);

  const sA = await conectar(tokenA);
  let asignadosA = [];
  sA.on('viaje:conductor_asignado', d => { asignadosA.push(d.id_viaje); });
  sA.on('viaje:ya_asignado', d => { asignadosA.push(`ya_asignado:${d.id_viaje}`); });

  await esperar(1200);
  sA.emit('viaje:aceptar', { id_viaje: va.id_viaje });
  sA.emit('viaje:aceptar', { id_viaje: vb.id_viaje });
  await esperar(3000);

  const { data: viajeA } = await api('GET', `/api/viajes/${va.id_viaje}`, null, tokenCli);
  const { data: viajeB } = await api('GET', `/api/viajes/${vb.id_viaje}`, null, tokenCli);
  const idCondA = viajeA.conductor?.id_conductor;
  const idCondB = viajeB.conductor?.id_conductor;
  const ambosAsignadosAlMismo = !!idCondA && idCondA === idCondB;

  r.paso(`Comportamiento observado: viaje ${va.id_viaje} → conductor ${idCondA ?? 'null'}, viaje ${vb.id_viaje} → conductor ${idCondB ?? 'null'}`,
    true,
    `eventos al conductor: ${JSON.stringify(asignadosA)}`);
  if (ambosAsignadosAlMismo) {
    r.paso('HUECO CONOCIDO: el mismo conductor quedo asignado a 2 viajes',
      false,
      'el backend no valida que un conductor no acepte viajes solapados (esperado en MVP)',
      'hueco');
  } else {
    r.paso('Solo uno de los dos viajes quedo asignado al conductor', true,
      `viajeA cond=${idCondA}, viajeB cond=${idCondB}`);
  }

  sA.disconnect();

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('2. DOS conductores aceptan EL MISMO viaje (race)');

  const vc = await crearViajeNuevo(tokenCli);
  const sA2 = await conectar(tokenA);
  const sB = await conectar(tokenB);

  let resultsA = [];
  let resultsB = [];
  sA2.on('viaje:conductor_asignado', () => resultsA.push('ganador'));
  sA2.on('viaje:ya_asignado', () => resultsA.push('ya_asignado'));
  sB.on('viaje:conductor_asignado', () => resultsB.push('ganador'));
  sB.on('viaje:ya_asignado', () => resultsB.push('ya_asignado'));

  await esperar(1200);
  // Emitir simultaneo
  await Promise.all([
    new Promise(res => { sA2.emit('viaje:aceptar', { id_viaje: vc.id_viaje }); res(); }),
    new Promise(res => { sB.emit('viaje:aceptar', { id_viaje: vc.id_viaje }); res(); }),
  ]);
  await esperar(3500);

  const { data: viajeC } = await api('GET', `/api/viajes/${vc.id_viaje}`, null, tokenCli);
  const ganadorEnDB = viajeC.conductor?.id_conductor;
  const gA = resultsA.includes('ganador');
  const gB = resultsB.includes('ganador');
  const ambosGanaron = gA && gB;

  r.paso(`Cantidad de "ganador" emitidos: A=${gA?1:0}, B=${gB?1:0} (DB: cond=${ganadorEnDB})`, true,
    `A: ${JSON.stringify(resultsA)} | B: ${JSON.stringify(resultsB)}`);

  if (ambosGanaron) {
    r.paso('CRITICO: ambos conductores recibieron viaje:conductor_asignado',
      false, 'Bug de race condition en la transaccion atomica', 'bug');
  } else {
    r.paso('Solo un conductor recibio viaje:conductor_asignado', true);
    const elOtroRecibioYaAsignado = (gA && resultsB.includes('ya_asignado')) || (gB && resultsA.includes('ya_asignado'));
    r.paso('El otro conductor recibio viaje:ya_asignado',
      elOtroRecibioYaAsignado, elOtroRecibioYaAsignado ? '' : 'no se observo viaje:ya_asignado');
  }

  sA2.disconnect();
  sB.disconnect();

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('3. Cliente con 5 viajes en paralelo (limitamos a 3 conductores reales — reusamos A y B)');

  // CAUTELA: solo tenemos 2 conductores. Vamos a hacer 3 viajes en paralelo
  // y aceptar 2 con conductores distintos para ver si el cliente recibe GPS
  // de ambos sin mezclar.
  const v3a = await crearViajeNuevo(tokenCli);
  const v3b = await crearViajeNuevo(tokenCli);
  const sCli = await conectar(tokenCli);
  const sA3 = await conectar(tokenA);
  const sB3 = await conectar(tokenB);

  await esperar(1200);
  sA3.emit('viaje:aceptar', { id_viaje: v3a.id_viaje });
  await esperar(700);
  sB3.emit('viaje:aceptar', { id_viaje: v3b.id_viaje });
  await esperar(2500);

  // El cliente debe estar en ambos rooms viaje:* — verificamos contando
  // mapa:actualizar de ambos viajes con coords distintas
  const mapas = { [v3a.id_viaje]: [], [v3b.id_viaje]: [] };
  sCli.on('mapa:actualizar', d => {
    // El evento no trae id_viaje (¡es un hueco del diseño!) — lo identificamos por coordenadas
    if (Math.abs(d.lat - PARADA_A.lat) < 0.05) mapas[v3a.id_viaje].push(d);
    else mapas[v3b.id_viaje].push(d);
  });

  for (let i = 0; i < 5; i++) {
    sA3.emit('conductor:ubicacion', {
      id_viaje: v3a.id_viaje,
      lat: PARADA_A.lat + i * 0.0001,
      lng: PARADA_A.lng + i * 0.0001,
      timestamp: Date.now() + i * 1000,
    });
    sB3.emit('conductor:ubicacion', {
      id_viaje: v3b.id_viaje,
      lat: -34.7 + i * 0.0001,  // bien lejos para distinguir
      lng: -58.5 + i * 0.0001,
      timestamp: Date.now() + i * 1000,
    });
    await esperar(300);
  }
  await esperar(2000);

  r.paso(`Cliente recibe mapa:actualizar de ambos viajes (v${v3a.id_viaje}: ${mapas[v3a.id_viaje].length}, v${v3b.id_viaje}: ${mapas[v3b.id_viaje].length})`,
    mapas[v3a.id_viaje].length > 0 && mapas[v3b.id_viaje].length > 0);

  // Hueco: mapa:actualizar no incluye id_viaje, asi que el front no puede
  // saber a que viaje pertenece si el cliente tiene mas de uno activo.
  const cualquierEventoSinId = mapas[v3a.id_viaje][0] && !('id_viaje' in mapas[v3a.id_viaje][0]);
  if (cualquierEventoSinId) {
    r.paso('HUECO: mapa:actualizar no incluye id_viaje',
      false,
      'cliente con N viajes simultaneos no puede distinguir GPS de cada uno',
      'hueco');
  } else {
    r.paso('mapa:actualizar incluye id_viaje', true);
  }

  sCli.disconnect(); sA3.disconnect(); sB3.disconnect();

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('4. Performance — 6 viajes activos mandando pings simultaneos durante 10s');

  // Limitado a 2 conductores (no tenemos mas), pero podemos crear muchos
  // viajes en paralelo. El test mide tiempo de respuesta del server REST
  // bajo carga de pings WebSocket.
  const viajes = [];
  for (let i = 0; i < 3; i++) {
    const v = await crearViajeNuevo(tokenCli);
    viajes.push(v);
  }
  const sA4 = await conectar(tokenA);
  const sB4 = await conectar(tokenB);
  await esperar(1000);

  // Aceptar uno con A, otro con B
  sA4.emit('viaje:aceptar', { id_viaje: viajes[0].id_viaje });
  sB4.emit('viaje:aceptar', { id_viaje: viajes[1].id_viaje });
  // El tercero queda sin aceptar (estara en BUSCANDO_CONDUCTOR — los pings
  // del 3ro no haran nada). Lo dejamos como "carga de fondo".
  await esperar(2000);

  const start = Date.now();
  let totalPings = 0;
  const intervalo = setInterval(() => {
    for (const cond of [sA4, sB4]) {
      const idx = cond === sA4 ? 0 : 1;
      cond.emit('conductor:ubicacion', {
        id_viaje: viajes[idx].id_viaje,
        lat: PARADA_A.lat + Math.random() * 0.01,
        lng: PARADA_A.lng + Math.random() * 0.01,
        timestamp: Date.now(),
      });
      totalPings++;
    }
  }, 100);

  // En paralelo, medir latencia REST
  const latencias = [];
  for (let i = 0; i < 10; i++) {
    const t = Date.now();
    await api('GET', '/api/viajes/mis-viajes', null, tokenCli);
    latencias.push(Date.now() - t);
    await esperar(800);
  }
  clearInterval(intervalo);
  const dur = Date.now() - start;
  const latProm = latencias.reduce((a, b) => a + b, 0) / latencias.length;
  const latMax = Math.max(...latencias);
  r.paso(`Servidor procesa ${totalPings} pings en ${dur}ms y atiende REST (latencia prom ${latProm.toFixed(0)}ms, max ${latMax}ms)`,
    latProm < 2000, `prom ${latProm.toFixed(0)}ms, max ${latMax}ms`);

  sA4.disconnect(); sB4.disconnect();

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('5. Viaje VENCIDO — fecha_programada en el pasado');

  const fechaPasada = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { status: sv, data: dv } = await api('POST', '/api/viajes', {
    zona: 'CABA', fecha_programada: fechaPasada, condiciones_requeridas: [],
    paradas: [PARADA_A, PARADA_B],
  }, tokenCli);
  r.paso(`POST con fecha pasada → ${sv}`, sv === 201 || sv === 400,
    `status ${sv}` + (sv !== 201 && sv !== 400 ? ` — ${dv.error}` : ''));

  if (sv === 201) {
    // Aparece en /disponibles?
    const { data: dispo } = await api('GET', '/api/viajes/disponibles', null, tokenA);
    const aparece = Array.isArray(dispo) && dispo.some(v => v.id_viaje === dv.id_viaje);
    r.paso('HUECO CONOCIDO: viaje vencido aparece en /disponibles',
      !aparece, aparece ? `viaje ${dv.id_viaje} listado pese a fecha pasada` : 'no listado',
      aparece ? 'hueco' : 'ok');
  }

  // ────────────────────────────────────────────────────────────────────────
  r.seccion('6. Reconexion de socket — conductor con viaje activo se reconecta');

  const v6 = await crearViajeNuevo(tokenCli);
  let sA6 = await conectar(tokenA);
  await esperar(1100);
  sA6.emit('viaje:aceptar', { id_viaje: v6.id_viaje });
  await esperar(1500);
  // primer ping para entrar a EN_CAMINO_A_ORIGEN
  sA6.emit('conductor:ubicacion', {
    id_viaje: v6.id_viaje, lat: PARADA_A.lat, lng: PARADA_A.lng, timestamp: Date.now(),
  });
  await esperar(1000);

  // Desconectar
  sA6.disconnect();
  await esperar(800);

  // Reconectar
  sA6 = await conectar(tokenA);
  await esperar(1200);

  // Verificar si recibe mapa:actualizar al mandar otro ping (room rejoin)
  let mapaTrasReconect = 0;
  sA6.on('mapa:actualizar', () => { mapaTrasReconect++; });
  sA6.emit('conductor:ubicacion', {
    id_viaje: v6.id_viaje, lat: PARADA_A.lat + 0.001, lng: PARADA_A.lng + 0.001, timestamp: Date.now(),
  });
  await esperar(1500);

  r.paso('Tras reconectar, el conductor recibe mapa:actualizar del room (rejoin)',
    mapaTrasReconect > 0, `${mapaTrasReconect} eventos`,
    mapaTrasReconect > 0 ? 'ok' : 'hueco');

  sA6.disconnect();

  return r.resumen();
}

main().then(res => {
  console.log('\n__RESULT_JSON__' + JSON.stringify(res));
  process.exit(0);
}).catch(e => {
  console.error('\n💥 Error inesperado:', e.message, e.stack);
  console.log('\n__RESULT_JSON__' + JSON.stringify({ nombre: 'concurrencia', error: e.message, total: 0, ok: 0, bugs: [], huecos: [], todos: [] }));
  process.exit(1);
});
