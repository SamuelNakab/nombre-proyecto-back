import { obtenerConductoresElegibles, obtenerGerentesElegibles } from './elegibilidad.service.js';

// Resuelve los destinatarios elegibles del viaje (segun sus condiciones_req) y lo
// publica con publicarViaje. Es el flujo de publicacion compartido entre la
// creacion del viaje (POST /api/viajes) y la republicacion tras una cancelacion
// del conductor o una reserva liberada. El `viaje` debe venir con paradas y
// condiciones_req.
//
// Destinatarios:
// - Conductores independientes/afiliados elegibles (tienen un vehiculo propio
//   que cumple las condiciones).
// - Gerentes cuya empresa activa tiene un vehiculo de flota que cumple las
//   condiciones (camino de elegibilidad a nivel empresa).
export async function publicarViajeAConductoresElegibles(io, viaje, clienteIdUsuario) {
  const condiciones = viaje.condiciones_req.map((c) => c.condicion);
  const conductoresElegibles = await obtenerConductoresElegibles(condiciones);
  const gerentesElegibles = await obtenerGerentesElegibles(condiciones);
  await publicarViaje(io, viaje, conductoresElegibles, gerentesElegibles, clienteIdUsuario);
}

export async function publicarViaje(io, viaje, conductoresElegibles, gerentesElegibles, clienteIdUsuario) {
  const room = `viaje:${viaje.id_viaje}`;
  const conductoresIds = new Set(conductoresElegibles.map((c) => c.id_usuario));
  const gerentesIds = new Set(gerentesElegibles.map((g) => g.id_usuario));

  const sockets = await io.fetchSockets();
  for (const s of sockets) {
    const { rol, id_usuario } = s.data.usuario;
    const esConductorElegible = rol === 'CONDUCTOR' && conductoresIds.has(id_usuario);
    const esGerenteElegible = rol === 'GERENTE' && gerentesIds.has(id_usuario);
    if (esConductorElegible || esGerenteElegible || id_usuario === clienteIdUsuario) {
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

  console.log(`[Matching] viaje ${viaje.id_viaje} publicado`);
}
