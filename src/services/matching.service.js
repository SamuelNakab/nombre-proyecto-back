import prisma from '../config/prisma.js';

const timers = new Map();

export async function publicarViaje(io, viaje, conductoresElegibles, clienteIdUsuario) {
  const room = `viaje:${viaje.id_viaje}`;
  const conductoresIds = new Set(conductoresElegibles.map((c) => c.id_usuario));

  const sockets = await io.fetchSockets();
  for (const s of sockets) {
    const { rol, id_usuario } = s.data.usuario;
    if ((rol === 'CONDUCTOR' && conductoresIds.has(id_usuario)) || id_usuario === clienteIdUsuario) {
      await s.join(room);
    }
  }

  io.to(room).emit('viaje:disponible', {
    id_viaje: viaje.id_viaje,
    zona: viaje.zona,
    precio_estimado: viaje.precio_estimado,
    fecha_programada: viaje.fecha_programada,
    descripcion: viaje.descripcion ?? null,
    paradas: viaje.paradas.map((p) => ({ orden: p.orden, direccion: p.direccion })),
    condiciones_req: viaje.condiciones_req.map((c) => ({ condicion: c.condicion })),
  });

  const minutos = parseInt(process.env.MATCHING_TIMEOUT_MINUTOS) || 10;
  const timeoutId = setTimeout(() => cancelarPorTimeout(io, viaje.id_viaje), minutos * 60 * 1000);
  timers.set(viaje.id_viaje, timeoutId);

  console.log(`[Matching] viaje ${viaje.id_viaje} publicado — timeout en ${minutos} min`);
}

export async function cancelarPorTimeout(io, id_viaje) {
  try {
    await prisma.viaje.update({
      where: { id_viaje },
      data: { estado: 'CANCELADO' },
    });
  } catch {
    return;
  }

  const room = `viaje:${id_viaje}`;
  io.to(room).emit('viaje:cancelado_sin_conductor', {
    id_viaje,
    mensaje: 'No se encontro un conductor disponible',
  });
  await io.socketsLeave(room);
  timers.delete(id_viaje);

  console.log(`[Matching] viaje ${id_viaje} cancelado por timeout`);
}

export function cancelarTimer(id_viaje) {
  const timeoutId = timers.get(id_viaje);
  if (timeoutId) {
    clearTimeout(timeoutId);
    timers.delete(id_viaje);
  }
}
