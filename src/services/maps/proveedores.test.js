import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as routes from './routes.js';
import * as legacy from './legacy.js';
import { ErrorMaps } from './comun.js';
import { calcularTramo, calcularEta, calcularRuta, estadisticasMaps } from './index.js';

const A = { lat: -34.6037, lng: -58.3816 };
const B = { latitud: -34.6098, longitud: -58.3925 };
const AHORA = new Date('2026-10-09T13:00:00Z');
const ENCODED = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

describe('routes.js — pedidos', () => {
  it('tramo: TRAFFIC_AWARE, FieldMask minimo, key en header y departureTime futuro', () => {
    const salida = new Date(AHORA.getTime() + 3600_000);
    const p = routes.pedidoTramo({ origen: A, destino: B, salida, ahora: AHORA, apiKey: 'K' });
    const body = JSON.parse(p.init.body);
    expect(p.sku).toBe('PRO');
    expect(p.url).not.toContain('K');
    expect(p.init.headers['X-Goog-Api-Key']).toBe('K');
    expect(p.init.headers['X-Goog-FieldMask']).toBe(
      'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'
    );
    expect(body.routingPreference).toBe('TRAFFIC_AWARE');
    expect(body.departureTime).toBe(salida.toISOString());
    expect(body.origin.location.latLng).toEqual({ latitude: A.lat, longitude: A.lng });
    expect(body.destination.location.latLng).toEqual({ latitude: B.latitud, longitude: B.longitud });
  });

  it('tramo: una salida pasada o inminente NO manda departureTime (Google usa ahora)', () => {
    for (const ms of [-60_000, 0, 30_000]) {
      const p = routes.pedidoTramo({
        origen: A,
        destino: B,
        salida: new Date(AHORA.getTime() + ms),
        ahora: AHORA,
        apiKey: 'K',
      });
      expect(JSON.parse(p.init.body).departureTime).toBeUndefined();
    }
  });

  it('ruta: Essentials sin trafico; mas de 10 intermedios sube a Pro', () => {
    const p = routes.pedidoRuta({ puntos: [A, B, A], apiKey: 'K' });
    const body = JSON.parse(p.init.body);
    expect(p.sku).toBe('ESSENTIALS');
    expect(body.routingPreference).toBe('TRAFFIC_UNAWARE');
    expect(body.intermediates).toHaveLength(1);
    expect(routes.pedidoRuta({ puntos: Array(13).fill(A), apiKey: 'K' }).sku).toBe('PRO');
  });
});

describe('routes.js — respuestas', () => {
  it('tramo: duracion, distancia y polilinea [lng, lat]', () => {
    const r = routes.leerTramo({
      routes: [{ duration: '658s', distanceMeters: 2418, polyline: { encodedPolyline: ENCODED } }],
    });
    expect(r.manejo_horas).toBeCloseTo(658 / 3600, 10);
    expect(r.distancia_km).toBeCloseTo(2.418, 10);
    expect(r.polilinea[0]).toEqual([-120.2, 38.5]);
  });

  it('distanceMeters omitido (0 en proto3) -> 0 km', () => {
    expect(routes.leerTramo({ routes: [{ duration: '0s' }] }).distancia_km).toBe(0);
  });

  it('routes vacio -> SIN_RUTA (400)', () => {
    for (const cuerpo of [{}, { routes: [] }, null]) {
      expect(() => routes.leerTramo(cuerpo)).toThrow(expect.objectContaining({ tipo: 'SIN_RUTA', status: 400 }));
    }
  });

  it('eta: segundos enteros', () => {
    expect(routes.leerEta({ routes: [{ duration: '123.6s', distanceMeters: 900 }] })).toEqual({
      segundos: 124,
      distancia_metros: 900,
    });
  });
});

describe('legacy.js (rollback)', () => {
  it('usa duration_in_traffic y departure_time en epoch', () => {
    const salida = new Date(AHORA.getTime() + 3600_000);
    const p = legacy.pedidoTramo({ origen: A, destino: B, salida, ahora: AHORA, apiKey: 'K' });
    expect(new URL(p.url).searchParams.get('departure_time')).toBe(String(Math.floor(salida / 1000)));
    const r = legacy.leerTramo({
      status: 'OK',
      routes: [
        {
          legs: [{ duration: { value: 500 }, duration_in_traffic: { value: 720 }, distance: { value: 3000 } }],
          overview_polyline: { points: ENCODED },
        },
      ],
    });
    expect(r.manejo_horas).toBeCloseTo(720 / 3600, 10);
    expect(r.distancia_km).toBe(3);
  });

  it('ZERO_RESULTS -> 400; REQUEST_DENIED -> 503', () => {
    expect(() => legacy.leerTramo({ status: 'ZERO_RESULTS' })).toThrow(
      expect.objectContaining({ tipo: 'SIN_RUTA', status: 400 })
    );
    expect(() => legacy.leerTramo({ status: 'REQUEST_DENIED', error_message: 'x' })).toThrow(
      expect.objectContaining({ tipo: 'NO_DISPONIBLE', status: 503 })
    );
  });
});

// La capa entera, con fetch falso: el mapeo de errores de punta a punta.
describe('index.js — errores de la capa', () => {
  const keyOriginal = process.env.GOOGLE_MAPS_API_KEY;
  const respuesta = (status, cuerpo) => ({ ok: status >= 200 && status < 300, status, json: async () => cuerpo });

  beforeEach(() => {
    process.env.GOOGLE_MAPS_API_KEY = 'clave-de-test';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env.GOOGLE_MAPS_API_KEY = keyOriginal;
  });

  const tramo = () => calcularTramo({ origen: A, destino: B, salida: AHORA, ahora: AHORA });

  it.each([
    ['403', () => respuesta(403, { error: { message: 'API key not valid' } })],
    ['500', () => respuesta(500, null)],
    ['503', () => respuesta(503, null)],
  ])('HTTP %s -> 503', async (_n, fn) => {
    vi.stubGlobal('fetch', vi.fn(async () => fn()));
    await expect(tramo()).rejects.toMatchObject({ status: 503, tipo: 'NO_DISPONIBLE' });
  });

  it('timeout -> 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      })
    );
    await expect(calcularEta({ origen: A, destino: B })).rejects.toMatchObject({ status: 503, detalle: 'timeout' });
  });

  it('sin ruta -> 400', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respuesta(200, {})));
    await expect(tramo()).rejects.toMatchObject({ status: 400, tipo: 'SIN_RUTA' });
  });

  it('sin key -> 503 sin llamar a Google', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const fetchFalso = vi.fn();
    vi.stubGlobal('fetch', fetchFalso);
    await expect(calcularRuta([A, B])).rejects.toBeInstanceOf(ErrorMaps);
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it('OK -> resultado, y cuenta la llamada por SKU', async () => {
    const antes = estadisticasMaps().por_sku.PRO ?? 0;
    vi.stubGlobal('fetch', vi.fn(async () => respuesta(200, { routes: [{ duration: '60s', distanceMeters: 1000 }] })));
    const r = await tramo();
    expect(r).toEqual({ distancia_km: 1, manejo_horas: 60 / 3600, polilinea: [] });
    expect(estadisticasMaps().por_sku.PRO).toBe(antes + 1);
  });

  it('nunca loguea la key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respuesta(403, { error: { message: 'denied' } })));
    await tramo().catch(() => {});
    const logs = [...console.error.mock.calls, ...console.log.mock.calls].flat().join(' ');
    expect(logs).not.toContain('clave-de-test');
  });
});
