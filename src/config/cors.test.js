import { describe, it, expect, vi } from 'vitest';
import { parsearOrigenes, origenPermitido, configurarCors } from './cors.js';

describe('parsearOrigenes', () => {
  it('sin variable (o vacia) -> null = sin restriccion', () => {
    expect(parsearOrigenes(undefined)).toBeNull();
    expect(parsearOrigenes('')).toBeNull();
    expect(parsearOrigenes('   ')).toBeNull();
  });
  it('separa por coma, saca espacios y la barra final', () => {
    const l = parsearOrigenes(' https://app.fleter.com.ar/ , https://staging.fleter.com.ar,, ');
    expect(l.map((r) => r.origen)).toEqual(['https://app.fleter.com.ar', 'https://staging.fleter.com.ar']);
  });
});

describe('origenPermitido', () => {
  const lista = parsearOrigenes('https://app.fleter.com.ar,https://*.vercel.app,http://localhost:5173');

  it('sin Origin (mobile, curl, server-to-server) siempre pasa', () => {
    expect(origenPermitido(undefined, lista)).toBe(true);
    expect(origenPermitido('', lista)).toBe(true);
  });
  it('sin lista pasa todo', () => {
    expect(origenPermitido('https://cualquiera.com', null)).toBe(true);
  });
  it('exacto (sin distinguir mayusculas ni barra final)', () => {
    expect(origenPermitido('https://app.fleter.com.ar', lista)).toBe(true);
    expect(origenPermitido('https://APP.fleter.com.ar/', lista)).toBe(true);
    expect(origenPermitido('http://localhost:5173', lista)).toBe(true);
    expect(origenPermitido('http://localhost:3000', lista)).toBe(false);
    expect(origenPermitido('https://app.fleter.com.ar.evil.com', lista)).toBe(false);
  });
  it('comodin = una sola etiqueta del host', () => {
    expect(origenPermitido('https://pr-12-fleter.vercel.app', lista)).toBe(true);
    expect(origenPermitido('https://a.b.vercel.app', lista)).toBe(false);
    expect(origenPermitido('http://pr-12.vercel.app', lista)).toBe(false);
    expect(origenPermitido('https://vercel.app', lista)).toBe(false);
    expect(origenPermitido('https://evil.com/.vercel.app', lista)).toBe(false);
    expect(origenPermitido('https://x.vercel.app.evil.com', lista)).toBe(false);
  });
});

describe('configurarCors', () => {
  it('sin CORS_ORIGINS: warning y "*" literal (igual que antes)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = configurarCors({});
    expect(c.express.origin).toBe('*');
    expect(c.permitido('https://cualquiera.com')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CORS_ORIGINS no configurado'));
    warn.mockRestore();
  });
  it('con CORS_ORIGINS: funcion de origen y expone Retry-After', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const c = configurarCors({ CORS_ORIGINS: 'https://app.fleter.com.ar' });
    const cb = vi.fn();
    c.express.origin('https://otro.com', cb);
    expect(cb).toHaveBeenCalledWith(null, false);
    c.express.origin('https://app.fleter.com.ar', cb);
    expect(cb).toHaveBeenLastCalledWith(null, true);
    expect(c.express.exposedHeaders).toContain('Retry-After');
    log.mockRestore();
  });
});
