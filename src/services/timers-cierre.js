// Timers en memoria del cierre de los viajes internos (Tarea 5): el cierre
// automatico de fin del dia y el aviso de "cierre manual habilitado" por tiempo.
// Viven en un modulo aparte para que limpiarViajeActivo (cancelacion.service) los
// pueda cortar sin importar cierre-automatico.service (que importa
// cierre.service, que importa cancelacion.service: seria un ciclo).
//
// Mismo patron y misma LIMITACION que los timers de reserva y de vencimiento: un
// setTimeout por viaje en la memoria de UN proceso, cero pollers. El barrido de
// arranque los reconstruye; con mas de una instancia hay que moverlos a una cola
// persistente.

// setTimeout desborda arriba de 2^31-1 ms (~24.8 dias) y dispara de inmediato.
// El handler relee el viaje y se re-arma si todavia no le toca.
const MAX_DELAY_MS = 2 ** 31 - 1;

export const TIPOS_TIMER_CIERRE = ['AUTOMATICO', 'HABILITADO'];

const timers = new Map(); // `${tipo}:${id_viaje}` → Timeout
const clave = (tipo, id_viaje) => `${tipo}:${id_viaje}`;

// Programa (o reprograma: reemplaza el anterior) el timer `tipo` del viaje para
// el instante `momento`. fn() corre al disparar.
export function programarTimerCierre(tipo, id_viaje, momento, fn) {
  cancelarTimerCierre(tipo, id_viaje);
  // +500 ms: los handlers comparan "ya llego el momento" con >=; disparar justo
  // en el borde no tiene que re-armarse en loop.
  const restante = new Date(momento).getTime() - Date.now() + 500;
  const ms = Math.min(Math.max(0, restante), MAX_DELAY_MS);
  const handle = setTimeout(() => {
    timers.delete(clave(tipo, id_viaje));
    fn();
  }, ms);
  timers.set(clave(tipo, id_viaje), handle);
}

export function cancelarTimerCierre(tipo, id_viaje) {
  const handle = timers.get(clave(tipo, id_viaje));
  if (handle) {
    clearTimeout(handle);
    timers.delete(clave(tipo, id_viaje));
  }
}

// Corta los dos timers del viaje. Idempotente.
export function cancelarTimersCierre(id_viaje) {
  for (const tipo of TIPOS_TIMER_CIERRE) cancelarTimerCierre(tipo, id_viaje);
}

export const tieneTimerCierre = (tipo, id_viaje) => timers.has(clave(tipo, id_viaje));
