import prisma from '../config/prisma.js';
import { cancelarTimer } from '../services/matching.service.js';

export function manejarAceptarViaje(socket, io) {
  socket.on('viaje:aceptar', async (data) => {
    if (!data?.id_viaje) {
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
    const id_viaje = Number(data.id_viaje);

    // Atomic update: solo actualiza si el viaje aun esta BUSCANDO_CONDUCTOR.
    // updateMany con condicion en WHERE es atomico en PostgreSQL: el segundo
    // conductor en llegar ve count=0 porque el primero ya cambio el estado.
    let updated;
    try {
      updated = await prisma.viaje.updateMany({
        where: { id_viaje, estado: 'BUSCANDO_CONDUCTOR' },
        data: {
          estado: 'CONDUCTOR_ASIGNADO',
          id_conductor: conductor.id_conductor,
          id_vehiculo: primerVehiculo?.id_vehiculo ?? null,
        },
      });
    } catch {
      socket.emit('error', { error: 'Error al procesar la asignacion' });
      return;
    }

    if (updated.count === 0) {
      socket.emit('viaje:ya_asignado', {
        id_viaje,
        mensaje: 'Otro conductor fue mas rapido',
      });
      return;
    }

    cancelarTimer(id_viaje);

    const viaje = await prisma.viaje.findUnique({
      where: { id_viaje },
      select: { cliente: { select: { id_usuario: true } } },
    });

    const eventoPayload = {
      id_viaje,
      id_usuario_conductor: conductor.id_usuario,
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
    };

    // Solo al socket del conductor ganador
    socket.emit('viaje:conductor_asignado', eventoPayload);

    // Al socket del cliente del viaje (busqueda directa por id_usuario)
    const idClienteUsuario = viaje?.cliente?.id_usuario;
    if (idClienteUsuario) {
      for (const [, s] of io.sockets.sockets) {
        if (s.data.usuario?.id_usuario === idClienteUsuario) {
          s.emit('viaje:conductor_asignado', eventoPayload);
          break;
        }
      }
    }

    // Broadcast a todos los demas del room (conductores que perdieron la race)
    socket.to(`viaje:${id_viaje}`).emit('viaje:no_disponible', { id_viaje });

    console.log(`[Matching] viaje ${id_viaje} asignado al conductor ${conductor.id_conductor}`);
  });
}
