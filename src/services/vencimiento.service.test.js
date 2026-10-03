import { describe, it, expect } from 'vitest';
import { esViajeVencido, ESTADOS_VENCIBLES } from './vencimiento.service.js';

const AYER = new Date(Date.now() - 24 * 60 * 60 * 1000);
const MANIANA = new Date(Date.now() + 24 * 60 * 60 * 1000);

describe('esViajeVencido', () => {
  it('es true si la fecha paso y el viaje sigue esperando', () => {
    expect(esViajeVencido({ estado: 'BUSCANDO_CONDUCTOR', fecha_programada: AYER })).toBe(true);
    expect(esViajeVencido({ estado: 'CONDUCTOR_ASIGNADO', fecha_programada: AYER })).toBe(true);
  });

  it('es false si la fecha todavia no llego', () => {
    expect(esViajeVencido({ estado: 'BUSCANDO_CONDUCTOR', fecha_programada: MANIANA })).toBe(false);
    expect(esViajeVencido({ estado: 'CONDUCTOR_ASIGNADO', fecha_programada: MANIANA })).toBe(false);
  });

  // Un viaje que ya arranco, que termino o que se cancelo NO esta colgado,
  // aunque su fecha_programada haya quedado atras.
  it('es false en todo estado que no sea vencible, aunque la fecha haya pasado', () => {
    const noVencibles = [
      'RESERVADO_POR_EMPRESA',
      'EN_CAMINO_A_ORIGEN',
      'CARGANDO',
      'EN_RUTA',
      'DESCARGANDO',
      'FINALIZADO',
      'CANCELADO',
    ];
    for (const estado of noVencibles) {
      expect(esViajeVencido({ estado, fecha_programada: AYER })).toBe(false);
    }
  });

  // RESERVADO_POR_EMPRESA queda deliberadamente afuera: mientras esta reservado
  // el viaje lo tiene una empresa, y su propio timeout de reserva lo devuelve al
  // mercado. Recien ahi puede contar como vencido.
  it('ESTADOS_VENCIBLES son exactamente los dos estados de espera', () => {
    expect(ESTADOS_VENCIBLES).toEqual(['BUSCANDO_CONDUCTOR', 'CONDUCTOR_ASIGNADO']);
  });

  it('acepta la fecha como string ISO, no solo como Date', () => {
    expect(
      esViajeVencido({ estado: 'BUSCANDO_CONDUCTOR', fecha_programada: AYER.toISOString() })
    ).toBe(true);
  });

  // El guard que evita el bug silencioso: un select al que se le olvido un campo
  // devolveria false sin que nadie se entere.
  it('tira error si falta estado o fecha_programada', () => {
    expect(() => esViajeVencido({ fecha_programada: AYER })).toThrow(
      /estado y fecha_programada/
    );
    expect(() => esViajeVencido({ estado: 'BUSCANDO_CONDUCTOR' })).toThrow(
      /estado y fecha_programada/
    );
  });
});
