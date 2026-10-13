import prisma from '../config/prisma.js';
import { obtenerAcumulado, limpiarGPS } from './gps.service.js';
import { generarRemito } from './remito.service.js';
import { detenerEmisorEta } from './eta-emisor.js';
import { repartirPorZona } from './zona.service.js';
import { cancelarAvisoVencimiento } from './vencimiento.service.js';
import {
  registrarCambioEstado,
  INCLUDE_HISTORIAL,
} from './historial-estado.service.js';
import {
  calcularMetricasViaje,
  bloqueTiempos,
  paradasConTiempos,
} from './duracion.service.js';
import { salasDeViaje } from '../sockets/salas.js';
import { marcarViajeCerrado } from './cancelacion.service.js';
import { escribirRealesInterno } from './medicion-real.service.js';
import { tiemposRealesDesdeHistorial } from './tiempos-reales.js';
import { OPCIONES_TX } from './organizacion.service.js';

// Se tira adentro de la tx del cierre interno para hacer rollback cuando la
// parada que sale ya no esta abierta (otro "salir" se adelanto).
class CierrePerdido extends Error {}

// `actor` = { id_usuario, origen } de quien disparo el cierre. cerrarViaje no
// puede saberlo por su cuenta: lo recibe de su caller.
//
// Dos callers:
//   - LEGACY: confirmarParada, al confirmar la ultima parada. Cierra desde
//     EN_RUTA o DESCARGANDO; los reales salen del historial de estados.
//   - INTERNO (ciclo por parada, Paso 3): salirDeParada, al salir de la ultima
//     (`paradaQueSale`). Cierra SOLO desde DESCARGANDO y escribe, en la MISMA
//     transaccion, la salida de esa parada, los reales por parada y por viaje y
//     FINALIZADO.
//
// La distancia real sale del acumulado GPS de Redis, leido ANTES de limpiarGPS.
//
// Devuelve null si NO cerro: el viaje ya no estaba en el estado esperado (p. ej.
// la PyME lo cancelo mientras se confirmaba / salia de la ultima parada).
export async function cerrarViaje(id_viaje, io, actor = {}, { paradaQueSale = null, ahora = new Date() } = {}) {
  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    select: {
      id_viaje: true,
      id_organizacion: true,
      zona: true,
      tarifa_hora: true,
      tarifa_km: true,
      // Hacen falta para repartir el precio de los viajes MIXTO.
      paradas: { select: { latitud: true, longitud: true } },
      // Para los reales del ciclo legacy.
      ...INCLUDE_HISTORIAL,
    },
  });

  const acumulado = await obtenerAcumulado(id_viaje);
  const tiempo_horas = acumulado?.tiempo_horas ?? 0;
  const distancia_km = acumulado?.distancia_km ?? 0;

  // Mismo reparto que usan la estimacion y el precio en vivo. En MIXTO esto
  // prorratea; antes se guardaba el tiempo total Y la distancia total en ambos
  // campos, cobrando el viaje completo dos veces.
  const { tiempo_capital, distancia_provincia } = repartirPorZona({
    zona: viaje.zona,
    paradas: viaje.paradas,
    tiempo_horas,
    distancia_km,
  });

  const precio_por_tiempo =
    tiempo_capital === null ? null : tiempo_capital * (viaje.tarifa_hora ?? 0);
  const precio_por_distancia =
    distancia_provincia === null ? null : distancia_provincia * (viaje.tarifa_km ?? 0);
  const precio_real = (precio_por_tiempo ?? 0) + (precio_por_distancia ?? 0);

  const datosCierre = {
    precio_real,
    estado: 'FINALIZADO',
    tiempo_capital,
    distancia_provincia,
    distancia_real_km: acumulado ? acumulado.distancia_km : null,
  };

  let cerro;
  if (paradaQueSale !== null) {
    cerro = await cerrarInterno(id_viaje, paradaQueSale, ahora, datosCierre);
  } else {
    // GUARD ATOMICO: solo cierra desde los dos estados en los que
    // confirmar-parada acepta confirmar (EN_RUTA o DESCARGANDO). Si una
    // cancelacion se adelanto, matchea 0 filas y el viaje queda CANCELADO.
    const reales = tiemposRealesDesdeHistorial(viaje.historial_estados, ahora);
    const r = await prisma.viaje.updateMany({
      where: { id_viaje, estado: { in: ['EN_RUTA', 'DESCARGANDO'] } },
      data: {
        ...datosCierre,
        ...(reales ? { manejo_real_horas: reales.manejo_horas, peon_real_horas: reales.peon_horas } : {}),
      },
    });
    cerro = r.count > 0;
  }
  if (!cerro) return null;

  // SITIO 11/12 del historial. Va ANTES de calcular las metricas: la fila
  // FINALIZADO es justamente el cierre de la etapa de descarga, asi que sin
  // ella duracion_descarga saldria null en el evento que emitimos abajo.
  await registrarCambioEstado({
    id_viaje,
    estado: 'FINALIZADO',
    id_usuario: actor.id_usuario ?? null,
    origen: actor.origen ?? null,
    // El mismo instante que la salida de la ultima parada y que el fin de los
    // reales (en el legacy, el del arranque del cierre).
    fecha: ahora,
  });

  const remito_url = await generarRemito(id_viaje);

  // Relectura completa: el select de arriba no trae ni las paradas con sus
  // tiempos ni las columnas de manejo / peon. Una query extra, una sola vez por
  // viaje, en el unico momento en que el cuadro completo existe entero.
  const viajeCompleto = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: { paradas: { orderBy: { orden: 'asc' } }, ...INCLUDE_HISTORIAL },
  });
  const metricas = calcularMetricasViaje(viajeCompleto);
  const tiempos = bloqueTiempos(viajeCompleto);
  const paradas = paradasConTiempos(viajeCompleto.paradas).map((p) => ({
    id_parada: p.id_parada,
    orden: p.orden,
    llegada_estimada: p.llegada_estimada,
    salida_estimada: p.salida_estimada,
    llegada_real: p.llegada_real,
    salida_real: p.salida_real,
    peon_estimado_min: p.peon_estimado_min,
    manejo_estimado_min: p.manejo_estimado_min,
    peon_real_min: p.peon_real_min,
    manejo_real_min: p.manejo_real_min,
    diferencia_min: p.diferencia_min,
  }));

  const desglose = {
    precio_por_tiempo,
    precio_por_distancia,
    tiempo_horas,
    distancia_km,
    tiempo_capital,
    distancia_provincia,
    tarifa_hora: viaje.tarifa_hora,
    tarifa_km: viaje.tarifa_km,
  };

  if (io) {
    // Canal 6/6 de las metricas por etapa. Van en el MISMO evento que ya
    // llevaba tiempo_capital y distancia_provincia — no se duplica el evento.
    // viaje:{id} y, si es de una PyME, organizacion:{id}. Desde el Paso 3
    // tambien los bloques estimado / real y los tiempos de cada parada.
    io.to(salasDeViaje(viaje)).emit('viaje:finalizado', {
      id_viaje,
      precio_real,
      desglose,
      remito_url,
      ...metricas,
      ...tiempos,
      paradas,
    });
  }

  // Marca ANTES de limpiar: un ping en vuelo re-limpia (ver cancelacion.service).
  marcarViajeCerrado(id_viaje);
  detenerEmisorEta(id_viaje);
  // Defensivo: para llegar a FINALIZADO el viaje paso por iniciarViaje, que ya
  // cancelo el aviso. Se cancela igual — es idempotente y gratis — con el mismo
  // criterio que el cancelarTimeoutReserva defensivo de cancelarViajeCliente.
  cancelarAvisoVencimiento(id_viaje);
  await limpiarGPS(id_viaje);

  return { precio_real, desglose, remito_url, ...metricas, ...tiempos, paradas };
}

// Cierre del ciclo INTERNO, en UNA transaccion: FINALIZADO (solo desde
// DESCARGANDO), salida de la ultima parada (solo si sigue abierta) y los reales.
// false si perdio la carrera.
async function cerrarInterno(id_viaje, id_parada, ahora, datosCierre) {
  try {
    return await prisma.$transaction(async (tx) => {
      const r = await tx.viaje.updateMany({
        where: { id_viaje, estado: 'DESCARGANDO' },
        data: datosCierre,
      });
      if (r.count === 0) throw new CierrePerdido();
      const p = await tx.parada.updateMany({
        where: { id_parada, id_viaje, salida_real: null },
        data: { salida_real: ahora },
      });
      if (p.count === 0) throw new CierrePerdido();
      const paradas = await tx.parada.findMany({
        where: { id_viaje },
        select: { id_parada: true, orden: true, llegada_real: true, salida_real: true },
      });
      await escribirRealesInterno(tx, id_viaje, paradas);
      return true;
    }, OPCIONES_TX);
  } catch (err) {
    if (err instanceof CierrePerdido) return false;
    throw err;
  }
}
