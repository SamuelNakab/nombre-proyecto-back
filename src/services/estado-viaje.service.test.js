import { describe, it, expect } from 'vitest';
import { validarTransicion, TRANSICIONES } from './estado-viaje.service.js';

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
