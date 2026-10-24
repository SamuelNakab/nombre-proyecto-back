import { describe, it, expect } from 'vitest';
import { evaluarPingSalida, configDeteccion, paradaDetectable } from './salida-deteccion.js';

const LLEGADA = Date.parse('2026-10-23T15:00:00Z');
const cfg = { metros: 500, segundos: 240, ahora: LLEGADA + 3_600_000 };
const parada = { id_parada: 7, llegada_real: new Date(LLEGADA), salida_real: null, salida_detectada: null };
const ping = (segDespues, distancia_metros) => ({ ts: LLEGADA + segDespues * 1000, distancia_metros });

// Corre una secuencia de pings y devuelve el estado final y la deteccion.
function secuencia(pings, p = parada, c = cfg) {
  let estado = null;
  let detectada = null;
  for (const pg of pings) {
    const r = evaluarPingSalida(estado, pg, p, c);
    estado = r.estado;
    if (r.detectada) detectada = r.detectada;
  }
  return { estado, detectada };
}

describe('evaluarPingSalida', () => {
  it('no corre sin llegada_real (antes de confirmar la llegada)', () => {
    const sinLlegada = { ...parada, llegada_real: null };
    expect(paradaDetectable(sinLlegada)).toBe(false);
    expect(secuencia([ping(10, 900), ping(300, 900)], sinLlegada).detectada).toBeNull();
  });

  it('no corre si la parada ya tiene salida_real o salida_detectada', () => {
    expect(secuencia([ping(10, 900), ping(300, 900)], { ...parada, salida_real: new Date() }).detectada).toBeNull();
    expect(secuencia([ping(10, 900), ping(300, 900)], { ...parada, salida_detectada: new Date() }).detectada).toBeNull();
  });

  it('ignora los pings con timestamp anterior (o igual) a la llegada', () => {
    const r = secuencia([ping(-600, 900), ping(0, 900), ping(-1, 900)]);
    expect(r.estado).toBeNull();
    expect(r.detectada).toBeNull();
  });

  it('500 m: 499 es adentro, 501 es afuera', () => {
    expect(evaluarPingSalida(null, ping(10, 499), parada, cfg).estado).toBeNull();
    expect(evaluarPingSalida(null, ping(10, 500), parada, cfg).estado).toBeNull();
    expect(evaluarPingSalida(null, ping(10, 501), parada, cfg).estado).toEqual({
      id_parada: 7,
      fuera_desde: LLEGADA + 10_000,
      ultimo_ts: LLEGADA + 10_000,
    });
  });

  it('umbral de tiempo: 239 s afuera no detecta, 240 s si; la hora es la del PRIMER ping afuera', () => {
    expect(secuencia([ping(60, 800), ping(200, 900), ping(299, 900)]).detectada).toBeNull();
    expect(secuencia([ping(60, 800), ping(200, 900), ping(300, 900)]).detectada).toEqual(new Date(LLEGADA + 60_000));
  });

  it('un ping de vuelta adentro resetea la deteccion', () => {
    const r = secuencia([ping(60, 800), ping(200, 100), ping(250, 800), ping(400, 900)]);
    // Sin el reset, 60 -> 400 = 340 s habria detectado.
    expect(r.detectada).toBeNull();
    expect(r.estado.fuera_desde).toBe(LLEGADA + 250_000);
    // Y la racha nueva detecta con SU primer ping.
    expect(secuencia([ping(60, 800), ping(200, 100), ping(250, 800), ping(490, 900)]).detectada).toEqual(
      new Date(LLEGADA + 250_000)
    );
  });

  it('ignora pings desordenados respecto de la racha', () => {
    const r = secuencia([ping(60, 800), ping(100, 800), ping(80, 100)]);
    expect(r.estado.fuera_desde).toBe(LLEGADA + 60_000);
  });

  it('ignora pings del futuro (mas de 60 s adelantados respecto del server)', () => {
    const c = { ...cfg, ahora: LLEGADA + 100_000 };
    expect(evaluarPingSalida(null, ping(161, 900), parada, c).estado).toBeNull();
    expect(evaluarPingSalida(null, ping(159, 900), parada, c).estado).not.toBeNull();
  });

  it('el estado de otra parada no cuenta: arranca de cero', () => {
    const deOtra = { id_parada: 6, fuera_desde: LLEGADA + 1_000, ultimo_ts: LLEGADA + 1_000 };
    const r = evaluarPingSalida(deOtra, ping(300, 900), parada, cfg);
    expect(r.detectada).toBeNull();
    expect(r.estado.fuera_desde).toBe(LLEGADA + 300_000);
  });
});

describe('configDeteccion', () => {
  it('defaults 500 m / 240 s; basura o <= 0 -> default', () => {
    expect(configDeteccion({})).toEqual({ metros: 500, segundos: 240 });
    expect(configDeteccion({ SALIDA_DETECCION_METROS: 'x', SALIDA_DETECCION_SEGUNDOS: '0' })).toEqual({
      metros: 500,
      segundos: 240,
    });
    expect(configDeteccion({ SALIDA_DETECCION_METROS: '300', SALIDA_DETECCION_SEGUNDOS: '4' })).toEqual({
      metros: 300,
      segundos: 4,
    });
  });
});
