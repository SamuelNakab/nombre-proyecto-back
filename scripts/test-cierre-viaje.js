// Test del CIERRE de viajes internos cuando el chofer no toca "Salir", y de la
// DETECCION DE SALIDA por GPS (Tarea 5).
//
// NO pega contra :3000: levanta servers efimeros propios (_server-efimero.js).
//   - 3951: el principal. ANTICIPACION 0, ventana 60/90, peon 30, deteccion de
//     salida con SALIDA_DETECCION_SEGUNDOS=4 (500 m) para no esperar 4 minutos.
//   - 3952: el del cierre automatico por TIMER, con CIERRE_FIN_DIA_SEGUNDOS_TEST
//     (el "fin del dia" es el inicio + N segundos).
//   - 3953: el del BARRIDO de arranque, limitado a la PyME del test
//     (CIERRE_BARRIDO_ID_ORGANIZACION): la DB esta compartida con produccion.
// Todos con RESERVA / VENCIMIENTO / CIERRE_BARRIDO_ARRANQUE=0 salvo el 3953.
// USA GOOGLE DE VERDAD: cada viaje creado gasta (paradas - 1) llamadas Pro; el
// total sale al final.
//
// Casos:
//   1. La PyME finaliza antes de tiempo: sin llegar a la ultima -> 409; en la
//      ultima antes de la hora prevista y sin deteccion -> 409; otra PyME -> 404.
//   2. La PyME finaliza pasada la hora prevista -> FINALIZADO, cerrado
//      ORGANIZACION, salida vacia, peon no medido, corte = hora prevista;
//      viaje:cierre_habilitado (TIEMPO) y viaje:finalizado al chofer.
//   3. Salida detectada en la ultima -> parada:salida_detectada (una vez) y
//      viaje:cierre_habilitado (GPS); la PyME cierra antes de la hora prevista
//      con salida_real = detectada (origen GPS).
//   4. Pings afuera ANTES de confirmar la llegada (EN_RUTA, y uno con timestamp
//      anterior a la llegada) no disparan deteccion.
//   5. Salir tardio con salida detectada: (a) intermedia -> salida_real =
//      detectada y el manejo del tramo siguiente parte de ahi; (b) ultima ->
//      cierre CHOFER con la detectada.
//   6. Un ping de vuelta adentro resetea la deteccion.
//   7. Cierre automatico por timer (3952): (a) llego a la ultima -> completo con
//      peon no medido; (b) no llego -> incompleto, paradas no visitadas; eventos a
//      la PyME y al chofer; Redis limpio.
//   8. Carrera Salir vs. finalizar de la PyME (5 rondas, RONDAS=N): uno gana, el
//      otro 409. 8b: el mismo con el orden FORZADO (la PyME commitea primero).
//   9. Salir y confirmar-parada sobre un viaje cerrado por la empresa (sobre el
//      del caso 2) y por el automatico (sobre el del 7b) -> 409; el ping se
//      ignora sin error.
//  10. Barrido de arranque (3953) cierra un viaje vencido y programa el resto.
//  11. Un chofer con un viaje en curso no puede iniciar otro (409) y la carrera
//      de dos iniciar a la vez (3 rondas): uno gana.
//  12. Flujo normal (Salir a tiempo, sin deteccion): igual que siempre, origen
//      CHOFER, precio = el del acumulado.
//  13. Tres pings simultaneos al cumplirse el umbral: una sola deteccion (guard
//      del updateMany de salida-deteccion.service).
//
// Acepta numeros de caso (el setup corre siempre):
//   node scripts/test-cierre-viaje.js 8
// Y si una corrida se corto sin limpiar:
//   node scripts/test-cierre-viaje.js --restos            (solo cuenta)
//   node scripts/test-cierre-viaje.js --restos --borrar   (borra)
//
// LIMPIEZA: borra TODO lo que crea (_limpieza.js) y al final verifica que no
// quedo nada.
import 'dotenv/config';
import { io as ioClient } from 'socket.io-client';
import prisma from '../src/config/prisma.js';
import redis from '../src/config/redis.js';
import { conServer, esperarLinea } from './_server-efimero.js';
import { crearRegistro } from './_limpieza.js';
import { restos } from './restos.js';
import { getToken as loginFirebase } from './_firebase-auth.js';
import { precioDesdeMediciones } from '../src/services/precio-real.js';

const PUERTO = 3951;
const PUERTO_TIMER = 3952;
const PUERTO_BARRIDO = 3953;
// RONDAS=N pisa las rondas de las carreras (protocolo de reversion).
const RONDAS = Number(process.env.RONDAS) > 0 ? Number(process.env.RONDAS) : 5;
const RONDAS_INICIAR = 3;
const FIN_DIA_TEST_SEGUNDOS = 30;

const ENV_BASE = {
  RESERVA_BARRIDO_ARRANQUE: '0',
  VENCIMIENTO_BARRIDO_ARRANQUE: '0',
  CIERRE_BARRIDO_ARRANQUE: '0',
  ANTICIPACION_MINIMA_MINUTOS: '0',
  VENTANA_INICIO_ANTES_MINUTOS: '60',
  VENTANA_INICIO_DESPUES_MINUTOS: '90',
  MARKETPLACE_HABILITADO: 'false',
  CALIFICACIONES_HABILITADAS: 'false',
  INVITACION_INTENTOS_MAX: '1000',
  RADIO_CONFIRMACION_METROS: '50',
  TIEMPO_PEON_MINUTOS: '30',
  SALIDA_DETECCION_METROS: '500',
  SALIDA_DETECCION_SEGUNDOS: '4',
};
const DETECCION_MS = 4000;

const SOLO = process.argv.slice(2).map(Number).filter(Number.isFinite);
const correr = (n) => SOLO.length === 0 || SOLO.includes(n);

const stamp = Date.now();
const S = String(stamp);
const PASS = 'test123456';
const LIC = '2030-01-01T00:00:00.000Z';

const ORIGEN = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const INTERMEDIA = { lat: -34.5975, lng: -58.3923, direccion: 'Tribunales, CABA' };
const DESTINO = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };
// ~1100 m al norte: afuera de los 500 m.
const lejosDe = (p) => ({ lat: p.lat + 0.01, lng: p.lng });

