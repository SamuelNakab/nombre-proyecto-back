import 'dotenv/config';
import admin from '../src/config/firebase.js';
import prisma from '../src/config/prisma.js';

// Crea una cuenta ADMIN (Firebase + DB) de forma idempotente. Lee credenciales
// de variables de entorno. Se corre manualmente contra la DB target:
//
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_NOMBRE=... ADMIN_APELLIDO=... \
//   ADMIN_DNI=... node scripts/crear-admin.js
//
// No hay endpoint publico de registro admin: esta es la unica via de creacion.

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const nombre = process.env.ADMIN_NOMBRE;
  const apellido = process.env.ADMIN_APELLIDO;
  const dni = process.env.ADMIN_DNI;

  if (!email || !password || !nombre || !apellido || !dni) {
    console.error(
      'Faltan variables de entorno. Requeridas: ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NOMBRE, ADMIN_APELLIDO, ADMIN_DNI'
    );
    await prisma.$disconnect();
    process.exit(1);
  }

  // Idempotencia: si ya existe un usuario con ese email en la DB, no hacemos nada.
  const existente = await prisma.usuario.findUnique({ where: { email } });
  if (existente) {
    console.log(
      `El admin ya existe en la DB (id_usuario=${existente.id_usuario}, rol=${existente.rol}). No se crea de nuevo.`
    );
    await prisma.$disconnect();
    return;
  }

  // Crear en Firebase. Si el email ya existe alli (estado parcial: Firebase si,
  // DB no), reutilizamos su uid para completar el registro en la DB.
  let uid;
  let creadoEnFirebase = false;
  try {
    const fbUser = await admin.auth().createUser({ email, password });
    uid = fbUser.uid;
    creadoEnFirebase = true;
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      const existing = await admin.auth().getUserByEmail(email);
      uid = existing.uid;
      console.log(
        `El email ya existia en Firebase (uid=${uid}); se reutiliza para crear el registro en la DB.`
      );
    } else {
      await prisma.$disconnect();
      throw err;
    }
  }

  // Crear en la DB con rol ADMIN. Rollback en Firebase si falla (solo si lo
  // creamos nosotros en esta corrida).
  try {
    const usuario = await prisma.usuario.create({
      data: { firebase_uid: uid, nombre, apellido, dni, email, rol: 'ADMIN' },
    });
    console.log(
      `Admin creado correctamente. id_usuario=${usuario.id_usuario}, email=${email}, rol=ADMIN`
    );
    await prisma.$disconnect();
  } catch (err) {
    if (creadoEnFirebase) {
      try {
        await admin.auth().deleteUser(uid);
        console.error('Rollback: usuario de Firebase eliminado porque fallo la creacion en la DB.');
      } catch {
        // rollback best-effort
      }
    }
    await prisma.$disconnect();
    if (err.code === 'P2002') {
      console.error(
        `No se pudo crear el admin: ya existe un usuario con ese campo unico (${err.meta?.target ?? 'email/dni'} duplicado).`
      );
      process.exit(1);
    }
    throw err;
  }
}

main().catch(async (e) => {
  console.error('Error creando admin:', e.message);
  try {
    await prisma.$disconnect();
  } catch {
    // noop
  }
  process.exit(1);
});
