// seed-cuentas-test.js — recrea las cuentas FIJAS que usan las suites de
// regresion, despues de un reset de la DB.
//
// Por que hace falta: casi todas las suites hacen `registrar(...)` aceptando 201
// o 409 y despues loguean por Firebase. Tras un reset de la DB, el usuario sigue
// existiendo en Firebase pero no en la tabla usuarios: el registro da 409
// ("email ya registrado", sale de Firebase), el login anda, y todo request
// autenticado da 404 "Usuario no registrado". Este script deja Firebase y la DB
// alineados.
//
// Idempotente. Por cada cuenta:
//   - Firebase: si existe, le resetea la password a la conocida; si no, la crea.
//   - DB: si no existe la fila (por email) la crea con su perfil (cliente /
//     conductor con licencia / admin); si existe con otro firebase_uid, lo alinea.
//
//   node scripts/seed-cuentas-test.js
//
// OJO: la DB de Neon esta compartida con produccion. Solo toca estas 6 cuentas
// de prueba, y la cuenta e2e con su PyME y su chofer (ver seedE2E).
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import admin from '../src/config/firebase.js';
import prisma from '../src/config/prisma.js';

const LIC = new Date('2030-01-01T00:00:00.000Z');

// Mismos DNIs y datos que ya usan los scripts al registrarse. La excepcion es
// stress-conductor2: scripts/stress/_helpers.js le pone el DNI 33333333, el MISMO
// que conductor2@test.com, asi que las dos cuentas no podian existir a la vez en
// la DB. Aca recibe 33333334; el helper de stress sigue andando porque su
// registro da 409 por email y usa la cuenta que ya existe.
const CUENTAS = [
  { email: 'cliente@test.com', password: 'test123456', rol: 'CLIENTE', nombre: 'Test', apellido: 'Cliente', dni: '11111111' },
  { email: 'cliente2@test.com', password: 'test123456', rol: 'CLIENTE', nombre: 'Test', apellido: 'ClienteDos', dni: '44444444' },
  { email: 'conductor@test.com', password: 'test123456', rol: 'CONDUCTOR', nombre: 'Conductor', apellido: 'Uno', dni: '22222222', nro_licencia: 'LIC001' },
  { email: 'conductor2@test.com', password: 'test123456', rol: 'CONDUCTOR', nombre: 'Conductor', apellido: 'Dos', dni: '33333333', nro_licencia: 'LIC002' },
  { email: 'stress-conductor2@test.com', password: 'test123456', rol: 'CONDUCTOR', nombre: 'Stress', apellido: 'ConductorDos', dni: '33333334', nro_licencia: 'LIC003' },
  { email: 'admin-test@fleter.com', password: 'admintest123', rol: 'ADMIN', nombre: 'Admin', apellido: 'Test', dni: '90000001' },
];

async function asegurarFirebase({ email, password }) {
  try {
    const u = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(u.uid, { password });
    return { uid: u.uid, accion: 'existia (password reseteada)' };
  } catch (err) {
    if (err.code !== 'auth/user-not-found') throw err;
    const u = await admin.auth().createUser({ email, password });
    return { uid: u.uid, accion: 'creada' };
  }
}

function perfilDe(c) {
  if (c.rol === 'CLIENTE') return { cliente: { create: {} } };
  if (c.rol === 'CONDUCTOR') return { conductor: { create: { nro_licencia: c.nro_licencia, licencia_vencimiento: LIC } } };
  return {};
}

async function asegurarDb(c, uid) {
  const existente = await prisma.usuario.findUnique({ where: { email: c.email } });
  if (existente) {
    if (existente.firebase_uid !== uid) {
      await prisma.usuario.update({ where: { id_usuario: existente.id_usuario }, data: { firebase_uid: uid } });
      return `existia (id ${existente.id_usuario}, firebase_uid alineado)`;
    }
    return `existia (id ${existente.id_usuario})`;
  }
  const u = await prisma.usuario.create({
    data: {
      firebase_uid: uid,
      nombre: c.nombre,
      apellido: c.apellido,
      dni: c.dni,
      email: c.email,
      rol: c.rol,
      ...perfilDe(c),
    },
  });
  return `creada (id ${u.id_usuario})`;
}

