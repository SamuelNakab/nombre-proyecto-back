import * as turf from '@turf/turf';
import redis from '../config/redis.js';
import prisma from '../config/prisma.js';
import { guardarRuta } from './gps.service.js';
import { obtenerRutaOptima } from './ruta.service.js';
import { recalcularEtaInmediato } from './eta-emisor.js';

export function verificarDesvio(lat, lng, rutaPolilinea) {
  if (rutaPolilinea.length < 2) return { desviado: false, distancia_metros: 0 };
  const punto = turf.point([lng, lat]);
  const linea = turf.lineString(rutaPolilinea);
  const cercano = turf.nearestPointOnLine(linea, punto, { units: 'meters' });
  const distancia = cercano.properties.dist;
  const umbral = parseFloat(process.env.DESVIO_UMBRAL_METROS || '300');
  return { desviado: distancia > umbral, distancia_metros: distancia };
}

const cooldownSeg = () => parseInt(process.env.RUTA_RECALCULO_COOLDOWN_SEGUNDOS) || 120;

// Maneja un ping respecto de la ruta vigente: cuenta desvios consecutivos,
// emite alerta:desvio y, al 2do ping consecutivo desviado (si pasa el cooldown),
// recalcula la ruta. Un ping de vuelta en ruta resetea el contador.
export async function manejarDesvio(io, id_viaje, lat, lng, ruta) {
  const desvio = verificarDesvio(lat, lng, ruta);

  if (!desvio.desviado) {
    await redis.del(`gps:${id_viaje}:pings_desviado`);
    return { desviado: false, recalculo: false, distancia_metros: desvio.distancia_metros };
  }

  const consecutivos = await redis.incr(`gps:${id_viaje}:pings_desviado`);
  await redis.expire(`gps:${id_viaje}:pings_desviado`, 86400);

  io.to(`viaje:${id_viaje}`).emit('alerta:desvio', {
    id_viaje,
    distancia_metros: Math.round(desvio.distancia_metros),
    mensaje: `El conductor se desvio ${Math.round(desvio.distancia_metros)}m de la ruta`,
  });

  // Solo recalculamos al 2do ping consecutivo desviado (un ping aislado puede
  // ser ruido GPS).
  if (consecutivos < 2) {
    return { desviado: true, recalculo: false, distancia_metros: desvio.distancia_metros };
  }

  // Cooldown: no recalcular mas de una vez cada RUTA_RECALCULO_COOLDOWN_SEGUNDOS.
  const ultimoRaw = await redis.get(`gps:${id_viaje}:ultimo_recalculo`);
  if (ultimoRaw && (Date.now() - Number(ultimoRaw)) / 1000 < cooldownSeg()) {
    return {
      desviado: true,
      recalculo: false,
      cooldown: true,
      distancia_metros: desvio.distancia_metros,
    };
  }

  const recalc = await recalcularRutaPorDesvio(io, id_viaje, lat, lng);
  return { desviado: true, recalculo: recalc.ok, distancia_metros: desvio.distancia_metros };
}

// Recalcula la ruta desde la posicion actual del conductor hasta la ultima
// parada pendiente (intermedias como waypoints), reemplaza la ruta en Redis,
// emite ruta:recalculada y fuerza un recalculo de ETA inmediato.
async function recalcularRutaPorDesvio(io, id_viaje, lat, lng) {
  const pendientes = await prisma.parada.findMany({
    where: { id_viaje, estado: 'PENDIENTE' },
    orderBy: { orden: 'asc' },
  });
  if (pendientes.length === 0) return { ok: false };

  const origen = { latitud: lat, longitud: lng };
  const nuevaRuta = await obtenerRutaOptima([origen, ...pendientes]);

  await guardarRuta(id_viaje, nuevaRuta);
  await redis.set(`gps:${id_viaje}:ultimo_recalculo`, String(Date.now()), 'EX', 86400);
  await redis.del(`gps:${id_viaje}:pings_desviado`);

  const proxima = pendientes[0];
  io.to(`viaje:${id_viaje}`).emit('ruta:recalculada', {
    id_viaje,
    nueva_ruta: nuevaRuta,
    proxima_parada_id: proxima.id_parada,
    motivo: 'desvio',
  });

  // La ruta cambio: el ETA viejo ya no vale, recalculamos con la API.
  await recalcularEtaInmediato(io, id_viaje);

  console.log(`[desvio.service] ruta recalculada para viaje ${id_viaje} (${nuevaRuta.length} puntos)`);
  return { ok: true, nuevaRuta };
}
