import { describe, it, expect, vi } from 'vitest';
import { configPrecio, leerConfigPrecio, advertirConfigPrecio, DEFINICION_PRECIO } from './precio.js';

describe('configPrecio', () => {
  it('sin variables: todos los defaults, sin invalidas', () => {
    const { valores, invalidas } = leerConfigPrecio({});
    expect(invalidas).toEqual([]);
    expect(valores.PRECIO_MINIMO_LIVIANO).toBe(84000);
    expect(valores.PRECIO_REDONDEO).toBe(1000);
    expect(valores.FEEDBACK_PRECIO_MONTO_MAX).toBe(100000000);
    expect(Object.keys(valores)).toHaveLength(Object.keys(DEFINICION_PRECIO).length);
  });

  it('el 0 vale en los numericos', () => {
    const v = configPrecio({ PRECIO_RECARGO_PROVINCIA_PORCENTAJE: '0', PRECIO_MINUTOS_POR_PARADA: '0' });
    expect(v.PRECIO_RECARGO_PROVINCIA_PORCENTAJE).toBe(0);
    expect(v.PRECIO_MINUTOS_POR_PARADA).toBe(0);
  });

  it('decimales y espacios', () => {
    expect(configPrecio({ PRECIO_KM_IDA: ' 4500.5 ' }).PRECIO_KM_IDA).toBe(4500.5);
  });

  it.each([
    ['vacio', ''],
    ['invalido', 'abc'],
    ['negativo', '-5'],
    ['infinito', 'Infinity'],
  ])('%s -> default y queda como invalida', (_n, valor) => {
    const { valores, invalidas } = leerConfigPrecio({ PRECIO_KM_IDA: valor });
    expect(valores.PRECIO_KM_IDA).toBe(4500);
    expect(invalidas).toEqual([{ nombre: 'PRECIO_KM_IDA', valor, defecto: 4500 }]);
  });

  it('horas minimas, fraccion y redondeo tienen que ser > 0', () => {
    const { valores, invalidas } = leerConfigPrecio({
      PRECIO_MINIMO_HORAS_CAMION: '0',
      PRECIO_FRACCION_MINUTOS: '0',
      PRECIO_REDONDEO: '0',
    });
    expect(valores.PRECIO_MINIMO_HORAS_CAMION).toBe(4);
    expect(valores.PRECIO_FRACCION_MINUTOS).toBe(30);
    expect(valores.PRECIO_REDONDEO).toBe(1000);
    expect(invalidas).toHaveLength(3);
  });

  it('las cantidades y los dias tienen que ser enteros', () => {
    const v = configPrecio({ PRECIO_AYUDANTES_MAX: '1.5', FEEDBACK_PRECIO_EDICION_DIAS: '0', PRECIO_GPS_MIN_PUNTOS: '3' });
    expect(v.PRECIO_AYUDANTES_MAX).toBe(1);
    expect(v.FEEDBACK_PRECIO_EDICION_DIAS).toBe(0);
    expect(v.PRECIO_GPS_MIN_PUNTOS).toBe(3);
  });

  it('advertirConfigPrecio loguea una linea por invalida', () => {
    const log = vi.fn();
    const r = advertirConfigPrecio({ PRECIO_KM_IDA: '-1', PRECIO_REDONDEO: 'x' }, log);
    expect(r).toHaveLength(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toMatch(/^\[precio\] PRECIO_KM_IDA="-1" invalido: se usa el default 4500$/);
  });
});
