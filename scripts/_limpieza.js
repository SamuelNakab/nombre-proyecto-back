// Limpieza compartida de los scripts de test. La DB de Neon esta COMPARTIDA con
// produccion: cada suite borra lo que crea y verifica que no quede nada.
//
// Uso en una suite:
//   const reg = crearRegistro('-jer-' + stamp);    // patron de SUS emails
//   reg.email(email); reg.viaje(id); reg.vehiculo(id); reg.empresa(id); reg.org(id);
//   try { ... } finally { limpio = (await reg.limpiar()).ok; }
//
// A partir de los EMAILS se derivan los viajes (como cliente, conductor o
// creador), las empresas que gerencian, sus vehiculos (propios y de flota), sus
// membresias y PyMEs. Las suites que usan las cuentas FIJAS del seed no
// registran emails: solo los viajes y vehiculos que crearon, por ID.
//
// GUARD DURO: si algo de lo que se va a borrar es una cuenta, PyME o vehiculo
// PROTEGIDO (seed-cuentas-test.js + la cuenta del E2E), TIRA. No filtra en
// silencio: un registro que llega a una cuenta fija es un bug de la suite.
//
// Extraida y generalizada de la limpiar() de test-viaje-interno.js. La usa
// tambien scripts/restos.js (conteo y borrado de restos de corridas cortadas).
import 'dotenv/config';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import prisma from '../src/config/prisma.js';
import redis from '../src/config/redis.js';
import admin from '../src/config/firebase.js';

// Las cuentas de seed-cuentas-test.js y la cuenta del E2E.
export const EMAILS_PROTEGIDOS = [
  'cliente@test.com',
  'cliente2@test.com',
  'conductor@test.com',
  'conductor2@test.com',
  'stress-conductor2@test.com',
  'admin-test@fleter.com',
  'chofer-e2e@test.com',
];
export const CUITS_PROTEGIDOS = ['30999999995']; // "PyME E2E"
export const PATENTES_PROTEGIDAS = ['E2E000'];

export function emailsProtegidos() {
  const e2e = process.env.TEST_USER_EMAIL?.trim().toLowerCase();
  return e2e ? [...EMAILS_PROTEGIDOS, e2e] : [...EMAILS_PROTEGIDOS];
}

const unicos = (xs) => [...new Set(xs.filter((x) => x !== null && x !== undefined))];

