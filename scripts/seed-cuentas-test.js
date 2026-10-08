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
// de prueba.
import 'dotenv/config';
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

async function main() {
  console.log('\nSeed de cuentas fijas de test\n');
  for (const c of CUENTAS) {
    const fb = await asegurarFirebase(c);
    const db = await asegurarDb(c, fb.uid);
    console.log(`  ${c.email.padEnd(28)} ${c.rol.padEnd(9)} firebase: ${fb.accion.padEnd(28)} db: ${db}`);
  }
  console.log('\nListo.');
}

main()
  .catch((e) => {
    console.error('💥 seed fallo:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
