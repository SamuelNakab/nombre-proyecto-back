import { Router } from 'express';
import { verificarToken, requireRol } from '../middlewares/auth.middleware.js';
import {
  requireMiembro,
  requireResponsable,
  requireInvitacionesConfiguradas,
} from '../middlewares/organizacion.middleware.js';
import {
  crearOrganizacion,
  obtenerOrganizacion,
  editarOrganizacion,
  listarMiembros,
  cambiarRol,
  eliminarMiembro,
  salir,
  crearInvitacion,
  listarInvitaciones,
  revocarInvitacion,
  listarChoferes,
  desvincularChofer,
} from '../controllers/organizaciones.controller.js';

const router = Router();

// PyMEs: solo cuentas CLIENTE (usuario de PyME). Todo lo que cuelga de /:id
// exige membresia activa en esa PyME (requireMiembro): un CLIENTE huerfano solo
// puede crear una PyME (POST /) o canjear un codigo (POST /api/invitaciones/canjear).
router.use(verificarToken, requireRol('CLIENTE'));

router.post('/', crearOrganizacion);
router.get('/:id', requireMiembro, obtenerOrganizacion);
router.put('/:id', requireMiembro, requireResponsable, editarOrganizacion);

router.get('/:id/miembros', requireMiembro, listarMiembros);
router.put('/:id/miembros/:idUsuario/rol', requireMiembro, requireResponsable, cambiarRol);
router.delete('/:id/miembros/:idUsuario', requireMiembro, requireResponsable, eliminarMiembro);
router.post('/:id/salir', requireMiembro, salir);

// El permiso por TIPO (MIEMBRO -> responsable, CHOFER -> cualquiera) lo decide
// el controller, porque depende del body / de la invitacion.
router.post('/:id/invitaciones', requireMiembro, requireInvitacionesConfiguradas, crearInvitacion);
router.get('/:id/invitaciones', requireMiembro, requireInvitacionesConfiguradas, listarInvitaciones);
router.delete('/:id/invitaciones/:idInv', requireMiembro, requireInvitacionesConfiguradas, revocarInvitacion);

router.get('/:id/choferes', requireMiembro, listarChoferes);
router.delete('/:id/choferes/:idConductor', requireMiembro, desvincularChofer);

export default router;
