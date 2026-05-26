import prisma from '../config/prisma.js';
import {
  guardarCoordenada,
  obtenerUltimaCoordenada,
  actualizarAcumulado,
  calcularVelocidad,
  guardarRuta,
  obtenerRuta,
} from '../services/gps.service.js';
import { obtenerRutaOptima, verificarDesvio } from '../services/desvio.service.js';
import { verificarParadaSospechosa } from '../services/parada.service.js';

export function registrarHandlersGPS(socket, io) {
  socket.on('conductor:ubicacion', async (data) => {
    try {
      const { id_viaje, lat, lng, timestamp } = data ?? {};

      if (socket.data.usuario.rol !== 'CONDUCTOR') {
        socket.emit('error', { error: 'Solo conductores pueden enviar GPS' });
        return;
      }

      if (
        id_viaje == null || lat == null || lng == null || timestamp == null ||
        typeof lat !== 'number' || typeof lng !== 'number' || typeof timestamp !== 'number'
      ) {
        socket.emit('error', { error: 'Datos GPS invalidos' });
        return;
      }

      const viaje = await prisma.viaje.findUnique({
        where: { id_viaje },
        include: { paradas: true },
      });
      if (!viaje) return;
      if (viaje.estado === 'FINALIZADO' || viaje.estado === 'CANCELADO') return;

      const anterior = await obtenerUltimaCoordenada(id_viaje);
      await guardarCoordenada(id_viaje, lat, lng, timestamp);
      const acumulado = await actualizarAcumulado(id_viaje, lat, lng, timestamp);

      const velocidad_kmh = anterior
        ? calcularVelocidad(anterior.lat, anterior.lng, anterior.timestamp, lat, lng, timestamp)
        : 0;

      if (viaje.estado === 'CONDUCTOR_ASIGNADO' && acumulado.es_primer_ping === true) {
        await prisma.viaje.update({
          where: { id_viaje },
          data: { estado: 'EN_CAMINO_A_ORIGEN' },
        });
        io.to(`viaje:${id_viaje}`).emit('viaje:estado_cambiado', {
          id_viaje,
          estado_anterior: 'CONDUCTOR_ASIGNADO',
          estado_nuevo: 'EN_CAMINO_A_ORIGEN',
        });
      }

      io.to(`viaje:${id_viaje}`).emit('mapa:actualizar', {
        lat,
        lng,
        timestamp,
        velocidad_kmh: Math.round(velocidad_kmh),
      });

      if (timestamp % 60000 < 16000) {
        const hora = new Date().getHours();
        const es_hora_pico = (hora >= 7 && hora <= 10) || (hora >= 17 && hora <= 20);

        let precio_acumulado = 0;
        let precio_por_tiempo = null;
        let precio_por_distancia = null;

        if (viaje.zona === 'CABA') {
          precio_por_tiempo = acumulado.tiempo_horas * (viaje.tarifa_hora || 0);
          precio_acumulado = precio_por_tiempo;
        } else if (viaje.zona === 'PROVINCIA') {
          precio_por_distancia = acumulado.distancia_km * (viaje.tarifa_km || 0);
          precio_acumulado = precio_por_distancia;
        } else {
          precio_por_tiempo = acumulado.tiempo_horas * (viaje.tarifa_hora || 0);
          precio_por_distancia = acumulado.distancia_km * (viaje.tarifa_km || 0);
          precio_acumulado = precio_por_tiempo + precio_por_distancia;
        }

        io.to(`viaje:${id_viaje}`).emit('costo:actualizar', {
          precio_acumulado,
          desglose: {
            precio_por_tiempo,
            precio_por_distancia,
            tiempo_horas: acumulado.tiempo_horas,
            distancia_km: acumulado.distancia_km,
            tarifa_hora: viaje.tarifa_hora,
            tarifa_km: viaje.tarifa_km,
            es_hora_pico,
          },
        });
      }

      let ruta = await obtenerRuta(id_viaje);
      if (!ruta) {
        ruta = await obtenerRutaOptima(viaje.paradas);
        await guardarRuta(id_viaje, ruta);
      }

      if (viaje.estado === 'EN_RUTA') {
        const desvio = verificarDesvio(lat, lng, ruta);
        if (desvio.desviado) {
          io.to(`viaje:${id_viaje}`).emit('alerta:desvio', {
            id_viaje,
            distancia_metros: Math.round(desvio.distancia_metros),
            mensaje: `El conductor se desvio ${Math.round(desvio.distancia_metros)}m de la ruta`,
          });
        }

        const parada_result = await verificarParadaSospechosa(
          id_viaje, viaje.zona, velocidad_kmh, lat, lng, viaje.paradas
        );
        if (parada_result.sospechosa) {
          io.to(`viaje:${id_viaje}`).emit('alerta:parada', {
            id_viaje,
            minutos_detenido: parada_result.minutos_detenido,
            mensaje: `El conductor lleva ${parada_result.minutos_detenido} minutos detenido`,
          });
        }
      }
    } catch (err) {
      console.error('[gps.socket] Error en conductor:ubicacion:', err);
      socket.emit('error', { error: 'Error interno al procesar ubicacion' });
    }
  });
}
