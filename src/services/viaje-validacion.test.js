import { describe, it, expect, afterEach } from 'vitest';
import {
  maxParadasPorViaje,
  MAX_PARADAS_DEFAULT,
  schemaParadas,
  schemaParadasInternas,
  snapshotParadas,
  paradasParaCrear,
} from './viaje-validacion.js';

// El tope se lee de process.env en cada validacion: los tests lo setean y lo
// restauran. Nada sale del .env (CI no lo tiene).
const ORIGINAL = process.env.MAX_PARADAS_POR_VIAJE;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MAX_PARADAS_POR_VIAJE;
  else process.env.MAX_PARADAS_POR_VIAJE = ORIGINAL;
});

const paradas = (n) => Array.from({ length: n }, (_, i) => ({ lat: -34.6 + i * 0.001, lng: -58.4 }));

describe('maxParadasPorViaje', () => {
  it('default 10; basura, vacio, decimales o < 2 caen al default', () => {
    expect(MAX_PARADAS_DEFAULT).toBe(10);
    expect(maxParadasPorViaje({})).toBe(10);
    expect(maxParadasPorViaje({ MAX_PARADAS_POR_VIAJE: '' })).toBe(10);
    expect(maxParadasPorViaje({ MAX_PARADAS_POR_VIAJE: 'abc' })).toBe(10);
    expect(maxParadasPorViaje({ MAX_PARADAS_POR_VIAJE: '2.5' })).toBe(10);
    expect(maxParadasPorViaje({ MAX_PARADAS_POR_VIAJE: '1' })).toBe(10);
    expect(maxParadasPorViaje({ MAX_PARADAS_POR_VIAJE: '-4' })).toBe(10);
  });

  it('un entero >= 2 vale', () => {
    expect(maxParadasPorViaje({ MAX_PARADAS_POR_VIAJE: '2' })).toBe(2);
    expect(maxParadasPorViaje({ MAX_PARADAS_POR_VIAJE: '25' })).toBe(25);
  });
});

describe('tope de paradas en los schemas', () => {
  it('con el default: 10 paradas pasan, 11 dan el error', () => {
    delete process.env.MAX_PARADAS_POR_VIAJE;
    expect(schemaParadas.safeParse(paradas(10)).success).toBe(true);
    const r = schemaParadas.safeParse(paradas(11));
    expect(r.success).toBe(false);
    expect(r.error.issues[0].message).toBe('Un viaje puede tener como máximo 10 paradas');
  });

  it('con MAX_PARADAS_POR_VIAJE=3: N pasa, N+1 no (se lee en cada validacion)', () => {
    process.env.MAX_PARADAS_POR_VIAJE = '3';
    expect(schemaParadas.safeParse(paradas(3)).success).toBe(true);
    expect(schemaParadas.safeParse(paradas(4)).error.issues[0].message).toBe(
      'Un viaje puede tener como máximo 3 paradas'
    );
    expect(schemaParadasInternas.safeParse(paradas(3)).success).toBe(true);
    expect(schemaParadasInternas.safeParse(paradas(4)).error.issues[0].message).toBe(
      'Un viaje puede tener como máximo 3 paradas'
    );
  });

  it('el minimo de 2 sigue igual', () => {
    expect(schemaParadas.safeParse(paradas(1)).success).toBe(false);
    expect(schemaParadasInternas.safeParse(paradas(1)).success).toBe(false);
  });

  it('opcional (editar): sin paradas no se valida el tope', () => {
    process.env.MAX_PARADAS_POR_VIAJE = '2';
    expect(schemaParadasInternas.optional().safeParse(undefined).success).toBe(true);
  });
});

describe('schemaParadasInternas: lugar O coordenadas', () => {
  it('acepta lugares, coordenadas y mezcla', () => {
    const r = schemaParadasInternas.safeParse([{ id_lugar: 4 }, { lat: -34.6, lng: -58.4, direccion: 'Av. X 123' }]);
    expect(r.success).toBe(true);
    expect(r.data).toEqual([{ id_lugar: 4 }, { lat: -34.6, lng: -58.4, direccion: 'Av. X 123' }]);
  });

  it('id_lugar con coordenadas -> error', () => {
    const r = schemaParadasInternas.safeParse([{ id_lugar: 4, lat: -34.6, lng: -58.4 }, { id_lugar: 5 }]);
    expect(r.error.issues[0].message).toBe('Cada parada lleva id_lugar o lat y lng, no las dos cosas');
  });

  it('ni lugar ni coordenadas completas -> error', () => {
    expect(schemaParadasInternas.safeParse([{ direccion: 'algo' }, { id_lugar: 5 }]).error.issues[0].message).toBe(
      'Cada parada lleva id_lugar o lat y lng'
    );
    expect(schemaParadasInternas.safeParse([{ lat: -34.6 }, { id_lugar: 5 }]).success).toBe(false);
  });

  it('id_lugar invalido', () => {
    expect(schemaParadasInternas.safeParse([{ id_lugar: 0 }, { id_lugar: 5 }]).error.issues[0].message).toBe(
      'id_lugar invalido'
    );
    expect(schemaParadasInternas.safeParse([{ id_lugar: 1.5 }, { id_lugar: 5 }]).success).toBe(false);
  });

  it('la ruta legacy NO acepta lugares', () => {
    expect(schemaParadas.safeParse([{ id_lugar: 4 }, { id_lugar: 5 }]).success).toBe(false);
  });
});

describe('snapshot de un lugar en la parada', () => {
  const lugar = {
    id_lugar: 7,
    id_organizacion: 3,
    nombre: 'Deposito Pilar',
    direccion: 'Ruta 8 km 50, Pilar',
    latitud: -34.45,
    longitud: -58.91,
    activo: true,
  };
  const porId = new Map([[7, lugar]]);

  it('copia direccion y coordenadas del lugar y guarda id_lugar; el nombre NO viaja', () => {
    const r = snapshotParadas([{ id_lugar: 7 }, { lat: -34.6, lng: -58.4, direccion: 'Av. X 123' }], porId);
    expect(r).toEqual([
      { lat: -34.45, lng: -58.91, direccion: 'Ruta 8 km 50, Pilar', id_lugar: 7 },
      { lat: -34.6, lng: -58.4, direccion: 'Av. X 123', id_lugar: null },
    ]);
    expect(JSON.stringify(r)).not.toContain('Deposito Pilar');
  });

  it('es una COPIA: cambiar el lugar despues no cambia lo que ya se resolvio', () => {
    const lugarMutable = { ...lugar };
    const r = snapshotParadas([{ id_lugar: 7 }], new Map([[7, lugarMutable]]));
    lugarMutable.direccion = 'Otra direccion';
    lugarMutable.latitud = 0;
    expect(r[0]).toEqual({ lat: -34.45, lng: -58.91, direccion: 'Ruta 8 km 50, Pilar', id_lugar: 7 });
  });

  it('tira si falta el lugar (el servicio valida antes y da 400)', () => {
    expect(() => snapshotParadas([{ id_lugar: 99 }], porId)).toThrow(/falta el lugar 99/);
  });

  it('paradasParaCrear lleva id_lugar a la fila (null para coordenadas)', () => {
    const filas = paradasParaCrear(snapshotParadas([{ id_lugar: 7 }, { lat: -34.6, lng: -58.4 }], porId));
    expect(filas).toEqual([
      { orden: 1, latitud: -34.45, longitud: -58.91, direccion: 'Ruta 8 km 50, Pilar', id_lugar: 7 },
      { orden: 2, latitud: -34.6, longitud: -58.4, direccion: '-34.6,-58.4', id_lugar: null },
    ]);
  });
});
