import { describe, it, expect } from 'vitest';
import { esHoraPico } from './tarifa.service.js';

describe('esHoraPico', () => {
  it('detecta hora pico en la mañana (7-10h)', () => {
    expect(esHoraPico(new Date('2026-07-01T08:30:00'))).toBe(true);
  });
  it('detecta hora pico en la tarde (17-20h)', () => {
    expect(esHoraPico(new Date('2026-07-01T18:00:00'))).toBe(true);
  });
  it('NO marca como pico un horario fuera de esas franjas', () => {
    expect(esHoraPico(new Date('2026-07-01T14:00:00'))).toBe(false);
  });
});
