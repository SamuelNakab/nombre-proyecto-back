import { describe, it, expect } from 'vitest';
import {
  entradasEstimado,
  entradasMedido,
  elegirFacturaA,
  elegirPeajes,
  validarDatosPrecio,
  ayudantesEfectivos,
  kmEstimadosHastaUltimaLlegada,
  kmMedidos,
  declaradosDe,
} from './precio-entradas.js';
import { calcularPrecioV2 } from './precio-v2.js';
import { configPrecio } from '../config/precio.js';

const P = configPrecio({});
const OBELISCO = { lat: -34.6037, lng: -58.3816 };
const PALERMO = { lat: -34.5889, lng: -58.4306 };
const LA_PLATA = { lat: -34.9214, lng: -57.9545 };
const SIN = { tipo_servicio: null, ayudantes: null, factura_a: null, peajes_estimados: null };

describe('entradasEstimado', () => {
  it('horas = manejo + minutos por parada x paradas; km sin vuelta', () => {
    const { entradas } = entradasEstimado(
      { paradas: [OBELISCO, PALERMO], manejo_horas: 0.25, distancia_km: 6, declarados: SIN },
      P
    );
    expect(entradas.horas).toBeCloseTo(0.25 + 0.5, 10);
    expect(entradas.km_ida).toBe(6);
    expect(entradas.servicio).toBe('LIVIANO');
    expect(entradas.ayudantes).toBe(0);
    expect(entradas.provincia).toBe(false);
    expect(entradas.paradas_extra).toBe(0);
    expect(entradas.escalera).toBe(false);
  });

  it('PRECIO_MINUTOS_POR_PARADA del env (0 vale)', () => {
    const p0 = configPrecio({ PRECIO_MINUTOS_POR_PARADA: '0' });
    const { entradas } = entradasEstimado(
      { paradas: [OBELISCO, PALERMO, OBELISCO], manejo_horas: 1, distancia_km: 1, declarados: SIN },
      p0
    );
    expect(entradas.horas).toBe(1);
  });

  it('provincia si alguna parada cae fuera de CABA', () => {
    const { entradas } = entradasEstimado(
      { paradas: [OBELISCO, LA_PLATA], manejo_horas: 1, distancia_km: 60, declarados: SIN },
      P
    );
    expect(entradas.provincia).toBe(true);
  });

  it('paradas extra = paradas - 2 (nunca negativo) y escalera por acceso', () => {
    const { entradas } = entradasEstimado(
      {
        paradas: [OBELISCO, { ...PALERMO, acceso: 'ESCALERA', pisos: 2 }, OBELISCO, PALERMO],
        manejo_horas: 1,
        distancia_km: 10,
        declarados: { ...SIN, ayudantes: 1 },
      },
      P
    );
    expect(entradas.paradas_extra).toBe(2);
    expect(entradas.escalera).toBe(true);
    expect(entradas.cantidad_paradas).toBe(4);
  });

  it('el snapshot guarda parametros, entradas y lo declarado (null = no declarado)', () => {
    const { snapshot } = entradasEstimado(
      { paradas: [OBELISCO, PALERMO], manejo_horas: 0.2, distancia_km: 5, declarados: SIN, facturaAOrganizacion: true },
      P
    );
    expect(snapshot.version).toBe(2);
    expect(snapshot.parametros.PRECIO_KM_IDA).toBe(4500);
    expect(snapshot.declarados.factura_a).toBeNull();
    expect(snapshot.entradas.factura_a).toBe(true);
    expect(snapshot.entradas.fuente_factura_a).toBe('ORGANIZACION');
  });
});

describe('factura A', () => {
  it('declarada en el viaje gana (aun false)', () => {
    expect(elegirFacturaA(false, true)).toEqual({ valor: false, fuente: 'VIAJE' });
    expect(elegirFacturaA(true, null)).toEqual({ valor: true, fuente: 'VIAJE' });
  });
  it('si no, el default de la organizacion', () => {
    expect(elegirFacturaA(null, true)).toEqual({ valor: true, fuente: 'ORGANIZACION' });
    expect(elegirFacturaA(undefined, false)).toEqual({ valor: false, fuente: 'ORGANIZACION' });
  });
  it('sin ninguno, false', () => {
    expect(elegirFacturaA(null, null)).toEqual({ valor: false, fuente: 'DEFAULT' });
  });
});

