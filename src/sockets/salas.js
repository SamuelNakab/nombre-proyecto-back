// Salas de socket.io de un viaje.
//
// - viaje:{id}          la de siempre: cliente legacy, gerente y conductores del
//                       pool. El tracking se emite aca.
// - organizacion:{id}   los miembros ACTIVOS de una PyME. Se arma al conectarse
//                       (sockets/index.js) y se sincroniza al crear la PyME, al
//                       canjear un codigo MIEMBRO, al salir y al eliminar un
//                       miembro (sincronizarSalaOrganizacion).
// - usuario:{id}        la personal. El chofer recibe todo lo suyo por aca.
//
// Los eventos y el tracking de un viaje INTERNO se emiten a viaje:{id} Y a
// organizacion:{id}: io.to([...]) deduplica, asi que un socket que este en las
// dos recibe una sola vez. Una PyME nunca recibe un viaje de otra: la sala sale
// del id_organizacion del propio viaje.

export const salaOrganizacion = (id_organizacion) => `organizacion:${id_organizacion}`;
export const salaUsuario = (id_usuario) => `usuario:${id_usuario}`;

// Pura. El viaje tiene que traer id_viaje e id_organizacion (null si es legacy).
export function salasDeViaje(viaje) {
  if (viaje.id_organizacion === undefined) {
    throw new Error('salasDeViaje: el viaje debe traer id_organizacion');
  }
  const salas = [`viaje:${viaje.id_viaje}`];
  if (viaje.id_organizacion !== null) salas.push(salaOrganizacion(viaje.id_organizacion));
  return salas;
}

// Suma (unir=true) o saca (unir=false) a TODOS los sockets de un usuario de la
// sala de una PyME. Best-effort: sin io (scripts, tests unitarios) no hace nada.
export async function sincronizarSalaOrganizacion(io, id_usuario, id_organizacion, unir) {
  if (!io) return;
  try {
    const sockets = io.in(salaUsuario(id_usuario));
    if (unir) sockets.socketsJoin(salaOrganizacion(id_organizacion));
    else sockets.socketsLeave(salaOrganizacion(id_organizacion));
  } catch (err) {
    console.error(`[salas] no se pudo sincronizar la sala de la PyME ${id_organizacion}:`, err.message);
  }
}

// Eventos del ciclo INTERNO: a la sala de la PyME, a la sala personal del chofer
// (por id_usuario, NO por id_conductor) y, si viene id_viaje, al room del viaje.
// Sin io (scripts) no hace nada.
export function emitirViajeInterno(io, { id_viaje, id_organizacion, id_usuario_chofer }, evento, payload) {
  if (!io) return;
  const salas = [];
  if (id_viaje != null) salas.push(`viaje:${id_viaje}`);
  if (id_organizacion != null) salas.push(salaOrganizacion(id_organizacion));
  if (id_usuario_chofer != null) salas.push(salaUsuario(id_usuario_chofer));
  if (salas.length > 0) io.to(salas).emit(evento, payload);
}
