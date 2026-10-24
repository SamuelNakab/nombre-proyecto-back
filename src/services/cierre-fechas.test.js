import { describe, it, expect } from 'vitest';
import {
  configCierre,
  ultimaParada,
  finPeonEstimado,
  horaPrevistaFin,
  finDelDia,
  momentoCierreAutomatico,
  cierreManualDesde,
  limiteInicioCandidatos,
} from './cierre-fechas.js';

const Z = (iso) => new Date(iso);
const cfg = { tz: 'America/Argentina/Buenos_Aires', extensionMinutos: 120, finDiaSegundosTest: null, peonMinutos: 30 };

const paradas = (llegadaUltima, extra = {}) => [
  { id_parada: 1, orden: 1, llegada_real: Z('2026-10-23T13:00:00Z'), peon_estimado_horas: 0.5 },
  { id_parada: 2, orden: 2, llegada_real: llegadaUltima, peon_estimado_horas: 0.5, ...extra },
];

describe('hora prevista de fin', () => {
  it('llegada a la ultima + peon estimado de esa parada', () => {
    expect(horaPrevistaFin(paradas(Z('2026-10-23T15:00:00Z')), cfg)).toEqual(Z('2026-10-23T15:30:00Z'));
  });

  it('sin peon estimado (viaje viejo): TIEMPO_PEON_MINUTOS', () => {
    const p = { llegada_real: Z('2026-10-23T15:00:00Z'), peon_estimado_horas: null };
    expect(finPeonEstimado(p, { peonMinutos: 45 })).toEqual(Z('2026-10-23T15:45:00Z'));
  });

  it('todavia no llego a la ultima: null', () => {
    expect(horaPrevistaFin(paradas(null), cfg)).toBeNull();
  });

  it('la ultima es la de mayor orden, no la ultima del array', () => {
    expect(ultimaParada([{ orden: 3 }, { orden: 1 }, { orden: 2 }]).orden).toBe(3);
  });
});

describe('fin del dia (hora argentina)', () => {
  it('inicio 23:30 AR (02:30Z del dia siguiente en UTC): cierra 23:59:59 AR del MISMO dia local', () => {
    expect(finDelDia(Z('2026-10-23T02:30:00Z'), cfg)).toEqual(Z('2026-10-23T02:59:59Z'));
  });

  it('inicio 00:10 AR: cierra 23:59:59 AR de ese dia (casi 24 h despues)', () => {
    expect(finDelDia(Z('2026-10-23T03:10:00Z'), cfg)).toEqual(Z('2026-10-24T02:59:59Z'));
  });

  it('la zona se inyecta y respeta el horario de verano (New York, 8/3/2026)', () => {
    // 23:59:59 EDT (-4) del 8 de marzo = 03:59:59Z del 9.
    expect(finDelDia(Z('2026-03-08T12:00:00Z'), { tz: 'America/New_York' })).toEqual(Z('2026-03-09T03:59:59Z'));
  });

  it('[SOLO TESTS] CIERRE_FIN_DIA_SEGUNDOS_TEST: inicio + N s', () => {
    expect(finDelDia(Z('2026-10-23T13:00:00Z'), { ...cfg, finDiaSegundosTest: 10 })).toEqual(Z('2026-10-23T13:00:10Z'));
  });
});

describe('momento del cierre automatico', () => {
  const inicio = Z('2026-10-23T13:00:00Z'); // 10:00 AR

  it('no llego a la ultima: fin del dia', () => {
    expect(momentoCierreAutomatico({ fecha_inicio: inicio, paradas: paradas(null) }, cfg)).toEqual(Z('2026-10-24T02:59:59Z'));
  });

  it('llego y la prevista cae ANTES del fin del dia: fin del dia', () => {
    const v = { fecha_inicio: inicio, paradas: paradas(Z('2026-10-23T20:00:00Z')) };
    expect(momentoCierreAutomatico(v, cfg)).toEqual(Z('2026-10-24T02:59:59Z'));
  });

  it('la prevista cruza la medianoche: prevista + 2 h', () => {
    // Llega 23:50 AR (02:50Z), peon 30 min -> prevista 00:20 AR (03:20Z) > 23:59:59.
    const v = { fecha_inicio: inicio, paradas: paradas(Z('2026-10-24T02:50:00Z')) };
    expect(momentoCierreAutomatico(v, cfg)).toEqual(Z('2026-10-24T05:20:00Z'));
  });

  it('CIERRE_EXTENSION_MINUTOS cambia el margen', () => {
    const v = { fecha_inicio: inicio, paradas: paradas(Z('2026-10-24T02:50:00Z')) };
    expect(momentoCierreAutomatico(v, { ...cfg, extensionMinutos: 30 })).toEqual(Z('2026-10-24T03:50:00Z'));
  });
});

