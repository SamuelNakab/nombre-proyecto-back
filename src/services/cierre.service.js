import prisma from '../config/prisma.js';
import { obtenerAcumulado, limpiarGPS } from './gps.service.js';
import { generarRemito } from './remito.service.js';
import { detenerEmisorEta } from './eta-emisor.js';

export async function cerrarViaje(id_viaje, io) {
  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    select: { zona: true, tarifa_hora: true, tarifa_km: true },
  });

  const acumulado = await obtenerAcumulado(id_viaje);
  const tiempo_horas = acumulado?.tiempo_horas ?? 0;
  const distancia_km = acumulado?.distancia_km ?? 0;

  let precio_real;
  let precio_por_tiempo = null;
  let precio_por_distancia = null;

  if (viaje.zona === 'CABA') {
    precio_por_tiempo = tiempo_horas * (viaje.tarifa_hora ?? 0);
    precio_real = precio_por_tiempo;
  } else if (viaje.zona === 'PROVINCIA') {
    precio_por_distancia = distancia_km * (viaje.tarifa_km ?? 0);
    precio_real = precio_por_distancia;
  } else {
    precio_por_tiempo = tiempo_horas * (viaje.tarifa_hora ?? 0);
    precio_por_distancia = distancia_km * (viaje.tarifa_km ?? 0);
    precio_real = precio_por_tiempo + precio_por_distancia;
  }

  await prisma.viaje.update({
    where: { id_viaje },
    data: {
      precio_real,
      estado: 'FINALIZADO',
      ...(viaje.zona === 'CABA' || viaje.zona === 'MIXTO' ? { tiempo_capital: tiempo_horas } : {}),
      ...(viaje.zona === 'PROVINCIA' || viaje.zona === 'MIXTO' ? { distancia_provincia: distancia_km } : {}),
    },
  });

  const remito_url = await generarRemito(id_viaje);

  const desglose = {
    precio_por_tiempo,
    precio_por_distancia,
    tiempo_horas,
    distancia_km,
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
