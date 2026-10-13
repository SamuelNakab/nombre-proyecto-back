import { describe, it, expect } from 'vitest';
import { paradaVistaChofer, paradaVistaPyme } from './vista-parada.js';

// Una parada tal como la trae INCLUDE_VIAJE_INTERNO (con el lugar guardado).
const NOMBRE = 'Deposito Secreto Pilar';
const parada = {
  id_parada: 11,
  id_viaje: 5,
  orden: 1,
  direccion: 'Ruta 8 km 50, Pilar',
  latitud: -34.45,
  longitud: -58.91,
  estado: 'PENDIENTE',
  fecha_entrega: null,
  llegada_estimada: new Date('2026-10-10T12:00:00.000Z'),
  peon_estimado_min: 30,
  id_lugar: 7,
  lugar: { id_lugar: 7, nombre: NOMBRE, activo: true },
};

describe('paradaVistaChofer', () => {
  it('sin lugar ni id_lugar: solo direccion, coordenadas, estado y tiempos', () => {
    const v = paradaVistaChofer(parada);
    expect(v).not.toHaveProperty('lugar');
    expect(v).not.toHaveProperty('id_lugar');
    expect(v).toMatchObject({ id_parada: 11, direccion: 'Ruta 8 km 50, Pilar', latitud: -34.45, longitud: -58.91 });
    expect(JSON.stringify(v)).not.toContain(NOMBRE);
  });

  it('una parada sin lugar queda igual (menos id_lugar)', () => {
    const v = paradaVistaChofer({ ...parada, id_lugar: null, lugar: null });
    expect(v).not.toHaveProperty('id_lugar');
    expect(v.direccion).toBe('Ruta 8 km 50, Pilar');
  });

  it('no muta la parada original', () => {
    paradaVistaChofer(parada);
    expect(parada.lugar.nombre).toBe(NOMBRE);
  });
});

describe('paradaVistaPyme', () => {
  it('la PyME ve el lugar con su nombre', () => {
    expect(paradaVistaPyme(parada)).toMatchObject({
      id_lugar: 7,
      lugar: { id_lugar: 7, nombre: NOMBRE, activo: true },
      direccion: 'Ruta 8 km 50, Pilar',
    });
  });

  it('un lugar borrado se sigue viendo, con activo false', () => {
    const v = paradaVistaPyme({ ...parada, lugar: { id_lugar: 7, nombre: NOMBRE, activo: false } });
    expect(v.lugar).toEqual({ id_lugar: 7, nombre: NOMBRE, activo: false });
  });

  it('sin lugar -> lugar null', () => {
    expect(paradaVistaPyme({ ...parada, id_lugar: null, lugar: null }).lugar).toBeNull();
  });

  it('tira si la parada viene de un lugar y el include se olvido la relacion', () => {
    // eslint-disable-next-line no-unused-vars
    const { lugar, ...sinRelacion } = parada;
    expect(() => paradaVistaPyme(sinRelacion)).toThrow(/relacion lugar/);
  });
});