// EJEMPLOS_JSON=ruta: guarda respuestas y payloads reales de los pasos clave
// (los ejemplos de API.md salen de aca, no se escriben a mano).
const EJEMPLOS = {};
const ejemplo = (nombre, valor) => {
  if (process.env.EJEMPLOS_JSON) EJEMPLOS[nombre] = valor?.status !== undefined && valor?.crudo !== undefined ? { status: valor.status, body: valor.data } : valor;
};

const emailsCreados = [];
const orgsCreadas = new Set();
const viajesCreados = new Set();
const sockets = [];

// -- Helpers ----------------------------------------------------------------

const pasos = [];
function paso(nombre, ok, detalle = '') {
  pasos.push({ nombre, ok: Boolean(ok), detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const titulo = (t) => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 60 - t.length))}\n`);

let BASE = `http://localhost:${PUERTO}`;

async function api(method, path, body, token) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    return { status: 0, data: { error: `fetch fallo: ${e.message}` }, crudo: '' };
  }
  const crudo = await res.text();
  let data;
  try {
    data = JSON.parse(crudo);
  } catch {
    data = { error: `Respuesta no-JSON (${res.status})` };
  }
  return { status: res.status, data, crudo };
}

const r2s = (r) => `${r.status} ${r.crudo.slice(0, 220)}`;
const statuses = (rs) => rs.map((r) => r.status).sort((a, b) => a - b).join(',');

const MULT = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
function cuitValido(n) {
  for (let k = 0; ; k++) {
    const base = '30' + String((Number(S.slice(-6)) * 100 + 7000 + n * 7 + k) % 1e8).padStart(8, '0');
    const suma = MULT.reduce((a, m, i) => a + m * Number(base[i]), 0);
    const dv = 11 - (suma % 11);
    if (dv === 10) continue;
    return base + (dv === 11 ? 0 : dv);
  }
}

let nUsuario = 0;
async function nuevoUsuario(tipo, etiqueta) {
  nUsuario++;
  const email = `${etiqueta}-cie-${S}-${nUsuario}@test.com`.toLowerCase();
  const dni = '6' + S.slice(-6) + String(nUsuario).padStart(2, '0');
  const datos = {
    nombre: etiqueta,
    apellido: 'Cie',
    dni,
    email,
    contrasena: PASS,
    telefono: `+54911${S.slice(-4)}${String(nUsuario).padStart(4, '0')}`,
    ...(tipo === 'conductor' ? { nro_licencia: `LCI${nUsuario}${S.slice(-4)}`, licencia_vencimiento: LIC } : {}),
  };
  emailsCreados.push(email);
  const endpoint = tipo === 'cliente' ? '/api/auth/registro-cliente' : '/api/auth/registro-conductor';
  const r = await api('POST', endpoint, datos);
  if (r.status !== 201) throw new Error(`registro ${tipo} ${email} fallo: ${r2s(r)}`);
  const token = await loginFirebase(email, PASS);
  const u = await prisma.usuario.findUnique({ where: { email }, include: { conductor: true } });
  return { email, token, id_usuario: u.id_usuario, id_conductor: u.conductor?.id_conductor ?? null };
}

async function crearOrgOk(u, nombre, cuit) {
  const r = await api('POST', '/api/organizaciones', { nombre, cuit }, u.token);
  if (r.status !== 201) throw new Error(`crear PyME ${nombre} fallo: ${r2s(r)}`);
  orgsCreadas.add(r.data.id_organizacion);
  return r.data.id_organizacion;
}

async function vincular(responsable, idOrg, chofer) {
  const inv = await api('POST', `/api/organizaciones/${idOrg}/invitaciones`, { tipo: 'CHOFER' }, responsable.token);
  if (inv.status !== 201) throw new Error(`invitar fallo: ${r2s(inv)}`);
  const c = await api('POST', '/api/invitaciones/canjear', { codigo: inv.data.codigo }, chofer.token);
  if (c.status !== 200) throw new Error(`canje fallo: ${r2s(c)}`);
}

let nPatente = 0;
async function vehiculoOk(chofer) {
  nPatente++;
  const patente = `C${S.slice(-4)}${String(nPatente).padStart(2, '0')}`;
  const r = await api(
    'POST',
    '/api/conductores/mis-vehiculos',
    { patente, marca: 'Fiat', modelo: 'Fiorino', anio: 2020, color: 'Blanco', tipo_vehiculo: 'Utilitario', condiciones: [] },
    chofer.token
  );
  if (r.status !== 201) throw new Error(`vehiculo fallo: ${r2s(r)}`);
  return r.data.id_vehiculo;
}

const enMin = (n) => new Date(Date.now() + n * 60000).toISOString();

async function okOFalla(promesa, que) {
  const r = await promesa;
  if (r.status !== 200 && r.status !== 201) throw new Error(`${que} fallo: ${r2s(r)}`);
  return r;
}

// -- Acciones -----------------------------------------------------------------

async function crearOk(u, idOrg, id_conductor, paradas) {
  const r = await api(
    'POST',
    `/api/organizaciones/${idOrg}/viajes`,
    { id_conductor, fecha_programada: enMin(2), condiciones_requeridas: [], paradas },
    u.token
  );
  if (r.status !== 201) throw new Error(`crear viaje fallo: ${r2s(r)}`);
  viajesCreados.add(r.data.id_viaje);
  return r.data.id_viaje;
}
const confirmar = (k, id, id_vehiculo) => api('POST', `/api/choferes/viajes/${id}/confirmar`, { id_vehiculo }, k.token);
const iniciar = (k, id) => api('POST', `/api/choferes/viajes/${id}/iniciar`, { lat: ORIGEN.lat, lng: ORIGEN.lng }, k.token);
const salir = (k, id) => api('POST', `/api/choferes/viajes/${id}/salir`, null, k.token);
const confirmarParada = (k, id, p) =>
  api('POST', `/api/viajes/${id}/confirmar-parada`, { id_parada: p.id_parada, lat: p.latitud, lng: p.longitud }, k.token);
const cancelarPyme = (u, idOrg, id) => api('POST', `/api/organizaciones/${idOrg}/viajes/${id}/cancelar`, {}, u.token);
const finalizar = (u, idOrg, id) => api('POST', `/api/organizaciones/${idOrg}/viajes/${id}/finalizar`, null, u.token);
const detallePyme = (u, idOrg, id) => api('GET', `/api/organizaciones/${idOrg}/viajes/${id}`, null, u.token);

