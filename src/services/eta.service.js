import prisma from '../config/prisma.js';
import redis from '../config/redis.js';
import { calcularEta } from './maps/index.js';

// Fuente de verdad del ETA: la capa de Google (calcularEta, Routes API con el
// trafico de ahora), desde la posicion actual del conductor hasta la proxima
// parada PENDIENTE. El estado se cachea en Redis para servir un countdown local
// entre recalculos con la API.
//
// Si Google falla, calcularEtaConApi TIRA (ErrorMaps): el emisor saltea ese
// ciclo y no emite. Ya no hay estimacion por linea recta: un ETA inventado es
// peor que ninguno.

const keyEta = (id_viaje) => `gps:${id_viaje}:eta`;

// Recalcula el ETA con la API y persiste el estado en Redis.
// Devuelve { segundos_restantes, proxima_parada_id, distancia_restante_metros }
// o null si el viaje no tiene paradas pendientes. TIRA ErrorMaps si Google
// falla (no se escribe nada en Redis).
export async function calcularEtaConApi(id_viaje, lat, lng) {
  const proxima = await prisma.parada.findFirst({
    where: { id_viaje, estado: 'PENDIENTE' },
    orderBy: { orden: 'asc' },
  });
  if (!proxima) return null;

  const { segundos, distancia_metros } = await calcularEta({
    origen: { lat, lng },
    destino: proxima,
  });

  const estado = {
    segundos_eta_api: segundos,
    timestamp_calculo: Date.now(),
    proxima_parada_id: proxima.id_parada,
  };
  await redis.set(keyEta(id_viaje), JSON.stringify(estado), 'EX', 86400);

  return {
    segundos_restantes: segundos,
    proxima_parada_id: proxima.id_parada,
    distancia_restante_metros: distancia_metros,
  };
}

// Lee el estado crudo del ETA cacheado en Redis (o null). Expuesto para que el
// emisor pueda decidir el recalculo programado sin conocer la key.
export async function leerEstadoEta(id_viaje) {
  const raw = await redis.get(keyEta(id_viaje));
  return raw ? JSON.parse(raw) : null;
}

// Countdown local a partir del ultimo ETA de la API.
// - null: no hay ETA cacheado (el emisor debe calcular con la API).
// - { necesita_recalculo: true }: el countdown llego a 0.
// - { segundos_restantes, proxima_parada_id }: countdown vigente.
export async function obtenerEtaActual(id_viaje) {
  const estado = await leerEstadoEta(id_viaje);
  if (!estado) return null;

  const transcurrido_seg = (Date.now() - estado.timestamp_calculo) / 1000;
  const countdown = estado.segundos_eta_api - transcurrido_seg;

  if (countdown <= 0) return { necesita_recalculo: true };

  return { segundos_restantes: countdown, proxima_parada_id: estado.proxima_parada_id };
}
