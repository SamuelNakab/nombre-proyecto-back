import prisma from '../config/prisma.js';
import { cancelarTimer } from '../services/matching.service.js';
import { obtenerRutaPlaneada } from '../services/ruta.service.js';

export function manejarAceptarViaje(socket, io) {
  socket.on('viaje:aceptar', async (payload) => {
    console.log('[viaje:aceptar] Payload recibido:', payload);

    if (!payload?.id_viaje) {
      socket.emit('error', { mensaje: 'id_viaje requerido' });
      return;
    }

    if (socket.data.usuario.rol !== 'CONDUCTOR') {
      socket.emit('error', { mensaje: 'Solo conductores pueden aceptar viajes' });
      return;
    }

    try {
      const conductor = await prisma.conductor.findUnique({
        where: { id_usuario: socket.data.usuario.id_usuario },
        include: {
          usuario: { select: { nombre: true, apellido: true } },
        },
      });

      if (!conductor) {
        socket.emit('error', { mensaje: 'Perfil de conductor no encontrado' });
        return;
      }

      console.log('[viaje:aceptar] Conductor:', conductor.id_conductor);

      const id_viaje = Number(payload.id_viaje);

      // id_vehiculo opcional: si viene se valida, si no se auto-selecciona
      let vehiculoFinal = null;

      if (payload.id_vehiculo) {
        vehiculoFinal = await prisma.vehiculo.findUnique({
          where: { id_vehiculo: parseInt(payload.id_vehiculo) },
          include: { condiciones: true },
        });
        if (!vehiculoFinal) {
          socket.emit('error', { mensaje: 'Vehiculo no encontrado' });
          return;
        }

        // Un vehiculo pertenece al conductor si es propio (A) o asignado via empresa (B)
        const esPropioDirecto = vehiculoFinal.id_conductor === conductor.id_conductor;
        const asignadoViaEmpresa = await prisma.conductorVehiculo.findFirst({
          where: {
            id_vehiculo: vehiculoFinal.id_vehiculo,
            id_conductor: conductor.id_conductor,
          },
        });
        if (!esPropioDirecto && !asignadoViaEmpresa) {
          socket.emit('error', { mensaje: 'Ese vehiculo no te pertenece' });
          return;
        }

        const condicionesRequeridas = await prisma.condicionRequerida.findMany({
          where: { id_viaje },
        });
        const condicionesVehiculo = vehiculoFinal.condiciones.map((c) => c.condicion);
        const faltaAlguna = condicionesRequeridas.some(
          (cr) => !condicionesVehiculo.includes(cr.condicion)
        );
        if (faltaAlguna) {
          socket.emit('error', { mensaje: 'Tu vehiculo no cumple las condiciones del viaje' });
          return;
        }
      } else {
        // Auto-seleccion: primer vehiculo elegible del conductor
        const condicionesRequeridas = await prisma.condicionRequerida.findMany({
          where: { id_viaje },
        });
        const condicionesNecesarias = condicionesRequeridas.map((c) => c.condicion);

        const vehiculosPropios = await prisma.vehiculo.findMany({
          where: { id_conductor: conductor.id_conductor },
          include: { condiciones: true },
        });

        vehiculoFinal =
          vehiculosPropios.find((v) => {
            const tiene = v.condiciones.map((c) => c.condicion);
            return condicionesNecesarias.every((c) => tiene.includes(c));
          }) || null;

        if (!vehiculoFinal && condicionesNecesarias.length === 0) {
          vehiculoFinal = vehiculosPropios[0] || null;
        }

        if (!vehiculoFinal) {
          // Intentar con vehiculos asignados via empresa
          const conductorVehiculos = await prisma.conductorVehiculo.findMany({
            where: { id_conductor: conductor.id_conductor },
            include: { vehiculo: { include: { condiciones: true } } },
          });
          vehiculoFinal =
            conductorVehiculos.find((cv) => {
              const tiene = cv.vehiculo.condiciones.map((c) => c.condicion);
              return condicionesNecesarias.every((c) => tiene.includes(c));
            })?.vehiculo || null;

          if (!vehiculoFinal && condicionesNecesarias.length === 0) {
            vehiculoFinal = conductorVehiculos[0]?.vehiculo || null;
          }
        }

        if (!vehiculoFinal) {
          socket.emit('error', { mensaje: 'No tenes un vehiculo que cumpla las condiciones del viaje' });
          console.log('[viaje:aceptar] Resultado: sin vehiculo elegible');
          return;
        }
      }

      // Transaccion atomica para evitar race conditions
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
              id_vehiculo: vehiculoFinal.id_vehiculo,
            },
          });
        });
      } catch (txError) {
        console.error('[viaje:aceptar] Error en transaccion:', txError);
        socket.emit('error', { mensaje: 'Error al procesar la asignacion' });
        return;
      }

      if (yaAsignado) {
        socket.emit('viaje:ya_asignado', {
          id_viaje,
          mensaje: 'Otro conductor fue mas rapido',
        });
        console.log('[viaje:aceptar] Resultado: viaje ya asignado');
        return;
      }

      cancelarTimer(id_viaje);

      // Ruta planeada (calculada al crear el viaje) para que el front la dibuje
      // apenas se asigna el conductor. Mismo formato [[lng, lat], ...].
      const ruta_planeada = await obtenerRutaPlaneada(id_viaje);

      const payload_evento = {
        id_viaje,
        id_usuario_conductor: conductor.id_usuario,
        conductor: {
          nombre: conductor.usuario.nombre,
          apellido: conductor.usuario.apellido,
          calificacion_promedio: conductor.calificacion_promedio,
        },
        vehiculo: {
          patente: vehiculoFinal.patente,
          marca: vehiculoFinal.marca,
          modelo: vehiculoFinal.modelo,
          tipo_vehiculo: vehiculoFinal.tipo_vehiculo,
        },
        ruta_planeada,
      };

      // 1. Al conductor ganador
      socket.emit('viaje:conductor_asignado', payload_evento);

      // 2. Al cliente via su room personal
      const viajeConCliente = await prisma.viaje.findUnique({
        where: { id_viaje },
        include: { cliente: { include: { usuario: true } } },
      });
      if (viajeConCliente?.cliente?.usuario) {
        io.to('usuario:' + viajeConCliente.cliente.usuario.id_usuario).emit(
          'viaje:conductor_asignado',
          payload_evento
        );
      }

      // 3. Al resto del room (conductores que no ganaron)
      socket.to('viaje:' + id_viaje).emit('viaje:no_disponible', { id_viaje });

      console.log(`[viaje:aceptar] Resultado: conductor asignado — viaje ${id_viaje} → conductor ${conductor.id_conductor}`);
    } catch (error) {
      console.error('[viaje:aceptar] Error:', error);
      socket.emit('error', { mensaje: 'Error interno al procesar el viaje' });
    }
  });
}
