import { describe, it, expect } from 'vitest';
import { motivoNoEditable, precioPagadoPendiente, editableHasta, serializarPrecioPagado } from './precio-pagado-reglas.js';

const FIN = '2026-11-01T12:00:00Z';
const fin = (dias) => new Date(new Date(FIN).getTime() + dias * 86_400_000);
const viaje = (extra = {}) => ({ estado: 'FINALIZADO', fecha_corte_precio: FIN, precio_pagado: null, ...extra });

describe('ventana del precio pagado', () => {
  it('editable hasta N dias desde el fin del viaje (inclusive)', () => {
    expect(editableHasta(viaje(), 30).toISOString()).toBe(fin(30).toISOString());
    expect(motivoNoEditable(viaje(), fin(29), 30)).toBeNull();
    expect(motivoNoEditable(viaje(), fin(30), 30)).toBeNull();
    expect(motivoNoEditable(viaje(), new Date(fin(30).getTime() + 1), 30)).toBe('VENCIDO');
  });
  it('no FINALIZADO', () => {
    expect(motivoNoEditable(viaje({ estado: 'CANCELADO' }), fin(1), 30)).toBe('NO_FINALIZADO');
    expect(motivoNoEditable(viaje({ estado: 'EN_RUTA' }), fin(1), 30)).toBe('NO_FINALIZADO');
  });
  it('FINALIZADO sin fecha de corte (anterior a la Tarea 5): vencido', () => {
    expect(motivoNoEditable(viaje({ fecha_corte_precio: null }), fin(1), 30)).toBe('VENCIDO');
  });
  it('0 dias: solo el mismo instante', () => {
    expect(motivoNoEditable(viaje(), fin(0), 0)).toBeNull();
    expect(motivoNoEditable(viaje(), fin(0.001), 0)).toBe('VENCIDO');
  });
});

describe('precio_pagado_pendiente', () => {
  it('finalizado, en ventana y sin feedback', () => {
    expect(precioPagadoPendiente(viaje(), fin(1), 30)).toBe(true);
    expect(precioPagadoPendiente(viaje({ precio_pagado: { monto: 1 } }), fin(1), 30)).toBe(false);
    expect(precioPagadoPendiente(viaje(), fin(31), 30)).toBe(false);
    expect(precioPagadoPendiente(viaje({ estado: 'ASIGNADO' }), fin(1), 30)).toBe(false);
  });
  it('tira si el include no trajo la relacion', () => {
    expect(() => precioPagadoPendiente({ estado: 'FINALIZADO', fecha_corte_precio: FIN }, fin(1), 30)).toThrow();
  });
  it('serializa null', () => {
    expect(serializarPrecioPagado(null)).toBeNull();
  });
});
