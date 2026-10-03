import { describe, it, expect } from 'vitest';
import { normalizarCuit, digitoVerificador, validarCuit } from './cuit.service.js';

describe('normalizarCuit', () => {
  it('saca guiones y espacios', () => {
    expect(normalizarCuit('33-69345023-9')).toBe('33693450239');
    expect(normalizarCuit(' 33 69345023 9 ')).toBe('33693450239');
  });
});

describe('digitoVerificador', () => {
  it('calcula el digito del CUIT de AFIP (33-69345023-9)', () => {
    expect(digitoVerificador('3369345023')).toBe(9);
  });
  it('resto 0 -> digito 0 (11 se mapea a 0)', () => {
    // 20-00000006: 2*5 + 6*2 = 22 -> resto 0 -> 11 - 0 = 11 -> 0.
    expect(digitoVerificador('2000000006')).toBe(0);
  });
  it('resto 1 -> null (AFIP nunca emite digito 10)', () => {
    // 20-00000001: 2*5 + 1*2 = 12 -> resto 1 -> 11 - 1 = 10 -> invalido.
    expect(digitoVerificador('2000000001')).toBeNull();
  });
});

describe('validarCuit', () => {
  it('acepta un CUIT valido con guiones y lo devuelve normalizado', () => {
    expect(validarCuit('33-69345023-9')).toEqual({ ok: true, cuit: '33693450239' });
  });
  it('acepta uno valido sin guiones', () => {
    expect(validarCuit('20123456786')).toEqual({ ok: true, cuit: '20123456786' });
  });
  it('rechaza formato: menos de 11 digitos', () => {
    const r = validarCuit('2012345678');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/formato/);
  });
  it('rechaza formato: letras', () => {
    expect(validarCuit('20-1234567A-6').error).toMatch(/formato/);
  });
  it('rechaza digito verificador incorrecto con su propio mensaje', () => {
    const r = validarCuit('33-69345023-8');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/digito verificador/);
  });
  it('rechaza los que darian digito 10', () => {
    expect(validarCuit('20000000010').error).toMatch(/digito verificador/);
  });
});
