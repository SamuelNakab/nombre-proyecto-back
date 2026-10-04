import { describe, it, expect } from 'vitest';
import {
  evaluarVentanaInicio,
  aperturaVentanaInicio,
  finVentanaInicio,
  fechaProgramadaLimiteVencimiento,
  ventanaInicioAntesMinutos,
  ventanaInicioAntesMinutosLegacy,
  ventanaInicioDespuesMinutos,
  configVentana,
  VENTANA_ANTES_DEFAULT,
  VENTANA_DESPUES_DEFAULT,
} from './ventana-inicio.js';

// Todo con valores DEFINIDOS ACA: CI no tiene .env. La env se inyecta por
// parametro, nunca se lee process.env.
const DIEZ = new Date('2026-10-05T13:00:00.000Z'); // 10:00 en Buenos Aires
const min = (n) => n * 60000;
const VENTANA = { antes: 60, despues: 90 };

describe('evaluarVentanaInicio', () => {
  it('viaje a las 10 con 60/90: se puede iniciar de 9:00 a 11:30', () => {
    expect(evaluarVentanaInicio(new Date(DIEZ.getTime() - min(61)), DIEZ, VENTANA)).toBe('ANTES');
    expect(evaluarVentanaInicio(new Date(DIEZ.getTime() - min(60)), DIEZ, VENTANA)).toBe('DENTRO');
    expect(evaluarVentanaInicio(DIEZ, DIEZ, VENTANA)).toBe('DENTRO');
    expect(evaluarVentanaInicio(new Date(DIEZ.getTime() + min(90)), DIEZ, VENTANA)).toBe('DENTRO');
    expect(evaluarVentanaInicio(new Date(DIEZ.getTime() + min(91)), DIEZ, VENTANA)).toBe('DESPUES');
  });

  it('los bordes son inclusivos al milisegundo', () => {
    const apertura = DIEZ.getTime() - min(60);
    const cierre = DIEZ.getTime() + min(90);
    expect(evaluarVentanaInicio(new Date(apertura - 1), DIEZ, VENTANA)).toBe('ANTES');
    expect(evaluarVentanaInicio(new Date(apertura), DIEZ, VENTANA)).toBe('DENTRO');
    expect(evaluarVentanaInicio(new Date(cierre), DIEZ, VENTANA)).toBe('DENTRO');
    expect(evaluarVentanaInicio(new Date(cierre + 1), DIEZ, VENTANA)).toBe('DESPUES');
  });

  it('acepta fraccionarios (los tests de integracion usan segundos)', () => {
    const v = { antes: 0.5, despues: 0.05 }; // 30s antes, 3s despues
    expect(evaluarVentanaInicio(new Date(DIEZ.getTime() - 31000), DIEZ, v)).toBe('ANTES');
    expect(evaluarVentanaInicio(new Date(DIEZ.getTime() - 29000), DIEZ, v)).toBe('DENTRO');
    expect(evaluarVentanaInicio(new Date(DIEZ.getTime() + 2900), DIEZ, v)).toBe('DENTRO');
    expect(evaluarVentanaInicio(new Date(DIEZ.getTime() + 3100), DIEZ, v)).toBe('DESPUES');
  });

  it('ventana 0/0: solo en el instante exacto', () => {
    const v = { antes: 0, despues: 0 };
    expect(evaluarVentanaInicio(DIEZ, DIEZ, v)).toBe('DENTRO');
    expect(evaluarVentanaInicio(new Date(DIEZ.getTime() - 1), DIEZ, v)).toBe('ANTES');
    expect(evaluarVentanaInicio(new Date(DIEZ.getTime() + 1), DIEZ, v)).toBe('DESPUES');
  });

  it('acepta las fechas como string ISO', () => {
    expect(evaluarVentanaInicio(DIEZ.toISOString(), DIEZ.toISOString(), VENTANA)).toBe('DENTRO');
  });
});

describe('apertura, fin y limite de vencimiento', () => {
  it('apertura y fin de la ventana', () => {
    expect(aperturaVentanaInicio(DIEZ, 60).toISOString()).toBe('2026-10-05T12:00:00.000Z');
    expect(finVentanaInicio(DIEZ, 90).toISOString()).toBe('2026-10-05T14:30:00.000Z');
  });

  it('un viaje vence si su fecha_programada es anterior al limite', () => {
    // A las 11:31 vencio el de las 10:00 (fin 11:30); el de las 10:02 no.
    const ahora = new Date('2026-10-05T14:31:00.000Z');
    const limite = fechaProgramadaLimiteVencimiento(ahora, 90);
    expect(limite.toISOString()).toBe('2026-10-05T13:01:00.000Z');
    expect(DIEZ < limite).toBe(true);
    expect(new Date('2026-10-05T13:02:00.000Z') < limite).toBe(false);
  });
});

describe('lectura de env (inyectada)', () => {
  it('defaults 60 / 90 sin variables', () => {
    expect(VENTANA_ANTES_DEFAULT).toBe(60);
    expect(VENTANA_DESPUES_DEFAULT).toBe(90);
    expect(configVentana({})).toEqual({ antes: 60, despues: 90 });
  });

  it('lee los valores, incluidos fraccionarios y 0', () => {
    const env = { VENTANA_INICIO_ANTES_MINUTOS: '30', VENTANA_INICIO_DESPUES_MINUTOS: '0.05' };
    expect(configVentana(env)).toEqual({ antes: 30, despues: 0.05 });
    expect(ventanaInicioDespuesMinutos({ VENTANA_INICIO_DESPUES_MINUTOS: '0' })).toBe(0);
  });

  it('basura, negativo o vacio caen al default', () => {
    for (const malo of ['abc', '-5', '', '   ']) {
      expect(ventanaInicioAntesMinutos({ VENTANA_INICIO_ANTES_MINUTOS: malo })).toBe(60);
      expect(ventanaInicioDespuesMinutos({ VENTANA_INICIO_DESPUES_MINUTOS: malo })).toBe(90);
    }
  });

  it('el iniciar legacy cae a la vieja VENTANA_INICIO_MINUTOS; el ciclo interno no', () => {
    expect(ventanaInicioAntesMinutosLegacy({ VENTANA_INICIO_MINUTOS: '120' })).toBe(120);
    expect(
      ventanaInicioAntesMinutosLegacy({ VENTANA_INICIO_MINUTOS: '120', VENTANA_INICIO_ANTES_MINUTOS: '' })
    ).toBe(120);
    expect(
      ventanaInicioAntesMinutosLegacy({ VENTANA_INICIO_MINUTOS: '120', VENTANA_INICIO_ANTES_MINUTOS: '45' })
    ).toBe(45);
    expect(ventanaInicioAntesMinutos({ VENTANA_INICIO_MINUTOS: '120' })).toBe(60);
  });
});