describe('cierre manual disponible desde', () => {
  const llegada = Z('2026-10-23T15:00:00Z');

  it('sin llegar a la ultima: no hay cierre manual', () => {
    expect(cierreManualDesde(paradas(null), cfg)).toEqual({
      desde: null,
      motivo: null,
      hora_prevista_fin: null,
      salida_detectada: null,
    });
  });

  it('sin salida detectada: la hora prevista de fin (TIEMPO)', () => {
    const r = cierreManualDesde(paradas(llegada), cfg);
    expect(r.desde).toEqual(Z('2026-10-23T15:30:00Z'));
    expect(r.motivo).toBe('TIEMPO');
  });

  it('salida detectada ANTES de la prevista: desde la detectada (GPS)', () => {
    const r = cierreManualDesde(paradas(llegada, { salida_detectada: Z('2026-10-23T15:10:00Z') }), cfg);
    expect(r.desde).toEqual(Z('2026-10-23T15:10:00Z'));
    expect(r.motivo).toBe('GPS');
    expect(r.hora_prevista_fin).toEqual(Z('2026-10-23T15:30:00Z'));
  });

  it('salida detectada DESPUES de la prevista: ya estaba habilitado por TIEMPO', () => {
    const r = cierreManualDesde(paradas(llegada, { salida_detectada: Z('2026-10-23T16:00:00Z') }), cfg);
    expect(r.desde).toEqual(Z('2026-10-23T15:30:00Z'));
    expect(r.motivo).toBe('TIEMPO');
  });
});

describe('configCierre', () => {
  it('defaults, basura y <= 0 -> default', () => {
    expect(configCierre({}).extensionMinutos).toBe(120);
    expect(configCierre({ CIERRE_EXTENSION_MINUTOS: 'abc' }).extensionMinutos).toBe(120);
    expect(configCierre({ CIERRE_EXTENSION_MINUTOS: '-5' }).extensionMinutos).toBe(120);
    expect(configCierre({ CIERRE_EXTENSION_MINUTOS: '0.5' }).extensionMinutos).toBe(0.5);
    expect(configCierre({}).finDiaSegundosTest).toBeNull();
    expect(configCierre({ CIERRE_FIN_DIA_SEGUNDOS_TEST: '8' }).finDiaSegundosTest).toBe(8);
  });
});

describe('limiteInicioCandidatos (filtro grueso del chequeo perezoso)', () => {
  it('es el inicio del dia local que contiene a ahora + 1 s', () => {
    // 23:59:58 AR del 23 (02:59:58Z del 24): todavia no vence nada de hoy.
    expect(limiteInicioCandidatos(Z('2026-10-24T02:59:58Z'), cfg)).toEqual(Z('2026-10-23T03:00:00Z'));
    // 23:59:59 AR: los iniciados hoy ya son candidatos.
    expect(limiteInicioCandidatos(Z('2026-10-24T02:59:59Z'), cfg)).toEqual(Z('2026-10-24T03:00:00Z'));
  });

  it('coincide con finDelDia: candidato <=> su fin del dia ya paso', () => {
    const inicio = Z('2026-10-23T13:00:00Z');
    for (const ahora of [Z('2026-10-24T02:59:58Z'), Z('2026-10-24T02:59:59Z'), Z('2026-10-24T10:00:00Z')]) {
      const candidato = inicio < limiteInicioCandidatos(ahora, cfg);
      expect(candidato).toBe(finDelDia(inicio, cfg) <= ahora);
    }
  });

  it('con la variable de test no hay filtro', () => {
    expect(limiteInicioCandidatos(new Date(), { ...cfg, finDiaSegundosTest: 5 })).toBeNull();
  });
});
