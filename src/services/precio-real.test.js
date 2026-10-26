import { describe, it, expect } from 'vitest';
import { precioDesdeMediciones } from './precio-real.js';
import { medicionEn } from './mediciones-gps.js';
import { repartirPorZona } from './zona.service.js';

const OBELISCO = { latitud: -34.6037, longitud: -58.3816 };
const LA_PLATA = { latitud: -34.9214, longitud: -57.9545 };

// El calculo que hacian cierre.service y costo.service antes de extraerlo.
function calculoViejo(viaje, { tiempo_horas, distancia_km }) {
  const { tiempo_capital, distancia_provincia } = repartirPorZona({ zona: viaje.zona, paradas: viaje.paradas, tiempo_horas, distancia_km });
  const precio_por_tiempo = tiempo_capital === null ? null : tiempo_capital * (viaje.tarifa_hora ?? 0);
  const precio_por_distancia = distancia_provincia === null ? null : distancia_provincia * (viaje.tarifa_km ?? 0);
  return (precio_por_tiempo ?? 0) + (precio_por_distancia ?? 0);
}

describe('precioDesdeMediciones (la formula)', () => {
  const med = { tiempo_horas: 1.5, distancia_km: 40 };
  for (const [zona, paradas] of [
    ['CABA', [OBELISCO, OBELISCO]],
    ['PROVINCIA', [LA_PLATA, LA_PLATA]],
    ['MIXTO', [OBELISCO, LA_PLATA]],
  ]) {
    it(`${zona}: igual al calculo de antes de la extraccion`, () => {
      const viaje = { zona, paradas, tarifa_hora: 3500, tarifa_km: 200 };
      const r = precioDesdeMediciones(viaje, med);
      expect(r.precio_real).toBeCloseTo(calculoViejo(viaje, med), 6);
      expect(r.precio_real).toBeGreaterThan(0);
    });
  }

  it('tarifas null cuentan como 0', () => {
    const r = precioDesdeMediciones({ zona: 'CABA', paradas: [OBELISCO, OBELISCO], tarifa_hora: null, tarifa_km: null }, med);
    expect(r.precio_real).toBe(0);
  });
});

describe('medicionEn (mediciones GPS hasta un instante)', () => {
  const T0 = Date.parse('2026-10-23T15:00:00Z');
  const s = (n) => T0 + n * 1000;
  const puntos = [
    { ts: s(0), tiempo_horas: 0, distancia_km: 0 },
    { ts: s(60), tiempo_horas: 60 / 3600, distancia_km: 1 },
    { ts: s(120), tiempo_horas: 120 / 3600, distancia_km: 2 },
  ];
  const acumulado = { tiempo_horas: 180 / 3600, distancia_km: 3, ultima_actualizacion: s(180) };

  it('T en o despues del ultimo ping: el acumulado tal cual (flujo normal)', () => {
    expect(medicionEn(puntos, acumulado, new Date(s(180)))).toEqual({ tiempo_horas: 180 / 3600, distancia_km: 3, sin_pings: false });
    expect(medicionEn(puntos, acumulado, new Date(s(900))).distancia_km).toBe(3);
  });

  it('T entre puntos: tiempo exacto, distancia del ultimo punto <= T', () => {
    const r = medicionEn([...puntos].reverse(), acumulado, new Date(s(90)));
    expect(r.tiempo_horas).toBeCloseTo(90 / 3600, 9);
    expect(r.distancia_km).toBe(1);
  });

  it('T antes del primer punto: 0', () => {
    expect(medicionEn(puntos, acumulado, new Date(s(-10)))).toEqual({ tiempo_horas: 0, distancia_km: 0, sin_pings: false });
  });

  it('sin pings: 0 y sin_pings', () => {
    expect(medicionEn([], null, new Date(s(10)))).toEqual({ tiempo_horas: 0, distancia_km: 0, sin_pings: true });
  });
});
