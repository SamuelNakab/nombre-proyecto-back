import { describe, it, expect } from 'vitest';
import { avanzarAcumulado, calidadGps, pingsEn } from './mediciones-gps.js';

// Distancia "plana" para el test: 1 km por cada 0.01 de diferencia en lng.
const dist = (a, b) => Math.abs(a[0] - b[0]) * 100;
const ping = (lng, timestamp) => ({ lat: -34.6, lng, timestamp });

function correr(pings) {
  let acc = null;
  const resultados = [];
  for (const p of pings) {
    const r = avanzarAcumulado(acc, p, dist);
    resultados.push(r);
    acc = r.nuevo;
  }
  return { acc, resultados };
}

describe('avanzarAcumulado: filtro de pings desordenados', () => {
  it('pings en orden: suma tiempo y distancia, cuenta pings y mayor hueco', () => {
    const { acc } = correr([ping(0, 0), ping(0.01, 60_000), ping(0.02, 180_000)]);
    expect(acc.distancia_km).toBeCloseTo(2, 10);
    expect(acc.tiempo_horas).toBeCloseTo(180_000 / 3_600_000, 10);
    expect(acc.pings).toBe(3);
    expect(acc.mayor_hueco_ms).toBe(120_000);
  });

  it('un ping con timestamp anterior o igual al ultimo se ignora (no resta tiempo ni suma zigzag)', () => {
    const { acc, resultados } = correr([
      ping(0, 0),
      ping(0.05, 120_000),
      ping(0.01, 60_000), // atrasado: volveria 4 km atras y restaria 1 min
      ping(0.02, 120_000), // mismo timestamp que el ultimo procesado
      ping(0.06, 180_000),
    ]);
    expect(resultados[2].ignorado).toBe(true);
    expect(resultados[3].ignorado).toBe(true);
    expect(acc.distancia_km).toBeCloseTo(6, 10);
    expect(acc.tiempo_horas).toBeCloseTo(180_000 / 3_600_000, 10);
    expect(acc.ultima_actualizacion).toBe(180_000);
    expect(acc.pings).toBe(3);
  });

  it('acumulado viejo (sin pings ni hueco) arranca en 0', () => {
    const viejo = { tiempo_horas: 1, distancia_km: 10, ultima_lat: -34.6, ultima_lng: 0, ultima_actualizacion: 1000 };
    const r = avanzarAcumulado(viejo, ping(0.01, 2000), dist);
    expect(r.nuevo.pings).toBe(1);
    expect(r.nuevo.mayor_hueco_ms).toBe(1000);
  });
});

describe('calidadGps', () => {
  it('sin acumulado: 0 pings y hueco null', () => {
    expect(calidadGps(null)).toEqual({ gps_puntos: 0, gps_mayor_hueco_segundos: null });
  });
  it('segundos redondeados', () => {
    expect(calidadGps({ pings: 12, mayor_hueco_ms: 61_400 })).toEqual({ gps_puntos: 12, gps_mayor_hueco_segundos: 61 });
  });
});

describe('pingsEn: pings hasta el corte', () => {
  const acumulado = { tiempo_horas: 1, distancia_km: 30, ultima_actualizacion: 3_600_000, pings: 100 };
  const puntos = [
    { ts: 0, tiempo_horas: 0, distancia_km: 0, pings: 1 },
    { ts: 1_800_000, tiempo_horas: 0.5, distancia_km: 15, pings: 50 },
  ];
  it('T >= ultimo ping: los pings del acumulado', () => {
    expect(pingsEn(puntos, acumulado, 3_600_000)).toBe(100);
  });
  it('T anterior: los pings del ultimo punto <= T', () => {
    expect(pingsEn(puntos, acumulado, 2_000_000)).toBe(50);
  });
  it('antes del primer punto o sin acumulado: 0', () => {
    expect(pingsEn(puntos, acumulado, -1)).toBe(0);
    expect(pingsEn([], null, 1)).toBe(0);
  });
});