describe('peajes', () => {
  it('fuente PYME, GOOGLE y NINGUNA', () => {
    expect(elegirPeajes(5000, 9999)).toEqual({ monto: 5000, fuente: 'PYME' });
    expect(elegirPeajes(0, 9999)).toEqual({ monto: 0, fuente: 'PYME' });
    expect(elegirPeajes(null, 9999)).toEqual({ monto: 9999, fuente: 'GOOGLE' });
    expect(elegirPeajes(null)).toEqual({ monto: 0, fuente: 'NINGUNA' });
  });
  it('lo declarado es el total: no se multiplica por el factor de vuelta', () => {
    const { entradas } = entradasEstimado(
      { paradas: [OBELISCO, PALERMO], manejo_horas: 0.2, distancia_km: 5, declarados: { ...SIN, peajes_estimados: 3000 } },
      P
    );
    expect(entradas.peajes).toBe(3000);
    expect(entradas.fuente_peajes).toBe('PYME');
  });
});

describe('validarDatosPrecio', () => {
  const paradas = [OBELISCO, PALERMO];
  const escalera = [OBELISCO, { ...PALERMO, acceso: 'ESCALERA', pisos: 3 }];
  it('EQUIPO solo con sus ayudantes fijos', () => {
    expect(validarDatosPrecio({ tipo_servicio: 'EQUIPO', ayudantes: 2, paradas }, P)).toBeNull();
    expect(validarDatosPrecio({ tipo_servicio: 'EQUIPO', ayudantes: null, paradas }, P)).toBeNull();
    expect(validarDatosPrecio({ tipo_servicio: 'EQUIPO', ayudantes: 1, paradas }, P)).toBe(
      'Con el servicio EQUIPO los ayudantes son siempre 2'
    );
  });
  it('LIVIANO y CAMION: 0 a PRECIO_AYUDANTES_MAX', () => {
    expect(validarDatosPrecio({ tipo_servicio: 'LIVIANO', ayudantes: 1, paradas }, P)).toBeNull();
    expect(validarDatosPrecio({ tipo_servicio: 'CAMION', ayudantes: 2, paradas }, P)).toBe(
      'Con el servicio CAMION los ayudantes pueden ser como máximo 1'
    );
    expect(validarDatosPrecio({ tipo_servicio: null, ayudantes: 2, paradas }, P)).toMatch(/LIVIANO/);
  });
  it('escalera requiere ayudante o EQUIPO', () => {
    const msg = 'Si alguna parada tiene acceso por escalera, el viaje necesita al menos 1 ayudante o el servicio EQUIPO';
    expect(validarDatosPrecio({ tipo_servicio: null, ayudantes: null, paradas: escalera }, P)).toBe(msg);
    expect(validarDatosPrecio({ tipo_servicio: 'CAMION', ayudantes: 0, paradas: escalera }, P)).toBe(msg);
    expect(validarDatosPrecio({ tipo_servicio: 'LIVIANO', ayudantes: 1, paradas: escalera }, P)).toBeNull();
    expect(validarDatosPrecio({ tipo_servicio: 'EQUIPO', ayudantes: null, paradas: escalera }, P)).toBeNull();
    expect(validarDatosPrecio({ tipo_servicio: null, ayudantes: null, paradas: [OBELISCO, { ...PALERMO, acceso: 'ASCENSOR', pisos: 9 }] }, P)).toBeNull();
  });
  it('ayudantes efectivos', () => {
    expect(ayudantesEfectivos('EQUIPO', null, P)).toBe(2);
    expect(ayudantesEfectivos('LIVIANO', null, P)).toBe(0);
    expect(ayudantesEfectivos('CAMION', 1, P)).toBe(1);
  });
  it('declaradosDe completa con null', () => {
    expect(declaradosDe({ ayudantes: 1 })).toMatchObject({ ayudantes: 1, tipo_servicio: null, valor_declarado: null });
  });
});

