import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// El cliente real no se usa: cada test inyecta uno falso.
vi.mock('../config/redis.js', () => ({ default: { status: 'end' } }));

const { obtenerPeajesGoogle, clavePeajes, franjaHoraria, ORIGEN_PEAJES, _reiniciarReportes } = await import(
  './peajes.service.js'
);
const { configPrecio } = await import('../config/precio.js');

const BELGRANO = { lat: -34.5627, lng: -58.4566 };
const LA_PLATA = { latitud: -34.9214, longitud: -57.9545 };
const PARADAS = [BELGRANO, LA_PLATA];
// Lunes 16-11-2026 14:00 en Buenos Aires (UTC-3).
const SALIDA = new Date('2026-11-16T17:00:00Z');
const RESULTADO = { ida: 5187, incompleto: false, tramos: [null, 5187] };

function redisFalso({ status = 'ready', guardado = null, getFalla = null, setFalla = null } = {}) {
  const store = new Map(guardado ? [[guardado.clave, JSON.stringify(guardado.valor)]] : []);
  return {
    status,
    store,
    get: vi.fn(async (k) => {
      if (getFalla) return getFalla();
      return store.get(k) ?? null;
    }),
    set: vi.fn(async (k, v) => {
      if (setFalla) return setFalla();
      store.set(k, v);
      return 'OK';
    }),
  };
}

const deps = (extra = {}) => ({
  calcular: vi.fn(async () => RESULTADO),
  cliente: redisFalso(),
  config: () => configPrecio({}),
  reportar: vi.fn(),
  proveedor: () => 'routes',
  ...extra,
});

