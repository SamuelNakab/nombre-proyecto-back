import { describe, it, expect } from 'vitest';
import { conductorEsElegible } from './elegibilidad.service.js';

// Firma real: conductorEsElegible(vehiculosConductor, vehiculosPropios, condicionesViaje)
// - vehiculosConductor: array de conductor_vehiculo, cada uno con .vehiculo.condiciones[{ condicion }]
// - vehiculosPropios:   array de vehiculo, cada uno con .condiciones[{ condicion }]
// - condicionesViaje:   array de strings con las condiciones requeridas del viaje
describe('conductorEsElegible', () => {
  it('un conductor SIN vehiculos no es elegible aunque el viaje no tenga condiciones', () => {
    expect(conductorEsElegible([], [], [])).toBe(false);
  });
  it('un conductor con un vehiculo que cumple las condiciones SI es elegible', () => {
    expect(
      conductorEsElegible([], [{ condiciones: [{ condicion: 'FRAGIL' }] }], ['FRAGIL'])
    ).toBe(true);
  });
  it('un conductor con vehiculo que NO cumple las condiciones no es elegible', () => {
    expect(
      conductorEsElegible([], [{ condiciones: [] }], ['REFRIGERADO'])
    ).toBe(false);
  });
});
