import { describe, it, expect } from 'vitest';
import {
  localAUtc,
  partesLocales,
  generarOcurrencias,
  resolverVentana,
  diaSemanaIso,
  parsearFecha,
  diasDelMes,
  hoyLocal,
  MAX_VIAJES_POR_SERIE,
} from './serie-fechas.js';

// Todo con valores DEFINIDOS ACA: ni reloj, ni .env, ni red. `ahora` y la
// anticipacion se inyectan.
const AHORA = new Date('2026-10-09T12:00:00.000Z'); // viernes 9/10/2026, 09:00 en Buenos Aires
const fechasDe = (r) => r.ocurrencias.map((o) => o.fecha);
const iso = (d) => d.toISOString();

const serie = (extra) =>
  generarOcurrencias({
    hora: '09:00',
    fecha_desde: '2026-10-10',
    fecha_hasta: '2026-11-09',
    ahora: AHORA,
    anticipacionMinutos: 60,
    ...extra,
  });

describe('zona horaria (America/Argentina/Buenos_Aires)', () => {
  it('las 9:00 de Argentina son las 12:00 UTC', () => {
    expect(iso(localAUtc({ anio: 2026, mes: 10, dia: 10, hora: 9, minuto: 0 }))).toBe('2026-10-10T12:00:00.000Z');
  });

  it('21:30 de Argentina cruza la medianoche UTC: 00:30 del dia siguiente', () => {
    expect(iso(localAUtc({ anio: 2026, mes: 12, dia: 31, hora: 21, minuto: 30 }))).toBe('2027-01-01T00:30:00.000Z');
  });

  it('00:00 de Argentina son las 03:00 UTC del mismo dia', () => {
    expect(iso(localAUtc({ anio: 2026, mes: 10, dia: 10, hora: 0, minuto: 0 }))).toBe('2026-10-10T03:00:00.000Z');
  });

  it('ida y vuelta: partesLocales devuelve la hora local de partida', () => {
    const t = localAUtc({ anio: 2026, mes: 3, dia: 1, hora: 17, minuto: 45 });
    expect(partesLocales(t)).toMatchObject({ anio: 2026, mes: 3, dia: 1, hora: 17, minuto: 45 });
  });

  it('el offset sale de la zona en ESE instante: en New York cambia con el horario de verano', () => {
    // 8/3/2026 arranca el horario de verano en EEUU (EST -5 -> EDT -4).
    const antes = localAUtc({ anio: 2026, mes: 3, dia: 7, hora: 9, minuto: 0 }, 'America/New_York');
    const despues = localAUtc({ anio: 2026, mes: 3, dia: 9, hora: 9, minuto: 0 }, 'America/New_York');
    expect(iso(antes)).toBe('2026-03-07T14:00:00.000Z');
    expect(iso(despues)).toBe('2026-03-09T13:00:00.000Z');
  });

  it('"hoy" es la fecha LOCAL: las 02:00 UTC del 10 todavia son el 9 en Argentina', () => {
    expect(hoyLocal(new Date('2026-10-10T02:00:00.000Z'))).toEqual({ anio: 2026, mes: 10, dia: 9 });
  });
});

describe('calendario', () => {
  it('dia de la semana ISO: 1 lunes ... 7 domingo', () => {
    expect(diaSemanaIso(parsearFecha('2026-10-09'))).toBe(5); // viernes
    expect(diaSemanaIso(parsearFecha('2026-10-11'))).toBe(7); // domingo
    expect(diaSemanaIso(parsearFecha('2026-10-12'))).toBe(1); // lunes
  });

  it('dias del mes, con bisiesto', () => {
    expect(diasDelMes(2027, 2)).toBe(28);
    expect(diasDelMes(2028, 2)).toBe(29);
    expect(diasDelMes(2026, 11)).toBe(30);
    expect(diasDelMes(2026, 12)).toBe(31);
  });

  it('una fecha que no existe no se parsea', () => {
    expect(parsearFecha('2026-02-30')).toBeNull();
    expect(parsearFecha('2026-13-01')).toBeNull();
    expect(parsearFecha('10/10/2026')).toBeNull();
  });
});