beforeEach(() => {
  _reiniciarReportes();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('clavePeajes', () => {
  it('franja horaria en hora argentina', () => {
    expect(franjaHoraria(SALIDA)).toBe('2026-11-16T14');
    expect(franjaHoraria(new Date('2026-11-17T02:30:00Z'))).toBe('2026-11-16T23');
  });

  it('misma clave dentro de la misma hora local; distinta en otra hora', () => {
    const k = clavePeajes(PARADAS, SALIDA);
    expect(k).toMatch(/^peajes:[0-9a-f]{64}$/);
    expect(clavePeajes(PARADAS, new Date('2026-11-16T17:59:59Z'))).toBe(k);
    expect(clavePeajes(PARADAS, new Date('2026-11-16T18:00:00Z'))).not.toBe(k);
  });

  it('coordenadas redondeadas a 5 decimales, acepta lat/lng y latitud/longitud', () => {
    const k = clavePeajes(PARADAS, SALIDA);
    expect(clavePeajes([{ latitud: -34.562701, longitud: -58.456599 }, { lat: -34.9214, lng: -57.9545 }], SALIDA)).toBe(k);
    expect(clavePeajes([{ lat: -34.56272, lng: -58.4566 }, LA_PLATA], SALIDA)).not.toBe(k);
  });

  it('el orden de las paradas importa', () => {
    expect(clavePeajes([LA_PLATA, BELGRANO], SALIDA)).not.toBe(clavePeajes(PARADAS, SALIDA));
  });
});

describe('obtenerPeajesGoogle', () => {
  it('sin cache: llama a Google con las paradas y la salida, y guarda el CRUDO con el TTL', async () => {
    const d = deps();
    const r = await obtenerPeajesGoogle({ paradas: PARADAS, salida: SALIDA }, d);
    expect(r).toEqual({ ...RESULTADO, error: false, origen: ORIGEN_PEAJES.GOOGLE });
    expect(d.calcular).toHaveBeenCalledTimes(1);
    expect(d.calcular.mock.calls[0][0]).toMatchObject({ puntos: PARADAS, salida: SALIDA });
    expect(d.cliente.set).toHaveBeenCalledWith(clavePeajes(PARADAS, SALIDA), JSON.stringify(RESULTADO), 'EX', 900);
  });

  it('acierto de cache: no llama a Google', async () => {
    const cliente = redisFalso({ guardado: { clave: clavePeajes(PARADAS, SALIDA), valor: RESULTADO } });
    const d = deps({ cliente });
    const r = await obtenerPeajesGoogle({ paradas: PARADAS, salida: SALIDA }, d);
    expect(r).toEqual({ ...RESULTADO, error: false, origen: ORIGEN_PEAJES.CACHE });
    expect(d.calcular).not.toHaveBeenCalled();
    expect(console.log.mock.calls.flat().join(' ')).toMatch(/\[peajes\] cache hit/);
  });

  it('dos calculos seguidos del mismo viaje = UNA llamada', async () => {
    const d = deps();
    await obtenerPeajesGoogle({ paradas: PARADAS, salida: SALIDA }, d);
    const r = await obtenerPeajesGoogle({ paradas: PARADAS, salida: new Date('2026-11-16T17:40:00Z') }, d);
    expect(r.origen).toBe(ORIGEN_PEAJES.CACHE);
    expect(d.calcular).toHaveBeenCalledTimes(1);
  });

  it('un valor basura en el cache cuenta como fallo de cache', async () => {
    const cliente = redisFalso({ guardado: { clave: clavePeajes(PARADAS, SALIDA), valor: { ida: 'x' } } });
    const d = deps({ cliente });
    expect((await obtenerPeajesGoogle({ paradas: PARADAS, salida: SALIDA }, d)).origen).toBe(ORIGEN_PEAJES.GOOGLE);
  });

  it('Redis caido (no ready): sigue sin cache, llama a Google y no escribe', async () => {
    const d = deps({ cliente: redisFalso({ status: 'reconnecting' }) });
    const r = await obtenerPeajesGoogle({ paradas: PARADAS, salida: SALIDA }, d);
    expect(r.origen).toBe(ORIGEN_PEAJES.GOOGLE);
    expect(d.cliente.get).not.toHaveBeenCalled();
    expect(d.cliente.set).not.toHaveBeenCalled();
  });

  it('Redis que tira en get y en set: sigue sin cache y no tira', async () => {
    const cliente = redisFalso({
      getFalla: () => Promise.reject(new Error('ECONNRESET')),
      setFalla: () => Promise.reject(new Error('ECONNRESET')),
    });
    const r = await obtenerPeajesGoogle({ paradas: PARADAS, salida: SALIDA }, deps({ cliente }));
    expect(r).toEqual({ ...RESULTADO, error: false, origen: ORIGEN_PEAJES.GOOGLE });
  });

  it('Redis colgado: corta a los 500 ms y sigue', async () => {
    const cliente = redisFalso({ getFalla: () => new Promise(() => {}) });
    const t0 = Date.now();
    const r = await obtenerPeajesGoogle({ paradas: PARADAS, salida: SALIDA }, deps({ cliente }));
    expect(r.origen).toBe(ORIGEN_PEAJES.GOOGLE);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('cache en 0: ni lee ni escribe', async () => {
    const d = deps({ config: () => configPrecio({ PRECIO_PEAJES_CACHE_SEGUNDOS: '0' }) });
    await obtenerPeajesGoogle({ paradas: PARADAS, salida: SALIDA }, d);
    expect(d.cliente.get).not.toHaveBeenCalled();
    expect(d.cliente.set).not.toHaveBeenCalled();
  });

  it('falla de Google: NO tira, error true, sin dato, warning a Sentry y no se cachea', async () => {
    const err = Object.assign(new Error('timeout'), { tipo: 'NO_DISPONIBLE', detalle: 'timeout' });
    const d = deps({ calcular: vi.fn(async () => Promise.reject(err)) });
    const r = await obtenerPeajesGoogle({ paradas: PARADAS, salida: SALIDA }, d);
    expect(r).toEqual({ ida: null, incompleto: null, tramos: null, error: true, origen: ORIGEN_PEAJES.ERROR });
    expect(d.reportar).toHaveBeenCalledWith(err, { contexto: 'peajes-google', nivel: 'warning' });
    expect(d.cliente.set).not.toHaveBeenCalled();
    expect(console.error.mock.calls.flat().join(' ')).toMatch(/\[peajes\] no se pudieron calcular/);
  });

  it('Sentry: a lo sumo un warning por minuto', async () => {
    const d = deps({ calcular: vi.fn(async () => Promise.reject(new Error('cuota'))) });
    await obtenerPeajesGoogle({ paradas: PARADAS, salida: SALIDA }, d);
    await obtenerPeajesGoogle({ paradas: PARADAS, salida: SALIDA }, d);
    expect(d.calcular).toHaveBeenCalledTimes(2);
    expect(d.reportar).toHaveBeenCalledTimes(1);
  });

  it('kill switch: no llama a Google ni al cache', async () => {
    const d = deps({ config: () => configPrecio({ PEAJES_GOOGLE_HABILITADO: 'false' }) });
    const r = await obtenerPeajesGoogle({ paradas: PARADAS, salida: SALIDA }, d);
    expect(r).toEqual({ ida: null, incompleto: null, tramos: null, error: false, origen: ORIGEN_PEAJES.DESHABILITADO });
    expect(d.calcular).not.toHaveBeenCalled();
    expect(d.cliente.get).not.toHaveBeenCalled();
  });

  it('MAPS_PROVIDER=legacy: no se calcula (no es un error)', async () => {
    const d = deps({ proveedor: () => 'legacy' });
    const r = await obtenerPeajesGoogle({ paradas: PARADAS, salida: SALIDA }, d);
    expect(r).toMatchObject({ ida: null, error: false, origen: ORIGEN_PEAJES.LEGACY });
    expect(d.calcular).not.toHaveBeenCalled();
  });

  it('paradas mal formadas: no tira', async () => {
    const r = await obtenerPeajesGoogle({ paradas: [{}, {}], salida: SALIDA }, deps());
    expect(r).toMatchObject({ error: true, origen: ORIGEN_PEAJES.ERROR });
  });
});
