// Mensajes de validacion en español (Tarea 6): los defaults de Zod salen con el
// nombre del campo, y los mensajes propios que ya existian NO cambian (el front y
// el simulador dependen de ellos).
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../config/prisma.js', () => ({ default: {} }));
vi.mock('../config/firebase.js', () => ({ default: {} }));
vi.mock('../config/redis.js', () => ({ default: { on: vi.fn() } }));
vi.mock('../sockets/index.js', () => ({ io: null }));

const { mensajeValidacion, responder400, nombreCampo } = await import('./errores-validacion.js');
const { schemaConductor } = await import('../controllers/auth.controller.js');
const { schemaMotivo, schemaDescripcion, schemaFechaProgramada } = await import('./viaje-validacion.js');

const msj = (schema, valor) => {
  const r = schema.safeParse(valor);
  expect(r.success).toBe(false);
  return mensajeValidacion(r.error);
};

describe('defaults de Zod en español con el campo', () => {
  const s = z.object({
    nombre: z.string().min(1),
    dni: z.string().min(7).max(9),
    anio: z.number().int().min(1990),
    precio: z.number().positive(),
    email: z.string().email(),
    vence: z.string().datetime(),
    tipo: z.enum(['A', 'B']),
    activo: z.boolean(),
    lista: z.array(z.string()).min(2),
  });
  const base = {
    nombre: 'x',
    dni: '1234567',
    anio: 2000,
    precio: 1,
    email: 'a@b.com',
    vence: '2030-01-01T00:00:00Z',
    tipo: 'A',
    activo: true,
    lista: ['a', 'b'],
  };
  const con = (cambio) => msj(s, { ...base, ...cambio });

  it('campo ausente -> obligatorio', () => {
    const sinNombre = { ...base, nombre: undefined };
    expect(msj(s, sinNombre)).toBe('El campo nombre es obligatorio');
  });
  it('tipo equivocado', () => {
    expect(con({ nombre: 5 })).toBe('El campo nombre debe ser texto');
    expect(con({ anio: 'x' })).toBe('El campo anio debe ser un número');
    expect(con({ anio: 2000.5 })).toBe('El campo anio debe ser un número entero');
    expect(con({ activo: 'si' })).toBe('El campo activo debe ser verdadero o falso');
    expect(con({ lista: 'a' })).toBe('El campo lista debe ser una lista');
  });
  it('tamaños y rangos', () => {
    expect(con({ nombre: '' })).toBe('El campo nombre no puede estar vacío');
    expect(con({ dni: '123' })).toBe('El campo dni debe tener al menos 7 caracteres');
    expect(con({ dni: '1234567890' })).toBe('El campo dni puede tener como máximo 9 caracteres');
    expect(con({ anio: 1980 })).toBe('El campo anio debe ser mayor o igual a 1990');
    expect(con({ precio: 0 })).toBe('El campo precio debe ser mayor a 0');
    expect(con({ lista: ['a'] })).toBe('El campo lista debe tener al menos 2 elementos');
  });
  it('formatos y opciones', () => {
    expect(con({ email: 'no' })).toBe('El campo email debe ser un email válido');
    expect(con({ vence: 'mañana' })).toBe('El campo vence debe ser una fecha ISO válida');
    expect(con({ tipo: 'C' })).toBe('El campo tipo debe ser uno de: A, B');
  });
  it('path anidado', () => {
    const p = z.object({ paradas: z.array(z.object({ lat: z.number() })) });
    expect(msj(p, { paradas: [{ lat: 1 }, { lat: 'x' }] })).toBe('El campo paradas[1].lat debe ser un número');
    expect(nombreCampo(['a', 0, 'b'])).toBe('a[0].b');
  });
  it('body que no es un objeto', () => {
    expect(msj(s, undefined)).toBe('El cuerpo de la solicitud debe ser un objeto JSON');
    expect(msj(s, [])).toBe('El cuerpo de la solicitud debe ser un objeto JSON');
  });
  it('campos de mas en un strict', () => {
    expect(msj(z.object({ a: z.string() }).strict(), { a: 'x', b: 1 })).toBe('Campos no permitidos: b');
  });
});

describe('los mensajes propios en español NO cambian', () => {
  it('motivo / descripcion', () => {
    expect(msj(z.object({ motivo: schemaMotivo }), {})).toBe('motivo es requerido');
    expect(msj(z.object({ motivo: schemaMotivo }), { motivo: 5 })).toBe('motivo debe ser texto');
    expect(msj(z.object({ descripcion: schemaDescripcion }), { descripcion: '   ' })).toBe('descripcion no puede estar vacia');
  });
  it('fecha_programada con valor invalido', () => {
    expect(msj(z.object({ fecha_programada: schemaFechaProgramada }), { fecha_programada: 'ayer' })).toMatch(
      /^fecha_programada debe ser una fecha ISO futura \(al menos \d+ minutos desde ahora\)$/
    );
  });
  it('fecha_programada ausente: ahora en español (antes "Invalid input: ...")', () => {
    expect(msj(z.object({ fecha_programada: schemaFechaProgramada }), {})).toBe('El campo fecha_programada es obligatorio');
  });
  it('un mensaje de .min() propio gana', () => {
    expect(msj(z.object({ codigo: z.string({ error: 'codigo es requerido' }).min(1, 'codigo es requerido') }), { codigo: '' })).toBe(
      'codigo es requerido'
    );
  });
});

describe('registro-conductor sin un campo', () => {
  const valido = {
    nombre: 'Ana',
    apellido: 'Paz',
    dni: '30111222',
    email: 'ana@test.com',
    contrasena: 'secreto1',
    nro_licencia: 'L1',
    licencia_vencimiento: '2030-01-01T00:00:00.000Z',
  };
  it('sin nombre -> español con el campo (antes: "Invalid input: expected string, received undefined")', () => {
    const sinNombre = { ...valido, nombre: undefined };
    expect(msj(schemaConductor(false), sinNombre)).toBe('El campo nombre es obligatorio');
  });
  it('sin licencia (obligatoria)', () => {
    const sinLicencia = { ...valido, nro_licencia: undefined };
    expect(msj(schemaConductor(false), sinLicencia)).toBe('El campo nro_licencia es obligatorio');
  });
  it('email invalido', () => {
    expect(msj(schemaConductor(false), { ...valido, email: 'x' })).toBe('El campo email debe ser un email válido');
  });
});

describe('responder400', () => {
  it('responde { error } con el primer issue', () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    responder400(res, z.object({ a: z.string() }).safeParse({}));
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'El campo a es obligatorio' });
  });
});
