// Rota la password de admin-test@fleter.com en Firebase al valor de
// TEST_ADMIN_PASSWORD (Tarea 6). Hace falta porque la password vieja estuvo
// commiteada y, con la DB compartida, admin-test es un ADMIN real de production.
// Sigue en el historial de git: por eso se ROTA, no alcanza con sacarla del codigo.
//
//   1. Poner una password nueva (12+ caracteres) en TEST_ADMIN_PASSWORD del .env.
//   2. node scripts/rotar-password-admin-test.js
//
// Solo toca esa cuenta en Firebase (no la DB) y despues verifica haciendo login
// con la password nueva. seed-cuentas-test.js hace lo mismo como efecto
// colateral (resetea la password de cada cuenta fija), pero tambien toca las demas.
import 'dotenv/config';
import admin from '../src/config/firebase.js';
import { getToken, credencialesAdminTest } from './_firebase-auth.js';

const MINIMO = 12;

async function main() {
  const { email, password } = credencialesAdminTest();
  if (password.length < MINIMO) {
    throw new Error(`TEST_ADMIN_PASSWORD tiene que tener al menos ${MINIMO} caracteres`);
  }
  const usuario = await admin.auth().getUserByEmail(email);
  await admin.auth().updateUser(usuario.uid, { password });
  console.log(`  password de ${email} actualizada en Firebase (uid ${usuario.uid})`);
  await getToken(email, password);
  console.log('  login con la password nueva: OK');
}

main().catch((e) => {
  console.error(`💥 ${e.message}`);
  process.exitCode = 1;
});
