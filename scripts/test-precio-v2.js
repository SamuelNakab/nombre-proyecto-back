// Test del PRECIO v2 de los viajes internos, los datos para recalibrar, el
// feedback del precio pagado y "el chofer no ve precios ni datos personales".
//
// NO pega contra :3000: levanta servers efimeros propios (_server-efimero.js).
//   - 3971: el principal (ANTICIPACION 0, ventana 60/90, marketplace apagado).
//   - 3972: cierre automatico por timer (CIERRE_FIN_DIA_SEGUNDOS_TEST).
//   - 3973: MARKETPLACE_HABILITADO=true, para que el socket del chofer pase por
//     TODOS los caminos que unen salas (pool del marketplace, viaje:aceptar).
// USA GOOGLE DE VERDAD (Routes, Pro): cada estimacion gasta (paradas - 1)
// llamadas; el total sale al final.
//
// Casos:
//   1. Crear con defaults: v2, snapshot, rango, desglose, tarifas de compat,
//      historial CREAR, staticDuration por parada.
//   2. Crear con datos de la Parte B (EQUIPO, factura A, peajes, carga, escalera)
//      y los 400 nuevos.
//   3. Factura A por defecto de la organizacion (RESPONSABLE la edita; MIEMBRO 403).
//   4. Lugar con acceso por defecto (snapshot en la parada; escalera sin ayudante 400).
//   5. estimar-precio: forma, no crea nada, id_lugar, chofer 403.
//   6. Editar: Parte B sin Google, reconfirmacion, viaje v1 que pasa a v2, estado
//      resultante invalido 400, historial EDITAR.
//   7. Serie con datos de la Parte B: copia a cada viaje, historial en lote,
//      serie:asignada sin precios al chofer.
//   8. Cierre CHOFER con GPS: precio medido, fuente GPS, calidad GPS, distancia
//      por tramo, ping desordenado ignorado, eventos divididos, remito sin montos.
//   9. Cierre CHOFER sin GPS: fallback a la distancia estimada (nunca 0).
//  10. Cierre ORGANIZACION.
//  11. Cierre AUTOMATICO incompleto sin GPS (3972): ESTIMADA_PARCIAL.
//  12. Cancelacion en curso: precio parcial solo en el historial.
//  13. Viaje con version_precio null: se cierra con v1, remito sin montos.
//  14. Costo en vivo: MIXTO v1 REST = socket (sin doble cobro), v2 en vivo,
//      costo-acumulado legacy 403 al chofer.
//  15. Feedback del precio pagado: permisos, estados, ventana, upsert concurrente
//      (RONDAS), lista / detalle, pendientes.
//  16. Dataset admin (JSON y CSV).
//  17. El chofer no recibe precios ni datos personales por NINGUN canal (chequeo
//      recursivo de todo lo que recibio + server 3973 con el marketplace prendido).
//
// PROTOCOLO DE REVERSION (guard -> caso que se pone en rojo):
//   - ON CONFLICT del upsert de precio pagado (cambiarlo por find + create)  -> 15e
//   - filtro de pings desordenados en avanzarAcumulado                       -> 8c
//   - clasificacion de la vista del chofer (vista-chofer.js)                 -> 17a / 17b
//   - version_precio en el cierre (precioMedido)                             -> 13a
//   - llegada_real null en el updateMany de confirmar (distancia por tramo)  -> 8d
//   - emitirViajeInternoDividido (payload con precio solo a la PyME)          -> 17c / 14c
//
// Acepta numeros de caso (el setup corre siempre), RONDAS=N y --restos [--borrar].
// LIMPIEZA: borra TODO lo que crea (_limpieza.js) y al final verifica que no
// quedo nada.
import 'dotenv/config';
import zlib from 'node:zlib';
import { io as ioClient } from 'socket.io-client';
import prisma from '../src/config/prisma.js';
import redis from '../src/config/redis.js';
import { conServer } from './_server-efimero.js';
import { crearRegistro } from './_limpieza.js';
import { restos } from './restos.js';
import { getToken as loginFirebase, credencialesAdminTest } from './_firebase-auth.js';
import { calcularPrecioV2 } from '../src/services/precio-v2.js';
import { precioDesdeMediciones } from '../src/services/precio-real.js';

const PUERTO = 3971;
const PUERTO_TIMER = 3972;
const PUERTO_MARKET = 3973;
const RONDAS = Number(process.env.RONDAS) > 0 ? Number(process.env.RONDAS) : 5;
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
  SALIDA_DETECCION_SEGUNDOS: '240',
};

const SOLO = process.argv.slice(2).map(Number).filter(Number.isFinite);
const correr = (n) => SOLO.length === 0 || SOLO.includes(n);

const stamp = Date.now();
const S = String(stamp);
const INICIO_TEST = new Date(stamp - 60_000);
const PASS = 'test123456';
const LIC = '2030-01-01T00:00:00.000Z';

