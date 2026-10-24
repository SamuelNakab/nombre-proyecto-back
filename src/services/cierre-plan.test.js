import { describe, it, expect } from 'vitest';
import { elegirSalidaReal, planCierre } from './cierre-plan.js';

const t = (hhmm) => new Date(`2026-10-23T${hhmm}:00Z`);
const AHORA = t('23:00');
const op = { ahora: AHORA, ultimoPing: null, peonMinutos: 30 };

// Viaje de 3 paradas; peon estimado 30 min y manejo estimado 40 min por tramo.
const p = (orden, extra = {}) => ({
  id_parada: orden * 10,
  orden,
  llegada_real: null,
  salida_real: null,
  salida_detectada: null,
  peon_estimado_horas: 0.5,
  manejo_estimado_horas: orden === 1 ? null : 40 / 60,
  ...extra,
});
const enUltima = (extraUltima = {}) => ({
  estado: 'DESCARGANDO',
  paradas: [
    p(1, { llegada_real: t('10:00'), salida_real: t('10:20') }),
    p(2, { llegada_real: t('11:00'), salida_real: t('11:15') }),
    p(3, { llegada_real: t('12:00'), ...extraUltima }),
  ],
});

describe('elegirSalidaReal', () => {
  it('sin deteccion: el toque, origen CHOFER', () => {
    expect(elegirSalidaReal({ salida_detectada: null, toque: t('12:40') })).toEqual({
      salida_real: t('12:40'),
      origen_salida: 'CHOFER',
    });
  });
  it('detectada ANTES del toque: la detectada, origen GPS', () => {
    expect(elegirSalidaReal({ salida_detectada: t('12:20'), toque: t('12:40') })).toEqual({
      salida_real: t('12:20'),
      origen_salida: 'GPS',
    });
  });
  it('detectada DESPUES del toque (no deberia pasar): el toque', () => {
    expect(elegirSalidaReal({ salida_detectada: t('12:50'), toque: t('12:40') }).origen_salida).toBe('CHOFER');
  });
});

describe('planCierre — instante de corte', () => {
  it('CHOFER sin deteccion (flujo normal): corte = toque', () => {
    const r = planCierre(enUltima(), 'CHOFER', op);
    expect(r).toMatchObject({
      estadosEsperados: ['DESCARGANDO'],
      abierta: 30,
      salida: { fecha: AHORA, origen: 'CHOFER' },
      corte: AHORA,
      noVisitadas: [],
      incompleto: false,
    });
  });

  it('CHOFER con deteccion anterior al toque: corte y salida = detectada', () => {
    const r = planCierre(enUltima({ salida_detectada: t('12:25') }), 'CHOFER', op);
    expect(r.salida).toEqual({ fecha: t('12:25'), origen: 'GPS' });
    expect(r.corte).toEqual(t('12:25'));
  });

  it('PyME, llego a la ultima con deteccion: corte = detectada', () => {
    const r = planCierre(enUltima({ salida_detectada: t('12:25') }), 'ORGANIZACION', op);
    expect(r.salida).toEqual({ fecha: t('12:25'), origen: 'GPS' });
    expect(r.corte).toEqual(t('12:25'));
  });

  it('PyME, llego a la ultima sin deteccion: salida vacia, corte = llegada + peon estimado', () => {
    const r = planCierre(enUltima(), 'ORGANIZACION', op);
    expect(r.abierta).toBe(30);
    expect(r.salida).toBeNull();
    expect(r.corte).toEqual(t('12:30'));
  });

  it('AUTOMATICO, llego a la ultima sin deteccion: igual que la PyME', () => {
    const r = planCierre(enUltima(), 'AUTOMATICO', op);
    expect(r.salida).toBeNull();
    expect(r.corte).toEqual(t('12:30'));
    expect(r.incompleto).toBe(false);
  });

  it('AUTOMATICO sin llegar, parado en una parada: su llegada + su peon; las demas no visitadas', () => {
    const v = {
      estado: 'DESCARGANDO',
      paradas: [p(1, { llegada_real: t('10:00'), salida_real: t('10:20') }), p(2, { llegada_real: t('11:00') }), p(3)],
    };
    const r = planCierre(v, 'AUTOMATICO', op);
    expect(r).toMatchObject({ abierta: 20, salida: null, noVisitadas: [30], incompleto: true });
    expect(r.corte).toEqual(t('11:30'));
    // Con deteccion en esa parada: la detectada.
    v.paradas[1].salida_detectada = t('11:12');
    expect(planCierre(v, 'AUTOMATICO', op)).toMatchObject({ salida: { fecha: t('11:12'), origen: 'GPS' }, corte: t('11:12') });
  });

  it('AUTOMATICO sin llegar, EN_RUTA: min(ultimo ping, salida anterior + manejo estimado)', () => {
    const v = {
      estado: 'EN_RUTA',
      paradas: [p(1, { llegada_real: t('10:00'), salida_real: t('10:20') }), p(2), p(3)],
    };
    // Cota: 10:20 + 40 min = 11:00.
    expect(planCierre(v, 'AUTOMATICO', { ...op, ultimoPing: t('18:00') }).corte).toEqual(t('11:00'));
    expect(planCierre(v, 'AUTOMATICO', { ...op, ultimoPing: t('10:45') }).corte).toEqual(t('10:45'));
    // Sin pings: la salida anterior (nunca antes).
    expect(planCierre(v, 'AUTOMATICO', op).corte).toEqual(t('10:20'));
    expect(planCierre(v, 'AUTOMATICO', op)).toMatchObject({ abierta: null, noVisitadas: [20, 30], incompleto: true });
  });

  it('ningun corte es posterior a ahora', () => {
    const r = planCierre(enUltima(), 'ORGANIZACION', { ...op, ahora: t('12:10') });
    expect(r.corte).toEqual(t('12:10'));
  });

  it('CHOFER / PyME fuera de la ultima parada: tira (lo valida el caller)', () => {
    const v = { estado: 'EN_RUTA', paradas: [p(1, { llegada_real: t('10:00'), salida_real: t('10:20') }), p(2)] };
    expect(() => planCierre(v, 'ORGANIZACION', op)).toThrow(/ultima parada/);
    expect(() => planCierre(v, 'OTRO', op)).toThrow();
  });
});