describe('medido: horas por reloj y fallback de km', () => {
  const { snapshot } = entradasEstimado(
    { paradas: [OBELISCO, PALERMO, OBELISCO], manejo_horas: 0.5, distancia_km: 20, declarados: SIN },
    P
  );
  const paradas = [
    { orden: 1, llegada_real: '2026-11-12T10:00:00Z', distancia_estimada_km: null },
    { orden: 2, llegada_real: '2026-11-12T10:30:00Z', distancia_estimada_km: 8 },
    { orden: 3, llegada_real: null, distancia_estimada_km: 12 },
  ];
  const base = { snapshot, inicio: '2026-11-12T10:00:00Z', corte: '2026-11-12T11:30:00Z', paradas };

  it('horas = corte - llegada a la parada 1', () => {
    const e = entradasMedido({ ...base, medicion: { distancia_km: 19, pings: 50 }, incompleto: false });
    expect(e.horas).toBe(1.5);
  });

  it('GPS confiable -> GPS', () => {
    const e = entradasMedido({ ...base, medicion: { distancia_km: 19, pings: 50 }, incompleto: false });
    expect([e.km_ida, e.fuente_km]).toEqual([19, 'GPS']);
  });

  it('pocos pings -> ESTIMADA (nunca 0 por falta de GPS)', () => {
    const e = entradasMedido({ ...base, medicion: { distancia_km: 19, pings: 3 }, incompleto: false });
    expect([e.km_ida, e.fuente_km]).toEqual([20, 'ESTIMADA']);
    const sin = entradasMedido({ ...base, medicion: { distancia_km: 0, pings: 0, sin_pings: true }, incompleto: false });
    expect([sin.km_ida, sin.fuente_km, sin.km_gps]).toEqual([20, 'ESTIMADA', null]);
  });

  it('distancia GPS menor al porcentaje -> ESTIMADA', () => {
    const e = entradasMedido({ ...base, medicion: { distancia_km: 9.9, pings: 50 }, incompleto: false });
    expect(e.fuente_km).toBe('ESTIMADA');
    const justo = entradasMedido({ ...base, medicion: { distancia_km: 10, pings: 50 }, incompleto: false });
    expect(justo.fuente_km).toBe('GPS');
  });

  it('incompleto -> referencia y fallback PARCIALES (tramos hasta la ultima llegada)', () => {
    expect(kmEstimadosHastaUltimaLlegada(paradas)).toBe(8);
    const e = entradasMedido({ ...base, medicion: { distancia_km: 0, pings: 0, sin_pings: true }, incompleto: true });
    expect([e.km_ida, e.fuente_km, e.referencia_km]).toEqual([8, 'ESTIMADA_PARCIAL', 8]);
    const gps = entradasMedido({ ...base, medicion: { distancia_km: 7, pings: 40 }, incompleto: true });
    expect(gps.fuente_km).toBe('GPS');
  });

  it('incompleto sin haber llegado a ninguna despues de la 1: 0 km parciales', () => {
    expect(kmEstimadosHastaUltimaLlegada([{ orden: 1, llegada_real: 'x' }, { orden: 2, llegada_real: null, distancia_estimada_km: 5 }])).toBe(0);
    expect(kmMedidos({ kmGps: 0, pings: 0, kmEstimadosTotal: 5, kmEstimadosParcial: 0, incompleto: true }, P)).toEqual({
      km_ida: 0,
      fuente_km: 'ESTIMADA_PARCIAL',
      referencia_km: 0,
    });
  });

  it('el medido usa los parametros del SNAPSHOT, no el env', () => {
    const e = entradasMedido({ ...base, medicion: { distancia_km: 19, pings: 50 }, incompleto: false });
    const conSnapshot = calcularPrecioV2(e, snapshot.parametros).total;
    const otroEnv = calcularPrecioV2(e, configPrecio({ PRECIO_KM_IDA: '9000' })).total;
    expect(conSnapshot).not.toBe(otroEnv);
    expect(conSnapshot).toBe(calcularPrecioV2(e, P).total);
  });
});