const ORIGEN = { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' };
const INTERMEDIA = { lat: -34.5975, lng: -58.3923, direccion: 'Tribunales, CABA' };
const DESTINO = { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' };
// Fuera de CABA (MIXTO / provincia).
const AVELLANEDA = { lat: -34.6627, lng: -58.3654, direccion: 'Avellaneda, Buenos Aires' };

const emailsCreados = [];
const orgsCreadas = new Set();
const viajesCreados = new Set();
const sockets = [];
// Todo lo que recibio un chofer por REST (para el chequeo recursivo del 17).
const recibidoPorChofer = [];

// -- Helpers ----------------------------------------------------------------

const pasos = [];
function paso(nombre, ok, detalle = '') {
  pasos.push({ nombre, ok: Boolean(ok), detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const titulo = (t) => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 60 - t.length))}\n`);

let BASE = `http://localhost:${PUERTO}`;

async function api(method, path, body, token, { chofer = null } = {}) {
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
    data = { error: `Respuesta no-JSON (${res.status})`, texto: crudo };
  }
  if (chofer) recibidoPorChofer.push({ canal: `${method} ${path}`, data, propio: chofer });
  return { status: res.status, data, crudo, headers: res.headers };
}
// Las llamadas del chofer quedan registradas para el chequeo recursivo.
const apiK = (method, path, body, k) => api(method, path, body, k.token, { chofer: k });

const r2s = (r) => `${r.status} ${(r.crudo ?? '').slice(0, 220)}`;
const statuses = (rs) => rs.map((r) => r.status).sort((a, b) => a - b).join(',');

const MULT = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
function cuitValido(n) {
  for (let k = 0; ; k++) {
    const base = '30' + String((Number(S.slice(-6)) * 100 + 9100 + n * 7 + k) % 1e8).padStart(8, '0');
    const suma = MULT.reduce((a, m, i) => a + m * Number(base[i]), 0);
    const dv = 11 - (suma % 11);
    if (dv === 10) continue;
    return base + (dv === 11 ? 0 : dv);
  }
}

let nUsuario = 0;
async function nuevoUsuario(tipo, etiqueta) {
  nUsuario++;
  const email = `${etiqueta}-pv2-${S}-${nUsuario}@test.com`.toLowerCase();
  const telefono = `+54911${S.slice(-4)}${String(nUsuario).padStart(4, '0')}`;
  const datos = {
    nombre: etiqueta,
    apellido: 'Pv2',
    dni: '5' + S.slice(-6) + String(nUsuario).padStart(2, '0'),
    email,
    contrasena: PASS,
    telefono,
    ...(tipo === 'conductor' ? { nro_licencia: `LPV${nUsuario}${S.slice(-4)}`, licencia_vencimiento: LIC } : {}),
  };
  emailsCreados.push(email);
  const endpoint = tipo === 'cliente' ? '/api/auth/registro-cliente' : '/api/auth/registro-conductor';
  const r = await api('POST', endpoint, datos);
  if (r.status !== 201) throw new Error(`registro ${tipo} ${email} fallo: ${r2s(r)}`);
  const token = await loginFirebase(email, PASS);
  const u = await prisma.usuario.findUnique({ where: { email }, include: { conductor: true } });
  return {
    email,
    token,
    telefono,
    dni: datos.dni,
    firebase_uid: u.firebase_uid,
    id_usuario: u.id_usuario,
    id_conductor: u.conductor?.id_conductor ?? null,
  };
}

async function crearOrgOk(u, nombre, cuit) {
  const r = await api('POST', '/api/organizaciones', { nombre, cuit }, u.token);
  if (r.status !== 201) throw new Error(`crear PyME ${nombre} fallo: ${r2s(r)}`);
  orgsCreadas.add(r.data.id_organizacion);
  return r.data.id_organizacion;
}

async function invitarYCanjear(responsable, idOrg, tipo, invitado) {
  const inv = await api('POST', `/api/organizaciones/${idOrg}/invitaciones`, { tipo }, responsable.token);
  if (inv.status !== 201) throw new Error(`invitar ${tipo} fallo: ${r2s(inv)}`);
  const c = await api('POST', '/api/invitaciones/canjear', { codigo: inv.data.codigo }, invitado.token);
  if (c.status !== 200) throw new Error(`canje ${tipo} fallo: ${r2s(c)}`);
}

let nPatente = 0;
async function vehiculoOk(chofer) {
  nPatente++;
  const patente = `P${S.slice(-4)}${String(nPatente).padStart(2, '0')}`;
  const r = await api(
    'POST',
    '/api/conductores/mis-vehiculos',
    { patente, marca: 'Renault', modelo: 'Kangoo', anio: 2021, color: 'Gris', tipo_vehiculo: 'Utilitario', condiciones: [] },
    chofer.token
  );
  if (r.status !== 201) throw new Error(`vehiculo fallo: ${r2s(r)}`);
  return r.data.id_vehiculo;
}

const enMin = (n) => new Date(Date.now() + n * 60000).toISOString();
const HORA = 3_600_000;
const ms = (d) => (d ? new Date(d).getTime() : null);

async function okOFalla(promesa, que) {
  const r = await promesa;
  if (r.status !== 200 && r.status !== 201) throw new Error(`${que} fallo: ${r2s(r)}`);
  return r;
}

const cuerpoViaje = (id_conductor, paradas, extra = {}) => ({
  id_conductor,
  fecha_programada: enMin(2),
  motivo: 'Test precio v2',
  descripcion: 'Indicaciones de prueba',
  paradas,
  ...extra,
});

async function crear(u, idOrg, body) {
  const r = await api('POST', `/api/organizaciones/${idOrg}/viajes`, body, u.token);
  if (r.status === 201) viajesCreados.add(r.data.id_viaje);
  return r;
}
async function crearOk(u, idOrg, body) {
  const r = await crear(u, idOrg, body);
  if (r.status !== 201) throw new Error(`crear viaje fallo: ${r2s(r)}`);
  return r;
}
const confirmar = (k, id, id_vehiculo) => apiK('POST', `/api/choferes/viajes/${id}/confirmar`, { id_vehiculo }, k);
const iniciar = (k, id) => apiK('POST', `/api/choferes/viajes/${id}/iniciar`, { lat: ORIGEN.lat, lng: ORIGEN.lng }, k);
const salir = (k, id) => apiK('POST', `/api/choferes/viajes/${id}/salir`, null, k);
const confirmarParada = (k, id, p) =>
  apiK('POST', `/api/viajes/${id}/confirmar-parada`, { id_parada: p.id_parada, lat: p.latitud, lng: p.longitud }, k);
const cancelarPyme = (u, idOrg, id) => api('POST', `/api/organizaciones/${idOrg}/viajes/${id}/cancelar`, {}, u.token);
const finalizar = (u, idOrg, id) => api('POST', `/api/organizaciones/${idOrg}/viajes/${id}/finalizar`, null, u.token);

const viajeDb = (id) => prisma.viaje.findUnique({ where: { id_viaje: id } });
const paradasDb = (id) => prisma.parada.findMany({ where: { id_viaje: id }, orderBy: { orden: 'asc' } });
const historialPrecio = (id) =>
  prisma.historialPrecioViaje.findMany({ where: { id_viaje: id }, orderBy: [{ fecha: 'asc' }, { id_historial_precio: 'asc' }] });
async function keysGps(id) {
  if (redis.status !== 'ready') return -1;
  return (await redis.keys(`gps:${id}:*`)).length;
}
const acumuladoDe = async (id) => JSON.parse((await redis.get(`gps:${id}:acumulado`)) ?? 'null');

// Crea, confirma e inicia (queda CARGANDO en la parada 1).
async function iniciado(ctx, k, paradas = [ORIGEN, DESTINO], extra = {}) {
  const r = await crearOk(ctx.P1, ctx.A, cuerpoViaje(k.id_conductor, paradas, extra));
  const id = r.data.id_viaje;
  await okOFalla(confirmar(k, id, ctx.veh.get(k.id_conductor)), 'confirmar');
  await okOFalla(iniciar(k, id), 'iniciar');
  return id;
}

async function llevarAUltima(k, id, { peonHoras = null, entreParadas = null } = {}) {
  const ps = await paradasDb(id);
  if (peonHoras !== null) {
    await prisma.parada.update({ where: { id_parada: ps.at(-1).id_parada }, data: { peon_estimado_horas: peonHoras } });
  }
  for (let i = 1; i < ps.length; i++) {
    await okOFalla(salir(k, id), `salir de la parada ${i}`);
    if (entreParadas) await entreParadas(ps[i - 1], ps[i]);
    await okOFalla(confirmarParada(k, id, ps[i]), `confirmar la parada ${i + 1}`);
  }
  return paradasDb(id);
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

// Ping GPS con el timestamp del reloj real (creciente POR VIAJE). conCosto: lo
// lleva al proximo segundo 1 de un minuto (timestamp % 60000 < 16000), que es
// cuando el server emite costo:actualizar.
const ultimoTs = new Map();
function tsSiguiente(id_viaje, { conCosto = false } = {}) {
  let ts = Math.max(Date.now(), (ultimoTs.get(id_viaje) ?? 0) + 1);
  if (conCosto && ts % 60000 >= 16000) ts = ts - (ts % 60000) + 60000 + 1000;
  ultimoTs.set(id_viaje, ts);
  return ts;
}
async function ping(esp, id_viaje, pos, { ts = tsSiguiente(id_viaje), espera = 400 } = {}) {
  esp.socket.emit('conductor:ubicacion', { id_viaje, lat: pos.lat, lng: pos.lng, timestamp: ts });
  await esperar(espera);
  return ts;
}
// N pings en linea recta entre a y b (incluidos los extremos). Separados 700 ms:
// el acumulado de Redis es GET + SET por ping (un celular manda cada varios
// segundos); pings mas juntos que lo que tarda el handler se pisarian.
async function recorrer(esp, id_viaje, a, b, n) {
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    await ping(esp, id_viaje, { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }, { espera: 700 });
  }
  await esperar(800);
}
// Un recorrido por calles (no en linea recta) de ORIGEN a DESTINO: ~4 km, del
// orden de la ruta de Google, para que la distancia GPS sea confiable.
const DESVIO_1 = { lat: -34.598, lng: -58.372 };
const DESVIO_2 = { lat: -34.585, lng: -58.385 };

// -- Remito -------------------------------------------------------------------

function textoDePdf(buf) {
  const bin = buf.toString('latin1');
  let texto = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(bin))) {
    let contenido;
    try {
      contenido = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      contenido = m[1];
    }
    for (const h of contenido.matchAll(/<([0-9a-fA-F]+)>/g)) texto += Buffer.from(h[1], 'hex').toString('latin1');
    for (const p of contenido.matchAll(/\(((?:\\.|[^\\)])*)\)/g)) texto += p[1];
    texto += '\n';
  }
  return texto;
}
const sinEspacios = (t) => t.replace(/\s+/g, '');

// El remito de un viaje interno no lleva montos: ni "$", ni "TOTAL", ni el
// numero del precio. Control positivo: la direccion de la parada SI esta.
async function remitoSinMontos(id, precio) {
  const url = `${process.env.R2_PUBLIC_URL}/remitos/${id}.pdf`;
  if (!process.env.R2_PUBLIC_URL) return { ok: false, detalle: 'sin R2_PUBLIC_URL' };
  let buf = null;
  for (let i = 0; i < 6 && !buf; i++) {
    const res = await fetch(url).catch(() => null);
    if (res?.ok) buf = Buffer.from(await res.arrayBuffer());
    else await esperar(1000);
  }
  if (!buf) return { ok: false, detalle: 'no se pudo bajar el PDF' };
  const t = sinEspacios(textoDePdf(buf));
  const control = t.includes(sinEspacios(DESTINO.direccion));
  // El numero solo se busca si es largo (un "4" aparece en cualquier fecha).
  const numero = precio != null && Math.round(precio) >= 1000 ? String(Math.round(precio)) : null;
  const sinMontos = !t.includes('$') && !/TOTAL/i.test(t) && !/DESGLOSE/i.test(t) && !(numero && t.includes(numero));
  return { ok: control && sinMontos, detalle: `pdf=${buf.length}B control=${control} sinMontos=${sinMontos}` };
}

// -- Chequeo recursivo del chofer -------------------------------------------

const CLAVE_PRECIO = /precio|tarifa|peaje|tiempo_capital|distancia_provincia/i;
const CLAVES_PERMITIDAS = new Set(['fecha_corte_precio']);
const CLAVES_PERSONALES = ['email', 'dni', 'firebase_uid'];