// Resuelve TODO lo que cuelga de un conjunto de emails / ids. No escribe nada.
// Tira si toca algo protegido.
export async function resolver({ emails = [], viajes = [], vehiculos = [], empresas = [], orgs = [] } = {}) {
  const protegidos = emailsProtegidos();
  const emailsMin = unicos(emails.map((e) => e.toLowerCase()));
  const tocados = emailsMin.filter((e) => protegidos.includes(e));
  if (tocados.length > 0) throw new Error(`[limpieza] se intento borrar una cuenta protegida: ${tocados.join(', ')}`);

  const usuarios = await prisma.usuario.findMany({
    where: { email: { in: emailsMin } },
    include: {
      conductor: true,
      cliente: true,
      membresias: { select: { id_organizacion: true } },
      empresas_gerente: { select: { id_empresa: true } },
    },
  });
  const idsUsuario = usuarios.map((u) => u.id_usuario);
  const idsConductor = unicos(usuarios.map((u) => u.conductor?.id_conductor));
  const idsCliente = unicos(usuarios.map((u) => u.cliente?.id_cliente));
  const idsOrg = unicos([...orgs, ...usuarios.flatMap((u) => u.membresias.map((m) => m.id_organizacion))]);
  const idsEmpresa = unicos([...empresas, ...usuarios.flatMap((u) => u.empresas_gerente.map((e) => e.id_empresa))]);

  const orgsProtegidas = await prisma.organizacion.findMany({
    where: { id_organizacion: { in: idsOrg }, cuit: { in: CUITS_PROTEGIDOS } },
    select: { id_organizacion: true, nombre: true },
  });
  if (orgsProtegidas.length > 0) {
    throw new Error(`[limpieza] se intento borrar una PyME protegida: ${orgsProtegidas.map((o) => o.nombre).join(', ')}`);
  }

  const filasVehiculo = await prisma.vehiculo.findMany({
    where: {
      OR: [
        { id_vehiculo: { in: unicos(vehiculos) } },
        { id_conductor: { in: idsConductor } },
        { id_empresa: { in: idsEmpresa } },
      ],
    },
    select: { id_vehiculo: true, patente: true },
  });
  const vehProtegidos = filasVehiculo.filter((v) => PATENTES_PROTEGIDAS.includes(v.patente));
  if (vehProtegidos.length > 0) {
    throw new Error(`[limpieza] se intento borrar un vehiculo protegido: ${vehProtegidos.map((v) => v.patente).join(', ')}`);
  }
  const idsVehiculo = filasVehiculo.map((v) => v.id_vehiculo);

  const filasViaje = await prisma.viaje.findMany({
    where: {
      OR: [
        { id_viaje: { in: unicos(viajes) } },
        { id_organizacion: { in: idsOrg } },
        { id_conductor: { in: idsConductor } },
        { id_cliente: { in: idsCliente } },
        { id_creador: { in: idsUsuario } },
        { id_empresa: { in: idsEmpresa } },
        { id_vehiculo: { in: idsVehiculo } },
      ],
    },
    select: { id_viaje: true, estado: true },
  });

  return {
    emails: emailsMin,
    idsUsuario,
    idsConductor,
    idsCliente,
    idsOrg,
    idsEmpresa,
    idsVehiculo,
    viajes: filasViaje,
    idsViaje: filasViaje.map((v) => v.id_viaje),
  };
}

async function borrarRemitos(idsFinalizados) {
  if (idsFinalizados.length === 0 || !process.env.R2_BUCKET_NAME) return 0;
  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  let n = 0;
  for (const id of idsFinalizados) {
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: `remitos/${id}.pdf` }));
      n++;
    } catch (e) {
      console.error(`  ⚠️  R2 remito ${id}: ${e.message}`);
    }
  }
  return n;
}

// Keys de Redis: gps:{id}:* de los viajes y el rate limit del canje de los
// usuarios + las IPs de loopback (las que generan los tests desde localhost).
async function borrarKeysRedis(idsViaje, idsUsuario) {
  if (redis.status !== 'ready') return;
  for (const id of idsViaje) {
    const keys = await redis.keys(`gps:${id}:*`);
    if (keys.length > 0) await redis.del(...keys);
  }
  const claves = idsUsuario.map((id) => `invitacion:canje:usuario:${id}`);
  let cursor = '0';
  do {
    const [sig, encontradas] = await redis.scan(cursor, 'MATCH', 'invitacion:canje:ip:*', 'COUNT', 500);
    cursor = sig;
    claves.push(...encontradas.filter((k) => /127\.0\.0\.1|::1$/.test(k)));
  } while (cursor !== '0');
  if (claves.length > 0) await redis.del(...claves);
}

