// Test de IDENTIDAD (Paso 1): PyMEs, miembros, invitaciones y vinculo con
// choferes.
//
// NO pega contra :3000: levanta servers efimeros propios (_server-efimero.js).
// El principal (3501) corre con INVITACION_INTENTOS_MAX alto porque TODOS los
// canjes del test salen de la misma IP (localhost) y el limite por IP los
// cortaria a los 5. El rate limit, la falta de secreto y Redis caido se prueban
// cada uno en su propio server (3502-3504) con el env que corresponde.
//
// Casos:
//   1. Registro de CLIENTE sin empresa; huerfano sin acceso a la PyME (403).
//   2. Crear PyME: ok, sin nombre, CUIT formato / digito, CUIT repetido,
//      CONDUCTOR, usuario que ya tiene PyME.
//   3. Invitaciones: permisos por tipo, el codigo aparece UNA vez, en la base
//      solo queda el hash, revocar.
//   4. Canje: ok (con minusculas y espacios); reusado / vencido / revocado /
//      inexistente / tipo cruzado -> respuesta IDENTICA; ya tiene PyME -> su
//      error explicito y el codigo no se consume.
//   5. Editar la PyME: responsable ok, miembro 403, CUIT repetido / invalido.
//   6. Choferes: vinculado a dos PyMEs, ninguna ve el vinculo de la otra,
//      desvincular desde los dos lados, volver a vincular.
//   7. Roles: promover, degradar, eliminar, irse; ultimo responsable 409 en los
//      tres caminos; volver a entrar a la misma PyME.
//   8. Perfil (/me): CLIENTE con PyME, huerfano, CONDUCTOR con lista.
//   9. Concurrencia: el mismo codigo canjeado por dos usuarios a la vez.
//  10. Concurrencia: los dos unicos responsables degradandose / yendose /
//      eliminandose a la vez.
//  11. Concurrencia: un usuario con dos codigos MIEMBRO a la vez, y creando una
//      PyME mientras canjea.
//  12. Rate limit (server propio, max 3): por usuario y por IP -> 429.
//  13. Sin INVITACION_SECRETO (server propio): 503, el resto anda.
//  14. Redis caido (server propio): el canje pasa y no se cuelga.
//
// Acepta numeros de caso para correr solo esos (el setup corre siempre):
//   node scripts/test-identidad.js 9 10 11
// Sirve para el protocolo de reversion (sacar un lock y ver el caso en rojo).
//
// LIMPIEZA: borra TODO lo que crea (PyMEs, membresias, invitaciones, vinculos,
// vehiculos, usuarios en la DB y en Firebase, keys de rate limit en Redis) y al
// final verifica que no quedo nada. La DB esta compartida con produccion.
import prisma from '../src/config/prisma.js';
import redis from '../src/config/redis.js';
import admin from '../src/config/firebase.js';
import { conServer } from './_server-efimero.js';

const FIREBASE_KEY = 'AIzaSyDpWEEvdenhCI6cpSvG4Kj3qnITIFDYn04';
const PUERTO = 3501;
const RONDAS = 5;

// RESERVA_BARRIDO_ARRANQUE=0: el server efimero no tiene por que barrer
// reservas reales de la DB compartida.
const ENV_BASE = { RESERVA_BARRIDO_ARRANQUE: '0', INVITACION_INTENTOS_MAX: '1000' };

const SOLO = process.argv.slice(2).map(Number).filter(Number.isFinite);
const correr = (n) => SOLO.length === 0 || SOLO.includes(n);

const stamp = Date.now();
const S = String(stamp);
const PASS = 'test123456';
const LIC = '2030-01-01T00:00:00.000Z';

// Todo lo que se crea, para la limpieza.
const emailsCreados = [];
const orgsCreadas = new Set();

// -- Helpers ----------------------------------------------------------------

const pasos = [];
function paso(nombre, ok, detalle = '') {
  pasos.push({ nombre, ok, detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle ? '  →  ' + detalle : ''}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const titulo = (t) => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 60 - t.length))}\n`);

async function getToken(email, password = PASS) {
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

let BASE = `http://localhost:${PUERTO}`;

async function api(method, path, body, token, base = BASE) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
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

const r2s = (r) => `${r.status} ${r.crudo.slice(0, 160)}`;

// CUIT valido derivado del stamp: 30 + 8 digitos + digito verificador. Si el
// digito diera 10 (invalido) se corre el numero.
const MULT = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
function cuitValido(n) {
  for (let k = 0; ; k++) {
    const base = '30' + String((Number(S.slice(-6)) * 100 + n * 7 + k) % 1e8).padStart(8, '0');
    const suma = MULT.reduce((a, m, i) => a + m * Number(base[i]), 0);
    const dv = 11 - (suma % 11);
    if (dv === 10) continue;
    return base + (dv === 11 ? 0 : dv);
  }
}
const conGuiones = (c) => `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`;
function cuitDigitoMalo(c) {
  return c.slice(0, 10) + ((Number(c[10]) + 1) % 10);
}

let nUsuario = 0;
// Registra un usuario nuevo (CLIENTE o CONDUCTOR) y devuelve { email, token, id_usuario, ... }.
async function nuevoUsuario(tipo, etiqueta, extra = {}) {
  nUsuario++;
  const email = `${etiqueta}-idn-${S}-${nUsuario}@test.com`.toLowerCase();
  const dni = S.slice(-7) + String(nUsuario).padStart(2, '0');
  const datos = {
    nombre: etiqueta,
    apellido: 'Idn',
    dni,
    email,
    contrasena: PASS,
    telefono: `+54911${S.slice(-4)}${String(nUsuario).padStart(4, '0')}`,
    ...(tipo === 'conductor' ? { nro_licencia: `LID${nUsuario}${S.slice(-4)}`, licencia_vencimiento: LIC } : {}),
    ...extra,
  };
  emailsCreados.push(email);
  const endpoint = tipo === 'cliente' ? '/api/auth/registro-cliente' : '/api/auth/registro-conductor';
  const r = await api('POST', endpoint, datos);
  if (r.status !== 201) throw new Error(`registro ${tipo} ${email} fallo: ${r2s(r)}`);
  const token = await getToken(email);
  const u = await prisma.usuario.findUnique({ where: { email }, include: { conductor: true } });
  return { email, token, id_usuario: u.id_usuario, id_conductor: u.conductor?.id_conductor ?? null, nombre: etiqueta, registro: r };
}

