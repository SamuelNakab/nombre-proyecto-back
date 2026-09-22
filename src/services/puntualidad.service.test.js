import { describe, it, expect, afterEach } from 'vitest';
import { calcularPuntualidadInicio } from './puntualidad.service.js';

const PROGRAMADA = new Date('2026-03-10T12:00:00.000Z');
const masMinutos = (m) => new Date(PROGRAMADA.getTime() + m * 60000);

// Los umbrales se leen del env en CADA llamada, asi que los tests que los tocan
// tienen que limpiarlos despues.
afterEach(() => {
  delete process.env.PUNTUALIDAD_TARDE_MINUTOS;
  delete process.env.PUNTUALIDAD_MUY_TARDE_MINUTOS;
});

const viaje = (llegada) => ({
  fecha_programada: PROGRAMADA,
  fecha_llegada_origen: llegada,
});

describe('calcularPuntualidadInicio', () => {
  it('llegar antes de hora es A_TIEMPO', () => {
    expect(calcularPuntualidadInicio(viaje(masMinutos(-45)))).toBe('A_TIEMPO');
    expect(calcularPuntualidadInicio(viaje(PROGRAMADA))).toBe('A_TIEMPO');
  });

  it('clasifica los tres tramos con los defaults (30 / 120)', () => {
    expect(calcularPuntualidadInicio(viaje(masMinutos(10)))).toBe('A_TIEMPO');
    expect(calcularPuntualidadInicio(viaje(masMinutos(45)))).toBe('TARDE');
    expect(calcularPuntualidadInicio(viaje(masMinutos(180)))).toBe('MUY_TARDE');
  });

  // Los bordes son <=, no <: exactamente 30 todavia es A_TIEMPO y exactamente
  // 120 todavia es TARDE. Mismo criterio que tenia el calculo viejo.
  it('los bordes exactos caen en el tramo de abajo', () => {
    expect(calcularPuntualidadInicio(viaje(masMinutos(30)))).toBe('A_TIEMPO');
    expect(calcularPuntualidadInicio(viaje(masMinutos(31)))).toBe('TARDE');
    expect(calcularPuntualidadInicio(viaje(masMinutos(120)))).toBe('TARDE');
    expect(calcularPuntualidadInicio(viaje(masMinutos(121)))).toBe('MUY_TARDE');
  });

  it('respeta los umbrales configurados por env', () => {
    process.env.PUNTUALIDAD_TARDE_MINUTOS = '5';
    process.env.PUNTUALIDAD_MUY_TARDE_MINUTOS = '10';
    expect(calcularPuntualidadInicio(viaje(masMinutos(3)))).toBe('A_TIEMPO');
    expect(calcularPuntualidadInicio(viaje(masMinutos(7)))).toBe('TARDE');
    expect(calcularPuntualidadInicio(viaje(masMinutos(20)))).toBe('MUY_TARDE');
  });

  it('un umbral basura cae al default en vez de romper', () => {
    process.env.PUNTUALIDAD_TARDE_MINUTOS = 'no-es-un-numero';
    expect(calcularPuntualidadInicio(viaje(masMinutos(10)))).toBe('A_TIEMPO');
    expect(calcularPuntualidadInicio(viaje(masMinutos(45)))).toBe('TARDE');
  });

  // El nucleo del cambio de semantica: los 845 viajes anteriores no tienen
  // fecha_llegada_origen, y devuelven null SIN IMPORTAR lo que diga la columna
  // muerta puntualidad_inicio, que se calculo midiendo la SALIDA.
  it('es null si el viaje todavia no llego al origen', () => {
    expect(calcularPuntualidadInicio(viaje(null))).toBe(null);
  });

  it('ignora por completo la columna muerta puntualidad_inicio', () => {
    expect(
      calcularPuntualidadInicio({
        fecha_programada: PROGRAMADA,
        fecha_llegada_origen: null,
        puntualidad_inicio: 'A_TIEMPO',
      })
    ).toBe(null);

    expect(
      calcularPuntualidadInicio({
        fecha_programada: PROGRAMADA,
        fecha_llegada_origen: masMinutos(200),
        puntualidad_inicio: 'A_TIEMPO',
      })
    ).toBe('MUY_TARDE');
  });

  it('acepta las fechas como string ISO, no solo como Date', () => {
    expect(
      calcularPuntualidadInicio({
        fecha_programada: PROGRAMADA.toISOString(),
        fecha_llegada_origen: masMinutos(45).toISOString(),
      })
    ).toBe('TARDE');
  });

  // El guard que evita el bug silencioso: un select al que se le olvido
  // fecha_llegada_origen devolveria null y toda la metrica saldria vacia.
  it('tira error si falta fecha_programada o fecha_llegada_origen', () => {
    expect(() => calcularPuntualidadInicio({ fecha_llegada_origen: PROGRAMADA })).toThrow(
      /fecha_programada y fecha_llegada_origen/
    );
    expect(() => calcularPuntualidadInicio({ fecha_programada: PROGRAMADA })).toThrow(
      /fecha_programada y fecha_llegada_origen/
    );
  });
});
