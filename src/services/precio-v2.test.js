import { describe, it, expect } from 'vitest';
import { calcularPrecioV2, redondearPrecio, horasFacturables, aPesos } from './precio-v2.js';
import { configPrecio } from '../config/precio.js';

const P = configPrecio({});

const entradas = ({
  km,
  horas,
  servicio = 'LIVIANO',
  ayudantes = 0,
  provincia = false,
  escalera = false,
  paradas_extra = 0,
  factura_a = false,
  peajes = 0,
}) => ({
  km_ida: km,
  horas,
  servicio,
  ayudantes: servicio === 'EQUIPO' ? P.PRECIO_EQUIPO_AYUDANTES : ayudantes,
  provincia,
  escalera,
  paradas_extra,
  factura_a,
  peajes,
  fuente_peajes: peajes ? 'PYME' : 'NINGUNA',
});

// Casos del relevamiento de 52 presupuestos (sin peajes).
const CASOS = [
  ['9,4 km, 0,5 h, LIVIANO', { km: 9.4, horas: 0.5 }, 84000],
  ['7,2 km, 0,5 h, LIVIANO, provincia', { km: 7.2, horas: 0.5, provincia: true }, 92000],
  ['49,0 km, 1,5 h, LIVIANO, provincia', { km: 49.0, horas: 1.5, provincia: true }, 221000],
  ['66,3 km, 1,5 h, LIVIANO, provincia', { km: 66.3, horas: 1.5, provincia: true }, 298000],
  ['9,4 km, 0,5 h, LIVIANO, 1 ayudante', { km: 9.4, horas: 0.5, ayudantes: 1 }, 108000],
  ['9,4 km, 0,5 h, LIVIANO, 1 ayudante, escalera', { km: 9.4, horas: 0.5, ayudantes: 1, escalera: true }, 135000],
  ['9,4 km, 0,5 h, EQUIPO', { km: 9.4, horas: 0.5, servicio: 'EQUIPO' }, 200000],
  ['9,4 km, 0,5 h, EQUIPO, escalera', { km: 9.4, horas: 0.5, servicio: 'EQUIPO', escalera: true }, 250000],
  ['29,1 km, 1 h, LIVIANO, provincia, 2 paradas extra', { km: 29.1, horas: 1, provincia: true, paradas_extra: 2 }, 181000],
  ['7,2 km, 0,5 h, CAMION, provincia', { km: 7.2, horas: 0.5, servicio: 'CAMION', provincia: true }, 370000],
  ['9,4 km, 3,5 h, LIVIANO', { km: 9.4, horas: 3.5 }, 140000],
  ['66,3 km, 1,5 h, LIVIANO, provincia, factura A', { km: 66.3, horas: 1.5, provincia: true, factura_a: true }, 361000],
];

describe('calcularPrecioV2: casos del relevamiento', () => {
  for (const [nombre, e, total] of CASOS) {
    it(`${nombre} -> ${total}`, () => {
      expect(calcularPrecioV2(entradas(e), P).total).toBe(total);
    });
  }

  it('rango de 84000 -> bajo 67000, alto 109000', () => {
    const r = calcularPrecioV2(entradas({ km: 9.4, horas: 0.5 }), P);
    expect([r.total, r.bajo, r.alto]).toEqual([84000, 67000, 109000]);
  });

  it('el IVA NO se aplica sobre los peajes', () => {
    const r = calcularPrecioV2(entradas({ km: 9.4, horas: 0.5, factura_a: true, peajes: 10374 }), P);
    expect(r.desglose.subtotal_sin_iva).toBe(84000);
    expect(r.desglose.iva).toBe(17640);
    expect(r.desglose.peajes).toBe(10374);
    // 84000 + 17640 + 10374 = 112014 -> 112000 (con IVA sobre peajes seria 114000)
    expect(r.total).toBe(112000);
    expect(r.desglose.ajuste_redondeo).toBe(-14);
  });
});

describe('calcularPrecioV2: desglose', () => {
  it('regimen, recargo de provincia solo en TIEMPO y nunca en CAMION', () => {
    const tiempo = calcularPrecioV2(entradas({ km: 7.2, horas: 0.5, provincia: true }), P).desglose;
    expect(tiempo.regimen).toBe('TIEMPO');
    expect(tiempo.recargo_provincia).toBe(8400);
    const dist = calcularPrecioV2(entradas({ km: 49, horas: 1.5, provincia: true }), P).desglose;
    expect(dist.regimen).toBe('DISTANCIA');
    expect(dist.recargo_provincia).toBe(0);
    expect(dist.distancia).toBe(220500);
    const camion = calcularPrecioV2(entradas({ km: 7.2, horas: 0.5, servicio: 'CAMION', provincia: true }), P).desglose;
    expect(camion.recargo_provincia).toBe(0);
  });

  it('EQUIPO no suma costo de ayudantes', () => {
    const d = calcularPrecioV2(entradas({ km: 1, horas: 0.5, servicio: 'EQUIPO' }), P).desglose;
    expect(d.costo_ayudantes).toBe(0);
    expect(d.ayudantes).toBe(0);
  });

  it('todo en pesos enteros y el desglose cierra', () => {
    const r = calcularPrecioV2(entradas({ km: 66.3, horas: 1.5, provincia: true, factura_a: true, peajes: 333 }), P);
    const d = r.desglose;
    for (const k of ['tiempo_base', 'costo_ayudantes', 'tiempo', 'distancia', 'subtotal_sin_iva', 'iva', 'peajes', 'total']) {
      expect(Number.isInteger(d[k])).toBe(true);
    }
    expect(d.subtotal_sin_iva + d.iva + d.peajes + d.ajuste_redondeo).toBe(r.total);
    expect(d.parametros.minimo).toBe(84000);
    expect(d.entradas.km_ida).toBe(66.3);
  });

  it('horas facturables: minimo, fraccion y tolerancia de float', () => {
    expect(horasFacturables(0.5, 2, 30)).toBe(2);
    expect(horasFacturables(3.5, 2, 30)).toBe(3.5);
    expect(horasFacturables(3.51, 2, 30)).toBe(4);
    expect(horasFacturables(2.0000000001, 2, 30)).toBe(2);
    expect(horasFacturables(4, 4, 30)).toBe(4);
  });

  it('redondeo al multiplo mas cercano, mitades hacia arriba', () => {
    expect(redondearPrecio(220500, 1000)).toBe(221000);
    expect(redondearPrecio(298349.99999999994, 1000)).toBe(298000);
    expect(redondearPrecio(92400, 1000)).toBe(92000);
    expect(redondearPrecio(1499, 1000)).toBe(1000);
    expect(redondearPrecio(1500, 1000)).toBe(2000);
    expect(aPesos(62653.5)).toBe(62654);
  });

  it('servicio desconocido tira', () => {
    expect(() => calcularPrecioV2({ ...entradas({ km: 1, horas: 1 }), servicio: 'MOTO' }, P)).toThrow();
  });
});
