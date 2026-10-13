import { describe, it, expect } from 'vitest';
import { tiemposRealesDesdeParadas, tiemposRealesDesdeHistorial } from './tiempos-reales.js';

const t = (hhmm) => new Date(`2026-10-09T${hhmm}:00Z`);
const min = (horas) => Math.round(horas * 60 * 1e6) / 1e6;

// Viaje interno de 3 paradas: llega a la 1 a las 10:00, sale 10:20; maneja
// hasta la 2 (10:50), sale 11:05; maneja hasta la 3 (11:30), sale 11:45.
const completo = [
  { id_parada: 1, orden: 1, llegada_real: t('10:00'), salida_real: t('10:20') },
  { id_parada: 2, orden: 2, llegada_real: t('10:50'), salida_real: t('11:05') },
  { id_parada: 3, orden: 3, llegada_real: t('11:30'), salida_real: t('11:45') },
];

describe('tiemposRealesDesdeParadas (viaje interno)', () => {
  it('peon por parada, manejo por tramo y totales', () => {
    const r = tiemposRealesDesdeParadas(completo);
    expect(r.paradas.map((p) => [min(p.peon_real_horas), p.manejo_real_horas === null ? null : min(p.manejo_real_horas)])).toEqual([
      [20, null],
      [15, 30],
      [15, 25],
    ]);
    expect(min(r.peon_horas)).toBe(50);
    expect(min(r.manejo_horas)).toBe(55);
    // total = llegada a la 1 -> salida de la ultima (1 h 45).
    expect(min(r.total_horas)).toBe(105);
  });

  it('no importa el orden del array', () => {
    expect(min(tiemposRealesDesdeParadas([...completo].reverse()).total_horas)).toBe(105);
  });

  it('no arranco -> null', () => {
    expect(tiemposRealesDesdeParadas(completo.map((p) => ({ ...p, llegada_real: null, salida_real: null })))).toBeNull();
  });

  it('en curso sin fin: la parada abierta no tiene peon todavia', () => {
    const enCurso = [completo[0], { ...completo[1], salida_real: null }, { ...completo[2], llegada_real: null, salida_real: null }];
    const r = tiemposRealesDesdeParadas(enCurso);
    expect(r.paradas).toHaveLength(2);
    expect(r.paradas[1].peon_real_horas).toBeNull();
    expect(min(r.manejo_horas)).toBe(30);
    expect(min(r.peon_horas)).toBe(20);
  });

  it('cancelado EN una parada: la abierta se cierra en la cancelacion', () => {
    const enParada = [completo[0], { ...completo[1], salida_real: null }, { ...completo[2], llegada_real: null, salida_real: null }];
    const r = tiemposRealesDesdeParadas(enParada, t('11:00'));
    expect(min(r.paradas[1].peon_real_horas)).toBe(10);
    expect(min(r.peon_horas)).toBe(30);
    expect(min(r.manejo_horas)).toBe(30);
  });

  it('cancelado MANEJANDO: el tramo parcial suma al manejo del viaje, no a una parada', () => {
    const manejando = [completo[0], completo[1], { ...completo[2], llegada_real: null, salida_real: null }];
    const r = tiemposRealesDesdeParadas(manejando, t('11:15'));
    expect(r.paradas).toHaveLength(2);
    expect(min(r.manejo_horas)).toBe(40); // 30 del tramo 1->2 + 10 parciales
    expect(min(r.peon_horas)).toBe(35);
  });
});

describe('tiemposRealesDesdeHistorial (legacy)', () => {
  const h = (estado, hhmm) => ({ estado, fecha: t(hhmm) });

  it('CARGANDO + DESCARGANDO = peon, EN_RUTA = manejo', () => {
    const r = tiemposRealesDesdeHistorial(
      [
        h('CONDUCTOR_ASIGNADO', '09:00'),
        h('EN_CAMINO_A_ORIGEN', '09:30'),
        h('CARGANDO', '10:00'),
        h('EN_RUTA', '10:20'),
        h('DESCARGANDO', '11:00'),
        h('FINALIZADO', '11:15'),
      ],
      t('11:15')
    );
    expect(min(r.peon_horas)).toBe(35);
    expect(min(r.manejo_horas)).toBe(40);
    expect(min(r.total_horas)).toBe(75);
  });

  it('cancelado en curso: el ultimo tramo cierra en la fila CANCELADO', () => {
    const r = tiemposRealesDesdeHistorial(
      [h('CARGANDO', '10:00'), h('EN_RUTA', '10:20'), h('CANCELADO', '10:50')],
      t('10:50')
    );
    expect(min(r.peon_horas)).toBe(20);
    expect(min(r.manejo_horas)).toBe(30);
  });

  it('sin la fila de cierre (fallo el historial): cierra en `fin`', () => {
    const r = tiemposRealesDesdeHistorial([h('CARGANDO', '10:00'), h('EN_RUTA', '10:20')], t('10:45'));
    expect(min(r.manejo_horas)).toBe(25);
  });

  it('nunca estuvo en curso -> null', () => {
    expect(tiemposRealesDesdeHistorial([h('BUSCANDO_CONDUCTOR', '09:00'), h('CANCELADO', '09:10')], t('09:10'))).toBeNull();
  });
});