// Borra lo resuelto, en orden de FKs. Devuelve cuanto borro de cada cosa.
export async function borrar(r) {
  const { idsUsuario, idsConductor, idsCliente, idsOrg, idsEmpresa, idsVehiculo, idsViaje } = r;
  const remitos = await borrarRemitos(r.viajes.filter((v) => v.estado === 'FINALIZADO').map((v) => v.id_viaje));
  await borrarKeysRedis(idsViaje, idsUsuario);

  const enViajes = { id_viaje: { in: idsViaje } };
  await prisma.calificacion.deleteMany({
    where: { OR: [enViajes, { id_cliente: { in: idsCliente } }, { id_conductor: { in: idsConductor } }] },
  });
  await prisma.transaccion.deleteMany({ where: enViajes });
  await prisma.historialEstadoViaje.deleteMany({ where: enViajes });
  await prisma.parada.deleteMany({ where: enViajes });
  await prisma.condicionRequerida.deleteMany({ where: enViajes });
  const viajes = (await prisma.viaje.deleteMany({ where: enViajes })).count;

  const series = (
    await prisma.serieViaje.deleteMany({
      where: {
        OR: [{ id_organizacion: { in: idsOrg } }, { id_conductor: { in: idsConductor } }, { id_creador: { in: idsUsuario } }],
      },
    })
  ).count;
  const lugares = (
    await prisma.lugar.deleteMany({ where: { OR: [{ id_organizacion: { in: idsOrg } }, { id_creador: { in: idsUsuario } }] } })
  ).count;

  await prisma.conductorVehiculo.deleteMany({
    where: { OR: [{ id_vehiculo: { in: idsVehiculo } }, { id_conductor: { in: idsConductor } }] },
  });
  await prisma.condicionVehiculo.deleteMany({ where: { id_vehiculo: { in: idsVehiculo } } });
  const vehiculos = (await prisma.vehiculo.deleteMany({ where: { id_vehiculo: { in: idsVehiculo } } })).count;
  await prisma.conductorEmpresa.deleteMany({
    where: { OR: [{ id_empresa: { in: idsEmpresa } }, { id_conductor: { in: idsConductor } }] },
  });
  const empresas = (await prisma.empresa.deleteMany({ where: { id_empresa: { in: idsEmpresa } } })).count;

  await prisma.vinculoChofer.deleteMany({
    where: { OR: [{ id_organizacion: { in: idsOrg } }, { id_conductor: { in: idsConductor } }] },
  });
  await prisma.invitacion.deleteMany({ where: { id_organizacion: { in: idsOrg } } });
  await prisma.miembroOrganizacion.deleteMany({
    where: { OR: [{ id_organizacion: { in: idsOrg } }, { id_usuario: { in: idsUsuario } }] },
  });
  const pymes = (await prisma.organizacion.deleteMany({ where: { id_organizacion: { in: idsOrg } } })).count;

  await prisma.metodoPago.deleteMany({ where: { id_usuario: { in: idsUsuario } } });
  await prisma.conductor.deleteMany({ where: { id_usuario: { in: idsUsuario } } });
  await prisma.cliente.deleteMany({ where: { id_usuario: { in: idsUsuario } } });
  const usuarios = (await prisma.usuario.deleteMany({ where: { id_usuario: { in: idsUsuario } } })).count;

  let firebase = 0;
  for (const email of r.emails) {
    try {
      const u = await admin.auth().getUserByEmail(email);
      await admin.auth().deleteUser(u.uid);
      firebase++;
    } catch (e) {
      if (e.code !== 'auth/user-not-found') console.error(`  ⚠️  Firebase ${email}: ${e.message}`);
    }
  }
  return { usuarios, firebase, viajes, vehiculos, empresas, pymes, series, lugares, remitos };
}

// Cuenta lo que queda de lo resuelto (y de los usuarios con el patron, si hay).
export async function contar(r, patron) {
  const usuarios = await prisma.usuario.findMany({
    where: patron ? { OR: [{ email: { contains: patron } }, { id_usuario: { in: r.idsUsuario } }] } : { id_usuario: { in: r.idsUsuario } },
    select: { id_usuario: true, email: true },
  });
  const conteos = {
    // includes en JS: el LIKE de Prisma no escapa '_' (comodin en '_veh_').
    usuarios: usuarios.filter((u) => r.idsUsuario.includes(u.id_usuario) || (patron && u.email.includes(patron))).length,
    viajes: await prisma.viaje.count({ where: { id_viaje: { in: r.idsViaje } } }),
    historial: await prisma.historialEstadoViaje.count({ where: { id_viaje: { in: r.idsViaje } } }),
    pymes: await prisma.organizacion.count({ where: { id_organizacion: { in: r.idsOrg } } }),
    empresas: await prisma.empresa.count({ where: { id_empresa: { in: r.idsEmpresa } } }),
    vehiculos: await prisma.vehiculo.count({ where: { id_vehiculo: { in: r.idsVehiculo } } }),
    keys_gps: 0,
  };
  if (redis.status === 'ready') {
    for (const id of r.idsViaje) conteos.keys_gps += (await redis.keys(`gps:${id}:*`)).length;
  }
  return { ok: Object.values(conteos).every((n) => n === 0), conteos };
}

