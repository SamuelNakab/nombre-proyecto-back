import { Router } from 'express';
import { verificarToken, requireRol } from '../middlewares/auth.middleware.js';
import {
  registrarVehiculo,
  listarMisVehiculos,
  actualizarVehiculo,
  eliminarVehiculo,
  agregarCondicion,
  quitarCondicion,
} from '../controllers/conductores.controller.js';

const router = Router();

router.post('/mis-vehiculos', [verificarToken, requireRol('CONDUCTOR')], registrarVehiculo);
router.get('/mis-vehiculos', [verificarToken, requireRol('CONDUCTOR')], listarMisVehiculos);
router.put('/mis-vehiculos/:id', [verificarToken, requireRol('CONDUCTOR')], actualizarVehiculo);
router.delete('/mis-vehiculos/:id', [verificarToken, requireRol('CONDUCTOR')], eliminarVehiculo);
router.post('/mis-vehiculos/:id/condiciones/:condicion', [verificarToken, requireRol('CONDUCTOR')], agregarCondicion);
router.delete('/mis-vehiculos/:id/condiciones/:condicion', [verificarToken, requireRol('CONDUCTOR')], quitarCondicion);

export default router;
