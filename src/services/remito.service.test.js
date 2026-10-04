import { describe, it, expect } from 'vitest';
import { bloqueSolicitante, formatearCuit } from './remito.service.js';

describe('bloqueSolicitante (encabezado del remito)', () => {
  it('viaje de PyME: titulo PYME con nombre, CUIT formateado y razon social', () => {
    const bloque = bloqueSolicitante({
      organizacion: { nombre: 'Ferreteria Sur', cuit: '30712345671', razon_social: 'Ferreteria Sur SRL' },
      // El cliente (ancla del schema: el creador) NO aparece.
      cliente: { nombre_empresa: 'Legacy SA', usuario: { nombre: 'Ana', apellido: 'Paz', telefono: '11' } },
    });
    expect(bloque).toEqual({
      titulo: 'PYME',
      lineas: ['Nombre: Ferreteria Sur', 'CUIT: 30-71234567-1', 'Razón social: Ferreteria Sur SRL'],
    });
  });

  it('PyME sin razon social', () => {
    const bloque = bloqueSolicitante({ organizacion: { nombre: 'X', cuit: '30712345671', razon_social: null } });
    expect(bloque.lineas).toEqual(['Nombre: X', 'CUIT: 30-71234567-1']);
  });

  it('viaje legacy: titulo CLIENTE, como siempre', () => {
    const bloque = bloqueSolicitante({
      organizacion: null,
      cliente: { nombre_empresa: 'Legacy SA', usuario: { nombre: 'Ana', apellido: 'Paz', telefono: '11' } },
    });
    expect(bloque).toEqual({
      titulo: 'CLIENTE',
      lineas: ['Nombre: Ana Paz', 'Empresa: Legacy SA', 'Teléfono: 11'],
    });
  });
});

describe('formatearCuit', () => {
  it('11 digitos -> XX-XXXXXXXX-X; otra cosa pasa tal cual', () => {
    expect(formatearCuit('30712345671')).toBe('30-71234567-1');
    expect(formatearCuit('123')).toBe('123');
    expect(formatearCuit(null)).toBe('');
  });
});
