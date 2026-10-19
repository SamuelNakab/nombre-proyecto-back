import prisma from '../config/prisma.js';
import { responderErrorNegocio } from '../services/error-negocio.js';
import { organizacionesDeChofer, desvincularChofer } from '../services/vinculo-chofer.service.js';
import { io } from '../sockets/index.js';

function idParam(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const conductorDe = (id_usuario) =>
  prisma.conductor.findUnique({ where: { id_usuario }, select: { id_conductor: true } });

// GET /api/choferes/mis-organizaciones
// El chofer ve el NOMBRE de sus PyMEs. Sin vinculos devuelve [].
export async function misOrganizaciones(req, res) {
  const conductor = await conductorDe(req.usuario.id_usuario);
  if (!conductor) return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  return res.status(200).json(await organizacionesDeChofer(conductor.id_conductor));
}

// DELETE /api/choferes/mis-organizaciones/:id
// Mismo servicio que el desvincular desde la PyME (desvincularChofer), con
// origen CHOFER.
export async function desvincularme(req, res) {
  const id_organizacion = idParam(req.params.id);
  if (!id_organizacion) return res.status(400).json({ error: 'id de PyME invalido' });
  const conductor = await conductorDe(req.usuario.id_usuario);
  if (!conductor) return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  try {
    // Mismo servicio: cancela tus viajes no finales con esa PyME y pasa a
    // BORRADA tus series activas con ella.
    const { viajes_cancelados, series_borradas } = await desvincularChofer({
      id_organizacion,
      id_conductor: conductor.id_conductor,
      actor: { id_usuario: req.usuario.id_usuario, origen: 'CHOFER' },
      io,
    });
    return res
      .status(200)
      .json({ mensaje: 'Te desvinculaste de la PyME', id_organizacion, viajes_cancelados, series_borradas });
  } catch (err) {
    return responderErrorNegocio(res, err);
  }
}
