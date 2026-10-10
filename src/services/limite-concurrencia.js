// Ejecuta fn(item, i) sobre todos los items con como MAXIMO `limite` en vuelo a
// la vez, y devuelve los resultados en el orden de los items. Pura (no sabe de
// Google): la usan las series para no tirarle 31 estimaciones juntas a la API.
//
// TODO O NADA:
//   - Ante el PRIMER error deja de lanzar items nuevos, espera a los que ya
//     estaban en vuelo (no quedan llamadas colgando con la respuesta ya dada) y
//     tira ese primer error.
//   - deadlineMs (opcional): si el total no termino a tiempo, tira
//     errorDeadline() sin esperar a los que estan en vuelo (cada llamada a
//     Google tiene su propio timeout, asi que terminan solas) y no lanza mas.
export async function ejecutarConLimite(items, limite, fn, { deadlineMs = null, errorDeadline } = {}) {
  if (!Number.isInteger(limite) || limite < 1) throw new Error('ejecutarConLimite: limite invalido');

  const resultados = new Array(items.length);
  let siguiente = 0;
  let error = null;
  let cortado = false;

  const trabajador = async () => {
    while (error === null && !cortado) {
      const i = siguiente++;
      if (i >= items.length) return;
      try {
        resultados[i] = await fn(items[i], i);
      } catch (err) {
        if (error === null) error = err;
        return;
      }
    }
  };

  const todos = Promise.all(Array.from({ length: Math.min(limite, items.length) }, trabajador)).then(() => {
    if (error !== null) throw error;
    return resultados;
  });

  if (!deadlineMs) return todos;

  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      cortado = true;
      reject(errorDeadline ? errorDeadline() : new Error(`ejecutarConLimite: se supero el limite de ${deadlineMs}ms`));
    }, deadlineMs);
  });
  // Si gana el deadline, `todos` puede rechazar despues: no es un rechazo sin
  // manejar.
  todos.catch(() => {});
  try {
    return await Promise.race([todos, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