async function nuevosUsuarios(tipo, etiqueta, cantidad) {
  const out = [];
  // De a 4 en paralelo: Firebase no se queja y el setup no tarda una eternidad.
  for (let i = 0; i < cantidad; i += 4) {
    const lote = await Promise.all(
      Array.from({ length: Math.min(4, cantidad - i) }, (_, j) => nuevoUsuario(tipo, `${etiqueta}${i + j + 1}`))
    );
    out.push(...lote);
  }
  return out;
}

const crearOrg = (u, body) => api('POST', '/api/organizaciones', body, u.token);
async function crearOrgOk(u, nombre, cuit) {
  const r = await crearOrg(u, { nombre, cuit });
  if (r.status !== 201) throw new Error(`crear PyME ${nombre} fallo: ${r2s(r)}`);
  orgsCreadas.add(r.data.id_organizacion);
  return r.data;
}
const invitar = (u, idOrg, tipo) => api('POST', `/api/organizaciones/${idOrg}/invitaciones`, { tipo }, u.token);
async function invitarOk(u, idOrg, tipo) {
  const r = await invitar(u, idOrg, tipo);
  if (r.status !== 201) throw new Error(`invitar ${tipo} en ${idOrg} fallo: ${r2s(r)}`);
  return r.data;
}
const canjear = (u, codigo, base) => api('POST', '/api/invitaciones/canjear', { codigo }, u.token, base);
const me = (u) => api('GET', '/api/auth/me', null, u.token);
const setRol = (actor, idOrg, idUsuario, rol) =>
  api('PUT', `/api/organizaciones/${idOrg}/miembros/${idUsuario}/rol`, { rol }, actor.token);
const eliminar = (actor, idOrg, idUsuario) => api('DELETE', `/api/organizaciones/${idOrg}/miembros/${idUsuario}`, null, actor.token);
const salir = (u, idOrg) => api('POST', `/api/organizaciones/${idOrg}/salir`, null, u.token);

const responsablesActivos = (id_organizacion) =>
  prisma.miembroOrganizacion.count({ where: { id_organizacion, activo: true, rol: 'RESPONSABLE' } });
const membresiasActivas = (id_usuario) => prisma.miembroOrganizacion.count({ where: { id_usuario, activo: true } });

// Entra a la PyME con un codigo nuevo de MIEMBRO y, si se pide, queda responsable.
async function sumarMiembro(responsable, idOrg, u, comoResponsable = false) {
  const inv = await invitarOk(responsable, idOrg, 'MIEMBRO');
  const r = await canjear(u, inv.codigo);
  if (r.status !== 200) throw new Error(`sumarMiembro fallo: ${r2s(r)}`);
  if (comoResponsable) {
    const p = await setRol(responsable, idOrg, u.id_usuario, 'RESPONSABLE');
    if (p.status !== 200) throw new Error(`promover fallo: ${r2s(p)}`);
  }
}

const statuses = (rs) => rs.map((r) => r.status).sort((a, b) => a - b).join(',');

// -- Limpieza -----------------------------------------------------------------

async function borrarKeysRateLimit(ids = []) {
  if (redis.status !== 'ready') return;
  try {
    const claves = ids.map((id) => `invitacion:canje:usuario:${id}`);
    let cursor = '0';
    do {
      const [sig, encontradas] = await redis.scan(cursor, 'MATCH', 'invitacion:canje:ip:*', 'COUNT', 500);
      cursor = sig;
      // Solo las IPs de loopback: las que genera este test desde localhost.
      claves.push(...encontradas.filter((k) => /127\.0\.0\.1|::1$/.test(k)));
    } while (cursor !== '0');
    if (claves.length > 0) await redis.del(...claves);
  } catch (e) {
    console.error('  ⚠️  no se pudieron borrar las keys de rate limit:', e.message);
  }
}

async function limpiar() {
  titulo('LIMPIEZA');
  const usuarios = await prisma.usuario.findMany({
    where: { email: { in: emailsCreados } },
    include: { conductor: true, membresias: { select: { id_organizacion: true } } },
  });
  const idsUsuario = usuarios.map((u) => u.id_usuario);
  const idsConductor = usuarios.map((u) => u.conductor?.id_conductor).filter(Boolean);
  // PyMEs: las que se crearon por API y cualquiera donde haya pasado un usuario
  // del test (p. ej. una creada en una carrera del caso 11).
  for (const u of usuarios) for (const m of u.membresias) orgsCreadas.add(m.id_organizacion);
  const idsOrg = [...orgsCreadas];

  await prisma.vinculoChofer.deleteMany({
    where: { OR: [{ id_organizacion: { in: idsOrg } }, { id_conductor: { in: idsConductor } }] },
  });
  await prisma.invitacion.deleteMany({ where: { id_organizacion: { in: idsOrg } } });
  await prisma.miembroOrganizacion.deleteMany({
    where: { OR: [{ id_organizacion: { in: idsOrg } }, { id_usuario: { in: idsUsuario } }] },
  });
  await prisma.organizacion.deleteMany({ where: { id_organizacion: { in: idsOrg } } });
  await prisma.condicionVehiculo.deleteMany({ where: { vehiculo: { id_conductor: { in: idsConductor } } } });
  await prisma.vehiculo.deleteMany({ where: { id_conductor: { in: idsConductor } } });
  await prisma.conductor.deleteMany({ where: { id_usuario: { in: idsUsuario } } });
  await prisma.cliente.deleteMany({ where: { id_usuario: { in: idsUsuario } } });
  await prisma.usuario.deleteMany({ where: { id_usuario: { in: idsUsuario } } });

  let fbBorrados = 0;
  for (const email of emailsCreados) {
    try {
      const u = await admin.auth().getUserByEmail(email);
      await admin.auth().deleteUser(u.uid);
      fbBorrados++;
    } catch (e) {
      if (e.code !== 'auth/user-not-found') console.error(`  ⚠️  Firebase ${email}: ${e.message}`);
    }
  }
  await borrarKeysRateLimit(idsUsuario);

  const quedanUsuarios = await prisma.usuario.count({ where: { email: { contains: `-idn-${S}-` } } });
  const quedanOrgs = await prisma.organizacion.count({ where: { id_organizacion: { in: idsOrg } } });
  const quedanInv = await prisma.invitacion.count({ where: { id_organizacion: { in: idsOrg } } });
  console.log(
    `  usuarios DB: ${idsUsuario.length} borrados | Firebase: ${fbBorrados} | PyMEs: ${idsOrg.length} | quedan: usuarios=${quedanUsuarios} pymes=${quedanOrgs} invitaciones=${quedanInv}`
  );
  return quedanUsuarios === 0 && quedanOrgs === 0 && quedanInv === 0;
}

