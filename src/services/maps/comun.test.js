import { describe, it, expect } from 'vitest';
import {
  ErrorMaps,
  MENSAJE_NO_DISPONIBLE,
  concatenarPolilineas,
  decodificarPolilinea,
  duracionASegundos,
  errorDeRed,
  errorDesdeHttp,
  metrosAKm,
  sinRuta,
} from './comun.js';
import { ErrorNegocio } from '../error-negocio.js';

describe('conversiones de la respuesta de Routes', () => {
  it('duration "123s" y "3.5s" -> segundos', () => {
    expect(duracionASegundos('123s')).toBe(123);
    expect(duracionASegundos('3.5s')).toBe(3.5);
    expect(duracionASegundos('0s')).toBe(0);
  });

  it('una duration ilegible tira NO_DISPONIBLE (nunca se inventa un valor)', () => {
    for (const malo of [undefined, null, 123, '123', 's', '-5s', 'abc']) {
      expect(() => duracionASegundos(malo)).toThrow(ErrorMaps);
    }
  });

  it('metros -> km', () => {
    expect(metrosAKm(2418)).toBeCloseTo(2.418, 10);
    expect(metrosAKm(0)).toBe(0);
    expect(() => metrosAKm('2418')).toThrow(ErrorMaps);
    expect(() => metrosAKm(-1)).toThrow(ErrorMaps);
  });
});

describe('polilineas', () => {
  it('decodifica al formato [lng, lat] (ejemplo de la doc de Google)', () => {
    expect(decodificarPolilinea('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  it('concatena tramos sin repetir el punto de union', () => {
    const a = [
      [1, 1],
      [2, 2],
    ];
    const b = [
      [2, 2],
      [3, 3],
    ];
    expect(concatenarPolilineas([a, b])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(concatenarPolilineas([a, [], b])).toHaveLength(3);
    expect(concatenarPolilineas([])).toEqual([]);
  });
});

describe('mapeo de errores', () => {
  it('timeout -> 503', () => {
    const err = errorDeRed(Object.assign(new Error('x'), { name: 'TimeoutError' }));
    expect(err).toBeInstanceOf(ErrorMaps);
    expect(err.status).toBe(503);
    expect(err.tipo).toBe('NO_DISPONIBLE');
    expect(err.detalle).toBe('timeout');
    expect(err.message).toBe(MENSAJE_NO_DISPONIBLE);
  });

  it('red caida -> 503', () => {
    expect(errorDeRed(new TypeError('fetch failed')).status).toBe(503);
  });

  it('403, 429, 5xx y un 400 de Google -> 503 (no es culpa del usuario)', () => {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const err = errorDesdeHttp(status, { error: { message: 'algo' } });
      expect(err.status).toBe(503);
      expect(err.tipo).toBe('NO_DISPONIBLE');
    }
  });

  it('sin ruta -> 400, y es un ErrorNegocio (sale por responderErrorNegocio)', () => {
    const err = sinRuta('routes vacio');
    expect(err.status).toBe(400);
    expect(err.tipo).toBe('SIN_RUTA');
    expect(err).toBeInstanceOf(ErrorNegocio);
  });
});
