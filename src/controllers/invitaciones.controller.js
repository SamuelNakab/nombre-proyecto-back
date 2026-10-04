import { z } from 'zod';
import { responderErrorNegocio } from '../services/error-negocio.js';
import { canjearCodigo } from '../services/invitacion.service.js';
import { consumirIntentoCanje, ipDelRequest } from '../services/rate-limit-canje.service.js';
import { sincronizarSalaOrganizacion } from '../sockets/salas.js';
import { io } from '../sockets/index.js';

const schemaCanje = z.object({
  codigo: z.string({ error: 'codigo es requerido' }).min(1, 'codigo es requerido'),
});

// POST /api/invitaciones/canjear
// Orden: 503 sin secreto (middleware) -> 429 rate limit -> 400 body ->
// errores explicitos del estado del usuario -> "Codigo invalido" uniforme.
// El rate limit va ANTES de validar el body: un intento con basura cuenta igual.
export async function canjear(req, res) {
  const { permitido } = await consumirIntentoCanje({
    id_usuario: req.usuario.id_usuario,
    ip: ipDelRequest(req),
  });
  if (!permitido) {
    return res.status(429).json({ error: 'Demasiados intentos. Proba de nuevo en unos minutos' });
  }

  const parsed = schemaCanje.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const resultado = await canjearCodigo({ usuario: req.usuario, codigo: parsed.data.codigo });
    // Un nuevo MIEMBRO entra a la sala de la PyME (eventos y tracking de sus
    // viajes). El chofer no: recibe lo suyo por su sala personal.
    if (resultado.tipo === 'MIEMBRO') {
      await sincronizarSalaOrganizacion(io, req.usuario.id_usuario, resultado.organizacion.id_organizacion, true);
    }
    return res.status(200).json(resultado);
  } catch (err) {
    return responderErrorNegocio(res, err);
  }
}
