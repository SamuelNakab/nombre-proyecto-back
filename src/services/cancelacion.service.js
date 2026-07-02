import { detenerEmisorEta } from './eta-emisor.js';
import { limpiarGPS } from './gps.service.js';

// Cleanup del estado "activo" de un viaje: corta el emisor periodico de ETA y
// borra TODAS las keys gps:{id_viaje}:* de Redis. Es idempotente — si no hay
// emisor corriendo (detenerEmisorEta es un no-op sin timer) ni keys en Redis
// (limpiarGPS hace del de keys inexistentes sin fallar), no hace nada y no tira
// error. Se reusa desde la cancelacion por conductor y por cliente.
export async function limpiarViajeActivo(id_viaje) {
  detenerEmisorEta(id_viaje);
  await limpiarGPS(id_viaje);
}
