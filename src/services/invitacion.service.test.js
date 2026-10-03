import { describe, it, expect, afterEach } from 'vitest';
import {
  ALFABETO_CODIGO,
  LARGO_CODIGO,
  generarCodigo,
  formatearCodigo,
  normalizarCodigo,
  hashCodigo,
  secretoInvitaciones,
  vigenciaHoras,
  intentosMaxCanje,
  ventanaCanjeMinutos,
} from './invitacion.service.js';

const ENV_ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ENV_ORIGINAL };
});

describe('alfabeto y generacion', () => {
  it('el alfabeto no tiene caracteres ambiguos (0/O, 1/I/L)', () => {
    for (const c of ['0', 'O', '1', 'I', 'L']) expect(ALFABETO_CODIGO).not.toContain(c);
  });
  it('genera codigos de 10 caracteres del alfabeto', () => {
    for (let i = 0; i < 200; i++) {
      const c = generarCodigo();
      expect(c).toHaveLength(LARGO_CODIGO);
      for (const ch of c) expect(ALFABETO_CODIGO).toContain(ch);
    }
  });
  it('no repite en 1000 codigos (sanity check del random)', () => {
    const vistos = new Set(Array.from({ length: 1000 }, generarCodigo));
    expect(vistos.size).toBe(1000);
  });
});

describe('formato y normalizacion', () => {
  it('formatea como XXXXX-XXXXX', () => {
    expect(formatearCodigo('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
  });
  it('ignora guiones, espacios y mayusculas', () => {
    expect(normalizarCodigo(' abcde-fghjk ')).toBe('ABCDEFGHJK');
    expect(normalizarCodigo('ab cde - fg hjk')).toBe('ABCDEFGHJK');
  });
  it('formatear y normalizar son inversas', () => {
    const c = generarCodigo();
    expect(normalizarCodigo(formatearCodigo(c))).toBe(c);
  });
});

describe('hashCodigo', () => {
  it('es determinístico, hex de 64 y depende del secreto', () => {
    const a = hashCodigo('ABCDEFGHJK', 's1');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCodigo('ABCDEFGHJK', 's1')).toBe(a);
    expect(hashCodigo('ABCDEFGHJK', 's2')).not.toBe(a);
    expect(hashCodigo('ABCDEFGHJM', 's1')).not.toBe(a);
  });
  it('no contiene el codigo en claro', () => {
    expect(hashCodigo('ABCDEFGHJK', 's1')).not.toContain('ABCDEFGHJK');
  });
  it('tira si no hay secreto', () => {
    delete process.env.INVITACION_SECRETO;
    expect(() => hashCodigo('ABCDEFGHJK')).toThrow(/INVITACION_SECRETO/);
  });
});

describe('configuracion por entorno', () => {
  it('secreto vacio cuenta como ausente', () => {
    process.env.INVITACION_SECRETO = '   ';
    expect(secretoInvitaciones()).toBeNull();
    process.env.INVITACION_SECRETO = 'x';
    expect(secretoInvitaciones()).toBe('x');
  });
  it('defaults 72 / 5 / 15 con valores ausentes o basura', () => {
    delete process.env.INVITACION_VIGENCIA_HORAS;
    process.env.INVITACION_INTENTOS_MAX = 'abc';
    process.env.INVITACION_VENTANA_MINUTOS = '-3';
    expect(vigenciaHoras()).toBe(72);
    expect(intentosMaxCanje()).toBe(5);
    expect(ventanaCanjeMinutos()).toBe(15);
  });
  it('lee los valores en cada llamada', () => {
    process.env.INVITACION_INTENTOS_MAX = '3';
    expect(intentosMaxCanje()).toBe(3);
    process.env.INVITACION_INTENTOS_MAX = '9';
    expect(intentosMaxCanje()).toBe(9);
  });
});
