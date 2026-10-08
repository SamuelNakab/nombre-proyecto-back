import prisma from '../config/prisma.js';
import { secretoInvitaciones } from '../services/invitacion.service.js';

function idParam(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Exige una membresia ACTIVA en la PyME de :id. Es lo que deja afuera al CLIENTE
// huerfano de todo lo que no sea crear una PyME o canjear un codigo.
// Mismo 403 exista o no la PyME: no se filtra que ids existen.
// Deja req.membresia (con su rol) y req.id_organizacion.
export async function requireMiembro(req, res, next) {
  const id_organizacion = idParam(req.params.id);
  if (!id_organizacion) return res.status(400).json({ error: 'id de PyME invalido' });

  const membresia = await prisma.miembroOrganizacion.findFirst({
    where: { id_organizacion, id_usuario: req.usuario.id_usuario, activo: true },
  });
  if (!membresia) return res.status(403).json({ error: 'No perteneces a esta PyME' });

  req.membresia = membresia;
  req.id_organizacion = id_organizacion;
  next();
}

// Va despues de requireMiembro. Las operaciones sobre miembros lo re-chequean
// adentro de su transaccion (ver exigirResponsable en organizacion.service.js).
export function requireResponsable(req, res, next) {
  if (req.membresia?.rol !== 'RESPONSABLE') {
    return res.status(403).json({ error: 'Solo un responsable puede hacer esto' });
  }
  next();
}

// Sin INVITACION_SECRETO no se puede ni generar ni verificar un codigo: 503 en
// todos los endpoints de invitaciones, y el resto de la app sigue andando.
export function requireInvitacionesConfiguradas(req, res, next) {
  if (!secretoInvitaciones()) {
    console.error('[invitaciones] INVITACION_SECRETO no configurado: respondiendo 503');
    return res.status(503).json({ error: 'Las invitaciones no estan disponibles en este momento' });
  }
  next();
}
