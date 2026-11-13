import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { VISIBLES_CHOFER, OCULTAS_CHOFER, viajeVistaChofer, resumenVistaChofer } from './vista-chofer.js';

const PRECIO = /precio|tarifa|peaje|tiempo_capital|distancia_provincia/;

describe('vista del chofer: clasificacion de TODAS las columnas de Viaje', () => {
  const columnas = Object.keys(Prisma.ViajeScalarFieldEnum);

  it('cada columna escalar esta en VISIBLES o en OCULTAS (una nueva sin clasificar rompe este test)', () => {
    const sinClasificar = columnas.filter((c) => !VISIBLES_CHOFER.includes(c) && !OCULTAS_CHOFER.includes(c));
    expect(sinClasificar).toEqual([]);
  });

  it('ninguna columna esta en las dos listas ni sobra', () => {
    expect(VISIBLES_CHOFER.filter((c) => OCULTAS_CHOFER.includes(c))).toEqual([]);
    expect([...VISIBLES_CHOFER, ...OCULTAS_CHOFER].filter((c) => !columnas.includes(c))).toEqual([]);
  });

  it('ninguna columna de precio, tarifa o peaje es visible (salvo el instante de corte)', () => {
    expect(VISIBLES_CHOFER.filter((c) => PRECIO.test(c) && c !== 'fecha_corte_precio')).toEqual([]);
  });
});

describe('viajeVistaChofer', () => {
  const serializado = {
    id_viaje: 1,
    estado: 'FINALIZADO',
    precio_estimado: 84000,
    precio_real: 90000,
    tarifa_hora: 37500,
    precio_parametros: { x: 1 },
    id_creador: 9,
    id_cliente: 7,
    cancelado_por_admin_id: 6,
    tipo_servicio: 'LIVIANO',
    creador: { id_usuario: 9, nombre: 'Ana', apellido: 'B' },
    precio_pagado: { monto: 1 },
    precio_pagado_pendiente: false,
    organizacion: { id_organizacion: 3, nombre: 'PyME', cuit: '30999999995', email: 'x@y' },
    conductor: { id_conductor: 2, id_usuario: 5, nombre: 'C', apellido: 'D', telefono: '1', email: 'c@d', dni: '1', firebase_uid: 'u' },
    vehiculo: { id_vehiculo: 4, patente: 'AA', marca: 'M', modelo: 'X', anio: 2020, color: 'r', tipo_vehiculo: 'utilitario', id_conductor: 2 },
    historial_estados: [{ id_historial: 1, id_viaje: 1, estado: 'ASIGNADO', fecha: 'f', id_usuario: 9, origen: 'CLIENTE' }],
    paradas: [{ id_parada: 1 }],
    remito_url: 'u',
    ruta_planeada: null,
    cierre: { cerrado_por: 'CHOFER' },
  };
  const v = viajeVistaChofer(serializado);

  it('sin precios, tarifas, snapshot ni feedback', () => {
    for (const k of ['precio_estimado', 'precio_real', 'tarifa_hora', 'precio_parametros', 'precio_pagado', 'precio_pagado_pendiente']) {
      expect(v).not.toHaveProperty(k);
    }
  });

  it('sin datos del creador ni ids de otros usuarios', () => {
    for (const k of ['creador', 'id_creador', 'id_cliente', 'cancelado_por_admin_id']) expect(v).not.toHaveProperty(k);
    expect(v.historial_estados[0]).toEqual({ id_historial: 1, estado: 'ASIGNADO', fecha: 'f', origen: 'CLIENTE' });
  });

  it('relaciones con lista blanca', () => {
    expect(v.organizacion).toEqual({ id_organizacion: 3, nombre: 'PyME', cuit: '30999999995' });
    expect(v.conductor).toEqual({ id_conductor: 2, id_usuario: 5, nombre: 'C', apellido: 'D', telefono: '1' });
    expect(v.vehiculo).not.toHaveProperty('id_conductor');
  });

  it('lo operativo si llega', () => {
    expect(v).toMatchObject({ id_viaje: 1, tipo_servicio: 'LIVIANO', remito_url: 'u', cierre: { cerrado_por: 'CHOFER' } });
  });

  it('resumen sin precio', () => {
    expect(resumenVistaChofer({ id_viaje: 1, precio_estimado: 1, precio_estimado_min: 1, precio_estimado_max: 2 })).toEqual({
      id_viaje: 1,
    });
  });
});
