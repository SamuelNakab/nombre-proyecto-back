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

// Siguiente estado del acumulado (gps:{id}:acumulado) con un ping. PURA: la
// distancia entre dos puntos se inyecta (turf en gps.service).
//
// Un ping con timestamp <= al ultimo PROCESADO se IGNORA (ignorado: true, el
// acumulado no cambia): antes restaba tiempo (delta negativo), sumaba el zigzag
// de ida y vuelta y movia ultima_actualizacion hacia atras.
//
// Ademas cuenta `pings` (aceptados) y `mayor_hueco_ms` (el mayor intervalo entre
// dos pings aceptados), que se persisten al cerrar (Viaje.gps_puntos /
// gps_mayor_hueco_segundos) y deciden si la distancia GPS es confiable para el
// precio. Viven en el MISMO JSON: cero escrituras extra por ping. Un acumulado
// viejo (anterior a este cambio) no los trae: arrancan en 0.
export function avanzarAcumulado(previo, { lat, lng, timestamp }, distanciaKm) {
  if (!previo) {
    return {
      nuevo: {
        tiempo_horas: 0,
        distancia_km: 0,
        ultima_lat: lat,
        ultima_lng: lng,
        ultima_actualizacion: timestamp,
        pings: 1,
        mayor_hueco_ms: 0,
      },
      es_primer_ping: true,
      ignorado: false,
      distancia_delta: 0,
      tiempo_delta: 0,
    };
  }
  if (!(timestamp > previo.ultima_actualizacion)) {
    return { nuevo: previo, es_primer_ping: false, ignorado: true, distancia_delta: 0, tiempo_delta: 0 };
  }
  const distancia_delta = distanciaKm([previo.ultima_lng, previo.ultima_lat], [lng, lat]);
  const hueco = timestamp - previo.ultima_actualizacion;
  const tiempo_delta = hueco / HORA_MS;
  return {
    nuevo: {
      tiempo_horas: previo.tiempo_horas + tiempo_delta,
      distancia_km: previo.distancia_km + distancia_delta,
      ultima_lat: lat,
      ultima_lng: lng,
      ultima_actualizacion: timestamp,
      pings: (previo.pings ?? 0) + 1,
      mayor_hueco_ms: Math.max(previo.mayor_hueco_ms ?? 0, hueco),
    },
    es_primer_ping: false,
    ignorado: false,
    distancia_delta,
    tiempo_delta,
  };
}

// Calidad del GPS de un viaje, para persistir al cerrar / cancelar en curso.
export function calidadGps(acumulado) {
  if (!acumulado) return { gps_puntos: 0, gps_mayor_hueco_segundos: null };
  return {
    gps_puntos: acumulado.pings ?? 0,
    gps_mayor_hueco_segundos:
      acumulado.mayor_hueco_ms == null ? null : Math.round(acumulado.mayor_hueco_ms / 1000),
  };
}

const ultimoPuntoHasta = (puntos, t) =>
  puntos.filter((p) => p.ts <= t).reduce((max, p) => (max === null || p.ts > max.ts ? p : max), null);

// puntos: [{ ts, tiempo_horas, distancia_km }] en cualquier orden.
// acumulado: { tiempo_horas, distancia_km, ultima_actualizacion } | null.
export function medicionEn(puntos, acumulado, T) {
  if (!acumulado) return { tiempo_horas: 0, distancia_km: 0, sin_pings: true };
  const t = new Date(T).getTime();
  if (t >= acumulado.ultima_actualizacion) {
    return { tiempo_horas: acumulado.tiempo_horas, distancia_km: acumulado.distancia_km, sin_pings: false };
  }
  const previo = ultimoPuntoHasta(puntos, t);
  if (!previo) return { tiempo_horas: 0, distancia_km: 0, sin_pings: false };
  return {
    tiempo_horas: Math.min(previo.tiempo_horas + (t - previo.ts) / HORA_MS, acumulado.tiempo_horas),
    distancia_km: previo.distancia_km,
    sin_pings: false,
  };
}

// Pings aceptados hasta T (precio v2: decide si la distancia GPS es confiable).
// Del acumulado si T >= ultimo ping; si no, del ultimo punto <= T. 0 si el
// acumulado o el punto no lo traen (anteriores a este cambio).
export function pingsEn(puntos, acumulado, T) {
  if (!acumulado) return 0;
  const t = new Date(T).getTime();
  if (t >= acumulado.ultima_actualizacion) return acumulado.pings ?? 0;
  return ultimoPuntoHasta(puntos, t)?.pings ?? 0;
}