// -- Casos --------------------------------------------------------------------

async function casosPrincipales(ctx) {
  const { C1, C2, C3, C4, C5, K1, K2 } = ctx;

  // CASO 1 -------------------------------------------------------------------
  if (correr(1)) {
    titulo('CASO 1: registro sin empresa y huerfano');
    const cli = await prisma.cliente.findUnique({ where: { id_usuario: C3.id_usuario } });
    paso('CASO 1a: registro de CLIENTE sin empresa ni CUIT → 201', C3.registro.status === 201, r2s(C3.registro));
    paso('CASO 1b: los campos legacy quedan en null', cli && cli.cuit === null && cli.nombre_empresa === null, JSON.stringify(cli));
    const r1 = await api('GET', '/api/organizaciones/999999999', null, C3.token);
    paso('CASO 1c: huerfano → GET de una PyME cualquiera = 403', r1.status === 403, r2s(r1));
  }

  // CASO 2 -------------------------------------------------------------------
  const cuitA = cuitValido(1);
  const cuitB = cuitValido(2);
  if (correr(2)) {
    titulo('CASO 2: crear PyME');
    const ok = await crearOrg(C1, { nombre: `PyME A ${S}`, cuit: conGuiones(cuitA), razon_social: 'A SRL', direccion: 'Av. Siempreviva 742' });
    if (ok.status === 201) orgsCreadas.add(ok.data.id_organizacion);
    ctx.A = ok.data;
    paso(
      'CASO 2a: crear ok → 201, RESPONSABLE, TRIAL y CUIT normalizado',
      ok.status === 201 && ok.data.mi_rol === 'RESPONSABLE' && ok.data.estado === 'TRIAL' && ok.data.cuit === cuitA,
      r2s(ok)
    );
    const sinNombre = await crearOrg(C3, { cuit: cuitValido(3) });
    paso('CASO 2b: sin nombre → 400', sinNombre.status === 400 && /nombre/.test(sinNombre.data.error), r2s(sinNombre));
    const formato = await crearOrg(C3, { nombre: 'X', cuit: '30-1234' });
    paso('CASO 2c: CUIT con formato invalido → 400 (formato)', formato.status === 400 && /formato/.test(formato.data.error), r2s(formato));
    const digito = await crearOrg(C3, { nombre: 'X', cuit: cuitDigitoMalo(cuitValido(3)) });
    paso('CASO 2d: CUIT con digito invalido → 400 (digito)', digito.status === 400 && /digito/.test(digito.data.error), r2s(digito));
    // Mismo CUIT que A pero escrito distinto (sin guiones, con espacios).
    const repetido = await crearOrg(C3, { nombre: 'X', cuit: ` ${cuitA.slice(0, 2)} ${cuitA.slice(2)} ` });
    paso('CASO 2e: CUIT repetido (escrito distinto) → 409', repetido.status === 409, r2s(repetido));
    const conductor = await crearOrg(K1, { nombre: 'X', cuit: cuitValido(3) });
    paso('CASO 2f: un CONDUCTOR no puede crear PyME → 403', conductor.status === 403, r2s(conductor));
    const otra = await crearOrg(C1, { nombre: 'Otra', cuit: cuitValido(3) });
    paso('CASO 2g: el que ya tiene PyME no puede crear otra → 409', otra.status === 409 && /Ya perteneces/.test(otra.data.error), r2s(otra));
    const huerfanoA = await api('GET', `/api/organizaciones/${ctx.A.id_organizacion}`, null, C3.token);
    const huerfanoMiembros = await api('GET', `/api/organizaciones/${ctx.A.id_organizacion}/miembros`, null, C3.token);
    const huerfanoInv = await invitar(C3, ctx.A.id_organizacion, 'CHOFER');
    paso(
      'CASO 2h: huerfano → ver / miembros / invitar en una PyME real = 403',
      huerfanoA.status === 403 && huerfanoMiembros.status === 403 && huerfanoInv.status === 403,
      `${huerfanoA.status} ${huerfanoMiembros.status} ${huerfanoInv.status}`
    );
  }
  if (!ctx.A) ctx.A = await crearOrgOk(C1, `PyME A ${S}`, cuitA);
  ctx.B = await crearOrgOk(C4, `PyME B ${S}`, cuitB);
  const A = ctx.A.id_organizacion;
  const B = ctx.B.id_organizacion;

  // CASO 3 + 4 -----------------------------------------------------------------
  // C2 entra a A con un codigo del responsable (es el canje ok del caso 4).
  let invMiembroA;
  if (correr(3) || correr(4)) {
    titulo('CASO 3: invitaciones');
    const crear = await invitar(C1, A, 'MIEMBRO');
    invMiembroA = crear.data;
    paso(
      'CASO 3a: el responsable crea una de MIEMBRO → 201 con codigo XXXXX-XXXXX',
      crear.status === 201 && /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(crear.data.codigo ?? ''),
      r2s(crear)
    );
    const fila = await prisma.invitacion.findUnique({ where: { id_invitacion: invMiembroA.id_invitacion } });
    const enClaro = invMiembroA.codigo.replace('-', '');
    paso(
      'CASO 3b: en la base queda solo el hash (ningun campo contiene el codigo)',
      fila && /^[0-9a-f]{64}$/.test(fila.codigo_hash) && !JSON.stringify(fila).includes(enClaro),
      `hash=${fila?.codigo_hash.slice(0, 12)}…`
    );
    const lista = await api('GET', `/api/organizaciones/${A}/invitaciones`, null, C1.token);
    const item = Array.isArray(lista.data) ? lista.data.find((i) => i.id_invitacion === invMiembroA.id_invitacion) : null;
    paso(
      'CASO 3c: el listado de pendientes la muestra SIN codigo ni hash',
      lista.status === 200 && item && !('codigo' in item) && !('codigo_hash' in item) && !lista.crudo.includes(enClaro) && !lista.crudo.includes(enClaro.slice(0, 5)),
      r2s(lista)
    );

    titulo('CASO 4: canje');
    // Minusculas y espacios: el canje los ignora.
    const ok = await canjear(C2, ` ${invMiembroA.codigo.toLowerCase().replace('-', ' - ')} `);
    paso(
      'CASO 4a: canje ok (minusculas y espacios) → 200, MIEMBRO de A',
      ok.status === 200 && ok.data.organizacion?.id_organizacion === A && ok.data.organizacion?.rol === 'MIEMBRO',
      r2s(ok)
    );

    const noPuede = await invitar(C2, A, 'MIEMBRO');
    paso('CASO 3d: un MIEMBRO no puede crear invitaciones de MIEMBRO → 403', noPuede.status === 403, r2s(noPuede));
    const chofer = await invitar(C2, A, 'CHOFER');
    paso('CASO 3e: un MIEMBRO si crea de CHOFER → 201', chofer.status === 201 && chofer.data.tipo === 'CHOFER', r2s(chofer));
    const invM2 = await invitarOk(C1, A, 'MIEMBRO');
    const revM = await api('DELETE', `/api/organizaciones/${A}/invitaciones/${invM2.id_invitacion}`, null, C2.token);
    paso('CASO 3f: un MIEMBRO no puede revocar una de MIEMBRO → 403', revM.status === 403, r2s(revM));
    const revC = await api('DELETE', `/api/organizaciones/${A}/invitaciones/${chofer.data.id_invitacion}`, null, C2.token);
    paso('CASO 3g: un MIEMBRO si revoca una de CHOFER → 200', revC.status === 200, r2s(revC));
    const revOtra = await api('DELETE', `/api/organizaciones/${A}/invitaciones/${chofer.data.id_invitacion}`, null, C2.token);
    paso('CASO 3h: revocar una que ya no esta pendiente → 409', revOtra.status === 409, r2s(revOtra));

    // Las cinco fallas del codigo tienen que dar EXACTAMENTE la misma respuesta.
    const reusado = await canjear(C5, invMiembroA.codigo);
    const invVencida = await invitarOk(C1, A, 'MIEMBRO');
    await prisma.invitacion.update({
      where: { id_invitacion: invVencida.id_invitacion },
      data: { fecha_vencimiento: new Date(Date.now() - 60000) },
    });
    const vencido = await canjear(C5, invVencida.codigo);
    const invRevocada = await invitarOk(C1, A, 'MIEMBRO');
    await api('DELETE', `/api/organizaciones/${A}/invitaciones/${invRevocada.id_invitacion}`, null, C1.token);
    const revocado = await canjear(C5, invRevocada.codigo);
    const inexistente = await canjear(C5, 'ABCDE-FGHJK');
    const invChofer = await invitarOk(C1, A, 'CHOFER');
    const cruzadoCliente = await canjear(C5, invChofer.codigo);
    const cruzadoConductor = await canjear(K2, invM2.codigo);
    const basura = await canjear(C5, '¡¡nada que ver!!');
    const todas = { reusado, vencido, revocado, inexistente, cruzadoCliente, cruzadoConductor, basura };
    const firmas = new Set(Object.values(todas).map((r) => `${r.status}|${r.crudo}`));
    paso(
      'CASO 4b: reusado / vencido / revocado / inexistente / tipo cruzado (x2) / basura → misma respuesta exacta',
      firmas.size === 1 && reusado.status === 400,
      [...firmas].join(' ‖ ')
    );
    const c5Sigue = await membresiasActivas(C5.id_usuario);
    paso('CASO 4c: ninguno de esos intentos le dio una PyME a nadie', c5Sigue === 0, `membresias C5=${c5Sigue}`);

    const invB = await invitarOk(C4, B, 'MIEMBRO');
    const yaTiene = await canjear(C2, invB.codigo);
    const filaB = await prisma.invitacion.findUnique({ where: { id_invitacion: invB.id_invitacion } });
    paso(
      'CASO 4d: el que ya tiene PyME recibe su error explicito (409) y el codigo NO se consume',
      yaTiene.status === 409 && /Ya perteneces/.test(yaTiene.data.error) && filaB.fecha_uso === null,
      `${r2s(yaTiene)} fecha_uso=${filaB.fecha_uso}`
    );
    const yaTieneBasura = await canjear(C2, 'ZZZZZ-ZZZZZ');
    paso('CASO 4e: el error de estado se chequea ANTES de buscar el codigo (409 aun con codigo inexistente)', yaTieneBasura.status === 409, r2s(yaTieneBasura));
  } else {
    await sumarMiembro(C1, A, C2);
  }

  // CASO 5 -------------------------------------------------------------------
  if (correr(5)) {
    titulo('CASO 5: editar la PyME');
    const ok = await api('PUT', `/api/organizaciones/${A}`, { nombre: `PyME A editada ${S}`, razon_social: 'A Editada SA', direccion: null }, C1.token);
    paso(
      'CASO 5a: el responsable edita → 200',
      ok.status === 200 && ok.data.nombre === `PyME A editada ${S}` && ok.data.razon_social === 'A Editada SA' && ok.data.direccion === null,
      r2s(ok)
    );
    const miembro = await api('PUT', `/api/organizaciones/${A}`, { nombre: 'hack' }, C2.token);
    paso('CASO 5b: un miembro no puede editar → 403', miembro.status === 403, r2s(miembro));
    const repetido = await api('PUT', `/api/organizaciones/${A}`, { cuit: conGuiones(cuitB) }, C1.token);
    paso('CASO 5c: CUIT de otra PyME → 409', repetido.status === 409, r2s(repetido));
    const invalido = await api('PUT', `/api/organizaciones/${A}`, { cuit: cuitDigitoMalo(cuitA) }, C1.token);
    paso('CASO 5d: CUIT invalido → 400', invalido.status === 400, r2s(invalido));
    const mismo = await api('PUT', `/api/organizaciones/${A}`, { cuit: cuitA }, C1.token);
    paso('CASO 5e: re-guardar su PROPIO CUIT no choca consigo misma → 200', mismo.status === 200, r2s(mismo));
    const vacio = await api('PUT', `/api/organizaciones/${A}`, {}, C1.token);
    paso('CASO 5f: body vacio → 400', vacio.status === 400, r2s(vacio));
  }

  // CASO 6 -------------------------------------------------------------------
  if (correr(6)) {
    titulo('CASO 6: choferes y vinculos');
    const patente = `ID${S.slice(-5)}`;
    const veh = await api('POST', '/api/conductores/mis-vehiculos', {
      patente, marca: 'Ford', modelo: 'Transit', anio: 2022, color: 'Blanco', tipo_vehiculo: 'FURGON', condiciones: ['FRAGIL'],
    }, K1.token);
    if (veh.status !== 201) throw new Error(`vehiculo K1 fallo: ${r2s(veh)}`);

    const invA = await invitarOk(C2, A, 'CHOFER'); // un MIEMBRO invita choferes
    const invB = await invitarOk(C4, B, 'CHOFER');
    const enA = await canjear(K1, invA.codigo);
    const enB = await canjear(K1, invB.codigo);
    paso(
      'CASO 6a: el chofer canjea codigos de dos PyMEs → 200 y 200',
      enA.status === 200 && enB.status === 200 && enA.data.organizacion?.id_organizacion === A,
      `${r2s(enA)} | ${enB.status}`
    );
    const mias = await api('GET', '/api/choferes/mis-organizaciones', null, K1.token);
    paso(
      'CASO 6b: el chofer ve el nombre de sus dos PyMEs',
      mias.status === 200 && mias.data.length === 2 && mias.data.every((o) => typeof o.nombre === 'string'),
      r2s(mias)
    );
    const listaA = await api('GET', `/api/organizaciones/${A}/choferes`, null, C1.token);
    const k1EnA = listaA.data?.find?.((c) => c.id_conductor === K1.id_conductor);
    paso(
      'CASO 6c: la PyME ve nombre, telefono y vehiculos (patente + caracteristicas)',
      listaA.status === 200 && k1EnA && k1EnA.telefono && k1EnA.vehiculos?.[0]?.patente === patente && k1EnA.vehiculos[0].condiciones.includes('FRAGIL'),
      r2s(listaA)
    );
    paso(
      'CASO 6d: A no ve que el chofer esta vinculado a B',
      !listaA.crudo.includes(ctx.B.nombre) && !listaA.crudo.includes(`"id_organizacion":${B}`) && !/organizaciones|vinculos/.test(listaA.crudo),
      'ni nombre, ni id, ni lista de vinculos'
    );
    const invA2 = await invitarOk(C1, A, 'CHOFER');
    const yaVinc = await canjear(K1, invA2.codigo);
    const filaA2 = await prisma.invitacion.findUnique({ where: { id_invitacion: invA2.id_invitacion } });
    paso(
      'CASO 6e: ya vinculado a ESA PyME → 409 explicito y el codigo no se consume',
      yaVinc.status === 409 && /Ya estas vinculado/.test(yaVinc.data.error) && filaA2.fecha_uso === null,
      r2s(yaVinc)
    );
    const ajena = await api('GET', `/api/organizaciones/${B}/choferes`, null, C1.token);
    paso('CASO 6f: un miembro de A no puede listar los choferes de B → 403', ajena.status === 403, r2s(ajena));

    // Desvincular desde la PyME (lo hace un MIEMBRO, no hace falta responsable).
    const desdePyme = await api('DELETE', `/api/organizaciones/${A}/choferes/${K1.id_conductor}`, null, C2.token);
    const listaA2 = await api('GET', `/api/organizaciones/${A}/choferes`, null, C1.token);
    const mias2 = await api('GET', '/api/choferes/mis-organizaciones', null, K1.token);
    paso(
      'CASO 6g: desvincular desde la PyME (miembro) → 200; A ya no lo ve; el chofer solo ve B',
      desdePyme.status === 200 && !listaA2.data.some((c) => c.id_conductor === K1.id_conductor) && mias2.data.length === 1 && mias2.data[0].id_organizacion === B,
      `${r2s(desdePyme)} | mias=${JSON.stringify(mias2.data)}`
    );
    const otraVez = await api('DELETE', `/api/organizaciones/${A}/choferes/${K1.id_conductor}`, null, C2.token);
    paso('CASO 6h: desvincular un vinculo que ya no esta activo → 404', otraVez.status === 404, r2s(otraVez));
    const desdeChofer = await api('DELETE', `/api/choferes/mis-organizaciones/${B}`, null, K1.token);
    const mias3 = await api('GET', '/api/choferes/mis-organizaciones', null, K1.token);
    paso('CASO 6i: desvincular desde el chofer → 200 y queda sin PyMEs', desdeChofer.status === 200 && mias3.data.length === 0, `${r2s(desdeChofer)} | ${mias3.crudo}`);
    const sinVinculo = await api('GET', `/api/organizaciones/${A}/choferes`, null, K1.token);
    paso('CASO 6j: un CONDUCTOR no entra a los endpoints de PyME → 403', sinVinculo.status === 403, r2s(sinVinculo));

    const revinc = await canjear(K1, invA2.codigo); // el codigo que no se consumio en 6e
    const filas = await prisma.vinculoChofer.findMany({
      where: { id_organizacion: A, id_conductor: K1.id_conductor },
      orderBy: { id_vinculo: 'asc' },
    });
    const filaB = await prisma.vinculoChofer.findFirst({ where: { id_organizacion: B, id_conductor: K1.id_conductor } });
    paso(
      'CASO 6k: volver a vincularse con un codigo nuevo → 200; fila nueva y la vieja conserva el historial',
      revinc.status === 200 &&
        filas.length === 2 &&
        filas[0].activo === false &&
        filas[0].desvinculado_por === 'ORGANIZACION' &&
        filas[0].desvinculado_por_id_usuario === C2.id_usuario &&
        filas[1].activo === true &&
        filas[1].metodo_cobro === 'CALCULO_PLATAFORMA' &&
        filas[1].parametros_cobro === null &&
        filaB.desvinculado_por === 'CHOFER' &&
        filaB.desvinculado_por_id_usuario === K1.id_usuario,
      `${revinc.status} filas=${filas.map((f) => `${f.activo}/${f.desvinculado_por}`).join(',')} B=${filaB?.desvinculado_por}`
    );
  }

  // CASO 7 -------------------------------------------------------------------
  if (correr(7)) {
    titulo('CASO 7: roles, bajas y volver a entrar');
    // Estado de partida en A: C1 RESPONSABLE (unico), C2 MIEMBRO.
    const promover = await setRol(C1, A, C2.id_usuario, 'RESPONSABLE');
    paso('CASO 7a: el responsable promueve a un miembro → 200', promover.status === 200 && promover.data.rol === 'RESPONSABLE', r2s(promover));
    const degradar = await setRol(C2, A, C1.id_usuario, 'MIEMBRO');
    paso('CASO 7b: un responsable degrada a otro → 200', degradar.status === 200 && degradar.data.rol === 'MIEMBRO', r2s(degradar));
    const yaNoPuede = await setRol(C1, A, C1.id_usuario, 'RESPONSABLE');
    paso('CASO 7c: el degradado ya no puede cambiar roles → 403', yaNoPuede.status === 403, r2s(yaNoPuede));

    // C2 es ahora el UNICO responsable.
    const autoDegradar = await setRol(C2, A, C2.id_usuario, 'MIEMBRO');
    const irse = await salir(C2, A);
    const autoEliminar = await eliminar(C2, A, C2.id_usuario);
    paso(
      'CASO 7d: el ultimo responsable → 409 al degradarse, al irse y al eliminarse',
      autoDegradar.status === 409 && irse.status === 409 && autoEliminar.status === 409,
      `${autoDegradar.status} ${irse.status} ${autoEliminar.status} — ${autoDegradar.data.error}`
    );
    paso('CASO 7e: y sigue habiendo exactamente un responsable', (await responsablesActivos(A)) === 1, '');

    await setRol(C2, A, C1.id_usuario, 'RESPONSABLE');
    await setRol(C1, A, C2.id_usuario, 'MIEMBRO');
    // Ahora: C1 RESPONSABLE, C2 MIEMBRO.
    const miembroElimina = await eliminar(C2, A, C1.id_usuario);
    paso('CASO 7f: un miembro no puede eliminar → 403', miembroElimina.status === 403, r2s(miembroElimina));
    const elim = await eliminar(C1, A, C2.id_usuario);
    const meElim = await me(C2);
    const verElim = await api('GET', `/api/organizaciones/${A}`, null, C2.token);
    paso(
      'CASO 7g: el responsable elimina a un miembro → 200; el eliminado queda huerfano y sin acceso',
      elim.status === 200 && meElim.data.organizacion === null && verElim.status === 403,
      `${r2s(elim)} | /me.organizacion=${JSON.stringify(meElim.data.organizacion)} | ver=${verElim.status}`
    );
    await sumarMiembro(C1, A, C2);
    const meVuelve = await me(C2);
    paso('CASO 7h: volver a entrar a la misma PyME con un codigo nuevo → ok', meVuelve.data.organizacion?.id_organizacion === A, JSON.stringify(meVuelve.data.organizacion));
    const seVa = await salir(C2, A);
    paso('CASO 7i: un miembro se va solo → 200', seVa.status === 200, r2s(seVa));
    await sumarMiembro(C1, A, C2);
    const filas = await prisma.miembroOrganizacion.findMany({
      where: { id_organizacion: A, id_usuario: C2.id_usuario },
      orderBy: { id_miembro: 'asc' },
    });
    const motivos = filas.map((f) => `${f.activo ? 'ACTIVA' : f.motivo_baja}`).join(',');
    paso(
      'CASO 7j: cada paso por la PyME es una fila (ELIMINADO por el responsable, SE_FUE, activa)',
      filas.length === 3 &&
        filas[0].motivo_baja === 'ELIMINADO' &&
        filas[0].baja_por_id_usuario === C1.id_usuario &&
        filas[1].motivo_baja === 'SE_FUE' &&
        filas[1].baja_por_id_usuario === C2.id_usuario &&
        filas[2].activo === true &&
        (await membresiasActivas(C2.id_usuario)) === 1,
      motivos
    );
  }

  // CASO 8 -------------------------------------------------------------------
  if (correr(8)) {
    titulo('CASO 8: perfil (/me)');
    const conPyme = await me(C1);
    const o = conPyme.data.organizacion;
    paso(
      'CASO 8a: CLIENTE con PyME → organizacion { id, nombre, estado, rol } + campos de siempre',
      conPyme.status === 200 && o?.id_organizacion === A && typeof o.nombre === 'string' && o.estado === 'TRIAL' && o.rol === 'RESPONSABLE' &&
        conPyme.data.email === C1.email && conPyme.data.rol === 'CLIENTE',
      r2s(conPyme)
    );
    const huerfano = await me(C3);
    paso('CASO 8b: CLIENTE huerfano → organizacion null', huerfano.status === 200 && huerfano.data.organizacion === null, r2s(huerfano));
    const chofer = await me(K1);
    const mias = await api('GET', '/api/choferes/mis-organizaciones', null, K1.token);
    paso(
      'CASO 8c: CONDUCTOR → organizaciones = lista de sus PyMEs',
      chofer.status === 200 && Array.isArray(chofer.data.organizaciones) &&
        chofer.data.organizaciones.length === mias.data.length &&
        chofer.data.organizaciones.every((x) => Object.keys(x).sort().join() === 'id_organizacion,nombre'),
      r2s(chofer)
    );
    const choferSin = await me(K2);
    paso('CASO 8d: CONDUCTOR sin vinculos → organizaciones []', choferSin.data.organizaciones?.length === 0 && !('organizacion' in choferSin.data), r2s(choferSin));
  }
}

