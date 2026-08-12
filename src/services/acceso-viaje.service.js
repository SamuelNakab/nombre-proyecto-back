import { obtenerGerentesElegibles } from './elegibilidad.service.js';

// Regla de acceso de LECTURA de un viaje. Es la MISMA para los tres endpoints
// que devuelven datos del viaje:
//   - GET /api/viajes/:id
//   - GET /api/viajes/:id/costo-acumulado
//   - GET /api/viajes/:id/remito
//
// Antes vivia inline en obtenerViaje y los otros dos se habian quedado en
// CLIENTE/CONDUCTOR (el gerente no podia ver el costo ni el remito de un viaje
// de su propia empresa). Tenerla en un solo lugar es lo que evita que se vuelvan
// a desincronizar.
//
// Pasa: el cliente dueño, el conductor asignado, o el gerente de la empresa
// dueña del viaje (viaje.id_empresa -> empresa.id_gerente). Cualquier otro, no.

// Relaciones que puedeVerViaje necesita tener cargadas. Se exporta para que los
// callers que no necesitan el objeto completo (costo-acumulado, remito) usen
// exactamente este include y no se olviden de una.
export const INCLUDE_ACCESO_VIAJE = {
  cliente: { select: { id_usuario: true } },
  conductor: { select: { id_usuario: true } },
  empresa: { select: { id_empresa: true, id_gerente: true } },
};

export function puedeVerViaje(viaje, usuario) {
  // Prisma deja en `undefined` las relaciones que no se incluyeron, y en `null`
  // las incluidas que no existen. Sin este chequeo, olvidarse un include no
  // rompe: devuelve un 403 silencioso — justo el bug que este helper viene a
  // evitar. Preferimos que explote fuerte.
  if (
    viaje.cliente === undefined ||
    viaje.conductor === undefined ||
    viaje.empresa === undefined
  ) {
    throw new Error(
      'puedeVerViaje: el viaje debe venir con las relaciones cliente, conductor y empresa incluidas'
    );
  }

  const esCliente = viaje.cliente.id_usuario === usuario.id_usuario;
  const esConductorAsignado =
    viaje.conductor !== null && viaje.conductor.id_usuario === usuario.id_usuario;
  const esGerenteDeLaEmpresa =
    viaje.empresa !== null && viaje.empresa.id_gerente === usuario.id_usuario;

  return esCliente || esConductorAsignado || esGerenteDeLaEmpresa;
}

// Regla ADICIONAL, solo para el DETALLE del viaje (GET /api/viajes/:id).
//
// Un viaje en BUSCANDO_CONDUCTOR todavia no tiene id_empresa, asi que ningun
// gerente pasa por puedeVerViaje. Pero el gerente necesita abrir el detalle
// (paradas, ruta_planeada, condiciones_req) para decidir si lo reserva — es el
// equivalente a lo que el conductor ve en GET /api/viajes/disponibles.
//
// Elegibilidad: se REUSA obtenerGerentesElegibles, el mismo helper de
// elegibilidad a nivel empresa que usa publicarViajeAConductoresElegibles para
// decidir a que gerentes les llega el push viaje:disponible. Consecuencia
// buscada: si te llego el push, podes abrir el detalle. No se reimplementa el
// matching de condiciones, asi que push y detalle no se pueden desincronizar.
//
// NO aplica a costo-acumulado ni a remito: un viaje sin conductor no tiene ni
// costo acumulado ni remito.
export async function puedeVerViajeDisponible(viaje, usuario) {
  if (usuario.rol !== 'GERENTE') return false;
  if (viaje.estado !== 'BUSCANDO_CONDUCTOR') return false;

  if (viaje.condiciones_req === undefined) {
    throw new Error(
      'puedeVerViajeDisponible: el viaje debe venir con la relacion condiciones_req incluida'
    );
  }

  const condiciones = viaje.condiciones_req.map((c) => c.condicion);
  const gerentesElegibles = await obtenerGerentesElegibles(condiciones);
  return gerentesElegibles.some((g) => g.id_usuario === usuario.id_usuario);
}
