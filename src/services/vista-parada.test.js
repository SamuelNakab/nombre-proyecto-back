import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  paradaVistaChofer,
  paradaVistaPyme,
  VISIBLES_CHOFER_PARADA,
  OCULTAS_CHOFER_PARADA,
  CALCULADOS_CHOFER_PARADA,
} from './vista-parada.js';
import { tiemposParada } from './duracion.service.js';

describe('vista del chofer: clasificacion de TODAS las columnas de Parada', () => {
  const columnas = Object.keys(Prisma.ParadaScalarFieldEnum);

  it('cada columna escalar esta en VISIBLES o en OCULTAS (una nueva sin clasificar rompe este test)', () => {
    const sinClasificar = columnas.filter(
      (c) => !VISIBLES_CHOFER_PARADA.includes(c) && !OCULTAS_CHOFER_PARADA.includes(c)
    );
    expect(sinClasificar).toEqual([]);
  });

  it('ninguna columna esta en las dos listas ni sobra', () => {
    expect(VISIBLES_CHOFER_PARADA.filter((c) => OCULTAS_CHOFER_PARADA.includes(c))).toEqual([]);
    expect([...VISIBLES_CHOFER_PARADA, ...OCULTAS_CHOFER_PARADA].filter((c) => !columnas.includes(c))).toEqual([]);
  });

  it('ningun peaje, precio ni lugar es visible', () => {
    expect(VISIBLES_CHOFER_PARADA.filter((c) => /peaje|precio|tarifa|lugar/.test(c))).toEqual([]);
    expect(OCULTAS_CHOFER_PARADA).toContain('peajes_google_tramo');
  });

  it('los calculados son exactamente los que suma tiemposParada', () => {
    expect(Object.keys(tiemposParada({})).sort()).toEqual([...CALCULADOS_CHOFER_PARADA].sort());
  });

  it('una parada COMPLETA da las mismas claves que el spread viejo, menos peajes_google_tramo', () => {
    const completa = Object.fromEntries(columnas.map((c) => [c, `v-${c}`]));
    const conTiempos = { ...completa, ...tiemposParada({}), lugar: { nombre: 'x' } };
    // El spread de antes: todo menos id_lugar y lugar.
    // eslint-disable-next-line no-unused-vars
    const { id_lugar, lugar, ...viejo } = conTiempos;
    const nuevo = paradaVistaChofer(conTiempos);
    expect(Object.keys(nuevo).sort()).toEqual(Object.keys(viejo).filter((k) => k !== 'peajes_google_tramo').sort());
    expect(nuevo).not.toHaveProperty('peajes_google_tramo');
  });
});

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
