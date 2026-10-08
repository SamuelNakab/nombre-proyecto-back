import { detenerEmisorEta } from './eta-emisor.js';
import { limpiarGPS } from './gps.service.js';

// Momento en que se limpio por ultima vez el estado activo de cada viaje. Cubre
// la carrera con un ping GPS EN VUELO: el handler de conductor:ubicacion valida
// el estado al empezar, y si la limpieza corre MIENTRAS el todavia esta
// escribiendo, sus escrituras (ultima, acumulado, ruta) y el emisor de ETA que
// arranca quedarian huerfanos. El handler anota cuando empezo y, despues de
// escribir, pregunta si hubo una limpieza POSTERIOR a ese inicio.
//
// Se compara contra el inicio del ping y no se usa un simple "fue cerrado": una
// limpieza no siempre cierra el viaje (cancelar-conductor y liberarReserva lo
// devuelven al mercado y el viaje sigue vivo). Un ping que EMPIEZA despues de la
// limpieza es de un viaje que siguio su curso y no se toca.
//
// En memoria y por 60 s: alcanza de sobra para un ping en vuelo, y no suma
// queries por ping. Misma limitacion de un solo proceso que los timers.
const VIGENCIA_MS = 60_000;
const limpiezas = new Map(); // id_viaje → { cuando, handle }

export function marcarViajeCerrado(id_viaje) {
  clearTimeout(limpiezas.get(id_viaje)?.handle);
  const handle = setTimeout(() => limpiezas.delete(id_viaje), VIGENCIA_MS);
  handle.unref?.();
  limpiezas.set(id_viaje, { cuando: Date.now(), handle });
}

// Si el estado activo del viaje se limpio DESPUES de `inicioPing` (o sea,
// mientras ese ping estaba en vuelo), corta el emisor de ETA y vuelve a borrar
// las keys GPS. Devuelve true si re-limpio.
export async function relimpiarSiCerrado(id_viaje, inicioPing) {
  const marca = limpiezas.get(id_viaje);
  if (!marca || marca.cuando < inicioPing) return false;
  detenerEmisorEta(id_viaje);
  await limpiarGPS(id_viaje);
  return true;
}

// Cleanup del estado "activo" de un viaje: corta el emisor periodico de ETA y
// borra TODAS las keys gps:{id_viaje}:* de Redis. Es idempotente — si no hay
// emisor corriendo (detenerEmisorEta es un no-op sin timer) ni keys en Redis
// (limpiarGPS hace del de keys inexistentes sin fallar), no hace nada y no tira
// error. Se reusa desde la cancelacion por conductor, por cliente, por la PyME,
// por el admin, desde la desvinculacion y desde liberarReserva.
//
// La marca va ANTES de limpiar: un ping en vuelo que termine de escribir
// despues de la limpieza ya la ve.
export async function limpiarViajeActivo(id_viaje) {
  marcarViajeCerrado(id_viaje);
  detenerEmisorEta(id_viaje);
  await limpiarGPS(id_viaje);
}
