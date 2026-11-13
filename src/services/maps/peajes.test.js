import { describe, it, expect } from 'vitest';
import { dineroAPesos, leerTollInfo, parsearPeajes } from './peajes.js';

const ars = (units, nanos) => ({ currencyCode: 'ARS', ...(units != null ? { units } : {}), ...(nanos != null ? { nanos } : {}) });
const peaje = (...precios) => ({ estimatedPrice: precios });
const ruta = (total, legs) => ({
  ...(total !== undefined ? { travelAdvisory: { tollInfo: total } } : {}),
  legs: legs.map((t) => (t === undefined ? {} : { travelAdvisory: { tollInfo: t } })),
});

describe('dineroAPesos', () => {
  it('units (string) + nanos', () => {
    expect(dineroAPesos(ars('5187', 60000000))).toBeCloseTo(5187.06, 10);
    expect(dineroAPesos(ars('6483', 840000000))).toBeCloseTo(6483.84, 10);
  });

  it('units y nanos omitidos cuando valen 0 (proto3)', () => {
    expect(dineroAPesos({ currencyCode: 'ARS' })).toBe(0);
    expect(dineroAPesos(ars(undefined, 500000000))).toBe(0.5);
    expect(dineroAPesos(ars('120'))).toBe(120);
  });
});

describe('leerTollInfo', () => {
  it('sin tollInfo = sin peajes (0, completo)', () => {
    expect(leerTollInfo(undefined)).toEqual({ pesos: 0, hayPeaje: false, conocido: true, incompleto: false });
  });

  it('tollInfo sin estimatedPrice = peaje con tarifa desconocida', () => {
    expect(leerTollInfo({})).toMatchObject({ pesos: 0, hayPeaje: true, conocido: false, incompleto: true });
  });

  it('otra moneda cuenta como desconocida; se suma lo conocido en ARS', () => {
    const r = leerTollInfo(peaje(ars('100'), { currencyCode: 'USD', units: '4' }));
    expect(r).toMatchObject({ pesos: 100, conocido: true, incompleto: true });
    expect(leerTollInfo(peaje({ currencyCode: 'USD', units: '4' }))).toMatchObject({ pesos: 0, conocido: false, incompleto: true });
  });
});

describe('parsearPeajes', () => {
  it('un leg (Belgrano -> La Plata real): ida redondeada y el tramo en la parada 2', () => {
    const r = parsearPeajes(ruta(peaje(ars('5187', 60000000)), [peaje(ars('5187', 60000000))]));
    expect(r).toEqual({ ida: 5187, incompleto: false, tramos: [null, 5187] });
  });

  it('redondeo normal: ,50 sube', () => {
    expect(parsearPeajes(ruta(peaje(ars('6483', 840000000)), [peaje(ars('6483', 840000000))])).ida).toBe(6484);
    expect(parsearPeajes(ruta(peaje(ars('10', 500000000)), [undefined])).ida).toBe(11);
    expect(parsearPeajes(ruta(peaje(ars('10', 499999999)), [undefined])).ida).toBe(10);
  });

  it('sin tollInfo en ningun lado = la ruta no tiene peajes (0)', () => {
    expect(parsearPeajes(ruta(undefined, [undefined, undefined]))).toEqual({ ida: 0, incompleto: false, tramos: [null, 0, 0] });
  });

  it('varios legs: cada uno en la parada donde termina; leg sin peaje = 0', () => {
    const r = parsearPeajes(ruta(peaje(ars('3000')), [undefined, peaje(ars('1000')), peaje(ars('2000'))]));
    expect(r).toEqual({ ida: 3000, incompleto: false, tramos: [null, 0, 1000, 2000] });
  });

  it('tollInfo sin precio: incompleto, se suma lo conocido y el leg desconocido queda null', () => {
    const r = parsearPeajes(ruta(peaje(ars('1000')), [peaje(ars('1000')), {}]));
    expect(r).toEqual({ ida: 1000, incompleto: true, tramos: [null, 1000, null] });
  });

  it('la ruta entera con tarifa desconocida: ida 0 e incompleto', () => {
    expect(parsearPeajes(ruta({}, [{}]))).toEqual({ ida: 0, incompleto: true, tramos: [null, null] });
  });

  it('otra moneda en un leg: incompleto aunque la ruta solo traiga ARS', () => {
    const r = parsearPeajes(ruta(peaje(ars('500')), [peaje(ars('500'), { currencyCode: 'UYU', units: '80' })]));
    expect(r).toEqual({ ida: 500, incompleto: true, tramos: [null, 500] });
  });

  it('sin legs (FieldMask sin legs): tramos solo con el origen', () => {
    expect(parsearPeajes({ travelAdvisory: { tollInfo: peaje(ars('70')) } })).toEqual({ ida: 70, incompleto: false, tramos: [null] });
  });
});
