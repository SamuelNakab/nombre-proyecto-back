import { describe, it, expect } from 'vitest';
import {
  validarTransicion,
  TRANSICIONES,
  TRANSICIONES_INTERNO,
  ESTADOS_TERMINALES,
  cicloDe,
} from './estado-viaje.service.js';

describe('validarTransicion', () => {
  it('permite el avance normal del flujo manual', () => {
    expect(() => validarTransicion('EN_CAMINO_A_ORIGEN', 'CARGANDO')).not.toThrow();
    expect(() => validarTransicion('CARGANDO', 'EN_RUTA')).not.toThrow();
    expect(() => validarTransicion('EN_RUTA', 'DESCARGANDO')).not.toThrow();
    expect(() => validarTransicion('DESCARGANDO', 'FINALIZADO')).not.toThrow();
  });

  it('rechaza retrocesos como EN_RUTA -> CARGANDO', () => {
    expect(() => validarTransicion('EN_RUTA', 'CARGANDO')).toThrow(/Transicion invalida/);
  });

  it('rechaza saltos de estado (EN_CAMINO_A_ORIGEN -> EN_RUTA)', () => {
    expect(() => validarTransicion('EN_CAMINO_A_ORIGEN', 'EN_RUTA')).toThrow(/Transicion invalida/);
  });

  it('permite las transiciones de la estructura jerarquica', () => {
    expect(() => validarTransicion('BUSCANDO_CONDUCTOR', 'RESERVADO_POR_EMPRESA')).not.toThrow();
    expect(() => validarTransicion('RESERVADO_POR_EMPRESA', 'CONDUCTOR_ASIGNADO')).not.toThrow();
    expect(() => validarTransicion('RESERVADO_POR_EMPRESA', 'BUSCANDO_CONDUCTOR')).not.toThrow();
    expect(() => validarTransicion('CONDUCTOR_ASIGNADO', 'RESERVADO_POR_EMPRESA')).not.toThrow();
  });

  it('permite cancelar desde cualquier estado no terminal', () => {
    for (const estado of Object.keys(TRANSICIONES)) {
      if (estado === 'FINALIZADO' || estado === 'CANCELADO') continue;
      expect(() => validarTransicion(estado, 'CANCELADO')).not.toThrow();
    }
  });

  it('no permite transicionar desde un estado terminal', () => {
    expect(() => validarTransicion('FINALIZADO', 'CARGANDO')).toThrow(/Transicion invalida/);
    expect(() => validarTransicion('CANCELADO', 'BUSCANDO_CONDUCTOR')).toThrow(/Transicion invalida/);
  });

  it('tira error claro ante un estado actual desconocido', () => {
    expect(() => validarTransicion('ESTADO_FALSO', 'CARGANDO')).toThrow(/desconocido/);
  });
});

// ─── Ciclo INTERNO (Paso 2) ──────────────────────────────────────────────────

const interno = (quien) => ({ ciclo: 'INTERNO', quien });
const ACTORES = ['CHOFER', 'PYME', 'ADMIN', 'SISTEMA'];

// La tabla completa, fila por fila: [desde, hacia, quienes pueden]. Ciclo por
// parada (Paso 3): salir = CARGANDO/DESCARGANDO -> EN_RUTA (o FINALIZADO en la
// ultima); confirmar-parada = EN_RUTA -> DESCARGANDO. EN_RUTA -> FINALIZADO ya
// no existe.
const VALIDAS_INTERNO = [
  ['ASIGNADO', 'CONFIRMADO', ['CHOFER']],
  ['ASIGNADO', 'RECHAZADO', ['CHOFER']],
  ['ASIGNADO', 'ASIGNADO', ['PYME']],
  ['ASIGNADO', 'CANCELADO', ['CHOFER', 'PYME', 'ADMIN', 'SISTEMA']],
  ['ASIGNADO', 'VENCIDO', ['SISTEMA']],
  ['CONFIRMADO', 'CARGANDO', ['CHOFER']],
  ['CONFIRMADO', 'ASIGNADO', ['PYME']],
  ['CONFIRMADO', 'CANCELADO', ['CHOFER', 'PYME', 'ADMIN', 'SISTEMA']],
  ['CONFIRMADO', 'VENCIDO', ['SISTEMA']],
  ['CARGANDO', 'EN_RUTA', ['CHOFER']],
  ['CARGANDO', 'CANCELADO', ['PYME', 'ADMIN', 'SISTEMA']],
  ['EN_RUTA', 'DESCARGANDO', ['CHOFER']],
  ['EN_RUTA', 'CANCELADO', ['PYME', 'ADMIN', 'SISTEMA']],
  ['DESCARGANDO', 'EN_RUTA', ['CHOFER']],
  ['DESCARGANDO', 'FINALIZADO', ['CHOFER']],
  ['DESCARGANDO', 'CANCELADO', ['PYME', 'ADMIN', 'SISTEMA']],
];

