import { describe, it, expect } from 'vitest';
import { idParam, ID_MAX } from './id-param.js';

describe('idParam', () => {
  it('acepta enteros positivos dentro de INT4', () => {
    expect(idParam('1')).toBe(1);
    expect(idParam('42')).toBe(42);
    expect(idParam(7)).toBe(7);
    expect(idParam(String(ID_MAX))).toBe(ID_MAX);
  });
  it('rechaza lo que antes llegaba a Prisma y daba 500', () => {
    for (const v of ['abc', 'undefined', '1.5', '0', '-1', '', ' ', '1e3', '0x10', String(ID_MAX + 1), '99999999999', undefined, null, NaN]) {
      expect(idParam(v), String(v)).toBeNull();
    }
  });
});