const viajeDb = (id) => prisma.viaje.findUnique({ where: { id_viaje: id } });
const paradasDb = (id) => prisma.parada.findMany({ where: { id_viaje: id }, orderBy: { orden: 'asc' } });
const historial = async (id) =>
  (
    await prisma.historialEstadoViaje.findMany({ where: { id_viaje: id }, orderBy: [{ fecha: 'asc' }, { id_historial: 'asc' }] })
  ).map((h) => `${h.estado}:${h.origen}`);
const filas = (h, estado) => h.filter((x) => x.startsWith(`${estado}:`)).length;
const HORA = 3_600_000;
const ms = (d) => (d ? new Date(d).getTime() : null);
async function keysGps(id) {
  if (redis.status !== 'ready') return -1;
  return (await redis.keys(`gps:${id}:*`)).length;
}

// Crea, confirma e inicia un viaje (queda CARGANDO en la parada 1).
async function iniciado(ctx, k, paradas = [ORIGEN, DESTINO]) {
  const id = await crearOk(ctx.P1, ctx.A, k.id_conductor, paradas);
  await okOFalla(confirmar(k, id, ctx.veh.get(k.id_conductor)), 'confirmar');
  await okOFalla(iniciar(k, id), 'iniciar');
  return id;
}

// Recorre el viaje hasta LLEGAR a la ultima parada (queda DESCARGANDO en ella).
// peonHoras: pisa el peon estimado de la ultima ANTES de llegar (define la hora
// prevista de fin).
async function llevarAUltima(k, id, { peonHoras = null } = {}) {
  const ps = await paradasDb(id);
  if (peonHoras !== null) {
    await prisma.parada.update({ where: { id_parada: ps.at(-1).id_parada }, data: { peon_estimado_horas: peonHoras } });
  }
  for (let i = 1; i < ps.length; i++) {
    await okOFalla(salir(k, id), `salir de la parada ${i}`);
    await okOFalla(confirmarParada(k, id, ps[i]), `confirmar la parada ${i + 1}`);
  }
  return paradasDb(id);
}

// Si el caso dejo el viaje vivo, la PyME lo cancela (el chofer no puede tener
// dos en curso).
async function asegurarCerrado(ctx, id) {
  const v = await viajeDb(id);
  if (v && !['FINALIZADO', 'CANCELADO', 'RECHAZADO', 'VENCIDO'].includes(v.estado)) await cancelarPyme(ctx.P1, ctx.A, id);
}

// -- Sockets ------------------------------------------------------------------

function conectar(base, token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { auth: { token: 'Bearer ' + token }, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`Socket connect_error: ${e.message}`)));
    setTimeout(() => reject(new Error('Timeout al conectar socket (8s)')), 8000);
  });
}
async function espia(base, token) {
  const socket = await conectar(base, token);
  sockets.push(socket);
  const eventos = [];
  socket.onAny((ev, d) => eventos.push({ ev, d }));
  return { socket, eventos };
}
const eventosDe = (esp, ev, id_viaje) => esp.eventos.filter((e) => e.ev === ev && e.d?.id_viaje === id_viaje).map((e) => e.d);
async function esperarEvento(esp, ev, id_viaje, msMax = 5000) {
  const limite = Date.now() + msMax;
  while (Date.now() < limite) {
    const e = eventosDe(esp, ev, id_viaje)[0];
    if (e) return e;
    await esperar(150);
  }
  return null;
}

// Ping GPS del chofer. Devuelve { ts, error } (error = el 'error' que emita el
// server, o null).
async function ping(esp, id_viaje, pos, ts = Date.now()) {
  const antes = esp.eventos.length;
  esp.socket.emit('conductor:ubicacion', { id_viaje, lat: pos.lat, lng: pos.lng, timestamp: ts });
  await esperar(700);
  const err = esp.eventos.slice(antes).find((e) => e.ev === 'error');
  return { ts, error: err ? err.d : null };
}

// Racha afuera que SI llega al umbral: dos pings separados por > DETECCION_MS.
// Devuelve el ts del primero (la hora que se tiene que detectar). Espera un poco
// al final: la deteccion escribe en la DB despues del segundo ping.
async function rachaAfuera(esp, id_viaje, pos) {
  const { ts } = await ping(esp, id_viaje, pos);
  await esperar(DETECCION_MS - 700 + 400);
  await ping(esp, id_viaje, pos);
  await esperar(1500);
  return ts;
}

// -- Casos --------------------------------------------------------------------