// Recorre TODO el JSON (no solo el primer nivel). Devuelve las violaciones.
function violaciones(valor, propio, ruta = '$', out = []) {
  if (Array.isArray(valor)) {
    valor.forEach((v, i) => violaciones(v, propio, `${ruta}[${i}]`, out));
  } else if (valor && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) {
      const r = `${ruta}.${k}`;
      if (CLAVE_PRECIO.test(k) && !CLAVES_PERMITIDAS.has(k)) out.push(`precio: ${r}`);
      if (CLAVES_PERSONALES.includes(k)) out.push(`personal: ${r}`);
      // Su propio telefono puede llegar (su perfil); el de otro usuario no.
      if (k === 'telefono' && v != null && v !== propio.telefono) out.push(`telefono ajeno: ${r}`);
      violaciones(v, propio, r, out);
    }
  }
  return out;
}

// -- Casos --------------------------------------------------------------------

async function casos(ctx) {
  const { P1, M1, Q1, A, K1, K2, K3, sP1, sK1, sK2 } = ctx;

  // CASO 1 -------------------------------------------------------------------
  if (correr(1)) {
    titulo('CASO 1: crear con defaults');
    const r = await crearOk(P1, A, cuerpoViaje(K1.id_conductor, [ORIGEN, DESTINO]));
    const v = await viajeDb(r.data.id_viaje);
    const snap = v.precio_parametros;
    const recalculado = calcularPrecioV2(snap.entradas, snap.parametros);
    paso(
      'CASO 1a: v2 con snapshot; precio_estimado = total de la formula con el snapshot (multiplo de 1000)',
      v.version_precio === 2 && snap?.version === 2 && v.precio_estimado === recalculado.total &&
        v.precio_estimado % 1000 === 0 && v.precio_estimado_min === recalculado.bajo && v.precio_estimado_max === recalculado.alto,
      `${v.precio_estimado} [${v.precio_estimado_min}, ${v.precio_estimado_max}] vs ${recalculado.total}`
    );
    paso(
      'CASO 1b: defaults usados y no declarados (null en el viaje, LIVIANO / 0 / false / NINGUNA en el snapshot)',
      v.tipo_servicio === null && v.ayudantes === null && v.factura_a === null && v.peajes_estimados === null &&
        snap.entradas.servicio === 'LIVIANO' && snap.entradas.ayudantes === 0 && snap.entradas.factura_a === false &&
        snap.entradas.fuente_factura_a === 'DEFAULT' && snap.entradas.peajes === 0 && v.fuente_peajes === 'NINGUNA',
      JSON.stringify(snap.entradas)
    );
    paso(
      'CASO 1c: compatibilidad: zona, tarifa_hora = PRECIO_HORA_LIVIANO, tarifa_km = PRECIO_KM_IDA, tiempo_capital / distancia_provincia null',
      v.zona === 'CABA' && v.tarifa_hora === 37500 && v.tarifa_km === 4500 && v.tiempo_capital === null && v.distancia_provincia === null,
      `${v.zona} ${v.tarifa_hora} ${v.tarifa_km}`
    );
    paso(
      'CASO 1d: horas del precio = manejo + 15 min x parada (no el peon de la duracion)',
      Math.abs(snap.entradas.horas - (v.manejo_estimado_horas + 0.5)) < 1e-9 && Math.abs(snap.entradas.km_ida - v.distancia_estimada_km) < 1e-9,
      `${snap.entradas.horas} vs ${v.manejo_estimado_horas} + 0.5`
    );
    const ps = await paradasDb(v.id_viaje);
    paso('CASO 1e: staticDuration del tramo guardado en la parada 2 (null en la 1)', ps[0].manejo_sin_transito_horas === null && ps[1].manejo_sin_transito_horas > 0, `${ps[1].manejo_sin_transito_horas}`);
    const h = await historialPrecio(v.id_viaje);
    paso('CASO 1f: historial CREAR con total, rango, desglose y parametros', h.length === 1 && h[0].motivo === 'CREAR' && h[0].version === 2 && h[0].total === v.precio_estimado && h[0].minimo === v.precio_estimado_min && h[0].parametros?.version === 2 && h[0].id_usuario === P1.id_usuario, JSON.stringify(h.map((x) => [x.motivo, x.total])));
    paso(
      'CASO 1g: respuesta: desglose_estimado v2, precio_pagado null y pendiente false',
      r.data.desglose_estimado?.version === 2 && r.data.desglose_estimado.total === v.precio_estimado && r.data.precio_pagado === null &&
        r.data.precio_pagado_pendiente === false && r.data.paradas[1].manejo_sin_transito_min > 0,
      JSON.stringify({ d: r.data.desglose_estimado?.total, pp: r.data.precio_pagado })
    );
    await cancelarPyme(P1, A, v.id_viaje);
  }

  // CASO 2 -------------------------------------------------------------------
  if (correr(2)) {
    titulo('CASO 2: crear con datos de la Parte B y sus 400');
    const r = await crearOk(
      P1,
      A,
      cuerpoViaje(K1.id_conductor, [ORIGEN, { ...DESTINO, acceso: 'ESCALERA', pisos: 2, operacion: 'DESCARGA' }], {
        tipo_servicio: 'EQUIPO',
        factura_a: true,
        peajes_estimados: 3000,
        tipo_carga: 'FRAGIL',
        bultos: 12,
        peso_kg: 350.5,
        volumen_m3: 4.2,
        pallets: 2,
        valor_declarado: 1500000,
      })
    );
    const v = await viajeDb(r.data.id_viaje);
    const e = v.precio_parametros.entradas;
    const d = v.precio_estimado_desglose;
    paso(
      'CASO 2a: lo declarado se guarda; el snapshot usa EQUIPO (2 ayudantes), escalera, factura A y peajes PYME',
      v.tipo_servicio === 'EQUIPO' && v.ayudantes === null && v.factura_a === true && v.peajes_estimados === 3000 && v.fuente_peajes === 'PYME' &&
        v.tipo_carga === 'FRAGIL' && v.bultos === 12 && v.peso_kg === 350.5 && v.pallets === 2 && v.valor_declarado === 1500000 &&
        e.servicio === 'EQUIPO' && e.ayudantes === 2 && e.escalera === true && e.factura_a === true && e.peajes === 3000,
      JSON.stringify(e)
    );
    paso(
      'CASO 2b: desglose: IVA solo sobre el subtotal, peajes aparte, recargo de escalera, EQUIPO sin costo de ayudantes',
      d.iva === Math.floor(d.subtotal_sin_iva * 0.21 + 0.5) && d.peajes === 3000 && d.recargo_escalera > 0 && d.costo_ayudantes === 0 &&
        d.subtotal_sin_iva + d.iva + d.peajes + d.ajuste_redondeo === v.precio_estimado && v.tarifa_hora === 100000,
      JSON.stringify({ sub: d.subtotal_sin_iva, iva: d.iva, peajes: d.peajes, total: d.total })
    );
    const ps = await paradasDb(v.id_viaje);
    paso('CASO 2c: la parada guarda acceso, pisos y operacion', ps[1].acceso === 'ESCALERA' && ps[1].pisos === 2 && ps[1].operacion === 'DESCARGA' && ps[0].acceso === null, JSON.stringify(ps.map((p) => [p.acceso, p.pisos, p.operacion])));
    await cancelarPyme(P1, A, v.id_viaje);

    const casos400 = [
      ['EQUIPO con 1 ayudante', { tipo_servicio: 'EQUIPO', ayudantes: 1 }, [ORIGEN, DESTINO], /EQUIPO los ayudantes son siempre 2/],
      ['LIVIANO con 2 ayudantes', { tipo_servicio: 'LIVIANO', ayudantes: 2 }, [ORIGEN, DESTINO], /como máximo 1/],
      ['escalera sin ayudante', {}, [ORIGEN, { ...DESTINO, acceso: 'ESCALERA', pisos: 1 }], /escalera.*al menos 1 ayudante/],
      ['ESCALERA sin pisos', { ayudantes: 1 }, [ORIGEN, { ...DESTINO, acceso: 'ESCALERA' }], /pisos es obligatorio/],
      ['bultos 0', { bultos: 0 }, [ORIGEN, DESTINO], /bultos/],
      ['tipo_servicio invalido', { tipo_servicio: 'MOTO' }, [ORIGEN, DESTINO], /tipo_servicio/],
    ];
    const antes = await prisma.viaje.count({ where: { id_organizacion: A } });
    const fallos = [];
    for (const [nombre, extra, paradas, re] of casos400) {
      const x = await crear(P1, A, cuerpoViaje(K1.id_conductor, paradas, extra));
      if (x.status !== 400 || !re.test(x.data.error ?? '')) fallos.push(`${nombre}: ${r2s(x)}`);
    }
    const despues = await prisma.viaje.count({ where: { id_organizacion: A } });
    paso('CASO 2d: los 400 de la Parte B, en español, sin crear nada', fallos.length === 0 && antes === despues, fallos.join(' | ') || `${casos400.length} casos`);
  }

  // CASO 3 -------------------------------------------------------------------
  if (correr(3)) {
    titulo('CASO 3: factura A por defecto de la organizacion');
    const miembro = await api('PUT', `/api/organizaciones/${A}`, { factura_a_por_defecto: true }, M1.token);
    paso('CASO 3a: un MIEMBRO no la puede editar → 403', miembro.status === 403, r2s(miembro));
    const resp = await api('PUT', `/api/organizaciones/${A}`, { factura_a_por_defecto: true }, P1.token);
    paso('CASO 3b: el RESPONSABLE la edita → 200 y se devuelve', resp.status === 200 && resp.data.factura_a_por_defecto === true, r2s(resp));
    const sinDeclarar = await crearOk(P1, A, cuerpoViaje(K1.id_conductor, [ORIGEN, DESTINO]));
    const v1 = await viajeDb(sinDeclarar.data.id_viaje);
    paso(
      'CASO 3c: viaje sin factura_a → usa la de la PyME (fuente ORGANIZACION), el viaje guarda null, IVA en el precio',
      v1.factura_a === null && v1.precio_parametros.entradas.factura_a === true && v1.precio_parametros.entradas.fuente_factura_a === 'ORGANIZACION' &&
        v1.precio_estimado_desglose.iva > 0 && v1.precio_parametros.declarados.factura_a_organizacion === true,
      JSON.stringify(v1.precio_parametros.declarados)
    );
    const declarada = await crearOk(P1, A, cuerpoViaje(K1.id_conductor, [ORIGEN, DESTINO], { factura_a: false }));
    const v2 = await viajeDb(declarada.data.id_viaje);
    paso('CASO 3d: factura_a false en el viaje gana (fuente VIAJE, sin IVA)', v2.factura_a === false && v2.precio_parametros.entradas.fuente_factura_a === 'VIAJE' && v2.precio_estimado_desglose.iva === 0, '');
    const reset = await api('PUT', `/api/organizaciones/${A}`, { factura_a_por_defecto: null }, P1.token);
    paso('CASO 3e: null la borra', reset.status === 200 && reset.data.factura_a_por_defecto === null, r2s(reset));
    await cancelarPyme(P1, A, v1.id_viaje);
    await cancelarPyme(P1, A, v2.id_viaje);
  }

  // CASO 4 -------------------------------------------------------------------
  if (correr(4) || correr(5)) {
    titulo('CASO 4: lugar con acceso por defecto');
    const sinPisos = await api('POST', `/api/organizaciones/${A}/lugares`, { nombre: `Dep ${S}`, direccion: DESTINO.direccion, lat: DESTINO.lat, lng: DESTINO.lng, acceso_por_defecto: 'ESCALERA' }, P1.token);
    paso('CASO 4a: ESCALERA sin pisos → 400', sinPisos.status === 400 && /pisos es obligatorio/.test(sinPisos.data.error), r2s(sinPisos));
    const lugar = await api('POST', `/api/organizaciones/${A}/lugares`, { nombre: `Dep ${S}`, direccion: DESTINO.direccion, lat: DESTINO.lat, lng: DESTINO.lng, acceso_por_defecto: 'ESCALERA', pisos_por_defecto: 3 }, P1.token);
    paso('CASO 4b: lugar con acceso y pisos por defecto', lugar.status === 201 && lugar.data.acceso_por_defecto === 'ESCALERA' && lugar.data.pisos_por_defecto === 3, r2s(lugar));
    ctx.lugar = lugar.data.id_lugar;
    const sinAyudante = await crear(P1, A, cuerpoViaje(K1.id_conductor, [ORIGEN, { id_lugar: ctx.lugar }]));
    paso('CASO 4c: parada con el lugar (escalera copiada) y sin ayudante → 400', sinAyudante.status === 400 && /escalera/.test(sinAyudante.data.error), r2s(sinAyudante));
    const ok = await crearOk(P1, A, cuerpoViaje(K1.id_conductor, [{ id_lugar: ctx.lugar }, INTERMEDIA, { id_lugar: ctx.lugar, acceso: 'PLANTA_BAJA' }], { ayudantes: 1 }));
    const ps = await paradasDb(ok.data.id_viaje);
    const v = await viajeDb(ok.data.id_viaje);
    paso(
      'CASO 4d: snapshot del acceso del lugar; si la parada manda acceso, gana el suyo; 1 parada extra',
      ps[0].acceso === 'ESCALERA' && ps[0].pisos === 3 && ps[2].acceso === 'PLANTA_BAJA' && ps[2].pisos === null &&
        v.precio_parametros.entradas.escalera === true && v.precio_parametros.entradas.paradas_extra === 1,
      JSON.stringify(ps.map((p) => [p.acceso, p.pisos]))
    );
    await cancelarPyme(P1, A, v.id_viaje);
  }

  // CASO 5 -------------------------------------------------------------------
  if (correr(5)) {
    titulo('CASO 5: estimar-precio');
    const antes = await prisma.viaje.count({ where: { id_organizacion: A } });
    const r = await api('POST', `/api/organizaciones/${A}/viajes/estimar-precio`, { paradas: [ORIGEN, { id_lugar: ctx.lugar }], ayudantes: 1, peajes_estimados: 1200 }, P1.token);
    const despues = await prisma.viaje.count({ where: { id_organizacion: A } });
    paso(
      'CASO 5a: 200 con total, rango, desglose v2, peajes (Google null, PYME) y estimados; no crea nada',
      r.status === 200 && r.data.version_precio === 2 && r.data.total % 1000 === 0 && r.data.bajo < r.data.total && r.data.alto > r.data.total &&
        r.data.desglose?.version === 2 && r.data.peajes.google === null && r.data.peajes.fuente === 'PYME' && r.data.peajes.usados === 1200 &&
        r.data.estimado.horas_precio > 0 && r.data.tramos.length === 2 && r.data.tramos[1].manejo_sin_transito_min !== undefined && antes === despues,
      r2s(r)
    );
    const e400 = await api('POST', `/api/organizaciones/${A}/viajes/estimar-precio`, { paradas: [ORIGEN, { id_lugar: ctx.lugar }] }, P1.token);
    paso('CASO 5b: las mismas validaciones que crear (escalera sin ayudante → 400)', e400.status === 400, r2s(e400));
    const chofer = await apiK('POST', `/api/organizaciones/${A}/viajes/estimar-precio`, { paradas: [ORIGEN, DESTINO] }, K1);
    const otra = await api('POST', `/api/organizaciones/${A}/viajes/estimar-precio`, { paradas: [ORIGEN, DESTINO] }, Q1.token);
    paso('CASO 5c: el chofer → 403; otra PyME → 403', chofer.status === 403 && otra.status === 403, `${chofer.status}/${otra.status}`);
  }

  // CASO 6 -------------------------------------------------------------------
  if (correr(6)) {
    titulo('CASO 6: editar');
    const r = await crearOk(P1, A, cuerpoViaje(K1.id_conductor, [ORIGEN, DESTINO]));
    const id = r.data.id_viaje;
    await okOFalla(confirmar(K1, id, ctx.veh.get(K1.id_conductor)), 'confirmar');
    const antes = await viajeDb(id);
    const ed = await api('PUT', `/api/organizaciones/${A}/viajes/${id}`, { ayudantes: 1 }, P1.token);
    const desp = await viajeDb(id);
    paso(
      'CASO 6a: solo un dato de la Parte B → recalcula con los estimados guardados (mismo manejo), sube el precio y vuelve a ASIGNADO',
      ed.status === 200 && desp.ayudantes === 1 && desp.precio_estimado > antes.precio_estimado && desp.manejo_estimado_horas === antes.manejo_estimado_horas &&
        desp.estado === 'ASIGNADO' && desp.id_vehiculo === null && desp.vehiculo_snapshot === null,
      `${antes.precio_estimado} → ${desp.precio_estimado} ${desp.estado}`
    );
    const h = await historialPrecio(id);
    paso('CASO 6b: historial EDITAR', h.map((x) => x.motivo).join(',') === 'CREAR,EDITAR' && h[1].total === desp.precio_estimado, h.map((x) => x.motivo).join(','));
    const mal = await api('PUT', `/api/organizaciones/${A}/viajes/${id}`, { tipo_servicio: 'CAMION', ayudantes: 3 }, P1.token);
    const malEquipo = await api('PUT', `/api/organizaciones/${A}/viajes/${id}`, { tipo_servicio: 'EQUIPO' }, P1.token);
    paso('CASO 6c: estado resultante invalido → 400 (CAMION con 3; EQUIPO con el ayudante guardado)', mal.status === 400 && malEquipo.status === 400, `${r2s(mal)} | ${r2s(malEquipo)}`);
    const borrar = await api('PUT', `/api/organizaciones/${A}/viajes/${id}`, { ayudantes: null }, P1.token);
    paso('CASO 6d: null borra lo declarado', borrar.status === 200 && (await viajeDb(id)).ayudantes === null, r2s(borrar));

    // Un viaje v1 (el codigo viejo) editado solo en el motivo pasa a v2.
    const { Prisma } = await import('@prisma/client');
    await prisma.viaje.update({ where: { id_viaje: id }, data: { version_precio: null, precio_parametros: Prisma.DbNull } });
    const motivo = await api('PUT', `/api/organizaciones/${A}/viajes/${id}`, { motivo: 'Otro motivo' }, P1.token);
    const v = await viajeDb(id);
    paso('CASO 6e: un viaje v1 editado (solo el motivo) queda v2 con snapshot', motivo.status === 200 && v.version_precio === 2 && v.precio_parametros?.version === 2, `${v.version_precio}`);
    await cancelarPyme(P1, A, id);
  }

  // CASO 7 -------------------------------------------------------------------
  if (correr(7)) {
    titulo('CASO 7: serie con datos de la Parte B');
    const manana = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const pasadoManana = new Date(Date.now() + 2 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const r = await api(
      'POST',
      `/api/organizaciones/${A}/series`,
      {
        id_conductor: K2.id_conductor,
        frecuencia: 'DIARIA',
        hora: '10:00',
        fecha_desde: manana,
        fecha_hasta: pasadoManana,
        paradas: [ORIGEN, { ...DESTINO, acceso: 'ESCALERA', pisos: 1 }],
        motivo: 'Serie precio v2',
        descripcion: 'Serie de prueba',
        tipo_servicio: 'LIVIANO',
        ayudantes: 1,
        peajes_estimados: 500,
        tipo_carga: 'GENERAL',
      },
      P1.token
    );
    const ids = (r.data.viajes ?? []).map((v) => v.id_viaje);
    ids.forEach((id) => viajesCreados.add(id));
    const serie = r.data.serie ? await prisma.serieViaje.findUnique({ where: { id_serie: r.data.serie.id_serie } }) : null;
    paso(
      'CASO 7a: la serie guarda lo declarado y la plantilla el acceso',
      r.status === 201 && serie?.tipo_servicio === 'LIVIANO' && serie.ayudantes === 1 && serie.peajes_estimados === 500 && serie.tipo_carga === 'GENERAL' &&
        serie.paradas[1].acceso === 'ESCALERA' && serie.paradas[1].pisos === 1 && r.data.serie.ayudantes === 1,
      r2s(r)
    );
    const viajes = await prisma.viaje.findMany({ where: { id_viaje: { in: ids } } });
    const hs = await prisma.historialPrecioViaje.findMany({ where: { id_viaje: { in: ids } } });
    paso(
      'CASO 7b: cada viaje v2 con lo declarado copiado, su snapshot y su fila CREAR',
      viajes.length === 2 && viajes.every((v) => v.version_precio === 2 && v.ayudantes === 1 && v.peajes_estimados === 500 && v.fuente_peajes === 'PYME' && v.precio_parametros.entradas.escalera === true) &&
        hs.length === 2 && hs.every((h) => h.motivo === 'CREAR'),
      `${viajes.length} viajes, ${hs.length} filas`
    );
    await esperar(1500);
    const evChofer = sK2.eventos.find((e) => e.ev === 'serie:asignada' && e.d?.id_serie === r.data.serie?.id_serie)?.d;
    const evPyme = sP1.eventos.find((e) => e.ev === 'serie:asignada' && e.d?.id_serie === r.data.serie?.id_serie)?.d;
    paso(
      'CASO 7c: serie:asignada a la PyME con precios y al chofer SIN precios',
      evPyme?.viajes?.[0]?.precio_estimado > 0 && evChofer && evChofer.viajes.every((v) => !('precio_estimado' in v) && !('precio_estimado_min' in v)),
      `pyme=${evPyme?.viajes?.[0]?.precio_estimado} chofer=${JSON.stringify(evChofer?.viajes?.[0] ?? null).slice(0, 120)}`
    );
    if (r.data.serie) await api('POST', `/api/organizaciones/${A}/series/${r.data.serie.id_serie}/cancelar`, null, P1.token);
    for (const id of ids) await cancelarPyme(P1, A, id);
  }

  // CASO 8 -------------------------------------------------------------------
  if (correr(8) || correr(15) || correr(16)) {
    titulo('CASO 8: cierre CHOFER con GPS');
    const id = await iniciado(ctx, K1, [ORIGEN, DESTINO], { factura_a: true });
    await recorrer(sK1, id, ORIGEN, ORIGEN, 3); // en la parada 1
    let antesDesordenado = null;
    const ps = await llevarAUltima(K1, id, {
      entreParadas: async (a, b) => {
        await recorrer(sK1, id, { lat: a.latitud, lng: a.longitud }, DESVIO_1, 4);
        await recorrer(sK1, id, DESVIO_1, DESVIO_2, 4);
        await recorrer(sK1, id, DESVIO_2, { lat: b.latitud, lng: b.longitud }, 4);
        // Un ping ATRASADO y lejos: no tiene que restar tiempo ni sumar el zigzag.
        antesDesordenado = await acumuladoDe(id);
        await ping(sK1, id, AVELLANEDA, { ts: ultimoTs.get(id) - 30_000, espera: 1500 });
      },
    });
    const despuesDesordenado = await acumuladoDe(id);
    await recorrer(sK1, id, DESTINO, DESTINO, 2);
    const acumulado = await acumuladoDe(id);
    const s = await salir(K1, id);
    const v = await viajeDb(id);
    const d = v.precio_medido_desglose;
    paso(
      'CASO 8a: precio medido v2 = precio_real, fuente GPS, recalculable con el snapshot',
      s.status === 200 && v.estado === 'FINALIZADO' && v.precio_medido === v.precio_real && d?.version === 2 && d.entradas.fuente_km === 'GPS' &&
        calcularPrecioV2(d.entradas, v.precio_parametros.parametros).total === v.precio_medido && d.factura_a === true,
      `${v.precio_medido} fuente=${d?.entradas?.fuente_km} km=${d?.entradas?.km_ida}`
    );
    const horasEsperadas = (ms(v.fecha_corte_precio) - ms(ps[0].llegada_real)) / HORA;
    paso('CASO 8b: horas medidas = reloj desde la llegada a la parada 1 hasta el corte', Math.abs(d?.entradas?.horas - horasEsperadas) < 1e-6, `${d?.entradas?.horas} vs ${horasEsperadas}`);
    paso(
      'CASO 8c: el ping atrasado se ignoro (ni tiempo ni distancia cambiaron)',
      antesDesordenado && despuesDesordenado && despuesDesordenado.ultima_actualizacion === antesDesordenado.ultima_actualizacion &&
        despuesDesordenado.distancia_km === antesDesordenado.distancia_km && despuesDesordenado.tiempo_horas === antesDesordenado.tiempo_horas,
      `${antesDesordenado?.distancia_km} → ${despuesDesordenado?.distancia_km}`
    );
    const psFin = await paradasDb(id);
    paso(
      'CASO 8d: distancia GPS del tramo en la parada 2 (una escritura; null en la 1); calidad del GPS persistida',
      psFin[0].distancia_real_km === null && psFin[1].distancia_real_km > 0.5 && psFin[1].distancia_real_km <= v.distancia_real_km + 1e-9 &&
        v.gps_puntos === acumulado.pings && v.gps_puntos >= 17 && Number.isInteger(v.gps_mayor_hueco_segundos),
      `tramo=${psFin[1].distancia_real_km} total=${v.distancia_real_km} pings=${v.gps_puntos} hueco=${v.gps_mayor_hueco_segundos}`
    );
    paso('CASO 8e: la respuesta de salir de la ultima NO trae precio (si remito_url)', !('precio_real' in s.data) && Boolean(s.data.remito_url), JSON.stringify(Object.keys(s.data)));
    const finPyme = await esperarEvento(sP1, 'viaje:finalizado', id, 5000);
    const finChofer = await esperarEvento(sK1, 'viaje:finalizado', id, 5000);
    paso(
      'CASO 8f: viaje:finalizado a la PyME con precio, desglose v2 y precio_pagado_pendiente; al chofer sin precio',
      finPyme?.precio_real === v.precio_medido && finPyme.desglose?.version === 2 && finPyme.version_precio === 2 && finPyme.precio_pagado_pendiente === true &&
        finChofer && !('precio_real' in finChofer) && !('desglose' in finChofer) && !('precio_pagado_pendiente' in finChofer) && finChofer.cerrado_por === 'CHOFER',
      `pyme=${finPyme?.precio_real} chofer=${Object.keys(finChofer ?? {}).join(',')}`
    );
    const h = await historialPrecio(id);
    paso('CASO 8g: historial CREAR + CIERRE (con el chofer como actor)', h.map((x) => x.motivo).join(',') === 'CREAR,CIERRE' && h[1].total === v.precio_medido && h[1].id_usuario === K1.id_usuario, h.map((x) => x.motivo).join(','));
    const rem = await remitoSinMontos(id, v.precio_medido);
    paso('CASO 8h: el remito v2 no tiene montos (control: la direccion si)', rem.ok, rem.detalle);
    paso('CASO 8i: Redis limpio', (await keysGps(id)) === 0, String(await keysGps(id)));
    ctx.finalizados.push(id);
  }

  // CASO 9 -------------------------------------------------------------------
  if (correr(9) || correr(15) || correr(16)) {
    titulo('CASO 9: cierre CHOFER sin GPS → distancia estimada');
    const id = await iniciado(ctx, K1);
    await llevarAUltima(K1, id);
    await okOFalla(salir(K1, id), 'salir de la ultima');
    const v = await viajeDb(id);
    const e = v.precio_medido_desglose?.entradas;
    paso(
      'CASO 9: sin pings → fuente ESTIMADA, km = los estimados (nunca 0), gps_puntos 0',
      v.precio_medido > 0 && e?.fuente_km === 'ESTIMADA' && Math.abs(e.km_ida - v.precio_parametros.entradas.km_ida) < 1e-9 && e.km_ida > 0 &&
        v.gps_puntos === 0 && v.gps_mayor_hueco_segundos === null && v.distancia_real_km === null,
      `${v.precio_medido} km=${e?.km_ida} fuente=${e?.fuente_km}`
    );
    ctx.finalizados.push(id);
  }

  // CASO 10 ------------------------------------------------------------------
  if (correr(10) || correr(15)) {
    titulo('CASO 10: cierre ORGANIZACION');
    const id = await iniciado(ctx, K1);
    await llevarAUltima(K1, id, { peonHoras: 0.0005 });
    await esperar(2500);
    const r = await finalizar(P1, A, id);
    const v = await viajeDb(id);
    paso(
      'CASO 10: FINALIZADO por la PyME con precio medido v2 (precio_real en la respuesta de la PyME) y fila CIERRE',
      r.status === 200 && r.data.precio_real === v.precio_medido && v.cerrado_por === 'ORGANIZACION' && v.precio_medido_desglose?.version === 2 &&
        (await historialPrecio(id)).some((h) => h.motivo === 'CIERRE' && h.id_usuario === P1.id_usuario),
      r2s(r)
    );
    ctx.finalizados.push(id);
  }

  // CASO 12 ------------------------------------------------------------------
  if (correr(12)) {
    titulo('CASO 12: cancelacion en curso');
    const id = await iniciado(ctx, K1);
    await recorrer(sK1, id, ORIGEN, ORIGEN, 3);
    const r = await cancelarPyme(P1, A, id);
    const v = await viajeDb(id);
    const h = await historialPrecio(id);
    const parcial = h.find((x) => x.motivo === 'CANCELACION_EN_CURSO');
    paso(
      'CASO 12: precio parcial SOLO en el historial (precio_real null), con fallback parcial y calidad GPS',
      r.status === 200 && v.estado === 'CANCELADO' && v.precio_real === null && v.precio_medido === null && parcial?.version === 2 &&
        parcial.total > 0 && parcial.desglose.entradas.fuente_km === 'ESTIMADA_PARCIAL' && parcial.id_usuario === P1.id_usuario && v.gps_puntos === 3,
      `${parcial?.total} ${parcial?.desglose?.entradas?.fuente_km} pings=${v.gps_puntos}`
    );
  }

  // CASO 13 ------------------------------------------------------------------
  if (correr(13)) {
    titulo('CASO 13: viaje con version_precio null → cierre v1');
    const { Prisma } = await import('@prisma/client');
    const id = await iniciado(ctx, K1);
    // Como lo dejaria el codigo viejo de main: sin version ni snapshot, tarifas v1.
    await prisma.viaje.update({
      where: { id_viaje: id },
      data: { version_precio: null, precio_parametros: Prisma.DbNull, tarifa_hora: 3500, tarifa_km: null, zona: 'CABA' },
    });
    await recorrer(sK1, id, ORIGEN, ORIGEN, 2);
    await llevarAUltima(K1, id);
    await recorrer(sK1, id, DESTINO, DESTINO, 2);
    const viaje = await prisma.viaje.findUnique({ where: { id_viaje: id }, include: { paradas: true } });
    const esperado = precioDesdeMediciones(viaje, await acumuladoDe(id)).precio_real;
    await okOFalla(salir(K1, id), 'salir de la ultima');
    const v = await viajeDb(id);
    const fin = await esperarEvento(sP1, 'viaje:finalizado', id, 5000);
    const h = await historialPrecio(id);
    paso(
      'CASO 13a: se cierra con la v1 (precio_real = formula vieja), sin precio_medido, desglose v1 en el evento',
      Math.abs(v.precio_real - esperado) < 1e-6 && v.precio_medido === null && fin?.version_precio === 1 && 'precio_por_tiempo' in (fin?.desglose ?? {}) &&
        h.at(-1)?.version === 1 && h.at(-1)?.motivo === 'CIERRE',
      `${v.precio_real} vs ${esperado}`
    );
    const rem = await remitoSinMontos(id, v.precio_real);
    paso('CASO 13b: el remito de un viaje interno v1 tampoco lleva montos', rem.ok, rem.detalle);
  }

  // CASO 14 ------------------------------------------------------------------
  if (correr(14)) {
    titulo('CASO 14: costo en vivo (REST y costo:actualizar)');
    // MIXTO v1: antes el socket cobraba tiempo total + km total.
    const id = await iniciado(ctx, K3, [ORIGEN, AVELLANEDA]);
    await prisma.viaje.update({
      where: { id_viaje: id },
      data: { version_precio: null, precio_parametros: (await import('@prisma/client')).Prisma.DbNull, tarifa_hora: 3500, tarifa_km: 150, zona: 'MIXTO' },
    });
    const sK3 = await espia(BASE, K3.token);
    ctx.sK3 = sK3;
    await esperar(500);
    await ping(sK3, id, ORIGEN, { espera: 300 });
    await ping(sK3, id, { lat: -34.62, lng: -58.375 }, { ts: tsSiguiente(id, { conCosto: true }), espera: 1500 });
    await esperarEvento(sP1, 'costo:actualizar', id, 4000);
    // El ULTIMO (el primer ping tambien puede haber emitido, con el acumulado en 0).
    const ev = eventosDe(sP1, 'costo:actualizar', id).at(-1);
    const rest = await api('GET', `/api/organizaciones/${A}/viajes/${id}/costo-acumulado`, null, P1.token);
    const viaje = await prisma.viaje.findUnique({ where: { id_viaje: id }, include: { paradas: true } });
    const formula = precioDesdeMediciones(viaje, await acumuladoDe(id)).precio_real;
    paso(
      'CASO 14a: MIXTO v1: costo:actualizar = REST = la formula del cierre (prorrateada, sin doble cobro)',
      ev && Math.abs(ev.precio_acumulado - formula) < 1e-6 && Math.abs(rest.data.precio_acumulado - formula) < 1e-6 && ev.version_precio === 1 &&
        ev.desglose.fraccion_caba === 0.5,
      `socket=${ev?.precio_acumulado} rest=${rest.data.precio_acumulado} formula=${formula}`
    );
    const legacy = await apiK('GET', `/api/viajes/${id}/costo-acumulado`, null, K3);
    paso('CASO 14b: costo-acumulado legacy de un viaje interno → 403 al chofer', legacy.status === 403, r2s(legacy));
    paso('CASO 14c: el chofer no recibio costo:actualizar', eventosDe(sK3, 'costo:actualizar', id).length === 0, '');
    await cancelarPyme(P1, A, id);

    // v2 en vivo: reloj desde la llegada a la parada 1 + fallback de km.
    const id2 = await iniciado(ctx, K3);
    await ping(sK3, id2, ORIGEN, { ts: tsSiguiente(id2, { conCosto: true }), espera: 1500 });
    const ev2 = await esperarEvento(sP1, 'costo:actualizar', id2, 4000);
    const rest2 = await api('GET', `/api/organizaciones/${A}/viajes/${id2}/costo-acumulado`, null, P1.token);
    paso(
      'CASO 14d: v2 en vivo: socket y REST con desglose v2, fuente ESTIMADA (pocos pings), minimo del servicio',
      ev2?.version_precio === 2 && ev2.desglose?.version === 2 && ev2.desglose.entradas.fuente_km === 'ESTIMADA' && rest2.data.version_precio === 2 &&
        rest2.data.precio_acumulado >= ev2.precio_acumulado && ev2.precio_acumulado >= 84000,
      `socket=${ev2?.precio_acumulado} rest=${rest2.data.precio_acumulado}`
    );
    await cancelarPyme(P1, A, id2);
  }
}

// CASO 11: cierre automatico incompleto (server 3972).
async function casoAutomatico(ctx) {
  titulo(`CASO 11: cierre AUTOMATICO incompleto (fin del dia = inicio + ${FIN_DIA_TEST_SEGUNDOS} s)`);
  await conServer({ ...ENV_BASE, CIERRE_FIN_DIA_SEGUNDOS_TEST: String(FIN_DIA_TEST_SEGUNDOS) }, PUERTO_TIMER, async (base, leerLog) => {
    const anterior = BASE;
    BASE = base;
    try {
      const sP = await espia(base, ctx.P1.token);
      const id = await iniciado(ctx, ctx.K2, [ORIGEN, INTERMEDIA, DESTINO]);
      const ps = await paradasDb(id);
      await okOFalla(salir(ctx.K2, id), 'salir de la 1');
      await okOFalla(confirmarParada(ctx.K2, id, ps[1]), 'confirmar la 2');
      await okOFalla(salir(ctx.K2, id), 'salir de la 2');
      const fin = await esperarEvento(sP, 'viaje:finalizado', id, (FIN_DIA_TEST_SEGUNDOS + 15) * 1000);
      const v = await viajeDb(id);
      const e = v.precio_medido_desglose?.entradas;
      paso(
        'CASO 11: incompleto sin GPS → ESTIMADA_PARCIAL con los km de los tramos hasta la ultima llegada',
        fin && v.cerrado_por === 'AUTOMATICO' && e?.fuente_km === 'ESTIMADA_PARCIAL' && Math.abs(e.km_ida - ps[1].distancia_estimada_km) < 1e-9 &&
          e.km_ida < v.precio_parametros.entradas.km_ida && v.precio_medido > 0,
        `km=${e?.km_ida} vs tramo=${ps[1].distancia_estimada_km} total=${v.precio_parametros.entradas.km_ida}`
      );
      ctx.finalizados.push(id);
      sumarLlamadasMaps(leerLog());
    } finally {
      BASE = anterior;
    }
  });
}

// CASO 15 y 16: feedback y dataset.
async function casoFeedback(ctx) {
  const { P1, M1, Q1, A, K1 } = ctx;
  const [f1, f2, f3] = ctx.finalizados;
  if (correr(15)) {
    titulo('CASO 15: feedback del precio pagado');
    if (!f1 || !f2) {
      paso('CASO 15: hacen falta viajes finalizados (casos 8 / 9 / 10)', false, String(ctx.finalizados));
      return;
    }
    const url = (id) => `/api/organizaciones/${A}/viajes/${id}/precio-pagado`;
    const g0 = await api('GET', url(f1), null, P1.token);
    paso('CASO 15a: GET sin feedback → null y pendiente', g0.status === 200 && g0.data.precio_pagado === null && g0.data.precio_pagado_pendiente === true && g0.data.editable === true, r2s(g0));
    const cuerpo = { monto: 250000, incluye_iva: true, monto_peajes: 3000, metodo_pago: 'TRANSFERENCIA', ayudantes_reales: 1, comentario: 'Pagado al chofer' };
    const c1 = await api('PUT', url(f1), cuerpo, M1.token);
    const c2 = await api('PUT', url(f1), { ...cuerpo, monto: 260000 }, P1.token);
    const fila = await prisma.precioPagadoViaje.findUnique({ where: { id_viaje: f1 } });
    paso(
      'CASO 15b: un MIEMBRO crea (201) y el RESPONSABLE actualiza (200, ediciones 1)',
      c1.status === 201 && c1.data.creado === true && c2.status === 200 && c2.data.creado === false && fila.monto === 260000 && fila.ediciones === 1 &&
        fila.id_usuario === P1.id_usuario && c2.data.precio_pagado_pendiente === false,
      `${c1.status}/${c2.status} ediciones=${fila?.ediciones}`
    );
    const invalidos = await Promise.all([
      api('PUT', url(f1), { monto: 0, incluye_iva: true }, P1.token),
      api('PUT', url(f1), { monto: 1000 }, P1.token),
      api('PUT', url(f1), { monto: 200000000, incluye_iva: false }, P1.token),
      api('PUT', url(f1), { monto: 1000, incluye_iva: true, comentario: '' }, P1.token),
    ]);
    paso('CASO 15c: validaciones → 400 en español', invalidos.every((x) => x.status === 400), invalidos.map((x) => `${x.status}:${x.data.error}`).join(' | '));
    const chofer = await apiK('PUT', url(f1), cuerpo, K1);
    const choferGet = await apiK('GET', url(f1), null, K1);
    const otra = await api('PUT', url(f1), cuerpo, Q1.token);
    paso('CASO 15d: el chofer → 403 (leer y escribir); otra PyME → 403', chofer.status === 403 && choferGet.status === 403 && otra.status === 403, `${chofer.status}/${choferGet.status}/${otra.status}`);

    // Upsert concurrente: dos PUT a la vez nunca crean dos filas.
    const rondas = [];
    let ok = true;
    for (let i = 0; i < RONDAS; i++) {
      await prisma.precioPagadoViaje.deleteMany({ where: { id_viaje: f2 } });
      const rs = await Promise.all([api('PUT', url(f2), { monto: 1000 + i, incluye_iva: false }, P1.token), api('PUT', url(f2), { monto: 2000 + i, incluye_iva: true }, M1.token)]);
      const n = await prisma.precioPagadoViaje.count({ where: { id_viaje: f2 } });
      const f = await prisma.precioPagadoViaje.findUnique({ where: { id_viaje: f2 } });
      rondas.push(`${statuses(rs)} filas=${n} ed=${f?.ediciones}`);
      if (statuses(rs) !== '200,201' || n !== 1 || f.ediciones !== 1) ok = false;
    }
    paso(`CASO 15e: ${RONDAS} rondas de dos PUT simultaneos → 201 + 200, UNA fila, ediciones 1`, ok, rondas.join(' | '));

    // Viaje no finalizado y ventana vencida.
    const vivo = await crearOk(P1, A, cuerpoViaje(K1.id_conductor, [ORIGEN, DESTINO]));
    const noFin = await api('PUT', url(vivo.data.id_viaje), cuerpo, P1.token);
    paso('CASO 15f: un viaje no finalizado → 400', noFin.status === 400 && /finalizado/.test(noFin.data.error), r2s(noFin));
    await cancelarPyme(P1, A, vivo.data.id_viaje);
    if (f3) {
      const original = (await viajeDb(f3)).fecha_corte_precio;
      await prisma.viaje.update({ where: { id_viaje: f3 }, data: { fecha_corte_precio: new Date(Date.now() - 40 * 86_400_000) } });
      const vencido = await api('PUT', url(f3), cuerpo, P1.token);
      const pend = await api('GET', `/api/organizaciones/${A}/viajes/precio-pagado/pendientes?limit=200`, null, P1.token);
      paso(
        'CASO 15g: pasada la ventana → 409 y deja de estar en pendientes',
        vencido.status === 409 && /plazo/.test(vencido.data.error) && !pend.data.viajes.some((x) => x.id_viaje === f3),
        r2s(vencido)
      );
      await prisma.viaje.update({ where: { id_viaje: f3 }, data: { fecha_corte_precio: original } });
    }

    // Pendientes, lista y detalle.
    const pend = await api('GET', `/api/organizaciones/${A}/viajes/precio-pagado/pendientes?limit=1&page=1`, null, P1.token);
    const ids = new Set(ctx.finalizados.filter((x) => x !== f1 && x !== f2));
    const todos = await api('GET', `/api/organizaciones/${A}/viajes/precio-pagado/pendientes?limit=200`, null, P1.token);
    paso(
      'CASO 15h: pendientes paginado, con lo minimo para pedirlo; sin los que ya tienen feedback',
      pend.status === 200 && pend.data.limit === 1 && pend.data.viajes.length <= 1 && pend.data.total >= ids.size &&
        !todos.data.viajes.some((x) => x.id_viaje === f1 || x.id_viaje === f2) &&
        todos.data.viajes.every((x) => 'origen' in x && 'destino' in x && 'rango' in x && 'precio_estimado' in x),
      `total=${pend.data.total} ${JSON.stringify(pend.data.viajes[0] ?? null).slice(0, 160)}`
    );
    const det = await api('GET', `/api/organizaciones/${A}/viajes/${f1}`, null, P1.token);
    const lista = await api('GET', `/api/organizaciones/${A}/viajes?grupo=historial`, null, P1.token);
    const enLista = lista.data.find?.((x) => x.id_viaje === f1);
    paso(
      'CASO 15i: detalle y lista de la PyME con precio_pagado (objeto) y precio_pagado_pendiente',
      det.data.precio_pagado?.monto === 260000 && det.data.precio_pagado_pendiente === false && enLista?.precio_pagado?.monto === 260000,
      JSON.stringify(det.data.precio_pagado)
    );
  }

  if (correr(16)) {
    titulo('CASO 16: dataset admin');
    let admin;
    try {
      const { email, password } = credencialesAdminTest();
      admin = await loginFirebase(email, password);
    } catch (e) {
      paso('CASO 16: dataset (necesita TEST_ADMIN_PASSWORD)', false, e.message);
      return;
    }
    const desde = INICIO_TEST.toISOString();
    const json = await api('GET', `/api/admin/precios/dataset?desde=${encodeURIComponent(desde)}&limit=1000`, null, admin);
    const fila = json.data.viajes?.find((x) => x.id_viaje === f1);
    paso(
      'CASO 16a: JSON con lo declarado, lo medido, peajes, estimado, medido, pagado y parametros',
      json.status === 200 && fila && fila.servicio === 'LIVIANO' && fila.medido_total > 0 && fila.estimado_total > 0 && fila.fuente_km === 'GPS' &&
        fila.peajes_google === null && fila.parametros?.PRECIO_KM_IDA === 4500 && fila.gps_puntos > 0 && (correr(15) ? fila.pagado_monto === 260000 : true),
      r2s(json).slice(0, 200)
    );
    const csv = await api('GET', `/api/admin/precios/dataset?desde=${encodeURIComponent(desde)}&formato=csv&limit=1000`, null, admin);
    const texto = csv.data.texto ?? csv.crudo;
    paso(
      'CASO 16b: CSV con encabezado y la fila del viaje',
      csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type')) && texto.startsWith('id_viaje,id_organizacion') &&
        texto.split('\r\n').some((l) => l.startsWith(`${f1},`)),
      `${csv.status} ${texto.slice(0, 80)}`
    );
    const noAdmin = await api('GET', '/api/admin/precios/dataset', null, P1.token);
    paso('CASO 16c: un no-admin → 403', noAdmin.status === 403, r2s(noAdmin));
  }
}

// CASO 17: el chofer no recibe precios ni datos personales.
async function casoChofer(ctx) {
  titulo('CASO 17: el chofer no ve precios ni datos personales');
  const { K1, K2, sK1, sK2, P1 } = ctx;

  // Las lecturas REST del chofer (lista, detalle, GET /api/viajes/:id).
  const id = ctx.finalizados[0];
  if (id) {
    await apiK('GET', '/api/choferes/viajes?grupo=historial', null, K1);
    await apiK('GET', `/api/choferes/viajes/${id}`, null, K1);
    const legacy = await apiK('GET', `/api/viajes/${id}`, null, K1);
    const nuevo = await apiK('GET', `/api/choferes/viajes/${id}`, null, K1);
    const sinRuta = (o) => ({ ...o, ruta_planeada: null });
    paso(
      'CASO 17a: GET /api/viajes/:id de un interno = GET /api/choferes/viajes/:id (misma forma, sin cliente ni creador)',
      legacy.status === 200 && JSON.stringify(Object.keys(sinRuta(legacy.data)).sort()) === JSON.stringify(Object.keys(sinRuta(nuevo.data)).sort()) &&
        !('cliente' in legacy.data) && !('creador' in legacy.data) && !('precio_real' in legacy.data),
      JSON.stringify(Object.keys(legacy.data)).slice(0, 200)
    );
  }

  // Server 3973 con el marketplace PRENDIDO: el chofer pasa por todos los caminos
  // que unen salas (pool al conectarse, viaje:aceptar) y aun asi no recibe precios.
  await conServer({ ...ENV_BASE, MARKETPLACE_HABILITADO: 'true' }, PUERTO_MARKET, async (base, leerLog) => {
    const anterior = BASE;
    BASE = base;
    try {
      const sK = await espia(base, K2.token);
      const sP = await espia(base, P1.token);
      await esperar(800);
      const idM = await iniciado(ctx, K2);
      sK.socket.emit('viaje:aceptar', { id_viaje: idM });
      await esperar(1200);
      const salasK = await (async () => {
        const v = await viajeDb(idM);
        return v.estado;
      })();
      await ping(sK, idM, ORIGEN, { ts: tsSiguiente(idM, { conCosto: true }), espera: 1500 });
      await llevarAUltima(K2, idM);
      await ping(sK, idM, DESTINO, { ts: tsSiguiente(idM, { conCosto: true }), espera: 1500 });
      await okOFalla(salir(K2, idM), 'salir de la ultima');
      await esperar(1500);
      const costoPyme = eventosDe(sP, 'costo:actualizar', idM);
      const finPyme = eventosDe(sP, 'viaje:finalizado', idM)[0];
      paso(
        'CASO 17c: con el marketplace prendido: viaje:aceptar no lo toma; la PyME SI recibe costo y finalizado con precio, el chofer NO',
        salasK === 'CARGANDO' && costoPyme.length > 0 && finPyme?.precio_real > 0 && eventosDe(sK, 'costo:actualizar', idM).length === 0 &&
          !('precio_real' in (eventosDe(sK, 'viaje:finalizado', idM)[0] ?? {})),
        `estado=${salasK} costoPyme=${costoPyme.length} finPyme=${finPyme?.precio_real}`
      );
      for (const e of sK.eventos) recibidoPorChofer.push({ canal: `socket 3973 ${e.ev}`, data: e.d, propio: K2 });
      sumarLlamadasMaps(leerLog());
    } finally {
      BASE = anterior;
    }
  });

  // Chequeo RECURSIVO de todo lo que recibieron los choferes (REST + sockets).
  for (const [esp, k] of [[sK1, K1], [sK2, K2], [ctx.sK3, ctx.K3]]) {
    for (const e of esp?.eventos ?? []) recibidoPorChofer.push({ canal: `socket ${e.ev}`, data: e.d, propio: k });
  }
  const malas = [];
  for (const { canal, data, propio } of recibidoPorChofer) {
    for (const v of violaciones(data, propio)) malas.push(`${canal}: ${v}`);
  }
  paso(
    `CASO 17b: ${recibidoPorChofer.length} respuestas y eventos del chofer sin claves de precio / tarifa / peaje ni email / dni / telefono / firebase_uid ajenos`,
    recibidoPorChofer.length > 20 && malas.length === 0,
    malas.slice(0, 8).join(' | ')
  );
}

// -- Main ---------------------------------------------------------------------

function limpiarRestos() {
  return restos({ solo: ['-pv2-'], borrarTodo: process.argv.includes('--borrar') });
}

async function limpiar() {
  for (const s of sockets) s.disconnect();
  const reg = crearRegistro(`-pv2-${S}-`);
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
  console.log('║        TEST PRECIO V2 (viajes internos)      ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  if (SOLO.length > 0) console.log(`  (solo los casos ${SOLO.join(', ')})\n`);
  if (!process.env.INVITACION_SECRETO) throw new Error('Falta INVITACION_SECRETO en el .env local');

  let limpio = false;
  try {
    await conServer(ENV_BASE, PUERTO, async (base, leerLog) => {
      BASE = base;
      titulo('SETUP');
      const [P1, M1, Q1] = await Promise.all([nuevoUsuario('cliente', 'Pym'), nuevoUsuario('cliente', 'Mie'), nuevoUsuario('cliente', 'Otra')]);
      const [K1, K2, K3] = await Promise.all([1, 2, 3].map((n) => nuevoUsuario('conductor', `Cho${n}`)));
      const A = await crearOrgOk(P1, `PyME Precio ${S}`, cuitValido(1));
      const B = await crearOrgOk(Q1, `PyME Otra ${S}`, cuitValido(2));
      await invitarYCanjear(P1, A, 'MIEMBRO', M1);
      const veh = new Map();
      for (const k of [K1, K2, K3]) {
        veh.set(k.id_conductor, await vehiculoOk(k));
        await invitarYCanjear(P1, A, 'CHOFER', k);
      }
      const [sP1, sK1, sK2] = await Promise.all([P1, K1, K2].map((u) => espia(base, u.token)));
      await esperar(1000);
      console.log(`  ${nUsuario} usuarios, PyMEs ${A} y ${B}, sockets conectados`);
      const ctx = { P1, M1, Q1, A, B, K1, K2, K3, veh, sP1, sK1, sK2, finalizados: [] };
      await casos(ctx);
      if (correr(11) || correr(15) || correr(16)) await casoAutomatico(ctx);
      if (correr(15) || correr(16)) await casoFeedback(ctx);
      if (correr(17)) await casoChofer(ctx);
      sumarLlamadasMaps(leerLog());
    });
  } finally {
    try {
      limpio = await limpiar();
    } catch (e) {
      console.error('  ⚠️  la limpieza fallo:', e.message);
    }
  }
  paso('LIMPIEZA: no quedo nada de lo creado por el test', limpio, '');

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
