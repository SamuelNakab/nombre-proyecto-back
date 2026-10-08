import { Router } from 'express';
import { verificarToken, requireRol } from '../middlewares/auth.middleware.js';
import { requireMarketplace } from '../middlewares/flags.middleware.js';
import {
  unirseAEmpresa,
  listarMisAfiliaciones,
  salirDeEmpresa,
} from '../controllers/afiliaciones.controller.js';

const router = Router();

// Todos los endpoints de afiliacion requieren token valido + rol CONDUCTOR.
// Con MARKETPLACE_HABILITADO en false, todo /api/afiliaciones da 404.
router.use(requireMarketplace, verificarToken, requireRol('CONDUCTOR'));

router.post('/', unirseAEmpresa);
router.get('/mias', listarMisAfiliaciones);
router.delete('/:id', salirDeEmpresa);

export default router;