async function casos(ctx) {
  const { P1, Q1, A, B, K1, sP1, sK1 } = ctx;

  // CASO 1 -------------------------------------------------------------------
  if (correr(1)) {
    titulo('CASO 1: la PyME finaliza antes de tiempo');
    const id = await iniciado(ctx, K1);
    const sinLlegar = await finalizar(P1, A, id);
    paso('CASO 1a: sin llegar a la ultima → 409', sinLlegar.status === 409 && /no llego a la ultima/.test(sinLlegar.data.error), r2s(sinLlegar));

    const ps = await llevarAUltima(K1, id);
    const antes = await finalizar(P1, A, id);
    paso('CASO 1b: en la ultima, antes de la hora prevista y sin deteccion → 409', antes.status === 409 && /se habilita a las/.test(antes.data.error), r2s(antes));

    ejemplo('finalizar_409_no_llego', sinLlegar);
    ejemplo('finalizar_409_no_habilitado', antes);
    const otra = await finalizar(Q1, B, id);
    paso('CASO 1c: desde otra PyME → 404', otra.status === 404, r2s(otra));

    const det = (await detallePyme(P1, A, id)).data;
    const previstaEsperada = ms(ps.at(-1).llegada_real) + ps.at(-1).peon_estimado_horas * HORA;
    paso(
      'CASO 1d: el GET expone el cierre (no habilitado, desde = hora prevista, cierre automatico)',
      det.cierre?.cierre_manual_habilitado === false &&
        ms(det.cierre.cierre_manual_desde) === previstaEsperada &&
        ms(det.cierre.hora_prevista_fin) === previstaEsperada &&
        det.cierre.cierre_automatico_en !== null &&
        det.cierre.salida_detectada === null &&
        det.cierre.cerrado_por === null,
      JSON.stringify(det.cierre)
    );
    ejemplo('get_cierre_en_curso', det.cierre);
    const v = await viajeDb(id);
    paso('CASO 1e: el viaje sigue DESCARGANDO', v.estado === 'DESCARGANDO', v.estado);
    await asegurarCerrado(ctx, id);
  }

  // CASO 2 -------------------------------------------------------------------
  if (correr(2) || correr(9)) {
    titulo('CASO 2: la PyME finaliza pasada la hora prevista');
    const id = await iniciado(ctx, K1);
    // Peon estimado de la ultima: 7.2 s.
    const ps = await llevarAUltima(K1, id, { peonHoras: 0.002 });
    await ping(sK1, id, DESTINO);
    const habilitado = await esperarEvento(sP1, 'viaje:cierre_habilitado', id, 15000);
    paso('CASO 2a: viaje:cierre_habilitado (TIEMPO) a la PyME', habilitado?.motivo === 'TIEMPO', JSON.stringify(habilitado));

    ejemplo('ev_cierre_habilitado_tiempo', habilitado);
    const r = await finalizar(P1, A, id);
    ejemplo('finalizar_200_sin_deteccion', r);
    const v = await viajeDb(id);
    const [, ultima] = await paradasDb(id);
    const prevista = ms(ps.at(-1).llegada_real) + 0.002 * HORA;
    paso(
      'CASO 2b: 200 → FINALIZADO, cerrado ORGANIZACION, salida vacia, corte = hora prevista',
      r.status === 200 && r.data.cerrado_por === 'ORGANIZACION' && r.data.peon_medido === false && r.data.salida_real === null &&
        v.estado === 'FINALIZADO' && v.cerrado_por === 'ORGANIZACION' && ultima.salida_real === null && ultima.origen_salida === null &&
        ms(v.fecha_corte_precio) === prevista,
      `${r2s(r)} | corte ${v.fecha_corte_precio?.toISOString()} vs ${new Date(prevista).toISOString()}`
    );
    const det = (await detallePyme(P1, A, id)).data;
    paso(
      'CASO 2c: peon NO medido en el read (peon_medido false, peon_completo false)',
      det.paradas.at(-1).peon_medido === false && det.paradas.at(-1).peon_real_min === null && det.real?.peon_completo === false &&
        det.cierre.cerrado_por === 'ORGANIZACION' && det.cierre.incompleto === false && det.duracion_real === null,
      JSON.stringify({ parada: det.paradas.at(-1).peon_medido, real: det.real, cierre: det.cierre })
    );
    const h = await historial(id);
    const fin = await esperarEvento(sK1, 'viaje:finalizado', id, 4000);
    paso('CASO 2d: historial FINALIZADO:CLIENTE y viaje:finalizado al chofer con cerrado_por', h.at(-1) === 'FINALIZADO:CLIENTE' && fin?.cerrado_por === 'ORGANIZACION', `${h.join(' ')} | ${fin?.cerrado_por}`);
    paso('CASO 2e: Redis limpio (GPS, puntos, deteccion)', (await keysGps(id)) === 0, String(await keysGps(id)));
    ejemplo('ev_finalizado_organizacion', fin);
    ejemplo('get_cierre_finalizado', det.cierre);
    ejemplo('get_parada_peon_no_medido', det.paradas.at(-1));
    ctx.cerradoPorEmpresa = id;
    await asegurarCerrado(ctx, id);
  }

  // CASO 3 -------------------------------------------------------------------
  if (correr(3)) {
    titulo('CASO 3: salida detectada en la ultima → la PyME cierra antes de la hora prevista');
    const id = await iniciado(ctx, K1);
    await llevarAUltima(K1, id); // peon 30 min: la prevista esta lejos
    const tsDetectada = await rachaAfuera(sK1, id, lejosDe(DESTINO));
    const evChofer = await esperarEvento(sK1, 'parada:salida_detectada', id, 4000);
    const evPyme = await esperarEvento(sP1, 'parada:salida_detectada', id, 4000);
    const hab = await esperarEvento(sP1, 'viaje:cierre_habilitado', id, 4000);
    paso(
      'CASO 3a: parada:salida_detectada al chofer y a la PyME con la hora del PRIMER ping afuera',
      evChofer && evPyme && ms(evChofer.salida_detectada) === tsDetectada && evChofer.es_ultima === true && /Salir/.test(evChofer.mensaje),
      JSON.stringify(evChofer)
    );
    paso('CASO 3b: viaje:cierre_habilitado (GPS) a la PyME', hab?.motivo === 'GPS', JSON.stringify(hab));
    ejemplo('ev_salida_detectada', evChofer);
    ejemplo('ev_cierre_habilitado_gps', hab);
    // Mas pings afuera: el evento es UNA vez por parada.
    await ping(sK1, id, lejosDe(DESTINO));
    await ping(sK1, id, lejosDe(DESTINO));
    paso('CASO 3c: una sola deteccion por parada', eventosDe(sK1, 'parada:salida_detectada', id).length === 1, String(eventosDe(sK1, 'parada:salida_detectada', id).length));

    const det = (await detallePyme(P1, A, id)).data;
    paso('CASO 3d: el GET dice habilitado por GPS', det.cierre.cierre_manual_habilitado === true && det.cierre.motivo_habilitacion === 'GPS' && ms(det.cierre.salida_detectada) === tsDetectada, JSON.stringify(det.cierre));

    const r = await finalizar(P1, A, id);
    ejemplo('finalizar_200_gps', r);
    const v = await viajeDb(id);
    const ultima = (await paradasDb(id)).at(-1);
    paso(
      'CASO 3e: finaliza → salida_real = detectada (GPS), corte = detectada',
      r.status === 200 && r.data.origen_salida === 'GPS' && r.data.peon_medido === true &&
        ms(ultima.salida_real) === tsDetectada && ultima.origen_salida === 'GPS' && ms(v.fecha_corte_precio) === tsDetectada && v.cerrado_por === 'ORGANIZACION',
      `${r2s(r)} | salida ${ultima.salida_real?.toISOString()}`
    );
  }

  // CASO 4 -------------------------------------------------------------------
  if (correr(4)) {
    titulo('CASO 4: pings antes de confirmar la llegada no detectan');
    const id = await iniciado(ctx, K1);
    await okOFalla(salir(K1, id), 'salir');
    // EN_RUTA, lejos de la parada 2 durante mas que el umbral.
    await rachaAfuera(sK1, id, lejosDe(DESTINO));
    const ps = await paradasDb(id);
    await okOFalla(confirmarParada(K1, id, ps[1]), 'confirmar la 2');
    const llegada = ms((await paradasDb(id))[1].llegada_real);
    // Un ping afuera con timestamp ANTERIOR a la llegada: no cuenta.
    await ping(sK1, id, lejosDe(DESTINO), llegada - 10_000);
    const [, d] = await paradasDb(id);
    const estado = redis.status === 'ready' ? await redis.get(`gps:${id}:salida`) : 'sin-redis';
    paso(
      'CASO 4a: sin deteccion ni estado (EN_RUTA y ping previo a la llegada ignorados)',
      d.salida_detectada === null && estado === null && eventosDe(sK1, 'parada:salida_detectada', id).length === 0,
      `salida_detectada=${d.salida_detectada} estado=${estado}`
    );
    // La racha arranca recien con un ping posterior a la llegada.
    const ts = await rachaAfuera(sK1, id, lejosDe(DESTINO));
    const [, d2] = await paradasDb(id);
    paso('CASO 4b: la deteccion arranca con el primer ping POSTERIOR a la llegada', ms(d2.salida_detectada) === ts, `${d2.salida_detectada?.toISOString()} vs ${new Date(ts).toISOString()}`);
    await asegurarCerrado(ctx, id);
  }

  // CASO 5 -------------------------------------------------------------------
  if (correr(5)) {
    titulo('CASO 5: Salir tardio con salida detectada (intermedia y ultima)');
    const id = await iniciado(ctx, K1, [ORIGEN, INTERMEDIA, DESTINO]);
    const ts1 = await rachaAfuera(sK1, id, lejosDe(ORIGEN));
    await esperar(500);
    const s1 = await salir(K1, id);
    const ps = await paradasDb(id);
    ejemplo('salir_200_gps', s1);
    paso(
      'CASO 5a: salir de la intermedia → salida_real = detectada (GPS)',
      s1.status === 200 && s1.data.origen_salida === 'GPS' && ms(s1.data.salida_real) === ts1 && ms(ps[0].salida_real) === ts1 && ps[0].origen_salida === 'GPS',
      r2s(s1)
    );
    await okOFalla(confirmarParada(K1, id, ps[1]), 'confirmar la 2');
    const [, p2] = await paradasDb(id);
    const manejo = (ms(p2.llegada_real) - ts1) / HORA;
    paso('CASO 5b: el manejo del tramo siguiente parte de la salida detectada', Math.abs(p2.manejo_real_horas - manejo) < 1e-9, `${p2.manejo_real_horas} vs ${manejo}`);
    const h = await historial(id);
    const filaEnRuta = (await prisma.historialEstadoViaje.findFirst({ where: { id_viaje: id, estado: 'EN_RUTA' }, orderBy: { fecha: 'asc' } }))?.fecha;
    paso('CASO 5c: la fila EN_RUTA del historial lleva la hora de la salida detectada', ms(filaEnRuta) === ts1, h.join(' '));

    // Intermedia sin deteccion: el toque (CHOFER).
    const s2 = await salir(K1, id);
    paso('CASO 5d: salir sin deteccion → origen CHOFER', s2.status === 200 && s2.data.origen_salida === 'CHOFER', r2s(s2));
    await okOFalla(confirmarParada(K1, id, ps[2]), 'confirmar la 3');
    const ts3 = await rachaAfuera(sK1, id, lejosDe(DESTINO));
    await esperar(500);
    const s3 = await salir(K1, id);
    const v = await viajeDb(id);
    const ultima = (await paradasDb(id)).at(-1);
    ejemplo('salir_ultima_200_gps', s3);
    paso(
      'CASO 5e: salir de la ULTIMA con deteccion → cierre CHOFER, salida = detectada, corte = detectada',
      s3.status === 200 && s3.data.viaje_finalizado === true && s3.data.origen_salida === 'GPS' &&
        v.estado === 'FINALIZADO' && v.cerrado_por === 'CHOFER' && ms(ultima.salida_real) === ts3 && ms(v.fecha_corte_precio) === ts3,
      `${r2s(s3)} | corte ${v.fecha_corte_precio?.toISOString()}`
    );
  }

  // CASO 6 -------------------------------------------------------------------
  if (correr(6)) {
    titulo('CASO 6: un ping de vuelta adentro resetea la deteccion');
    const id = await iniciado(ctx, K1);
    await llevarAUltima(K1, id);
    await ping(sK1, id, lejosDe(DESTINO)); // racha 1
    await esperar(2500);
    await ping(sK1, id, DESTINO); // adentro: reset
    await esperar(1000);
    const { ts: t3 } = await ping(sK1, id, lejosDe(DESTINO)); // racha 2
    await esperar(2500);
    await ping(sK1, id, lejosDe(DESTINO)); // > 4 s desde la racha 1, < 4 s desde la 2
    const sinDetectar = (await paradasDb(id)).at(-1).salida_detectada;
    paso('CASO 6a: sin el reset habria detectado; con el reset todavia no', sinDetectar === null, String(sinDetectar));
    await esperar(2000);
    await ping(sK1, id, lejosDe(DESTINO));
    await esperar(1500);
    const detectada = (await paradasDb(id)).at(-1).salida_detectada;
    paso('CASO 6b: detecta con el primer ping de la racha NUEVA', ms(detectada) === t3, `${detectada?.toISOString()} vs ${new Date(t3).toISOString()}`);
    await asegurarCerrado(ctx, id);
  }

  // CASO 13 ------------------------------------------------------------------
  if (correr(13)) {
    titulo('CASO 13: pings simultaneos al cumplirse el umbral → una sola deteccion');
    const id = await iniciado(ctx, K1);
    await llevarAUltima(K1, id);
    const { ts: t0 } = await ping(sK1, id, lejosDe(DESTINO));
    await esperar(DETECCION_MS - 700 + 400);
    // Tres pings en el mismo tick: los tres ven la racha cumplida.
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      sK1.socket.emit('conductor:ubicacion', { id_viaje: id, ...lejosDe(DESTINO), timestamp: base + i });
    }
    await esperar(3000);
    const evs = eventosDe(sK1, 'parada:salida_detectada', id);
    const detectada = (await paradasDb(id)).at(-1).salida_detectada;
    paso('CASO 13: un solo parada:salida_detectada y la hora del primer ping afuera', evs.length === 1 && ms(detectada) === t0, `eventos=${evs.length} detectada=${detectada?.toISOString()}`);
    await asegurarCerrado(ctx, id);
  }

  // CASO 8 -------------------------------------------------------------------
  if (correr(8)) {
    titulo(`CASO 8: carrera Salir vs. finalizar de la PyME (${RONDAS} rondas)`);
    let ok = true;
    const det = [];
    for (let r = 0; r < RONDAS; r++) {
      const id = await iniciado(ctx, K1);
      await llevarAUltima(K1, id, { peonHoras: 0.0003 }); // ~1 s
      await esperar(1500);
      const [sal, fin] = await Promise.all([salir(K1, id), finalizar(P1, A, id)]);
      const v = await viajeDb(id);
      const h = await historial(id);
      const ganador = sal.status === 200 ? 'CHOFER' : 'ORGANIZACION';
      const coherente =
        statuses([sal, fin]) === '200,409' && v.estado === 'FINALIZADO' && filas(h, 'FINALIZADO') === 1 && v.cerrado_por === ganador &&
        /ya fue cerrado/.test((sal.status === 409 ? sal : fin).data.error);
      ok &&= coherente;
      det.push(`r${r + 1}:${sal.status}/${fin.status}/${v.cerrado_por}`);
      await asegurarCerrado(ctx, id);
    }
    paso('CASO 8: un solo ganador, una fila FINALIZADO, el que pierde 409 "ya fue cerrado"', ok, det.join(' '));

    // 8b: ORDEN FORZADO, la PyME commitea primero. En la carrera libre "salir"
    // llega casi siempre antes a su tx; este es el orden en el que el estado del
    // WHERE del cierre es la UNICA proteccion (la PyME no escribe la salida de la
    // parada, asi que el guard de la parada no la cubre). El test toma el lock de
    // la fila del viaje: los dos cierres leen DESCARGANDO, arman su plan y se
    // encolan en el updateMany en el orden en que llegaron; al soltarlo, gana la
    // PyME y el chofer re-evalua el WHERE.
    const id = await iniciado(ctx, K1);
    await llevarAUltima(K1, id, { peonHoras: 0.0003 });
    await esperar(1500);
    let soltar;
    const liberado = new Promise((r) => (soltar = r));
    const lock = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id_viaje FROM viajes WHERE id_viaje = ${id} FOR UPDATE`;
        await liberado;
      },
      { timeout: 30000, maxWait: 10000 }
    );
    await esperar(800);
    const pFin = finalizar(P1, A, id);
    await esperar(2500);
    const pSal = salir(K1, id);
    await esperar(2500);
    soltar();
    await lock;
    const [fin, sal] = await Promise.all([pFin, pSal]);
    const v = await viajeDb(id);
    const h = await historial(id);
    paso(
      'CASO 8b: orden forzado (la PyME primero) → finalizar 200, salir 409, una fila FINALIZADO',
      fin.status === 200 && sal.status === 409 && v.cerrado_por === 'ORGANIZACION' && filas(h, 'FINALIZADO') === 1,
      `finalizar ${fin.status} / salir ${sal.status} / ${v.cerrado_por} / filas FINALIZADO=${filas(h, 'FINALIZADO')}`
    );
    await asegurarCerrado(ctx, id);
  }

  // CASO 9 (parte empresa) ---------------------------------------------------
  if (correr(9) && ctx.cerradoPorEmpresa) {
    titulo('CASO 9: acciones del chofer sobre un viaje cerrado por la empresa');
    const id = ctx.cerradoPorEmpresa;
    const ps = await paradasDb(id);
    const s = await salir(K1, id);
    const c = await confirmarParada(K1, id, ps[0]);
    ejemplo('salir_409_empresa', s);
    ejemplo('confirmar_parada_409_empresa', c);
    paso('CASO 9a: salir → 409 "cerrado por la empresa"', s.status === 409 && /por la empresa/.test(s.data.error), r2s(s));
    paso('CASO 9b: confirmar-parada → 409 "cerrado por la empresa" (antes de "ya confirmada")', c.status === 409 && /por la empresa/.test(c.data.error), r2s(c));
    const p = await ping(sK1, id, DESTINO);
    paso('CASO 9c: el ping de un viaje cerrado se ignora sin error', p.error === null && (await keysGps(id)) === 0, JSON.stringify(p.error));
  }

  // CASO 11 ------------------------------------------------------------------
  if (correr(11)) {
    titulo('CASO 11: un chofer no puede tener dos viajes en curso');
    const enCurso = await iniciado(ctx, K1);
    const otro = await crearOk(P1, A, K1.id_conductor, [ORIGEN, DESTINO]);
    await okOFalla(confirmar(K1, otro, ctx.veh.get(K1.id_conductor)), 'confirmar');
    const r = await iniciar(K1, otro);
    ejemplo('iniciar_409_otro_en_curso', r);
    paso('CASO 11a: iniciar con otro en curso → 409', r.status === 409 && new RegExp(`#${enCurso}`).test(r.data.error), r2s(r));
    await cancelarPyme(P1, A, enCurso);
    const r2 = await iniciar(K1, otro);
    paso('CASO 11b: con el primero cerrado, inicia', r2.status === 200, r2s(r2));
    await asegurarCerrado(ctx, otro);

    const { K3 } = ctx;
    let ok = true;
    const det = [];
    for (let i = 0; i < RONDAS_INICIAR; i++) {
      const ids = [];
      for (let j = 0; j < 2; j++) {
        const id = await crearOk(P1, A, K3.id_conductor, [ORIGEN, DESTINO]);
        await okOFalla(confirmar(K3, id, ctx.veh.get(K3.id_conductor)), 'confirmar');
        ids.push(id);
      }
      const rs = await Promise.all(ids.map((id) => iniciar(K3, id)));
      const estados = await Promise.all(ids.map(async (id) => (await viajeDb(id)).estado));
      const coherente = statuses(rs) === '200,409' && estados.filter((e) => e === 'CARGANDO').length === 1;
      ok &&= coherente;
      det.push(`r${i + 1}:${statuses(rs)}/${estados.join('+')}`);
      for (const id of ids) await asegurarCerrado(ctx, id);
    }
    paso('CASO 11c: dos iniciar a la vez del mismo chofer → uno solo arranca', ok, det.join(' '));
  }

  // CASO 12 ------------------------------------------------------------------
  if (correr(12)) {
    titulo('CASO 12: flujo normal (Salir a tiempo, sin deteccion)');
    const id = await iniciado(ctx, K1);
    await llevarAUltima(K1, id);
    await ping(sK1, id, DESTINO);
    await esperar(1200);
    const { ts: ts2 } = await ping(sK1, id, DESTINO);
    // El server puede tardar mas que la espera del ping: hasta que el acumulado
    // refleje el segundo.
    let acumulado = null;
    for (let i = 0; i < 40 && acumulado?.ultima_actualizacion !== ts2; i++) {
      acumulado = JSON.parse(await redis.get(`gps:${id}:acumulado`));
      if (acumulado?.ultima_actualizacion !== ts2) await esperar(150);
    }
    const viaje = await prisma.viaje.findUnique({ where: { id_viaje: id }, include: { paradas: true } });
    const esperado = precioDesdeMediciones(viaje, acumulado).precio_real;
    const s = await salir(K1, id);
    const v = await viajeDb(id);
    const ultima = (await paradasDb(id)).at(-1);
    paso(
      'CASO 12: cerrado CHOFER, origen CHOFER, corte = salida, precio = el del acumulado',
      s.status === 200 && s.data.origen_salida === 'CHOFER' && v.cerrado_por === 'CHOFER' && ultima.origen_salida === 'CHOFER' &&
        ms(v.fecha_corte_precio) === ms(ultima.salida_real) && Math.abs(v.precio_real - esperado) < 1e-6,
      `${r2s(s)} | precio ${v.precio_real} vs ${esperado}`
    );
  }
}

