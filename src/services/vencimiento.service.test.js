import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

// ─── Ciclo INTERNO: el flag unificado ────────────────────────────────────────

describe('esViajeVencido — ciclo interno', () => {
  // La ventana se define aca, no en el .env (CI no lo tiene).
  let anterior;
  beforeEach(() => {
    anterior = process.env.VENTANA_INICIO_DESPUES_MINUTOS;
    process.env.VENTANA_INICIO_DESPUES_MINUTOS = '90';
  });
  afterEach(() => {
    if (anterior === undefined) delete process.env.VENTANA_INICIO_DESPUES_MINUTOS;
    else process.env.VENTANA_INICIO_DESPUES_MINUTOS = anterior;
  });

  const haceMin = (n) => new Date(Date.now() - n * 60000);

  it('VENCIDO siempre es vencido', () => {
    expect(esViajeVencido({ estado: 'VENCIDO', fecha_programada: MANIANA })).toBe(true);
  });

  it('ASIGNADO y CONFIRMADO vencen recien cuando cierra la ventana (fecha + 90 min)', () => {
    for (const estado of ['ASIGNADO', 'CONFIRMADO']) {
      expect(esViajeVencido({ estado, fecha_programada: haceMin(89) })).toBe(false);
      expect(esViajeVencido({ estado, fecha_programada: haceMin(91) })).toBe(true);
      expect(esViajeVencido({ estado, fecha_programada: MANIANA })).toBe(false);
    }
  });

  it('el resto del ciclo interno no vence', () => {
    for (const estado of ['CARGANDO', 'EN_RUTA', 'DESCARGANDO', 'FINALIZADO', 'CANCELADO', 'RECHAZADO']) {
      expect(esViajeVencido({ estado, fecha_programada: AYER })).toBe(false);
    }
  });

  it('el legacy no cambia: vence apenas pasa fecha_programada, sin ventana', () => {
    expect(esViajeVencido({ estado: 'CONDUCTOR_ASIGNADO', fecha_programada: haceMin(1) })).toBe(true);
  });
});
