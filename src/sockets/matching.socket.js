import prisma from '../config/prisma.js';
import { cancelarTimer } from '../services/matching.service.js';

export function manejarAceptarViaje(socket, io) {
  socket.on('viaje:aceptar', async (payload) => {
    if (!payload?.id_viaje) {
      socket.emit('error', { error: 'id_viaje requerido' });
      return;
    }

    if (socket.data.usuario.rol !== 'CONDUCTOR') {
      socket.emit('error', { error: 'Solo conductores pueden aceptar viajes' });
      return;
    }

    const conductor = await prisma.conductor.findUnique({
      where: { id_usuario: socket.data.usuario.id_usuario },
      include: {
        usuario: { select: { nombre: true, apellido: true } },
        conductor_vehiculos: { include: { vehiculo: true }, take: 1 },
      },
    });

    if (!conductor) {
      socket.emit('error', { error: 'Perfil de conductor no encontrado' });
      return;
    }

    const primerVehiculo = conductor.conductor_vehiculos[0]?.vehiculo ?? null;
    const id_viaje = Number(payload.id_viaje);

    let yaAsignado = false;
    try {
      await prisma.$transaction(async (tx) => {
        const viaje = await tx.viaje.findUnique({ where: { id_viaje } });
        if (!viaje || viaje.estado !== 'BUSCANDO_CONDUCTOR') {
          yaAsignado = true;
          return;
        }
        await tx.viaje.update({
          where: { id_viaje },
          data: {
            estado: 'CONDUCTOR_ASIGNADO',
            id_conductor: conductor.id_conductor,
            id_vehiculo: primerVehiculo?.id_vehiculo ?? null,
          },
        });
      });
    } catch {
      socket.emit('error', { error: 'Error al procesar la asignacion' });
      return;
    }

    if (yaAsignado) {
      socket.emit('viaje:ya_asignado', {
        id_viaje,
        mensaje: 'Otro conductor fue mas rapido',
      });
      return;
    }

    cancelarTimer(id_viaje);

    const room = `viaje:${id_viaje}`;
    io.to(room).emit('viaje:conductor_asignado', {
      id_viaje,
      conductor: {
        nombre: conductor.usuario.nombre,
        apellido: conductor.usuario.apellido,
        calificacion_promedio: conductor.calificacion_promedio,
      },
      vehiculo: primerVehiculo
        ? {
            patente: primerVehiculo.patente,
            marca: primerVehiculo.marca,
            modelo: primerVehiculo.modelo,
            tipo_vehiculo: primerVehiculo.tipo_vehiculo,
          }
        : null,
    });

    console.log(`[Matching] viaje ${id_viaje} asignado al conductor ${conductor.id_conductor}`);
  });
}
