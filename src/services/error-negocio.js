// Error de regla de negocio con su status HTTP. Lo tiran los servicios de
// identidad (organizaciones, invitaciones, vinculos) desde ADENTRO de una
// $transaction: tirar es lo que hace rollback, y el status viaja con el error
// hasta el controller sin que el servicio conozca a `res`.
//
// `extra` (opcional): campos que se suman al cuerpo junto a { error } (p. ej. las
// ocurrencias salteadas cuando una serie no genera ningun viaje).
export class ErrorNegocio extends Error {
  constructor(status, mensaje, extra = null) {
    super(mensaje);
    this.status = status;
    this.extra = extra;
  }
}

// Para los controllers: responde { error } si es un ErrorNegocio y relanza
// cualquier otra cosa (que la maneje Express como un 500).
export function responderErrorNegocio(res, err) {
  if (err instanceof ErrorNegocio) {
    return res.status(err.status).json({ error: err.message, ...(err.extra ?? {}) });
  }
  throw err;
}
