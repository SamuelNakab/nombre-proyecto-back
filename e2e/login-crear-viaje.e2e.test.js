// E2E contra staging: login de la cuenta e2e y el viaje INTERNO (Paso 2).
//
// Corre en el job e2e-staging de CI, DESPUES del deploy a staging (ver ci.yml).
// Solo necesita TEST_API_URL, FIREBASE_WEB_API_KEY, TEST_USER_EMAIL y
// TEST_USER_PASSWORD: la PyME y el chofer se resuelven solos (/api/auth/me y
// la lista de choferes), nada de ids como secret.
//
// La cuenta e2e, su "PyME E2E" y el chofer vinculado con el vehiculo E2E000
// (FRAGIL) los deja scripts/seed-cuentas-test.js, de forma idempotente.
//
// El viaje se CANCELA al final (y en afterAll si un assert fallo en el medio):
// staging comparte la DB con produccion y no puede quedar un viaje vivo.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const API_URL = process.env.TEST_API_URL;
const FIREBASE_KEY = process.env.FIREBASE_WEB_API_KEY;
const EMAIL = process.env.TEST_USER_EMAIL;
const PASSWORD = process.env.TEST_USER_PASSWORD;
const PATENTE_E2E = 'E2E000';

let token;
let idOrganizacion;
let idViaje = null;
let cancelado = false;

async function api(method, path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* sin cuerpo JSON */
  }
  return { status: res.status, data };
}

async function cancelarSiQuedoVivo() {
  if (idViaje === null || cancelado) return;
  const r = await api('POST', `/api/organizaciones/${idOrganizacion}/viajes/${idViaje}/cancelar`, {
    motivo: 'e2e: limpieza',
  });
  if (r.status === 200) cancelado = true;
}

describe('E2E: login y viaje interno de PyME contra staging', () => {
  beforeAll(async () => {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
      }
    );
    const data = await res.json();
    token = data.idToken;
  });

  afterAll(async () => {
    await cancelarSiQuedoVivo();
  }, 15000);

  it('el usuario de prueba puede loguearse', () => {
    expect(token).toBeTruthy();
  });

  it('la PyME crea un viaje para su chofer y lo cancela', async () => {
    const me = await api('GET', '/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.data.organizacion?.id_organizacion).toBeTruthy();
    idOrganizacion = me.data.organizacion.id_organizacion;

    const choferes = await api('GET', `/api/organizaciones/${idOrganizacion}/choferes`);
    expect(choferes.status).toBe(200);
    const chofer = choferes.data.find((c) => c.vehiculos.some((v) => v.patente === PATENTE_E2E));
    expect(chofer, `la PyME no tiene un chofer con el vehiculo ${PATENTE_E2E} (correr seed-cuentas-test.js)`).toBeTruthy();

    const fechaProgramada = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const crear = await api('POST', `/api/organizaciones/${idOrganizacion}/viajes`, {
      id_conductor: chofer.id_conductor,
      fecha_programada: fechaProgramada,
      condiciones_requeridas: ['FRAGIL'],
      descripcion: 'e2e: viaje de prueba',
      paradas: [
        { lat: -34.6037, lng: -58.3816, direccion: 'Plaza de Mayo, CABA' },
        { lat: -34.5895, lng: -58.3974, direccion: 'Recoleta, CABA' },
      ],
    });
    expect(crear.status).toBe(201);
    idViaje = crear.data.id_viaje;
    expect(idViaje).toBeTruthy();
    expect(crear.data.estado).toBe('ASIGNADO');
    expect(crear.data.id_organizacion).toBe(idOrganizacion);

    const cancelar = await api('POST', `/api/organizaciones/${idOrganizacion}/viajes/${idViaje}/cancelar`, {
      motivo: 'e2e',
    });
    expect(cancelar.status).toBe(200);
    expect(cancelar.data.estado).toBe('CANCELADO');
    cancelado = true;
  }, 30000);
});
