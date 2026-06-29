import { describe, it, expect, beforeAll } from 'vitest';

const API_URL = process.env.TEST_API_URL;
const FIREBASE_KEY = process.env.FIREBASE_WEB_API_KEY;
const EMAIL = process.env.TEST_USER_EMAIL;
const PASSWORD = process.env.TEST_USER_PASSWORD;

let token;

describe('E2E: login y creacion de viaje contra staging', () => {
  beforeAll(async () => {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true })
      }
    );
    const data = await res.json();
    token = data.idToken;
  });

  it('el usuario de prueba puede loguearse', () => {
    expect(token).toBeTruthy();
  });

  it('el cliente autenticado puede crear un viaje', async () => {
    const fechaProgramada = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const res = await fetch(`${API_URL}/api/viajes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        zona: 'CABA',
        fecha_programada: fechaProgramada,
        paradas: [
          { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' },
          { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' }
        ]
      })
    });
    expect(res.status).toBe(201);
    const viaje = await res.json();
    expect(viaje.id_viaje).toBeTruthy();
  });
});