async function casosConcurrencia(ctx) {
  const A = ctx.A.id_organizacion;
  const B = ctx.B.id_organizacion;
  const { C1, C4 } = ctx;

  // CASO 9 -------------------------------------------------------------------
  if (correr(9)) {
    titulo(`CASO 9: el mismo codigo, dos usuarios a la vez (${RONDAS} rondas)`);
    // Pool de huerfanos: el perdedor de cada ronda vuelve al pool.
    const pool = await nuevosUsuarios('cliente', 'Car', RONDAS + 1);
    let todasOk = true;
    const detalle = [];
    for (let r = 0; r < RONDAS; r++) {
      const [u1, u2] = [pool.shift(), pool.shift()];
      const inv = await invitarOk(C1, A, 'MIEMBRO');
      const rs = await Promise.all([canjear(u1, inv.codigo), canjear(u2, inv.codigo)]);
      const ganadores = rs.filter((x) => x.status === 200).length;
      const perdedor = rs.find((x) => x.status !== 200);
      const fila = await prisma.invitacion.findUnique({ where: { id_invitacion: inv.id_invitacion } });
      const m1 = await membresiasActivas(u1.id_usuario);
      const m2 = await membresiasActivas(u2.id_usuario);
      const ok = ganadores === 1 && perdedor?.status === 400 && perdedor.data.error === 'Codigo invalido' && m1 + m2 === 1 && fila.fecha_uso !== null;
      todasOk &&= ok;
      detalle.push(`r${r + 1}:${statuses(rs)}`);
      pool.push(m1 === 0 ? u1 : u2);
    }
    paso('CASO 9: gana exactamente uno, el otro recibe "Codigo invalido", una sola membresia', todasOk, detalle.join(' '));
  }

  // CASO 10 ------------------------------------------------------------------
  if (correr(10)) {
    titulo(`CASO 10: los dos unicos responsables a la vez (${RONDAS} rondas por variante)`);
    const [X, Y] = await nuevosUsuarios('cliente', 'Resp', 2);
    const D = (await crearOrgOk(X, `PyME D ${S}`, cuitValido(10))).id_organizacion;
    await sumarMiembro(X, D, Y, true);

    // Variante 1: los dos se degradan a si mismos.
    let ok1 = true;
    const det1 = [];
    for (let r = 0; r < RONDAS; r++) {
      const rs = await Promise.all([setRol(X, D, X.id_usuario, 'MIEMBRO'), setRol(Y, D, Y.id_usuario, 'MIEMBRO')]);
      const resp = await responsablesActivos(D);
      ok1 &&= statuses(rs) === '200,409' && resp === 1;
      det1.push(`r${r + 1}:${statuses(rs)}/resp=${resp}`);
      // Restaurar: el que quedo responsable promueve al otro.
      const quedo = rs[0].status === 200 ? Y : X;
      const otro = quedo === X ? Y : X;
      await setRol(quedo, D, otro.id_usuario, 'RESPONSABLE');
    }
    paso('CASO 10a: degradarse a la vez → uno 200, otro 409, queda un responsable', ok1, det1.join(' '));

    // Variante 2: los dos se van a la vez.
    let ok2 = true;
    const det2 = [];
    for (let r = 0; r < RONDAS; r++) {
      const rs = await Promise.all([salir(X, D), salir(Y, D)]);
      const resp = await responsablesActivos(D);
      ok2 &&= statuses(rs) === '200,409' && resp === 1;
      det2.push(`r${r + 1}:${statuses(rs)}/resp=${resp}`);
      const quedo = rs[0].status === 200 ? Y : X;
      const seFue = quedo === X ? Y : X;
      await sumarMiembro(quedo, D, seFue, true);
    }
    paso('CASO 10b: irse a la vez → uno 200, otro 409, queda un responsable', ok2, det2.join(' '));

    // Variante 3: cada uno elimina al otro a la vez. El segundo ya no es
    // responsable (ni miembro) cuando le toca el lock: 403.
    let ok3 = true;
    const det3 = [];
    for (let r = 0; r < RONDAS; r++) {
      const rs = await Promise.all([eliminar(X, D, Y.id_usuario), eliminar(Y, D, X.id_usuario)]);
      const resp = await responsablesActivos(D);
      ok3 &&= rs.filter((x) => x.status === 200).length === 1 && resp === 1;
      det3.push(`r${r + 1}:${statuses(rs)}/resp=${resp}`);
      const quedo = rs[0].status === 200 ? X : Y;
      const eliminado = quedo === X ? Y : X;
      await sumarMiembro(quedo, D, eliminado, true);
    }
    paso('CASO 10c: eliminarse mutuamente a la vez → gana uno, queda un responsable', ok3, det3.join(' '));
  }

  // CASO 11 ------------------------------------------------------------------
  if (correr(11)) {
    titulo(`CASO 11: un usuario, dos caminos a una PyME a la vez (${RONDAS} rondas)`);
    const usuarios = await nuevosUsuarios('cliente', 'Dbl', RONDAS * 2);

    let ok1 = true;
    const det1 = [];
    for (let r = 0; r < RONDAS; r++) {
      const u = usuarios[r];
      const [invA, invB] = await Promise.all([invitarOk(C1, A, 'MIEMBRO'), invitarOk(C4, B, 'MIEMBRO')]);
      const rs = await Promise.all([canjear(u, invA.codigo), canjear(u, invB.codigo)]);
      const activas = await membresiasActivas(u.id_usuario);
      const usadas = await prisma.invitacion.count({
        where: { id_invitacion: { in: [invA.id_invitacion, invB.id_invitacion] }, fecha_uso: { not: null } },
      });
      ok1 &&= statuses(rs) === '200,409' && activas === 1 && usadas === 1;
      det1.push(`r${r + 1}:${statuses(rs)}/activas=${activas}/usadas=${usadas}`);
    }
    paso('CASO 11a: dos codigos MIEMBRO a la vez → uno 200, otro 409; una sola PyME y un solo codigo consumido', ok1, det1.join(' '));

    let ok2 = true;
    const det2 = [];
    for (let r = 0; r < RONDAS; r++) {
      const u = usuarios[RONDAS + r];
      const inv = await invitarOk(C1, A, 'MIEMBRO');
      const rs = await Promise.all([
        crearOrg(u, { nombre: `PyME carrera ${S}-${r}`, cuit: cuitValido(20 + r) }),
        canjear(u, inv.codigo),
      ]);
      if (rs[0].status === 201) orgsCreadas.add(rs[0].data.id_organizacion);
      const activas = await membresiasActivas(u.id_usuario);
      const exitos = (rs[0].status === 201 ? 1 : 0) + (rs[1].status === 200 ? 1 : 0);
      ok2 &&= exitos === 1 && activas === 1 && [409].includes(rs[0].status === 201 ? rs[1].status : rs[0].status);
      det2.push(`r${r + 1}:crear=${rs[0].status},canje=${rs[1].status}/activas=${activas}`);
    }
    paso('CASO 11b: crear PyME mientras canjea → gana uno, el otro 409; una sola PyME', ok2, det2.join(' '));
  }
}

