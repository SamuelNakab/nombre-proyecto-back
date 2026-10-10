import { z } from 'zod';
import { responderErrorNegocio } from '../services/error-negocio.js';
import {
  crearOrganizacion as crearOrganizacionSrv,
  obtenerOrganizacion as obtenerOrganizacionSrv,
  editarOrganizacion as editarOrganizacionSrv,
  listarMiembros as listarMiembrosSrv,
  cambiarRol as cambiarRolSrv,
  eliminarMiembro as eliminarMiembroSrv,
  salirDeOrganizacion,
} from '../services/organizacion.service.js';
import {
  crearInvitacion as crearInvitacionSrv,
  listarPendientes,
  revocarInvitacion as revocarInvitacionSrv,
} from '../services/invitacion.service.js';
import {
  listarChoferes as listarChoferesSrv,
  desvincularChofer as desvincularChoferSrv,
} from '../services/vinculo-chofer.service.js';
import { sincronizarSalaOrganizacion } from '../sockets/salas.js';
import { io } from '../sockets/index.js';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const textoRequerido = (campo) =>
  z.string({ error: `${campo} es requerido` }).trim().min(1, `${campo} es requerido`);

const schemaCrear = z.object({
  nombre: textoRequerido('nombre'),
  // El formato y el digito verificador los valida cuit.service (mensajes propios).
  cuit: textoRequerido('cuit'),
  razon_social: z.string().trim().min(1).optional(),
  direccion: z.string().trim().min(1).optional(),
});

const schemaEditar = z
  .object({
    nombre: textoRequerido('nombre').optional(),
    cuit: textoRequerido('cuit').optional(),
    razon_social: z.string().trim().min(1).nullable().optional(),
    direccion: z.string().trim().min(1).nullable().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: 'Mandá al menos un campo para editar',
  });

const schemaRol = z.object({
  rol: z.enum(['RESPONSABLE', 'MIEMBRO'], { error: 'rol debe ser RESPONSABLE o MIEMBRO' }),
});

const schemaInvitacion = z.object({
  tipo: z.enum(['MIEMBRO', 'CHOFER'], { error: 'tipo debe ser MIEMBRO o CHOFER' }),
});

