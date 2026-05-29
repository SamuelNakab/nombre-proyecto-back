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
      },
    });

    if (!conductor) {
      socket.emit('error', { error: 'Perfil de conductor no encontrado' });
      return;
    }

    const id_viaje = Number(payload.id_viaje);

    // ── CAMBIO A: id_vehiculo opcional con auto-selección ─────────────────
    let vehiculoFinal = null;

    if (payload.id_vehiculo) {
      vehiculoFinal = await prisma.vehiculo.findUnique({
        where: { id_vehiculo: parseInt(payload.id_vehiculo) },
        include: { condiciones: true },
      });
      if (!vehiculoFinal) {
        socket.emit('error', { error: 'Vehiculo no encontrado' });
        return;
      }

      // ── CAMBIO B: verificación de propiedad correcta ──────────────────
      const esPropioDirecto = vehiculoFinal.id_conductor === conductor.id_conductor;
      const asignadoViaEmpresa = await prisma.conductorVehiculo.findFirst({
        where: {
          id_vehiculo: vehiculoFinal.id_vehiculo,
          id_conductor: conductor.id_conductor,
        },
      });
      if (!esPropioDirecto && !asignadoViaEmpresa) {
        socket.emit('error', { error: 'Ese vehiculo no te pertenece' });
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
        socket.emit('error', { error: 'Tu vehiculo no cumple las condiciones del viaje' });
        return;
      }
    } else {
      // Auto-selección del primer vehículo elegible
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
        // Intentar con vehículos asignados vía empresa
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
        socket.emit('error', { error: 'No tenes vehiculos disponibles para este viaje' });
        return;
      }
    }

    // ── Transacción atómica ───────────────────────────────────────────────
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

    const payload_evento = {
      id_viaje,
      id_usuario_conductor: conductor.id_usuario,
      conductor: {
        nombre: conductor.usuario.nombre,
        apellido: conductor.usuario.apellido,
        calificacion_promedio: conductor.calificacion_promedio,
      },
      vehiculo: vehiculoFinal
        ? {
            patente: vehiculoFinal.patente,
            marca: vehiculoFinal.marca,
            modelo: vehiculoFinal.modelo,
            tipo_vehiculo: vehiculoFinal.tipo_vehiculo,
          }
        : null,
    };

    // ── CAMBIO C: emitir correctamente a cada destinatario ────────────────

    // 1. Al conductor ganador
    socket.emit('viaje:conductor_asignado', payload_evento);

    // 2. Al cliente directamente via su room personal
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

    console.log(`[Matching] viaje ${id_viaje} asignado al conductor ${conductor.id_conductor}`);
  });
}