async function casoRateLimit(ctx) {
  titulo('CASO 12: rate limit (server propio, INVITACION_INTENTOS_MAX=3)');
  if (redis.status !== 'ready') {
    paso('CASO 12: requiere Redis', false, `redis.status=${redis.status}`);
    return;
  }
  const [R1, R2] = await nuevosUsuarios('cliente', 'Rl', 2);
  await borrarKeysRateLimit([R1.id_usuario, R2.id_usuario]);
  await conServer({ ...ENV_BASE, INVITACION_INTENTOS_MAX: '3', INVITACION_VENTANA_MINUTOS: '1' }, 3502, async (base) => {
    const intentos = [];
    for (let i = 0; i < 4; i++) intentos.push(await canjear(R1, 'ZZZZZ-ZZZZZ', base));
    paso(
      'CASO 12a: por usuario — 3 intentos pasan (400), el 4to → 429',
      intentos.slice(0, 3).every((r) => r.status === 400) && intentos[3].status === 429,
      intentos.map((r) => r.status).join(',')
    );
    // Otro usuario desde la MISMA IP: el contador por IP ya esta en 4.
    const otro = await canjear(R2, 'ZZZZZ-ZZZZZ', base);
    paso('CASO 12b: por IP — otro usuario desde la misma IP → 429', otro.status === 429, r2s(otro));
    // Con un codigo VALIDO tambien corta: el limite va antes de mirar el codigo.
    const inv = await invitarOk(ctx.C1, ctx.A.id_organizacion, 'MIEMBRO');
    const valido = await canjear(R2, inv.codigo, base);
    paso('CASO 12c: con un codigo valido tambien → 429 (y no se consume)', valido.status === 429 && (await membresiasActivas(R2.id_usuario)) === 0, r2s(valido));
  });
  await borrarKeysRateLimit([R1.id_usuario, R2.id_usuario]);
}