describe('generarOcurrencias por frecuencia', () => {
  it('DIARIA: 31 viajes en la ventana inclusiva de 30 dias, todos a las 9:00 AR', () => {
    const r = serie({ frecuencia: 'DIARIA' });
    expect(r.ocurrencias).toHaveLength(31);
    expect(r.ocurrencias).toHaveLength(MAX_VIAJES_POR_SERIE);
    expect(r.salteadas).toEqual([]);
    expect(r.ocurrencias[0]).toMatchObject({ fecha: '2026-10-10' });
    expect(iso(r.ocurrencias[0].fecha_programada)).toBe('2026-10-10T12:00:00.000Z');
    expect(iso(r.ocurrencias[30].fecha_programada)).toBe('2026-11-09T12:00:00.000Z');
    for (const o of r.ocurrencias) expect(partesLocales(o.fecha_programada)).toMatchObject({ hora: 9, minuto: 0 });
  });

  it('DIAS_SEMANA lunes, miercoles y viernes', () => {
    const r = serie({ frecuencia: 'DIAS_SEMANA', dias_semana: [1, 3, 5] });
    expect(fechasDe(r).slice(0, 4)).toEqual(['2026-10-12', '2026-10-14', '2026-10-16', '2026-10-19']);
    expect(r.ocurrencias.every((o) => [1, 3, 5].includes(diaSemanaIso(parsearFecha(o.fecha))))).toBe(true);
    // 10/10 (sabado) a 9/11 (lunes): 4 lunes + 4 miercoles + 4 viernes + el lunes 9/11.
    expect(r.ocurrencias).toHaveLength(13);
  });

  it('SEMANAL los martes', () => {
    const r = serie({ frecuencia: 'SEMANAL', dia_semana: 2 });
    expect(fechasDe(r)).toEqual(['2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03']);
  });

  it('MENSUAL el dia 15', () => {
    const r = serie({ frecuencia: 'MENSUAL', dia_mes: 15 });
    expect(fechasDe(r)).toEqual(['2026-10-15']);
    expect(r.ocurrencias[0].ajuste).toBeUndefined();
  });

  it('MENSUAL el 31 en un mes que lo tiene: sin ajuste', () => {
    const r = serie({ frecuencia: 'MENSUAL', dia_mes: 31, fecha_desde: '2026-10-20', fecha_hasta: '2026-11-19' });
    expect(r.ocurrencias).toEqual([
      { fecha: '2026-10-31', fecha_programada: new Date('2026-10-31T12:00:00.000Z') },
    ]);
  });

  it('MENSUAL el 31 en noviembre (30 dias): se ajusta al 30, marcado FIN_DE_MES', () => {
    const r = serie({ frecuencia: 'MENSUAL', dia_mes: 31, fecha_desde: '2026-11-10', fecha_hasta: '2026-12-10' });
    expect(r.ocurrencias).toEqual([
      { fecha: '2026-11-30', fecha_programada: new Date('2026-11-30T12:00:00.000Z'), ajuste: 'FIN_DE_MES' },
    ]);
  });

  it('MENSUAL el 31 en febrero: el 28, y el 29 en un bisiesto', () => {
    const comun = serie({ frecuencia: 'MENSUAL', dia_mes: 31, fecha_desde: '2027-02-10', fecha_hasta: '2027-03-12' });
    expect(comun.ocurrencias).toMatchObject([{ fecha: '2027-02-28', ajuste: 'FIN_DE_MES' }]);
    const bisiesto = serie({ frecuencia: 'MENSUAL', dia_mes: 30, fecha_desde: '2028-02-10', fecha_hasta: '2028-03-11' });
    expect(fechasDe(bisiesto)).toEqual(['2028-02-29']);
    expect(bisiesto.ocurrencias[0].ajuste).toBe('FIN_DE_MES');
  });

  it('una ventana sin ninguna ocurrencia devuelve vacio', () => {
    const r = serie({ frecuencia: 'SEMANAL', dia_semana: 3, fecha_desde: '2026-10-10', fecha_hasta: '2026-10-12' });
    expect(r.ocurrencias).toEqual([]);
  });
});

