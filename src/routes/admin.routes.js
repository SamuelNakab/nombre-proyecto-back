import { Router } from 'express';
import { verificarToken, requireRol } from '../middlewares/auth.middleware.js';
import {
  listarUsuarios,
  obtenerUsuario,
  listarViajes,
  obtenerViaje,
  obtenerEstadisticas,
  cancelarViaje,
} from '../controllers/admin.controller.js';

const router = Router();

// Todos los endpoints admin requieren token valido + rol ADMIN.
router.use(verificarToken, requireRol('ADMIN'));

router.get('/usuarios', listarUsuarios);
router.get('/usuarios/:id', obtenerUsuario);
router.get('/viajes', listarViajes);
router.get('/viajes/:id', obtenerViaje);
router.get('/estadisticas', obtenerEstadisticas);
router.post('/viajes/:id/cancelar', cancelarViaje);

export default router;