function idParam(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const esResponsable = (req) => req.membresia.rol === 'RESPONSABLE';

// ─── PyME ────────────────────────────────────────────────────────────────────

// POST /api/organizaciones
export async function crearOrganizacion(req, res) {
  const parsed = schemaCrear.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  try {
    const org = await crearOrganizacionSrv({ id_usuario: req.usuario.id_usuario, ...parsed.data });
    // El creador entra a la sala de la PyME (organizacion:{id}).
    await sincronizarSalaOrganizacion(io, req.usuario.id_usuario, org.id_organizacion, true);
    return res.status(201).json(org);
  } catch (err) {
    return responderErrorNegocio(res, err);
  }
}

// GET /api/organizaciones/:id
export async function obtenerOrganizacion(req, res) {
  try {
    return res.status(200).json(await obtenerOrganizacionSrv(req.id_organizacion, req.membresia.rol));
  } catch (err) {
    return responderErrorNegocio(res, err);
  }
}

// PUT /api/organizaciones/:id
export async function editarOrganizacion(req, res) {
  const parsed = schemaEditar.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  try {
    const org = await editarOrganizacionSrv({
      id_organizacion: req.id_organizacion,
      id_usuario: req.usuario.id_usuario,
      datos: parsed.data,
    });
    return res.status(200).json(org);
  } catch (err) {
    return responderErrorNegocio(res, err);
  }
}

// ─── Miembros ────────────────────────────────────────────────────────────────

// GET /api/organizaciones/:id/miembros
export async function listarMiembros(req, res) {
  return res.status(200).json(await listarMiembrosSrv(req.id_organizacion));
}

// PUT /api/organizaciones/:id/miembros/:idUsuario/rol
export async function cambiarRol(req, res) {
  const id_usuario = idParam(req.params.idUsuario);
  if (!id_usuario) return res.status(400).json({ error: 'id de usuario invalido' });
  const parsed = schemaRol.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  try {
    const r = await cambiarRolSrv({
      id_organizacion: req.id_organizacion,
      id_actor: req.usuario.id_usuario,
      id_usuario,
      rol: parsed.data.rol,
    });
    return res.status(200).json({ mensaje: 'Rol actualizado', ...r });
  } catch (err) {
    return responderErrorNegocio(res, err);
  }
}

// DELETE /api/organizaciones/:id/miembros/:idUsuario
export async function eliminarMiembro(req, res) {
  const id_usuario = idParam(req.params.idUsuario);
  if (!id_usuario) return res.status(400).json({ error: 'id de usuario invalido' });
  try {
    await eliminarMiembroSrv({ id_organizacion: req.id_organizacion, id_actor: req.usuario.id_usuario, id_usuario });
    // Sale de la sala de la PyME: deja de recibir eventos y tracking.
    await sincronizarSalaOrganizacion(io, id_usuario, req.id_organizacion, false);
    return res.status(200).json({ mensaje: 'Miembro eliminado', id_usuario });
  } catch (err) {
    return responderErrorNegocio(res, err);
  }
}

// POST /api/organizaciones/:id/salir
export async function salir(req, res) {
  try {
    await salirDeOrganizacion({ id_organizacion: req.id_organizacion, id_usuario: req.usuario.id_usuario });
    await sincronizarSalaOrganizacion(io, req.usuario.id_usuario, req.id_organizacion, false);
    return res.status(200).json({ mensaje: 'Saliste de la PyME', id_organizacion: req.id_organizacion });
  } catch (err) {
    return responderErrorNegocio(res, err);
  }
}

// ─── Invitaciones ────────────────────────────────────────────────────────────

// POST /api/organizaciones/:id/invitaciones
// MIEMBRO: solo un responsable. CHOFER: cualquier miembro.
export async function crearInvitacion(req, res) {
  const parsed = schemaInvitacion.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (parsed.data.tipo === 'MIEMBRO' && !esResponsable(req)) {
    return res.status(403).json({ error: 'Solo un responsable puede invitar miembros' });
  }
  const inv = await crearInvitacionSrv({
    id_organizacion: req.id_organizacion,
    tipo: parsed.data.tipo,
    id_usuario: req.usuario.id_usuario,
  });
  return res.status(201).json(inv);
}

// GET /api/organizaciones/:id/invitaciones
export async function listarInvitaciones(req, res) {
  return res.status(200).json(await listarPendientes(req.id_organizacion));
}

// DELETE /api/organizaciones/:id/invitaciones/:idInv
export async function revocarInvitacion(req, res) {
  const id_invitacion = idParam(req.params.idInv);
  if (!id_invitacion) return res.status(400).json({ error: 'id de invitacion invalido' });
  try {
    await revocarInvitacionSrv({
      id_organizacion: req.id_organizacion,
      id_invitacion,
      id_usuario: req.usuario.id_usuario,
      esResponsable: esResponsable(req),
    });
    return res.status(200).json({ mensaje: 'Invitacion revocada', id_invitacion });
  } catch (err) {
    return responderErrorNegocio(res, err);
  }
}

// ─── Choferes ────────────────────────────────────────────────────────────────

// GET /api/organizaciones/:id/choferes
export async function listarChoferes(req, res) {
  return res.status(200).json(await listarChoferesSrv(req.id_organizacion));
}

// DELETE /api/organizaciones/:id/choferes/:idConductor
export async function desvincularChofer(req, res) {
  const id_conductor = idParam(req.params.idConductor);
  if (!id_conductor) return res.status(400).json({ error: 'id de conductor invalido' });
  try {
    // Cancela en la misma transaccion TODOS los viajes no finales de ese chofer
    // con esta PyME, incluido uno en curso (causa DESVINCULACION), y pasa a
    // BORRADA sus series activas con esta PyME.
    const { viajes_cancelados, series_borradas } = await desvincularChoferSrv({
      id_organizacion: req.id_organizacion,
      id_conductor,
      actor: { id_usuario: req.usuario.id_usuario, origen: 'ORGANIZACION' },
      io,
    });
    return res
      .status(200)
      .json({ mensaje: 'Chofer desvinculado', id_conductor, viajes_cancelados, series_borradas });
  } catch (err) {
    return responderErrorNegocio(res, err);
  }
}
