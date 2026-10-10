import { describe, it, expect } from 'vitest';
import { ejecutarConLimite } from './limite-concurrencia.js';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Tarea falsa que registra cuantas hay en vuelo a la vez.
function medidor() {
  const m = { enVuelo: 0, maximo: 0, lanzadas: 0 };
  m.tarea = async (x, ms = 10) => {
    m.lanzadas++;
    m.enVuelo++;
    m.maximo = Math.max(m.maximo, m.enVuelo);
    await esperar(ms);
    m.enVuelo--;
    return x * 2;
  };
  return m;
}

describe('ejecutarConLimite', () => {
  it('nunca mas de N a la vez, y los resultados en el orden de los items', async () => {
    const m = medidor();
    const items = Array.from({ length: 31 }, (_, i) => i);
    const r = await ejecutarConLimite(items, 4, (x) => m.tarea(x, 5 + (x % 3) * 5));
    expect(r).toEqual(items.map((x) => x * 2));
    expect(m.maximo).toBe(4);
  });

  it('con menos items que el limite, lanza solo los que hay', async () => {
    const m = medidor();
    expect(await ejecutarConLimite([1, 2], 4, (x) => m.tarea(x))).toEqual([2, 4]);
    expect(m.maximo).toBe(2);
    expect(await ejecutarConLimite([], 4, (x) => m.tarea(x))).toEqual([]);
  });

  it('ante el primer error: no lanza mas, espera a las que estaban en vuelo y tira ESE error', async () => {
    const m = medidor();
    const terminadas = [];
    const p = ejecutarConLimite(Array.from({ length: 20 }, (_, i) => i), 3, async (x) => {
      if (x === 4) {
        await esperar(5);
        throw new Error('google caido');
      }
      const r = await m.tarea(x, 20);
      terminadas.push(x);
      return r;
    });
    await expect(p).rejects.toThrow('google caido');
    // Al rechazar ya no queda nada en vuelo.
    expect(m.enVuelo).toBe(0);
    expect(m.lanzadas).toBeLessThan(20);
    await esperar(50);
    expect(m.lanzadas).toBeLessThan(20);
  });

  it('deadline: tira el error del caller y deja de lanzar', async () => {
    const m = medidor();
    const p = ejecutarConLimite(Array.from({ length: 10 }, (_, i) => i), 2, (x) => m.tarea(x, 30), {
      deadlineMs: 50,
      errorDeadline: () => new Error('timeout total'),
    });
    await expect(p).rejects.toThrow('timeout total');
    const lanzadasAlCortar = m.lanzadas;
    await esperar(80);
    expect(m.lanzadas).toBeLessThanOrEqual(lanzadasAlCortar + 2);
    expect(m.lanzadas).toBeLessThan(10);
  });

  it('si termina antes del deadline, devuelve normal', async () => {
    const m = medidor();
    expect(await ejecutarConLimite([1, 2, 3], 2, (x) => m.tarea(x, 5), { deadlineMs: 1000 })).toEqual([2, 4, 6]);
  });

  it('limite invalido', async () => {
    await expect(ejecutarConLimite([1], 0, async (x) => x)).rejects.toThrow(/limite invalido/);
  });
});