async function casoSinSecreto(ctx) {
  titulo('CASO 13: sin INVITACION_SECRETO (server propio)');
  await conServer({ ...ENV_BASE, INVITACION_SECRETO: '' }, 3503, async (base, leerLog) => {
    const A = ctx.A.id_organizacion;
    const canje = await canjear(ctx.C3, 'ABCDE-FGHJK', base);
    const crear = await api('POST', `/api/organizaciones/${A}/invitaciones`, { tipo: 'CHOFER' }, ctx.C1.token, base);
    const listar = await api('GET', `/api/organizaciones/${A}/invitaciones`, null, ctx.C1.token, base);
    paso(
      'CASO 13a: canjear / crear / listar invitaciones → 503',
      canje.status === 503 && crear.status === 503 && listar.status === 503,
      `${canje.status} ${crear.status} ${listar.status} — ${canje.data.error}`
    );
    const ver = await api('GET', `/api/organizaciones/${A}`, null, ctx.C1.token, base);
    paso('CASO 13b: el server arranco y el resto anda (GET de la PyME → 200)', ver.status === 200, r2s(ver));
    paso('CASO 13c: se loguea el error al arrancar', leerLog().includes('[invitaciones] INVITACION_SECRETO no configurado'), '');
  });
}

async function casoSinRedis(ctx) {
  titulo('CASO 14: Redis caido (server propio con REDIS_URL a un puerto muerto)');
  const [U] = await nuevosUsuarios('cliente', 'Nr', 1);
  const inv = await invitarOk(ctx.C1, ctx.A.id_organizacion, 'MIEMBRO');
  await conServer({ ...ENV_BASE, INVITACION_INTENTOS_MAX: '1', REDIS_URL: 'redis://127.0.0.1:6399' }, 3504, async (base, leerLog) => {
    const t0 = Date.now();
    const r = await canjear(U, inv.codigo, base);
    const ms = Date.now() - t0;
    paso('CASO 14a: el canje pasa (200) sin colgarse', r.status === 200 && ms < 8000, `${r2s(r)} en ${ms}ms`);
    // Con max=1, si contara habria cortado el segundo intento: no cuenta nada.
    const r2 = await canjear(U, 'ZZZZZ-ZZZZZ', base);
    paso('CASO 14b: sin Redis no hay limite (2do intento con max=1 no da 429)', r2.status !== 429, r2s(r2));
    paso('CASO 14c: se loguea que se dejo pasar', leerLog().includes('[invitaciones] rate limit sin Redis'), '');
  });
}

// -- Main ---------------------------------------------------------------------

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║        TEST IDENTIDAD (PASO 1) — FLETER      ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  if (SOLO.length > 0) console.log(`  (solo los casos ${SOLO.join(', ')})\n`);
  if (!process.env.INVITACION_SECRETO) throw new Error('Falta INVITACION_SECRETO en el .env local');

  let limpio = false;
  try {
    await conServer(ENV_BASE, PUERTO, async (base) => {
      BASE = base;
      titulo('SETUP: usuarios');
      const [C1, C2, C3, C4, C5] = await nuevosUsuarios('cliente', 'Cli', 5);
      const [K1, K2] = await nuevosUsuarios('conductor', 'Con', 2);
      console.log(`  ${nUsuario} usuarios registrados`);
      const ctx = { C1, C2, C3, C4, C5, K1, K2 };
      await casosPrincipales(ctx);
      await casosConcurrencia(ctx);
      // El rate limit va despues de todo lo demas: comparte la key por IP de
      // localhost con el server principal, y la borra antes y despues.
      if (correr(12)) await casoRateLimit(ctx);
      if (correr(13)) await casoSinSecreto(ctx);
      if (correr(14)) await casoSinRedis(ctx);
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
    await prisma.$disconnect().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(1);
  });