// ─── Cuenta e2e (Paso 2) ─────────────────────────────────────────────────────
//
// El e2e (e2e/login-crear-viaje.e2e.test.js) corre contra staging, que comparte
// la DB con este script. Necesita:
//   1. El usuario e2e (TEST_USER_EMAIL / TEST_USER_PASSWORD, mismos valores que
//      los secrets de GitHub), CLIENTE. Si ya existe en Firebase NO se le toca la
//      password: es la del secret.
//   2. La "PyME E2E" (CUIT fijo de prueba), ACTIVA, con el usuario e2e como
//      RESPONSABLE.
//   3. Un chofer (chofer-e2e@test.com) con vinculo ACTIVO a esa PyME y un
//      vehiculo propio con FRAGIL (la condicion que pide el test). Nadie se
//      loguea con el: password aleatoria.
// Sin TEST_USER_EMAIL / TEST_USER_PASSWORD se saltea con un aviso; el resto del
// seed corre igual. Idempotente: correrlo N veces deja lo mismo.

const E2E_CUIT = '30999999995'; // CUIT de prueba con digito verificador valido
const E2E_PYME = 'PyME E2E';
const E2E_CHOFER = {
  email: 'chofer-e2e@test.com',
  rol: 'CONDUCTOR',
  nombre: 'Chofer',
  apellido: 'E2E',
  dni: '90000003',
  nro_licencia: 'LIC-E2E',
};
const E2E_PATENTE = 'E2E000';

// Como asegurarFirebase, pero NUNCA cambia la password de una cuenta existente.
async function asegurarFirebaseSinTocar(email, passwordSiCrea) {
  try {
    const u = await admin.auth().getUserByEmail(email);
    return { uid: u.uid, accion: 'existia (password sin tocar)' };
  } catch (err) {
    if (err.code !== 'auth/user-not-found') throw err;
    const u = await admin.auth().createUser({ email, password: passwordSiCrea });
    return { uid: u.uid, accion: 'creada' };
  }
}

