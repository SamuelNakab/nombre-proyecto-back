// MEDICIONES GPS hasta un instante (Tarea 5). PURO.
//
// El precio real sale del acumulado GPS de Redis (gps:{id}:acumulado: tiempo =
// suma de los intervalos entre pings, distancia = suma de los tramos). El
// acumulado es un total corriente: no se puede "rebobinar". Para cortar el
// precio en un instante anterior al ultimo ping (salida detectada, hora prevista
// de fin...) se guardan PUNTOS del acumulado en gps:{id}:puntos (ver
// gps.service.registrarPuntoMedicion), con un muestreo minimo de
// PUNTOS_MUESTREO_MS.
//
// medicionEn(puntos, acumulado, T):
//   - sin acumulado (no hubo pings)            -> 0 / 0, sin_pings: true
//   - T >= ultimo ping                         -> el acumulado tal cual (el
//     flujo normal: identico al calculo de siempre)
//   - T antes del primer punto                 -> 0 / 0
//   - si no, el ultimo punto <= T: el tiempo es exacto (el acumulado de tiempo
//     crece linealmente entre pings) y la distancia es la del punto (error <=
//     PUNTOS_MUESTREO_MS de manejo).

export const PUNTOS_MUESTREO_MS = 30_000;
const HORA_MS = 3_600_000;

// puntos: [{ ts, tiempo_horas, distancia_km }] en cualquier orden.
// acumulado: { tiempo_horas, distancia_km, ultima_actualizacion } | null.
export function medicionEn(puntos, acumulado, T) {
  if (!acumulado) return { tiempo_horas: 0, distancia_km: 0, sin_pings: true };
  const t = new Date(T).getTime();
  if (t >= acumulado.ultima_actualizacion) {
    return { tiempo_horas: acumulado.tiempo_horas, distancia_km: acumulado.distancia_km, sin_pings: false };
  }
  const previo = puntos
    .filter((p) => p.ts <= t)
    .reduce((max, p) => (max === null || p.ts > max.ts ? p : max), null);
  if (!previo) return { tiempo_horas: 0, distancia_km: 0, sin_pings: false };
  return {
    tiempo_horas: Math.min(previo.tiempo_horas + (t - previo.ts) / HORA_MS, acumulado.tiempo_horas),
    distancia_km: previo.distancia_km,
    sin_pings: false,
  };
}
