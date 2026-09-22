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
import { calcularMetricasViaje } from './duracion.service.js';

// `actor` = { id_usuario, origen } de quien disparo el cierre. cerrarViaje no
// puede saberlo por su cuenta: lo recibe de confirmarParada, que es su unico
// caller (el conductor que confirma la ultima parada).
export async function cerrarViaje(id_viaje, io, actor = {}) {
  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    select: {
      zona: true,
      tarifa_hora: true,
      tarifa_km: true,
      // Hacen falta para repartir el precio de los viajes MIXTO.
      paradas: { select: { latitud: true, longitud: true } },
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

  await prisma.viaje.update({
    where: { id_viaje },
    data: {
      precio_real,
      estado: 'FINALIZADO',
      tiempo_capital,
      distancia_provincia,
    },
  });

  // SITIO 11/12 del historial. Va ANTES de calcular las metricas: la fila
  // FINALIZADO es justamente el cierre de la etapa de descarga, asi que sin
  // ella duracion_descarga saldria null en el evento que emitimos abajo.
  await registrarCambioEstado({
    id_viaje,
    estado: 'FINALIZADO',
    id_usuario: actor.id_usuario ?? null,
    origen: actor.origen ?? null,
  });

  const remito_url = await generarRemito(id_viaje);

  // Relectura: el select de arriba no trae ni el historial ni los escalares que
  // necesitan las metricas. Es una query extra, una sola vez por viaje, en el
  // unico momento en que el cuadro completo (aproximacion, carga, descarga,
  // duracion real y puntualidad) existe entero.
  const viajeCompleto = await prisma.viaje.findUnique({
    where: { id_viaje },
    select: {
      estado: true,
      fecha_programada: true,
      fecha_inicio: true,
      fecha_llegada_origen: true,
      paradas: { select: { fecha_entrega: true } },
      ...INCLUDE_HISTORIAL,
    },
  });
  const metricas = calcularMetricasViaje(viajeCompleto);

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
    io.to(`viaje:${id_viaje}`).emit('viaje:finalizado', {
      id_viaje,
      precio_real,
      desglose,
      remito_url,
      ...metricas,
    });
  }

  detenerEmisorEta(id_viaje);
  // Defensivo: para llegar a FINALIZADO el viaje paso por iniciarViaje, que ya
  // cancelo el aviso. Se cancela igual — es idempotente y gratis — con el mismo
  // criterio que el cancelarTimeoutReserva defensivo de cancelarViajeCliente.
  cancelarAvisoVencimiento(id_viaje);
  await limpiarGPS(id_viaje);

  return { precio_real, desglose, remito_url, ...metricas };
}
