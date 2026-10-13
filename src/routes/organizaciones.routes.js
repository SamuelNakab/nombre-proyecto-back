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
import {
  crearViaje,
  listarViajes,
  obtenerViaje,
  editarViaje,
  reasignarViaje,
  cancelarViajePyme,
  costoAcumulado,
  remito,
} from '../controllers/viajes-internos.controller.js';
import * as lugares from '../controllers/lugares.controller.js';
import * as series from '../controllers/series.controller.js';

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

// Viajes INTERNOS de la PyME (Paso 2). Cualquier miembro activo. Scoping por
// req.id_organizacion: un viaje de otra PyME da 404.
router.post('/:id/viajes', requireMiembro, crearViaje);
router.get('/:id/viajes', requireMiembro, listarViajes);
router.get('/:id/viajes/:idViaje', requireMiembro, obtenerViaje);
router.put('/:id/viajes/:idViaje', requireMiembro, editarViaje);
router.post('/:id/viajes/:idViaje/reasignar', requireMiembro, reasignarViaje);
router.post('/:id/viajes/:idViaje/cancelar', requireMiembro, cancelarViajePyme);
router.get('/:id/viajes/:idViaje/costo-acumulado', requireMiembro, costoAcumulado);
router.get('/:id/viajes/:idViaje/remito', requireMiembro, remito);

// Lugares guardados (Paso 4). Cualquier miembro activo. Un lugar de otra PyME da
// 404. Borrar es soft delete.
router.get('/:id/lugares', requireMiembro, lugares.listar);
router.post('/:id/lugares', requireMiembro, lugares.crear);
router.put('/:id/lugares/:idLugar', requireMiembro, lugares.editar);
router.delete('/:id/lugares/:idLugar', requireMiembro, lugares.borrar);

// Series de viajes (Paso 4). Cualquier miembro activo. Crear genera TODOS los
// viajes de la ventana (todo o nada); cancelar no toca los viajes creados.
router.post('/:id/series', requireMiembro, series.crear);
router.get('/:id/series', requireMiembro, series.listar);
router.get('/:id/series/:idSerie', requireMiembro, series.obtener);
router.post('/:id/series/:idSerie/cancelar', requireMiembro, series.cancelar);

export default router;
