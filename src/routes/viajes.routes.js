import { Router } from 'express';
import { verificarToken, requireRol } from '../middlewares/auth.middleware.js';
import {
  estimarCosto,
  crearViaje,
  listarViajesDisponibles,
  listarMisViajes,
  obtenerViaje,
  cambiarEstado,
  obtenerCostoAcumulado,
} from '../controllers/viajes.controller.js';

const router = Router();

router.post('/estimar-costo', verificarToken, requireRol('CLIENTE'), estimarCosto);
router.post('/', verificarToken, requireRol('CLIENTE'), crearViaje);
router.get('/disponibles', verificarToken, requireRol('CONDUCTOR'), listarViajesDisponibles);
router.get('/mis-viajes', verificarToken, requireRol('CLIENTE'), listarMisViajes);
router.patch('/:id/estado', verificarToken, requireRol('CONDUCTOR'), cambiarEstado);
router.get('/:id/costo-acumulado', verificarToken, obtenerCostoAcumulado);
router.get('/:id', verificarToken, obtenerViaje);

export default router;