// CASO 7 + 9 (parte automatico): server 3952 con el "fin del dia" corto.
async function casoTimer(ctx) {
  titulo(`CASO 7: cierre automatico por timer (fin del dia = inicio + ${FIN_DIA_TEST_SEGUNDOS} s)`);
  const env = { ...ENV_BASE, CIERRE_FIN_DIA_SEGUNDOS_TEST: String(FIN_DIA_TEST_SEGUNDOS) };
  await conServer(env, PUERTO_TIMER, async (base, leerLog) => {
    const anterior = BASE;
    BASE = base;
    try {
      const { P1, A, K1, K2 } = ctx;
      const [sP, sK1, sK2] = await Promise.all([P1, K1, K2].map((u) => espia(base, u.token)));
      await esperar(800);

      // 7a: llega a la ultima (con la prevista ANTES del fin del dia).
      const a = await iniciado(ctx, K1);
      await llevarAUltima(K1, a, { peonHoras: 0.0001 });
      await ping(sK1, a, DESTINO);
      // 7b: no llega (queda EN_RUTA hacia la 2).
      const b = await iniciado(ctx, K2);
      await okOFalla(salir(K2, b), 'salir');
      // Un ping manejando: el corte es min(ultimo ping, salida + manejo estimado).
      const { ts: tsPingB } = await ping(sK2, b, lejosDe(ORIGEN));
      await esperar(1500);

      const espera = (FIN_DIA_TEST_SEGUNDOS + 15) * 1000;
      const [finA, finB] = await Promise.all([
        esperarEvento(sP, 'viaje:finalizado', a, espera),
        esperarEvento(sP, 'viaje:finalizado', b, espera),
      ]);
      const va = await viajeDb(a);
      const pa = await paradasDb(a);
      paso(
        'CASO 7a: llego a la ultima → FINALIZADO AUTOMATICO completo, peon de la ultima no medido',
        va.estado === 'FINALIZADO' && va.cerrado_por === 'AUTOMATICO' && pa.every((p) => !p.no_visitada) &&
          pa.at(-1).salida_real === null && pa.at(-1).peon_real_horas === null && finA?.cerrado_por === 'AUTOMATICO' && finA?.incompleto === false,
        `${va.estado}/${va.cerrado_por} evento=${JSON.stringify(finA && { cerrado_por: finA.cerrado_por, incompleto: finA.incompleto })}`
      );
      const vb = await viajeDb(b);
      const pb = await paradasDb(b);
      const manejoHastaCorte = (tsPingB - ms(pb[0].salida_real)) / HORA;
      paso(
        'CASO 7b: no llego → FINALIZADO incompleto, la 2 no visitada, corte = ultimo ping, el tramo en curso suma al manejo',
        vb.estado === 'FINALIZADO' && vb.cerrado_por === 'AUTOMATICO' && pb[1].no_visitada === true && pb[1].llegada_real === null &&
          ms(vb.fecha_corte_precio) === tsPingB && Math.abs(vb.manejo_real_horas - manejoHastaCorte) < 1e-9 &&
          finB?.incompleto === true && finB?.paradas_no_visitadas?.includes(pb[1].id_parada),
        `${vb.estado}/${vb.cerrado_por} no_visitada=${pb[1].no_visitada} corte=${vb.fecha_corte_precio?.toISOString()} vs ${new Date(tsPingB).toISOString()} manejo=${vb.manejo_real_horas} vs ${manejoHastaCorte}`
      );
      ejemplo('ev_finalizado_automatico_incompleto', finB);
      const alChofer = (await esperarEvento(sK1, 'viaje:finalizado', a, 3000)) && (await esperarEvento(sK2, 'viaje:finalizado', b, 3000));
      const h = await historial(b);
      paso('CASO 7c: viaje:finalizado a los choferes; historial FINALIZADO:SISTEMA', Boolean(alChofer) && h.at(-1) === 'FINALIZADO:SISTEMA', h.join(' '));
      paso('CASO 7d: Redis limpio (el emisor de ETA y las keys)', (await keysGps(a)) === 0 && (await keysGps(b)) === 0 && /eta-emisor\] detenido para viaje/.test(leerLog()), `${await keysGps(a)}/${await keysGps(b)}`);
      const det = (await detallePyme(P1, A, b)).data;
      paso('CASO 7e: el GET marca incompleto y las paradas no visitadas', det.cierre.incompleto === true && det.paradas[1].no_visitada === true, JSON.stringify(det.cierre));

      if (correr(9)) {
        const s = await salir(K2, b);
        const c = await confirmarParada(K2, b, pb[1]);
        ejemplo('salir_409_automatico', s);
        paso('CASO 9d: salir y confirmar-parada sobre un cierre automatico → 409', s.status === 409 && c.status === 409 && /automaticamente/.test(s.data.error) && /automaticamente/.test(c.data.error), `${r2s(s)} | ${r2s(c)}`);
      }
      sumarLlamadasMaps(leerLog());
    } finally {
      BASE = anterior;
    }
  });
}