async function seedE2E() {
  const email = process.env.TEST_USER_EMAIL?.trim().toLowerCase();
  const password = process.env.TEST_USER_PASSWORD;
  console.log('\nCuenta e2e (PyME + chofer vinculado)\n');
  if (!email || !password) {
    console.log('  ⚠  TEST_USER_EMAIL / TEST_USER_PASSWORD no estan en el entorno: se saltea la cuenta e2e.');
    return;
  }

  // 1. Usuario e2e, CLIENTE con perfil.
  const fb = await asegurarFirebaseSinTocar(email, password);
  let usuario = await prisma.usuario.findUnique({ where: { email }, include: { cliente: true } });
  if (usuario && usuario.rol !== 'CLIENTE') {
    console.log(`  ⚠  ${email} existe con rol ${usuario.rol}, no CLIENTE: no se toca nada.`);
    return;
  }
  if (!usuario) {
    usuario = await prisma.usuario.create({
      data: {
        firebase_uid: fb.uid,
        nombre: 'E2E',
        apellido: 'PyME',
        dni: '90000002',
        email,
        rol: 'CLIENTE',
        cliente: { create: {} },
      },
      include: { cliente: true },
    });
  } else {
    if (usuario.firebase_uid !== fb.uid) {
      await prisma.usuario.update({ where: { id_usuario: usuario.id_usuario }, data: { firebase_uid: fb.uid } });
    }
    if (!usuario.cliente) {
      await prisma.cliente.create({ data: { id_usuario: usuario.id_usuario } });
    }
  }
  console.log(`  ${email.padEnd(28)} CLIENTE   firebase: ${fb.accion.padEnd(28)} db: id ${usuario.id_usuario}`);

  // 2. PyME E2E, ACTIVA, con el usuario como RESPONSABLE.
  let org = await prisma.organizacion.findFirst({ where: { cuit: E2E_CUIT } });
  if (!org) {
    org = await prisma.organizacion.create({ data: { nombre: E2E_PYME, cuit: E2E_CUIT, estado: 'ACTIVA' } });
  } else if (org.estado !== 'ACTIVA') {
    org = await prisma.organizacion.update({ where: { id_organizacion: org.id_organizacion }, data: { estado: 'ACTIVA' } });
  }

  const membresias = await prisma.miembroOrganizacion.findMany({
    where: { id_usuario: usuario.id_usuario, activo: true },
  });
  const otra = membresias.find((m) => m.id_organizacion !== org.id_organizacion);
  if (otra) {
    console.log(
      `  ⚠  ${email} ya es miembro activo de otra PyME (id ${otra.id_organizacion}): no se lo suma a ${E2E_PYME}.`
    );
    return;
  }
  const propia = membresias.find((m) => m.id_organizacion === org.id_organizacion);
  if (!propia) {
    await prisma.miembroOrganizacion.create({
      data: { id_organizacion: org.id_organizacion, id_usuario: usuario.id_usuario, rol: 'RESPONSABLE' },
    });
  } else if (propia.rol !== 'RESPONSABLE') {
    await prisma.miembroOrganizacion.update({ where: { id_miembro: propia.id_miembro }, data: { rol: 'RESPONSABLE' } });
  }
  console.log(`  ${E2E_PYME.padEnd(28)} PyME      id ${org.id_organizacion}, CUIT ${E2E_CUIT}, ACTIVA, responsable ${email}`);

  // 3. Chofer vinculado con vehiculo FRAGIL.
  const fbChofer = await asegurarFirebaseSinTocar(E2E_CHOFER.email, randomBytes(24).toString('base64url'));
  let chofer = await prisma.usuario.findUnique({ where: { email: E2E_CHOFER.email }, include: { conductor: true } });
  if (!chofer) {
    chofer = await prisma.usuario.create({
      data: {
        firebase_uid: fbChofer.uid,
        nombre: E2E_CHOFER.nombre,
        apellido: E2E_CHOFER.apellido,
        dni: E2E_CHOFER.dni,
        email: E2E_CHOFER.email,
        rol: 'CONDUCTOR',
        conductor: { create: { nro_licencia: E2E_CHOFER.nro_licencia, licencia_vencimiento: LIC } },
      },
      include: { conductor: true },
    });
  } else if (chofer.firebase_uid !== fbChofer.uid) {
    await prisma.usuario.update({ where: { id_usuario: chofer.id_usuario }, data: { firebase_uid: fbChofer.uid } });
  }
  const id_conductor = chofer.conductor.id_conductor;

  let vehiculo = await prisma.vehiculo.findUnique({ where: { patente: E2E_PATENTE } });
  if (vehiculo && vehiculo.id_conductor !== id_conductor) {
    console.log(`  ⚠  la patente ${E2E_PATENTE} es de otro dueño: no se toca.`);
    return;
  }
  if (!vehiculo) {
    vehiculo = await prisma.vehiculo.create({
      data: {
        id_conductor,
        patente: E2E_PATENTE,
        marca: 'Fiat',
        modelo: 'Fiorino',
        anio: 2020,
        color: 'Blanco',
        tipo_vehiculo: 'Utilitario',
      },
    });
  }
  await prisma.condicionVehiculo.upsert({
    where: { id_vehiculo_condicion: { id_vehiculo: vehiculo.id_vehiculo, condicion: 'FRAGIL' } },
    update: {},
    create: { id_vehiculo: vehiculo.id_vehiculo, condicion: 'FRAGIL' },
  });

  const vinculo = await prisma.vinculoChofer.findFirst({
    where: { id_organizacion: org.id_organizacion, id_conductor, activo: true },
  });
  if (!vinculo) {
    await prisma.vinculoChofer.create({ data: { id_organizacion: org.id_organizacion, id_conductor } });
  }
  console.log(
    `  ${E2E_CHOFER.email.padEnd(28)} CONDUCTOR firebase: ${fbChofer.accion.padEnd(28)} db: conductor ${id_conductor}, ` +
      `vehiculo ${E2E_PATENTE} (FRAGIL), vinculo ${vinculo ? 'existia' : 'creado'}`
  );
}

async function main() {
  console.log('\nSeed de cuentas fijas de test\n');
  for (const c of CUENTAS) {
    const fb = await asegurarFirebase(c);
    const db = await asegurarDb(c, fb.uid);
    console.log(`  ${c.email.padEnd(28)} ${c.rol.padEnd(9)} firebase: ${fb.accion.padEnd(28)} db: ${db}`);
  }
  await seedE2E();
  console.log('\nListo.');
}

main()
  .catch((e) => {
    console.error('💥 seed fallo:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