describe('validarTransicion — ciclo interno', () => {
  it('la tabla tiene exactamente estas transiciones', () => {
    const enTabla = Object.entries(TRANSICIONES_INTERNO).flatMap(([desde, destinos]) =>
      Object.entries(destinos).map(([hacia, regla]) => [desde, hacia, regla.quien])
    );
    expect(enTabla).toEqual(VALIDAS_INTERNO);
  });

  it('cada transicion valida la permite su actor y la rechaza el resto', () => {
    for (const [desde, hacia, quienes] of VALIDAS_INTERNO) {
      for (const actor of ACTORES) {
        const llamada = () => validarTransicion(desde, hacia, interno(actor));
        if (quienes.includes(actor)) expect(llamada).not.toThrow();
        else expect(llamada).toThrow(/no permitida/);
      }
    }
  });

  it('no existe EN_CAMINO_A_ORIGEN ni los saltos', () => {
    expect(() => validarTransicion('CONFIRMADO', 'EN_CAMINO_A_ORIGEN', interno('CHOFER'))).toThrow(/Transicion invalida/);
    expect(() => validarTransicion('CONFIRMADO', 'EN_RUTA', interno('CHOFER'))).toThrow(/Transicion invalida/);
    expect(() => validarTransicion('ASIGNADO', 'CARGANDO', interno('CHOFER'))).toThrow(/Transicion invalida/);
    expect(() => validarTransicion('EN_RUTA', 'CARGANDO', interno('CHOFER'))).toThrow(/Transicion invalida/);
  });

  it('el chofer no puede cancelar un viaje en curso; la PyME si', () => {
    for (const estado of ['CARGANDO', 'EN_RUTA', 'DESCARGANDO']) {
      expect(() => validarTransicion(estado, 'CANCELADO', interno('CHOFER'))).toThrow(/no permitida/);
      expect(() => validarTransicion(estado, 'CANCELADO', interno('PYME'))).not.toThrow();
    }
  });

  it('los cuatro finales no tienen salida', () => {
    for (const final of ['FINALIZADO', 'CANCELADO', 'RECHAZADO', 'VENCIDO']) {
      expect(TRANSICIONES_INTERNO[final]).toEqual({});
      for (const actor of ACTORES) {
        expect(() => validarTransicion(final, 'CANCELADO', interno(actor))).toThrow(/Transicion invalida/);
      }
    }
    expect(ESTADOS_TERMINALES).toEqual(['FINALIZADO', 'CANCELADO', 'RECHAZADO', 'VENCIDO']);
  });

  it('sin actor tira error', () => {
    expect(() => validarTransicion('ASIGNADO', 'CONFIRMADO', { ciclo: 'INTERNO' })).toThrow(/no permitida/);
  });

  it('un estado legacy no existe en la tabla interna', () => {
    expect(() => validarTransicion('CONDUCTOR_ASIGNADO', 'CANCELADO', interno('PYME'))).toThrow(/desconocido/);
  });

  it('sin contexto sigue usando la tabla legacy (los callers viejos no cambian)', () => {
    expect(() => validarTransicion('CONDUCTOR_ASIGNADO', 'EN_CAMINO_A_ORIGEN')).not.toThrow();
    expect(() => validarTransicion('ASIGNADO', 'CONFIRMADO')).toThrow(/desconocido/);
    expect(() => validarTransicion('CARGANDO', 'EN_RUTA', { ciclo: 'LEGACY', quien: 'NADIE' })).not.toThrow();
  });
});

describe('cicloDe', () => {
  it('INTERNO con id_organizacion, LEGACY con null', () => {
    expect(cicloDe({ id_organizacion: 7 })).toBe('INTERNO');
    expect(cicloDe({ id_organizacion: null })).toBe('LEGACY');
  });

  it('tira si el viaje no trae id_organizacion', () => {
    expect(() => cicloDe({})).toThrow(/id_organizacion/);
  });
});

describe('ciclo por parada (Paso 3)', () => {
  it('EN_RUTA ya no puede pasar directo a FINALIZADO', () => {
    expect(() => validarTransicion('EN_RUTA', 'FINALIZADO', interno('CHOFER'))).toThrow(/Transicion invalida/);
  });

  it('el chofer alterna entre EN_RUTA y DESCARGANDO en cada parada', () => {
    expect(() => validarTransicion('EN_RUTA', 'DESCARGANDO', interno('CHOFER'))).not.toThrow();
    expect(() => validarTransicion('DESCARGANDO', 'EN_RUTA', interno('CHOFER'))).not.toThrow();
  });
});
