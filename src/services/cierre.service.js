import prisma from '../config/prisma.js';
import { obtenerAcumulado, limpiarGPS } from './gps.service.js';
import { generarRemito } from './remito.service.js';
import { detenerEmisorEta } from './eta-emisor.js';
import { repartirPorZona } from './zona.service.js';

export async function cerrarViaje(id_viaje, io) {
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

  const remito_url = await generarRemito(id_viaje);

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
    io.to(`viaje:${id_viaje}`).emit('viaje:finalizado', {
      id_viaje,
      precio_real,
      desglose,
      remito_url,
    });
  }

  detenerEmisorEta(id_viaje);
  await limpiarGPS(id_viaje);

  return { precio_real, desglose, remito_url };
}