// CASO 10: barrido de arranque (3953), limitado a la PyME del test.
async function casoBarrido(ctx) {
  titulo('CASO 10: barrido de arranque');
  const { K2, K3, A } = ctx;
  const vencido = await iniciado(ctx, K2);
  const vigente = await iniciado(ctx, K3);
  // Inicio "ayer": su fin del dia ya paso.
  await prisma.viaje.update({ where: { id_viaje: vencido }, data: { fecha_inicio: new Date(Date.now() - 25 * HORA) } });

  const env = { ...ENV_BASE, CIERRE_BARRIDO_ARRANQUE: '1', CIERRE_BARRIDO_ID_ORGANIZACION: String(A) };
  await conServer(env, PUERTO_BARRIDO, async (_base, leerLog) => {
    const m = await esperarLinea(leerLog, /\[cierre-automatico\] barrido de arranque: (\d+) viajes en curso, (\d+) cerrados, (\d+) con timer/);
    paso('CASO 10a: el barrido loguea 2 en curso, 1 cerrado, 1 programado', m && m[1] === '2' && m[2] === '1' && m[3] === '1', m?.[0] ?? leerLog().slice(-500));
    sumarLlamadasMaps(leerLog());
  });
  const v = await viajeDb(vencido);
  const ps = await paradasDb(vencido);
  const h = await historial(vencido);
  paso(
    'CASO 10b: el vencido queda FINALIZADO AUTOMATICO incompleto; el vigente sigue en curso',
    v.estado === 'FINALIZADO' && v.cerrado_por === 'AUTOMATICO' && ps[1].no_visitada === true && h.at(-1) === 'FINALIZADO:SISTEMA' &&
      (await viajeDb(vigente)).estado === 'CARGANDO',
    `${v.estado}/${v.cerrado_por} ${h.join(' ')}`
  );
  await asegurarCerrado(ctx, vigente);
}

