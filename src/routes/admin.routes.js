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
import { datasetPrecios } from '../controllers/admin-precios.controller.js';

const router = Router();

// Todos los endpoints admin requieren token valido + rol ADMIN.
router.use(verificarToken, requireRol('ADMIN'));

router.get('/usuarios', listarUsuarios);
router.get('/usuarios/:id', obtenerUsuario);
router.get('/viajes', listarViajes);
router.get('/viajes/:id', obtenerViaje);
router.get('/estadisticas', obtenerEstadisticas);
router.post('/viajes/:id/cancelar', cancelarViaje);
// Precio v2: dataset para recalibrar (viajes v2 finalizados), JSON o CSV.
router.get('/precios/dataset', datasetPrecios);

export default router;
