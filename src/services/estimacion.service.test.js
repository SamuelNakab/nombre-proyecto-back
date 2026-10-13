import { describe, it, expect, afterEach } from 'vitest';
import { estimarRecorrido, tiempoPeonMinutos, columnasEstimadasViaje } from './estimacion.service.js';
import { ErrorMaps, noDisponible, sinRuta } from './maps/comun.js';

const MIN = 60_000;
const p = (n) => ({ lat: -34.6 - n / 100, lng: -58.4 });

// Tramo falso: cada tramo tarda lo que diga la lista (en minutos) y mide i+1 km.
// Registra la hora de salida con la que se lo llamo.
function tramoFalso(minutos) {
  const llamadas = [];
  const fn = async ({ salida }) => {
    const i = llamadas.length;
    llamadas.push(salida);
    return { manejo_horas: minutos[i] / 60, distancia_km: i + 1, polilinea: [[i, i], [i + 1, i + 1]] };
  };
  fn.llamadas = llamadas;
  return fn;
}

const AHORA = new Date('2026-10-09T08:00:00Z');
const A_LAS_10 = new Date('2026-10-09T10:00:00Z');

describe('estimarRecorrido — el ejemplo A -> B -> C', () => {
  it('peon 30 en cada parada, manejo 40 + 25: total 2 h 35 = 1 h 05 + 1 h 30', async () => {
    const tramo = tramoFalso([40, 25]);
    const r = await estimarRecorrido({
      paradas: [p(1), p(2), p(3)],
      inicio: A_LAS_10,
      peonMinutos: 30,
      calcularTramo: tramo,
      ahora: AHORA,
    });
    const hora = (d) => d.toISOString().slice(11, 16);

    expect(r.paradas.map((x) => [hora(x.llegada_estimada), hora(x.salida_estimada)])).toEqual([
      ['10:00', '10:30'],
      ['11:10', '11:40'],
      ['12:05', '12:35'],
    ]);
    // Cada tramo sale a la llegada anterior + peon.
    expect(tramo.llamadas.map(hora)).toEqual(['10:30', '11:40']);
    expect(r.totales.manejo_horas * 60).toBeCloseTo(65, 9);
    expect(r.totales.peon_horas * 60).toBeCloseTo(90, 9);
    expect(r.totales.total_horas * 60).toBeCloseTo(155, 9);
    expect(r.totales.distancia_km).toBe(3);
    expect(hora(r.totales.fin_estimado)).toBe('12:35');
    // Manejo y distancia son del tramo que LLEGA: null en la parada 1.
    expect(r.paradas[0].manejo_estimado_horas).toBeNull();
    expect(r.paradas[0].distancia_estimada_km).toBeNull();
    expect(r.paradas[2].manejo_estimado_horas * 60).toBeCloseTo(25, 9);
    expect(r.paradas[2].distancia_estimada_km).toBe(2);
    // Polilinea concatenada sin repetir el punto de union.
    expect(r.polilinea).toEqual([[0, 0], [1, 1], [2, 2]]);
  });
});