// -- Main ---------------------------------------------------------------------

function limpiarRestos() {
  return restos({ solo: ['-cie-'], borrarTodo: process.argv.includes('--borrar') });
}

async function limpiar() {
  for (const s of sockets) s.disconnect();
  const reg = crearRegistro(`-cie-${S}-`);
  emailsCreados.forEach(reg.email);
  orgsCreadas.forEach(reg.org);
  viajesCreados.forEach(reg.viaje);
  return (await reg.limpiar()).ok;
}

const llamadasMaps = {};
function sumarLlamadasMaps(log) {
  const ultimos = [...log.matchAll(/\[maps\][^\n]*\(([A-Z]+=\d+(?: [A-Z]+=\d+)*)\)/g)].at(-1);
  if (!ultimos) return;
  for (const par of ultimos[1].split(' ')) {
    const [sku, n] = par.split('=');
    llamadasMaps[sku] = (llamadasMaps[sku] ?? 0) + Number(n);
  }
}

async function main() {
  if (process.argv.includes('--restos')) return limpiarRestos();
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   TEST CIERRE SIN "SALIR" (TAREA 5) — FLETER ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  if (SOLO.length > 0) console.log(`  (solo los casos ${SOLO.join(', ')})\n`);
  if (!process.env.INVITACION_SECRETO) throw new Error('Falta INVITACION_SECRETO en el .env local');

  let limpio = false;
  try {
    await conServer(ENV_BASE, PUERTO, async (base, leerLog) => {
      BASE = base;
      titulo('SETUP');
      const [P1, Q1] = await Promise.all([nuevoUsuario('cliente', 'Pym'), nuevoUsuario('cliente', 'Otra')]);
      const [K1, K2, K3] = await Promise.all([1, 2, 3].map((n) => nuevoUsuario('conductor', `Cho${n}`)));
      const A = await crearOrgOk(P1, `PyME Cierre ${S}`, cuitValido(1));
      const B = await crearOrgOk(Q1, `PyME Otra ${S}`, cuitValido(2));
      const veh = new Map();
      for (const k of [K1, K2, K3]) {
        veh.set(k.id_conductor, await vehiculoOk(k));
        await vincular(P1, A, k);
      }
      const [sP1, sK1] = await Promise.all([P1, K1].map((u) => espia(base, u.token)));
      await esperar(1000);
      console.log(`  ${nUsuario} usuarios, PyMEs ${A} y ${B}, sockets conectados`);
      const ctx = { P1, Q1, A, B, K1, K2, K3, veh, sP1, sK1 };
      await casos(ctx);
      if (correr(10)) await casoBarrido(ctx);
      sumarLlamadasMaps(leerLog());
      if (correr(7) || correr(9)) await casoTimer(ctx);
    });
  } finally {
    try {
      limpio = await limpiar();
    } catch (e) {
      console.error('  ⚠️  la limpieza fallo:', e.message);
    }
  }
  paso('LIMPIEZA: no quedo nada de lo creado por el test', limpio, '');
  if (process.env.EJEMPLOS_JSON) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.EJEMPLOS_JSON, JSON.stringify(EJEMPLOS, null, 2));
    console.log(`  ejemplos JSON: ${Object.keys(EJEMPLOS).length} en ${process.env.EJEMPLOS_JSON}`);
  }

  const ok = pasos.filter((p) => p.ok).length;
  const fallaron = pasos.filter((p) => !p.ok);
  console.log(`\n  llamadas a Google (por SKU): ${JSON.stringify(llamadasMaps)}`);
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║                  RESUMEN                     ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`  ${ok}/${pasos.length} checks pasaron`);
  if (fallaron.length > 0) {
    console.log('\n  Fallaron:');
    fallaron.forEach((p) => console.log(`    ❌ ${p.nombre}${p.detalle ? ': ' + p.detalle : ''}`));
  }
  return fallaron.length === 0;
}

main()
  .then(async (ok) => {
    await prisma.$disconnect().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(ok ? 0 : 1);
  })
  .catch(async (e) => {
    console.error('\n💥 Error inesperado:', e.message, e.stack);
    try {
      await limpiar();
    } catch {
      /* ya se intento */
    }
    await prisma.$disconnect().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(1);
  });
