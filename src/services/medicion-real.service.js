// Tiempos REALES de MANEJO y PEON (y distancia real) de un viaje.
//
// Viaje INTERNO (ciclo por parada, Paso 3): cada parada tiene llegada_real
// (iniciar en la 1, confirmar-parada en las demas) y salida_real ("salir").
//   peon de una parada   = salida_real - llegada_real
//   manejo de un tramo   = llegada_real - salida_real de la parada anterior
//   totales del viaje    = las sumas. total = llegada a la 1 -> salida de la
//                          ultima, el mismo intervalo que la duracion estimada.
// Los timestamps de las paradas los escribe el servidor en el MISMO instante
// que la fila del historial de esa transicion, asi que coinciden con el.
//
// Viaje LEGACY (ciclo del marketplace, sin cambios): solo por viaje, desde el
// historial de estados: CARGANDO + DESCARGANDO = peon, EN_RUTA = manejo.
//
// Se GUARDAN (no se calculan en el read): en cada confirmar / salir, al cerrar
// y, si el viaje se cancela en curso, lo medido hasta ese momento
// (guardarMedicionParcial).
import prisma from '../config/prisma.js';
import { obtenerAcumulado, medicionesHasta, calidadGpsViaje } from './gps.service.js';
import { precioMedido, filaHistorial, registrarHistorialPrecio, SELECT_PRECIO } from './precio.service.js';
import { INCLUDE_HISTORIAL } from './historial-estado.service.js';
import { tiemposRealesDesdeParadas, tiemposRealesDesdeHistorial } from './tiempos-reales.js';
import { reportarError } from '../config/sentry.js';

export { tiemposRealesDesdeParadas, tiemposRealesDesdeHistorial } from './tiempos-reales.js';

// ─── Escritura ───────────────────────────────────────────────────────────────

// Distancia real: el acumulado GPS de Redis. Hay que leerlo ANTES de que
// limpiarGPS lo borre. null si no hubo pings.
export async function distanciaRealKm(id_viaje) {
  const acumulado = await obtenerAcumulado(id_viaje);
  return acumulado ? acumulado.distancia_km : null;
}

// Escribe en `db` (prisma o una tx) los reales por parada y por viaje de un
// viaje INTERNO. Devuelve los totales (o null si no arranco).
export async function escribirRealesInterno(db, id_viaje, paradas, { fin = null, extraViaje = {} } = {}) {
  const reales = tiemposRealesDesdeParadas(paradas, fin);
  if (!reales) return null;
  for (const p of reales.paradas) {
    await db.parada.update({
      where: { id_parada: p.id_parada },
      data: { peon_real_horas: p.peon_real_horas, manejo_real_horas: p.manejo_real_horas },
    });
  }
  await db.viaje.update({
    where: { id_viaje },
    data: { manejo_real_horas: reales.manejo_horas, peon_real_horas: reales.peon_horas, ...extraViaje },
  });
  return reales;
}

// Cancelacion EN CURSO (PyME, admin, desvinculacion): guarda lo medido hasta
// `fin`. Va DESPUES del commit de la cancelacion y ANTES de limpiarViajeActivo
// (necesita el acumulado de Redis). NUNCA TIRA, mismo criterio que el
// historial: un fallo deja un hueco en las metricas, no un viaje que no se
// puede cancelar.
//
// Viaje INTERNO (precio v2): ademas calcula el precio medido PARCIAL hasta `fin`
// (v1 o v2 segun version_precio, con el fallback de km PARCIAL) y lo guarda SOLO
// en el historial de precios (CANCELACION_EN_CURSO): precio_real sigue null. Y
// persiste la calidad del GPS (gps_puntos, gps_mayor_hueco_segundos).
export async function guardarMedicionParcial(id_viaje, fin, { id_usuario = null } = {}) {
  try {
    const viaje = await prisma.viaje.findUnique({
      where: { id_viaje },
      select: {
        ...SELECT_PRECIO,
        paradas: {
          select: {
            id_parada: true,
            orden: true,
            latitud: true,
            longitud: true,
            llegada_real: true,
            salida_real: true,
            distancia_estimada_km: true,
          },
        },
        ...INCLUDE_HISTORIAL,
      },
    });
    if (!viaje) return false;
    const distancia_real_km = await distanciaRealKm(id_viaje);

    if (viaje.id_organizacion !== null) {
      await historialPrecioParcial(viaje, fin, id_usuario);
      return (
        (await escribirRealesInterno(prisma, id_viaje, viaje.paradas, {
          fin,
          extraViaje: { distancia_real_km, ...(await calidadGpsViaje(id_viaje)) },
        })) !== null
      );
    }

    const reales = tiemposRealesDesdeHistorial(viaje.historial_estados, fin);
    if (!reales) return false;
    // (legacy: sin precio parcial ni calidad de GPS, como siempre)
    await prisma.viaje.update({
      where: { id_viaje },
      data: { manejo_real_horas: reales.manejo_horas, peon_real_horas: reales.peon_horas, distancia_real_km },
    });
    return true;
  } catch (err) {
    console.error(`[medicion-real] no se pudo guardar lo medido del viaje ${id_viaje}: ${err.message}`);
    reportarError(err, { contexto: 'medicion-real', nivel: 'warning', extra: { id_viaje } });
    return false;
  }
}

// Precio medido parcial de un viaje interno cancelado en curso, solo al
// historial. Nunca tira (lo envuelve el try de guardarMedicionParcial, y el
// historial no tira).
async function historialPrecioParcial(viaje, fin, id_usuario) {
  try {
    const mediciones = await medicionesHasta(viaje.id_viaje, fin);
    const r = precioMedido(viaje, mediciones, { corte: fin, incompleto: true });
    await registrarHistorialPrecio(
      filaHistorial({ id_viaje: viaje.id_viaje, motivo: 'CANCELACION_EN_CURSO', id_usuario, fecha: new Date(fin) }, r)
    );
  } catch (err) {
    console.error(`[medicion-real] no se pudo calcular el precio parcial del viaje ${viaje.id_viaje}: ${err.message}`);
    reportarError(err, { contexto: 'medicion-real', nivel: 'warning', extra: { id_viaje: viaje.id_viaje } });
  }
}