describe('estimarRecorrido — invariantes', () => {
  it.each([2, 4])('%i paradas: peon en todas, salida = llegada + peon, manejo + peon = total', async (n) => {
    const manejos = [17, 33, 8].slice(0, n - 1);
    const r = await estimarRecorrido({
      paradas: Array.from({ length: n }, (_, i) => p(i)),
      inicio: A_LAS_10,
      peonMinutos: 20,
      calcularTramo: tramoFalso(manejos),
      ahora: AHORA,
    });
    expect(r.paradas).toHaveLength(n);
    for (const x of r.paradas) {
      expect(x.peon_estimado_horas * 60).toBeCloseTo(20, 9);
      expect(x.salida_estimada - x.llegada_estimada).toBe(20 * MIN);
    }
    for (let i = 1; i < n; i++) {
      expect(r.paradas[i].llegada_estimada - r.paradas[i - 1].salida_estimada).toBeCloseTo(manejos[i - 1] * MIN, 0);
    }
    expect(r.totales.peon_horas * 60).toBeCloseTo(20 * n, 9);
    expect(r.totales.total_horas).toBeCloseTo(r.totales.manejo_horas + r.totales.peon_horas, 12);
    expect(r.totales.fin_estimado - A_LAS_10).toBeCloseTo(r.totales.total_horas * 3_600_000, 0);
  });

  it('fecha pasada (o sin fecha) -> arranca ahora', async () => {
    for (const inicio of [new Date(AHORA.getTime() - 3 * 3_600_000), null, undefined]) {
      const tramo = tramoFalso([10]);
      const r = await estimarRecorrido({ paradas: [p(1), p(2)], inicio, peonMinutos: 30, calcularTramo: tramo, ahora: AHORA });
      expect(r.paradas[0].llegada_estimada).toEqual(AHORA);
      expect(tramo.llamadas[0]).toEqual(new Date(AHORA.getTime() + 30 * MIN));
    }
  });

  it('una salida que quedaria en el pasado se pide con ahora', async () => {
    const tramo = tramoFalso([10]);
    await estimarRecorrido({ paradas: [p(1), p(2)], inicio: null, peonMinutos: 0, calcularTramo: tramo, ahora: AHORA });
    expect(tramo.llamadas[0]).toEqual(AHORA);
  });

  it('peon 0: total = manejo', async () => {
    const r = await estimarRecorrido({
      paradas: [p(1), p(2), p(3)],
      inicio: A_LAS_10,
      peonMinutos: 0,
      calcularTramo: tramoFalso([10, 20]),
      ahora: AHORA,
    });
    expect(r.totales.total_horas).toBeCloseTo(0.5, 12);
  });
});

describe('estimarRecorrido — errores (nunca valores inventados)', () => {
  it('un error de Google en un tramo del medio se propaga y no se sigue llamando', async () => {
    let llamadas = 0;
    const tramo = async () => {
      llamadas++;
      if (llamadas === 2) throw noDisponible('timeout');
      return { manejo_horas: 0.1, distancia_km: 1, polilinea: [] };
    };
    await expect(
      estimarRecorrido({ paradas: [p(1), p(2), p(3), p(4)], inicio: A_LAS_10, peonMinutos: 30, calcularTramo: tramo, ahora: AHORA })
    ).rejects.toMatchObject({ status: 503, tipo: 'NO_DISPONIBLE' });
    expect(llamadas).toBe(2);
  });

  it('sin ruta en el tramo 2 -> 400 que dice entre que paradas', async () => {
    let llamadas = 0;
    const tramo = async () => {
      if (++llamadas === 2) throw sinRuta('routes vacio');
      return { manejo_horas: 0.1, distancia_km: 1, polilinea: [] };
    };
    const err = await estimarRecorrido({
      paradas: [p(1), p(2), p(3)],
      inicio: A_LAS_10,
      peonMinutos: 30,
      calcularTramo: tramo,
      ahora: AHORA,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ErrorMaps);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/parada 2 y la parada 3/);
  });

  it('un error que no es de Google tambien se propaga', async () => {
    const tramo = async () => {
      throw new Error('bug');
    };
    await expect(
      estimarRecorrido({ paradas: [p(1), p(2)], inicio: A_LAS_10, peonMinutos: 30, calcularTramo: tramo, ahora: AHORA })
    ).rejects.toThrow('bug');
  });
});

describe('columnas y env', () => {
  const original = process.env.TIEMPO_PEON_MINUTOS;
  afterEach(() => {
    if (original === undefined) delete process.env.TIEMPO_PEON_MINUTOS;
    else process.env.TIEMPO_PEON_MINUTOS = original;
  });

  it('TIEMPO_PEON_MINUTOS: default 30, 0 valido, basura / negativo -> 30', () => {
    for (const [valor, esperado] of [[undefined, 30], ['', 30], ['45', 45], ['0', 0], ['abc', 30], ['-5', 30], ['12.5', 12.5]]) {
      if (valor === undefined) delete process.env.TIEMPO_PEON_MINUTOS;
      else process.env.TIEMPO_PEON_MINUTOS = valor;
      expect(tiempoPeonMinutos()).toBe(esperado);
    }
  });

  it('duracion_estimada_horas = total (manejo + peon)', () => {
    expect(
      columnasEstimadasViaje({ total_horas: 2.5, manejo_horas: 1, peon_horas: 1.5, distancia_km: 9 })
    ).toEqual({ duracion_estimada_horas: 2.5, manejo_estimado_horas: 1, peon_estimado_horas: 1.5, distancia_estimada_km: 9 });
  });
});