describe('ocurrencias salteadas', () => {
  // 08:30 AR del sabado 10/10.
  const AHORA_SABADO = new Date('2026-10-10T11:30:00.000Z');

  it('PASADA: la hora de hoy ya paso', () => {
    const r = serie({ frecuencia: 'DIARIA', hora: '08:00', ahora: AHORA_SABADO, fecha_hasta: '2026-10-11' });
    expect(r.salteadas).toEqual([
      { fecha: '2026-10-10', fecha_programada: new Date('2026-10-10T11:00:00.000Z'), motivo: 'PASADA' },
    ]);
    expect(fechasDe(r)).toEqual(['2026-10-11']);
  });

  it('SIN_ANTICIPACION: falta menos que ANTICIPACION_MINIMA_MINUTOS', () => {
    const r = serie({ frecuencia: 'DIARIA', hora: '09:00', ahora: AHORA_SABADO, fecha_hasta: '2026-10-11' });
    expect(r.salteadas).toMatchObject([{ fecha: '2026-10-10', motivo: 'SIN_ANTICIPACION' }]);
    expect(fechasDe(r)).toEqual(['2026-10-11']);
  });

  it('el borde exacto (ahora + anticipacion) se saltea, igual que crear un viaje', () => {
    // 09:30 AR = 12:30Z = ahora (11:30Z) + 60 min.
    const r = serie({ frecuencia: 'DIARIA', hora: '09:30', ahora: AHORA_SABADO, fecha_hasta: '2026-10-10' });
    expect(r.salteadas).toMatchObject([{ motivo: 'SIN_ANTICIPACION' }]);
    const unMinutoMas = serie({ frecuencia: 'DIARIA', hora: '09:31', ahora: AHORA_SABADO, fecha_hasta: '2026-10-10' });
    expect(fechasDe(unMinutoMas)).toEqual(['2026-10-10']);
  });

  it('con anticipacion 0 solo se saltea lo que ya paso', () => {
    const r = serie({ frecuencia: 'DIARIA', hora: '08:31', ahora: AHORA_SABADO, anticipacionMinutos: 0, fecha_hasta: '2026-10-10' });
    expect(fechasDe(r)).toEqual(['2026-10-10']);
  });
});

describe('resolverVentana', () => {
  it('fecha_hasta por defecto = fecha_desde + 30 dias', () => {
    expect(resolverVentana({ fecha_desde: '2026-10-10', ahora: AHORA })).toEqual({
      fecha_desde: '2026-10-10',
      fecha_hasta: '2026-11-09',
    });
  });

  it('acepta una fecha_hasta dentro de los 30 dias', () => {
    expect(resolverVentana({ fecha_desde: '2026-10-10', fecha_hasta: '2026-10-20', ahora: AHORA })).toEqual({
      fecha_desde: '2026-10-10',
      fecha_hasta: '2026-10-20',
    });
  });

  it('hoy local vale como fecha_desde (aunque en UTC ya sea manana)', () => {
    // 23:00 AR del 9/10 = 02:00Z del 10/10.
    const r = resolverVentana({ fecha_desde: '2026-10-09', ahora: new Date('2026-10-10T02:00:00.000Z') });
    expect(r.fecha_desde).toBe('2026-10-09');
  });

  it('errores: fecha invalida, anterior a hoy, demasiado lejos, ventana de mas de 30 dias, hasta antes que desde', () => {
    expect(resolverVentana({ fecha_desde: '2026-02-30', ahora: AHORA }).error).toMatch(/fecha_desde/);
    expect(resolverVentana({ fecha_desde: '2026-10-08', ahora: AHORA }).error).toBe('fecha_desde no puede ser anterior a hoy');
    expect(resolverVentana({ fecha_desde: '2027-01-08', ahora: AHORA }).error).toMatch(/90 dias/);
    expect(resolverVentana({ fecha_desde: '2027-01-07', ahora: AHORA }).error).toBeUndefined();
    expect(resolverVentana({ fecha_desde: '2026-10-10', fecha_hasta: '2026-11-10', ahora: AHORA }).error).toMatch(
      /30 dias/
    );
    expect(resolverVentana({ fecha_desde: '2026-10-10', fecha_hasta: '2026-10-09', ahora: AHORA }).error).toMatch(
      /anterior a fecha_desde/
    );
    expect(resolverVentana({ fecha_desde: '2026-10-10', fecha_hasta: 'manana', ahora: AHORA }).error).toMatch(
      /fecha_hasta/
    );
  });
});
