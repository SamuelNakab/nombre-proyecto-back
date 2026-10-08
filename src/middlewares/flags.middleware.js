// Flags que dejan DORMIDO lo que el Paso 2 reemplaza. Nada se borra: con el flag
// en true todo vuelve a funcionar como antes.
//
// - MARKETPLACE_HABILITADO (default false): viajes disponibles, crear viaje por
//   la ruta vieja, reservar / asignar / reasignar / cancelar-reserva, aceptar
//   (socket), gerente (registro), empresas y afiliaciones. Tambien corta la
//   publicacion viaje:disponible y el barrido de reservas del arranque.
// - CALIFICACIONES_HABILITADAS (default false): POST /api/viajes/:id/calificacion.
//   Flag PROPIO y no el del marketplace: las calificaciones pueden volver sin el
//   marketplace (una PyME calificando a sus choferes encaja en el modelo nuevo).
//
// Se leen en CADA request (no se cachean): se pueden cambiar sin redeploy de
// codigo. Solo 'true' o '1' prenden; cualquier otra cosa (vacio incluido) es false.

const prendido = (valor) => valor === 'true' || valor === '1';

export function marketplaceHabilitado() {
  return prendido(process.env.MARKETPLACE_HABILITADO);
}

export function calificacionesHabilitadas() {
  return prendido(process.env.CALIFICACIONES_HABILITADAS);
}

// 404 y no 403: para el cliente, la ruta no existe. Va ANTES de verificarToken
// en cada router, asi el 404 sale igual con o sin token.
const NO_ENCONTRADO = { error: 'No encontrado' };

export function requireMarketplace(_req, res, next) {
  if (!marketplaceHabilitado()) return res.status(404).json(NO_ENCONTRADO);
  next();
}

export function requireCalificaciones(_req, res, next) {
  if (!calificacionesHabilitadas()) return res.status(404).json(NO_ENCONTRADO);
  next();
}