// `patron`: lo que tienen en comun los emails de la corrida (p. ej. '-jer-123').
// Al limpiar, ademas de los emails anotados, se suman los usuarios de la DB con
// ese patron (las suites legacy registran usuarios en varios lugares y asi no
// hace falta anotar cada uno), y la verificacion cuenta los que queden. null en
// las suites de cuentas fijas: ahi solo se borra lo anotado por ID.
export function crearRegistro(patronInicial = null) {
  let patron = patronInicial;
  const emails = new Set();
  const viajes = new Set();
  const vehiculos = new Set();
  const empresas = new Set();
  const orgs = new Set();
  let resuelto = null;

  async function resolverTodo() {
    const conPatron = patron
      ? (await prisma.usuario.findMany({ where: { email: { contains: patron } }, select: { email: true } }))
          .map((u) => u.email.toLowerCase())
          .filter((e) => e.includes(patron)) // el LIKE de Prisma no escapa '_'
      : [];
    return resolver({
      emails: [...emails, ...conPatron],
      viajes: [...viajes],
      vehiculos: [...vehiculos],
      empresas: [...empresas],
      orgs: [...orgs],
    });
  }

  return {
    patron: (p) => (patron = p),
    email: (e) => (emails.add(e.toLowerCase()), e),
    viaje: (id) => (id !== null && id !== undefined && viajes.add(id), id),
    vehiculo: (id) => (id !== null && id !== undefined && vehiculos.add(id), id),
    empresa: (id) => (id !== null && id !== undefined && empresas.add(id), id),
    org: (id) => (id !== null && id !== undefined && orgs.add(id), id),

    // Borra todo y verifica. Devuelve { ok, conteos } de lo que QUEDO.
    async limpiar() {
      console.log(`\n-- LIMPIEZA ${'-'.repeat(51)}\n`);
      resuelto = await resolverTodo();
      const b = await borrar(resuelto);
      const v = await contar(resuelto, patron);
      console.log(`  borrados: ${JSON.stringify(b)}`);
      console.log(`  quedan:   ${JSON.stringify(v.conteos)}`);
      return v;
    },

    // Solo cuenta (despues de limpiar, o sin limpiar si nunca se resolvio).
    async verificar() {
      if (!resuelto) resuelto = await resolverTodo();
      return contar(resuelto, patron);
    },
  };
}

// Cierre comun de las suites legacy: limpia (pase lo que pase), reporta la
// limpieza como un paso mas, cierra Prisma / Redis y sale. Exit 1 si fallo algun
// check (ok=false) o si quedo algo sin borrar.
export async function terminar(reg, ok) {
  let limpio = false;
  try {
    limpio = (await reg.limpiar()).ok;
  } catch (e) {
    console.error('  ⚠️  la limpieza fallo:', e.message);
  }
  console.log(`  ${limpio ? '✅' : '❌'} LIMPIEZA: no quedo nada de lo creado por el test`);
  await cerrarConexiones();
  process.exit(ok && limpio ? 0 : 1);
}

// Desconexion de los clientes compartidos (para el final de un script).
export async function cerrarConexiones() {
  await prisma.$disconnect().catch(() => {});
  await redis.quit().catch(() => {});
}
