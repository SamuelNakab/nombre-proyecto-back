import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Sin Redis ni DB: se mockean las tres dependencias del emisor.
vi.mock('../config/redis.js', () => ({ default: { del: vi.fn() } }));
vi.mock('./gps.service.js', () => ({
  obtenerUltimaCoordenada: vi.fn(async () => ({ lat: -34.6, lng: -58.4, timestamp: Date.now() })),
}));
vi.mock('./eta.service.js', () => ({
  // null = el viaje no tiene paradas pendientes (ya llego a la ultima).
  calcularEtaConApi: vi.fn(async () => null),
  obtenerEtaActual: vi.fn(async () => null),
  leerEstadoEta: vi.fn(async () => null),
}));

const { iniciarEmisorEta, detenerEmisorEta, etaSinPendientes } = await import('./eta-emisor.js');
const { calcularEtaConApi } = await import('./eta.service.js');

const io = { to: () => ({ emit: vi.fn() }) };

describe('emisor de ETA sin paradas pendientes (Tarea 5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calcularEtaConApi.mockClear();
  });
  afterEach(() => {
    detenerEmisorEta(99);
    vi.useRealTimers();
  });

  it('consulta UNA vez y los ticks siguientes no vuelven a consultar', async () => {
    iniciarEmisorEta(io, 99, ['viaje:99']);
    await vi.advanceTimersByTimeAsync(0);
    expect(calcularEtaConApi).toHaveBeenCalledTimes(1);
    expect(etaSinPendientes(99)).toBe(true);

    // 5 ticks de 30 s (con pings, para que no corte el watchdog).
    for (let i = 0; i < 5; i++) {
      iniciarEmisorEta(io, 99, ['viaje:99']);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(calcularEtaConApi).toHaveBeenCalledTimes(1);
  });

  it('detener borra la marca', async () => {
    iniciarEmisorEta(io, 99, ['viaje:99']);
    await vi.advanceTimersByTimeAsync(0);
    detenerEmisorEta(99);
    expect(etaSinPendientes(99)).toBe(false);
  });
});
