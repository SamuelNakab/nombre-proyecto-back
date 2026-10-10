// Que ve cada uno de una PARADA (Paso 4, lugares guardados). Pura.
//
// REGLA: el chofer NUNCA ve el nombre de un lugar guardado de la PyME. La
// parada le llega solo con direccion y coordenadas (mas sus tiempos y estado).
// Defensa en dos capas:
//   1. El nombre no esta en la fila de la parada: el snapshot copia direccion y
//      coordenadas, no el nombre (snapshotParadas). Los canales que spreadean la
//      fila cruda (GET /api/viajes/:id, admin, cierre) no lo pueden filtrar.
//   2. Lo que se le serializa al chofer pasa por paradaVistaChofer, que saca
//      tambien id_lugar y la relacion `lugar` si el include la trajo.
// Los sockets que reciben a la vez la PyME y el chofer (viaje:asignado,
// viaje:editado, serie:asignada) arman la parada con campos EXPLICITOS
// (resumenViaje) y no llevan el lugar: la PyME ve el nombre por REST.

export function paradaVistaChofer(parada) {
  // eslint-disable-next-line no-unused-vars
  const { id_lugar, lugar, ...resto } = parada;
  return resto;
}

// La PyME ve el nombre ACTUAL del lugar (join), aun si se borro (activo false).
// TIRA si la parada viene de un lugar y el include no trajo la relacion: un
// include olvidado devolveria lugar null en silencio (mismo idiom que
// esViajeVencido y puedeVerViaje).
export function paradaVistaPyme(parada) {
  const { lugar, ...resto } = parada;
  if (parada.id_lugar != null && lugar === undefined) {
    throw new Error('paradaVistaPyme: la parada debe venir con la relacion lugar incluida');
  }
  return {
    ...resto,
    lugar: lugar ? { id_lugar: lugar.id_lugar, nombre: lugar.nombre, activo: lugar.activo } : null,
  };
}
