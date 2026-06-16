import {
  api, getToken, registrarSiNoExiste, crearReporter, STRESS_USERS,
} from './_helpers.js';

const TIPOS_CONDICION = ['FRAGIL', 'REFRIGERADO', 'CARGA_PESADA', 'PELIGROSO', 'VOLUMINOSO'];

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   STRESS — VEHICULOS EXHAUSTIVO             ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const r = crearReporter('vehiculos');

  await registrarSiNoExiste(STRESS_USERS.cliente, 'cliente');
  await registrarSiNoExiste(STRESS_USERS.conductor, 'conductor');
  await registrarSiNoExiste(STRESS_USERS.conductor2, 'conductor');

  const tokenA = await getToken(STRESS_USERS.conductor.email, STRESS_USERS.conductor.contrasena);
  const tokenB = await getToken(STRESS_USERS.conductor2.email, STRESS_USERS.conductor2.contrasena);
  r.paso('Tokens conductores A y B obtenidos', !!tokenA && !!tokenB);

  // limpiar vehiculos previos para tests deterministicos
  const { data: misA } = await api('GET', '/api/conductores/mis-vehiculos', null, tokenA);
  if (Array.isArray(misA)) {
    for (const v of misA) {
      if (v.patente?.startsWith('STR')) {
        await api('DELETE', `/api/conductores/mis-vehiculos/${v.id_vehiculo}`, null, tokenA);
      }
    }
  }

  r.seccion('1. Crear vehiculo con todas las condiciones');
  const { status: s1, data: v1 } = await api('POST', '/api/conductores/mis-vehiculos', {
    patente: 'STR001', marca: 'Mercedes', modelo: 'Sprinter', anio: 2022,
    color: 'Gris', tipo_vehiculo: 'furgon', condiciones: TIPOS_CONDICION,
  }, tokenA);
  r.paso('POST con 5 condiciones → 201', s1 === 201, `status ${s1}`);
  r.paso('Respuesta incluye las 5 condiciones',
    s1 === 201 && Array.isArray(v1.condiciones) && v1.condiciones.length === 5,
    `${v1?.condiciones?.length} condiciones`);
  const id_v1 = v1?.id_vehiculo;

  r.seccion('2. Crear vehiculo con condiciones vacias');
  const { status: s2, data: v2 } = await api('POST', '/api/conductores/mis-vehiculos', {
    patente: 'STR002', marca: 'Ford', modelo: 'F100', anio: 2018,
    color: 'Rojo', tipo_vehiculo: 'pickup', condiciones: [],
  }, tokenA);
  r.paso('POST sin condiciones → 201', s2 === 201, `status ${s2}`);
  r.paso('Respuesta tiene condiciones=[]',
    s2 === 201 && Array.isArray(v2.condiciones) && v2.condiciones.length === 0);
  const id_v2 = v2?.id_vehiculo;

  r.seccion('3. Patente duplicada → 409');
  const { status: s3, data: d3 } = await api('POST', '/api/conductores/mis-vehiculos', {
    patente: 'STR001', marca: 'X', modelo: 'Y', anio: 2020,
    color: 'A', tipo_vehiculo: 'auto', condiciones: [],
  }, tokenA);
  r.paso('Patente repetida rechazada con 409', s3 === 409, `status ${s3} — ${d3.error}`);

  r.seccion('4. Editar vehiculo de otro conductor → 403');
  // Crear vehiculo del conductor B
  const { data: vB } = await api('POST', '/api/conductores/mis-vehiculos', {
    patente: 'STR099', marca: 'Toyota', modelo: 'Hiace', anio: 2019,
    color: 'Negro', tipo_vehiculo: 'furgon', condiciones: [],
  }, tokenB);
  const id_vB = vB?.id_vehiculo;
  const { status: s4 } = await api('PUT', `/api/conductores/mis-vehiculos/${id_vB}`, {
    color: 'Verde',
  }, tokenA);
  r.paso('PUT vehiculo ajeno rechazado con 403', s4 === 403, `status ${s4}`);

  r.seccion('5. Eliminar vehiculo inexistente → 404');
  const { status: s5 } = await api('DELETE', '/api/conductores/mis-vehiculos/9999999', null, tokenA);
  r.paso('DELETE inexistente → 404', s5 === 404, `status ${s5}`);

  r.seccion('6. Eliminar vehiculo en viaje activo → 400');
  // Crear viaje del cliente y aceptarlo con conductor A usando v1
  await registrarSiNoExiste(STRESS_USERS.cliente, 'cliente');
  const tokenCli = await getToken(STRESS_USERS.cliente.email, STRESS_USERS.cliente.contrasena);
  const fecha = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const { data: viajeData } = await api('POST', '/api/viajes', {
    zona: 'CABA', fecha_programada: fecha,
    condiciones_requeridas: [],
    paradas: [
      { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo' },
      { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta' },
    ],
  }, tokenCli);
  const id_viaje = viajeData?.id_viaje;
  // Aceptar via WebSocket
  const { io } = await import('socket.io-client');
  const sA = io('http://localhost:3000', { auth: { token: 'Bearer ' + tokenA } });
  await new Promise(resolve => sA.on('connect', resolve));
  await new Promise(r2 => setTimeout(r2, 1200));
  sA.emit('viaje:aceptar', { id_viaje, id_vehiculo: id_v1 });
  await new Promise(r2 => setTimeout(r2, 1500));
  const { status: s6, data: d6 } = await api('DELETE', `/api/conductores/mis-vehiculos/${id_v1}`, null, tokenA);
  r.paso('DELETE vehiculo en viaje activo → 400', s6 === 400, `status ${s6} — ${d6.error || ''}`);
  sA.disconnect();

  r.seccion('7. Condicion duplicada → 409');
  await api('POST', `/api/conductores/mis-vehiculos/${id_v2}/condiciones/FRAGIL`, null, tokenA);
  const { status: s7 } = await api('POST', `/api/conductores/mis-vehiculos/${id_v2}/condiciones/FRAGIL`, null, tokenA);
  r.paso('Agregar FRAGIL ya existente → 409', s7 === 409, `status ${s7}`);

  r.seccion('8. Condicion invalida → 400');
  const { status: s8 } = await api('POST', `/api/conductores/mis-vehiculos/${id_v2}/condiciones/INVENTADA`, null, tokenA);
  r.paso('Agregar INVENTADA → 400', s8 === 400, `status ${s8}`);

  r.seccion('9. Anio fuera de rango');
  const { status: s9a } = await api('POST', '/api/conductores/mis-vehiculos', {
    patente: 'STR003', marca: 'A', modelo: 'B', anio: 1980,
    color: 'C', tipo_vehiculo: 'auto', condiciones: [],
  }, tokenA);
  r.paso('Anio 1980 → 400', s9a === 400, `status ${s9a}`);
  const { status: s9b } = await api('POST', '/api/conductores/mis-vehiculos', {
    patente: 'STR004', marca: 'A', modelo: 'B', anio: 2050,
    color: 'C', tipo_vehiculo: 'auto', condiciones: [],
  }, tokenA);
  r.paso('Anio 2050 → 400', s9b === 400, `status ${s9b}`);

  return r.resumen();
}

main().then(res => {
  // Imprimir JSON al final para que el runner lo pueda parsear
  console.log('\n__RESULT_JSON__' + JSON.stringify(res));
  process.exit(res.bugs.length === 0 ? 0 : 1);
}).catch(e => {
  console.error('\n💥 Error inesperado:', e.message);
  console.log('\n__RESULT_JSON__' + JSON.stringify({ nombre: 'vehiculos', error: e.message, total: 0, ok: 0, bugs: [], huecos: [], todos: [] }));
  process.exit(1);
});
