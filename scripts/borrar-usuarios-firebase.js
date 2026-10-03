import 'dotenv/config';
import admin from 'firebase-admin';

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});

// Emails que NO se borran (agregá los que quieras conservar)
const CONSERVAR = new Set(['admin-test@fleter.com']);

const CONFIRMAR = process.argv.includes('--confirmar');

async function main() {
  const uids = [];
  let pageToken;
  do {
    const res = await admin.auth().listUsers(1000, pageToken);
    for (const u of res.users) {
      if (!CONSERVAR.has(u.email)) uids.push(u.uid);
    }
    pageToken = res.pageToken;
  } while (pageToken);

  console.log(`Usuarios a borrar: ${uids.length}`);
  if (!CONFIRMAR) {
    console.log('Simulacro. Para borrar de verdad: node scripts/borrar-usuarios-firebase.js --confirmar');
    return;
  }

  for (let i = 0; i < uids.length; i += 1000) {
    const lote = uids.slice(i, i + 1000);
    const r = await admin.auth().deleteUsers(lote);
    console.log(`Lote: ${r.successCount} borrados, ${r.failureCount} fallos`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });