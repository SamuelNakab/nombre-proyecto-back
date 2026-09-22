import { describe, it, expect } from 'vitest';
import {
  horasAMinutos,
  calcularDuracionRealMinutos,
  calcularDuracionCargaMinutos,
  calcularDuracionDescargaMinutos,
  calcularDuracionAproximacionMinutos,
} from './duracion.service.js';

const T0 = new Date('2026-03-10T12:00:00.000Z');
const en = (m) => new Date(T0.getTime() + m * 60000);

// Historial de un viaje que corrio entero, con tiempos redondos:
//   sale hacia el origen  T0
//   llega al origen       T0 + 20   (no es una fila: es fecha_llegada_origen)
//   empieza a cargar      T0 + 25
//   sale del origen       T0 + 55   -> 30 min de carga
//   empieza a descargar   T0 + 100
//   cierra                T0 + 115  -> 15 min de descarga
const historialCompleto = [
  { id_historial: 1, estado: 'BUSCANDO_CONDUCTOR', fecha: en(-60) },
  { id_historial: 2, estado: 'CONDUCTOR_ASIGNADO', fecha: en(-30) },
  { id_historial: 3, estado: 'EN_CAMINO_A_ORIGEN', fecha: en(0) },
  { id_historial: 4, estado: 'CARGANDO', fecha: en(25) },
  { id_historial: 5, estado: 'EN_RUTA', fecha: en(55) },
  { id_historial: 6, estado: 'DESCARGANDO', fecha: en(100) },
  { id_historial: 7, estado: 'FINALIZADO', fecha: en(115) },
];

const viajeFinalizado = (over = {}) => ({
  estado: 'FINALIZADO',
  fecha_inicio: en(0),
  fecha_llegada_origen: en(20),
  historial_estados: historialCompleto,
  paradas: [{ fecha_entrega: en(90) }, { fecha_entrega: en(115) }],
  ...over,
});

describe('horasAMinutos', () => {
  it('convierte horas float a minutos enteros', () => {
    expect(horasAMinutos(1.5)).toBe(90);
    expect(horasAMinutos(0.25)).toBe(15);
  });

  it('null/undefined/basura pasan como null', () => {
    expect(horasAMinutos(null)).toBe(null);
    expect(horasAMinutos(undefined)).toBe(null);
    expect(horasAMinutos(NaN)).toBe(null);
  });
});

describe('calcularDuracionRealMinutos', () => {
  // EL cambio de semantica: se mide desde la SALIDA del origen (la fila
  // EN_RUTA), no desde fecha_inicio. Con fecha_inicio daria 115, no 60.
  it('mide desde la salida del origen (EN_RUTA) hasta la ultima entrega', () => {
    expect(calcularDuracionRealMinutos(viajeFinalizado())).toBe(60);
  });

  it('usa max(fecha_entrega), no la ultima parada por orden', () => {
    const v = viajeFinalizado({
      paradas: [{ fecha_entrega: en(115) }, { fecha_entrega: en(90) }],
    });
    expect(calcularDuracionRealMinutos(v)).toBe(60);
  });

  it('es null mientras el viaje no este FINALIZADO', () => {
    expect(calcularDuracionRealMinutos(viajeFinalizado({ estado: 'EN_RUTA' }))).toBe(null);
  });

  // Los 159 viajes ya finalizados no tienen fila EN_RUTA. Devolver el numero
  // viejo seria devolver algo que ya no significa lo mismo.
  it('es null en un viaje viejo sin historial', () => {
    expect(calcularDuracionRealMinutos(viajeFinalizado({ historial_estados: [] }))).toBe(null);
  });

  it('es null si ninguna parada fue confirmada', () => {
    expect(
      calcularDuracionRealMinutos(viajeFinalizado({ paradas: [{ fecha_entrega: null }] }))
    ).toBe(null);
  });

  it('es null si la ultima entrega quedo antes de la salida (reloj corrido)', () => {
    expect(
      calcularDuracionRealMinutos(viajeFinalizado({ paradas: [{ fecha_entrega: en(10) }] }))
    ).toBe(null);
  });

  it('tira error si falta la relacion paradas', () => {
    const { paradas, ...sinParadas } = viajeFinalizado();
    expect(paradas).toBeDefined();
    expect(() => calcularDuracionRealMinutos(sinParadas)).toThrow(/paradas incluida/);
  });

  it('tira error si falta el historial', () => {
    const { historial_estados, ...sinHistorial } = viajeFinalizado();
    expect(historial_estados).toBeDefined();
    expect(() => calcularDuracionRealMinutos(sinHistorial)).toThrow(/historial_estados/);
  });
});

describe('calcularDuracionCargaMinutos', () => {
  it('mide de CARGANDO a EN_RUTA — el tiempo de peon en el origen', () => {
    expect(calcularDuracionCargaMinutos(viajeFinalizado())).toBe(30);
  });

  it('es null si el viaje todavia no salio del origen', () => {
    const v = viajeFinalizado({ historial_estados: historialCompleto.slice(0, 4) });
    expect(calcularDuracionCargaMinutos(v)).toBe(null);
  });

  it('es null en un viaje viejo sin historial', () => {
    expect(calcularDuracionCargaMinutos(viajeFinalizado({ historial_estados: [] }))).toBe(null);
  });

  it('tira error si falta el historial', () => {
    expect(() => calcularDuracionCargaMinutos({})).toThrow(/historial_estados/);
  });
});

describe('calcularDuracionDescargaMinutos', () => {
  it('mide de DESCARGANDO a FINALIZADO', () => {
    expect(calcularDuracionDescargaMinutos(viajeFinalizado())).toBe(15);
  });

  it('es null si el viaje todavia no cerro', () => {
    const v = viajeFinalizado({ historial_estados: historialCompleto.slice(0, 6) });
    expect(calcularDuracionDescargaMinutos(v)).toBe(null);
  });

  // Un viaje que ya estaba EN_RUTA cuando se deployo esto SI puede tener este
  // dato: las dos transiciones que necesita ocurren despues.
  it('funciona con historial parcial si tiene las dos filas que necesita', () => {
    const v = viajeFinalizado({
      historial_estados: [
        { id_historial: 9, estado: 'DESCARGANDO', fecha: en(100) },
        { id_historial: 10, estado: 'FINALIZADO', fecha: en(115) },
      ],
    });
    expect(calcularDuracionDescargaMinutos(v)).toBe(15);
    expect(calcularDuracionRealMinutos(v)).toBe(null);
  });
});

describe('calcularDuracionAproximacionMinutos', () => {
  it('mide de fecha_inicio a fecha_llegada_origen', () => {
    expect(calcularDuracionAproximacionMinutos(viajeFinalizado())).toBe(20);
  });

  it('no necesita el historial: le alcanzan dos escalares', () => {
    expect(
      calcularDuracionAproximacionMinutos({ fecha_inicio: en(0), fecha_llegada_origen: en(20) })
    ).toBe(20);
  });

  it('es null si el viaje no arranco o no registro la llegada', () => {
    expect(
      calcularDuracionAproximacionMinutos({ fecha_inicio: null, fecha_llegada_origen: en(20) })
    ).toBe(null);
    expect(
      calcularDuracionAproximacionMinutos({ fecha_inicio: en(0), fecha_llegada_origen: null })
    ).toBe(null);
  });

  it('tira error si falta alguno de los dos campos', () => {
    expect(() => calcularDuracionAproximacionMinutos({ fecha_inicio: en(0) })).toThrow(
      /fecha_inicio y fecha_llegada_origen/
    );
  });
});
