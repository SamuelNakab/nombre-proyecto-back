import { describe, it, expect } from 'vitest';
import { aCsv, celdaCsv } from './csv.js';

describe('csv', () => {
  it('escapa comas, comillas y saltos', () => {
    expect(celdaCsv('a,b')).toBe('"a,b"');
    expect(celdaCsv('dijo "hola"')).toBe('"dijo ""hola"""');
    expect(celdaCsv('linea1\nlinea2')).toBe('"linea1\nlinea2"');
  });
  it('null vacio, numeros y booleanos tal cual, objetos como JSON', () => {
    expect(celdaCsv(null)).toBe('');
    expect(celdaCsv(undefined)).toBe('');
    expect(celdaCsv(-5)).toBe('-5');
    expect(celdaCsv(true)).toBe('true');
    expect(celdaCsv({ a: 1 })).toBe('"{""a"":1}"');
  });
  it('neutraliza formulas en textos', () => {
    expect(celdaCsv('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(celdaCsv('+1')).toBe("'+1");
    expect(celdaCsv('-2')).toBe("'-2");
  });
  it('arma encabezado y filas con CRLF', () => {
    expect(aCsv([{ a: 1, b: 'x' }, { a: null, b: 'y,z' }], ['a', 'b'])).toBe('a,b\r\n1,x\r\n,"y,z"\r\n');
  });
});
