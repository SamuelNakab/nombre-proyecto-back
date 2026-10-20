// Login contra Firebase Auth (REST) para los scripts de test. UNICO lugar que
// conoce la Web API key: las suites la tenian hardcodeada y ahora sale del .env.
//
// FIREBASE_WEB_API_KEY es la Web API key del proyecto de Firebase (la misma que
// el secret de GitHub que usa el e2e). NO es la GOOGLE_MAPS_API_KEY.
import 'dotenv/config';

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1/accounts';

// Se lee en cada llamada (mismo criterio que el resto de las variables).
export function firebaseWebApiKey() {
  const key = process.env.FIREBASE_WEB_API_KEY;
  if (!key) {
    throw new Error(
      'Falta FIREBASE_WEB_API_KEY en el .env (es la Web API key de Firebase, NO la GOOGLE_MAPS_API_KEY)'
    );
  }
  return key;
}

async function llamar(accion, email, password) {
  const res = await fetch(`${IDENTITY}:${accion}?key=${firebaseWebApiKey()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  return res.json();
}

// ID token de un usuario existente. Tira si el login falla.
export async function getToken(email, password) {
  const data = await llamar('signInWithPassword', email, password);
  if (!data.idToken) throw new Error(`Firebase login fallido para ${email}: ${data.error?.message}`);
  return data.idToken;
}
