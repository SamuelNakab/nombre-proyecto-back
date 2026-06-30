import { Router } from 'express';
import { verificarToken, requireRol } from '../middlewares/auth.middleware.js';
import {
  estimarCosto,
  crearViaje,
  listarViajesDisponibles,
  listarMisViajes,
  listarMisViajesConductor,
  obtenerViaje,
  cambiarEstado,
  cancelarViajeConductor,
  obtenerCostoAcumulado,
  obtenerQRParadas,
  confirmarParada,
  calificarViaje,
  obtenerRemito,
} from '../controllers/viajes.controller.js';

const router = Router();

router.post('/estimar-costo', verificarToken, requireRol('CLIENTE'), estimarCosto);
router.post('/', verificarToken, requireRol('CLIENTE'), crearViaje);
router.get('/disponibles', verificarToken, requireRol('CONDUCTOR'), listarViajesDisponibles);
router.get('/mis-viajes', verificarToken, requireRol('CLIENTE'), listarMisViajes);
router.get('/mis-viajes-conductor', verificarToken, requireRol('CONDUCTOR'), listarMisViajesConductor);
router.patch('/:id/estado', verificarToken, requireRol('CONDUCTOR'), cambiarEstado);
router.post('/:id/cancelar-conductor', verificarToken, requireRol('CONDUCTOR'), cancelarViajeConductor);
router.get('/:id/costo-acumulado', verificarToken, obtenerCostoAcumulado);
router.get('/:id/qr-paradas', verificarToken, requireRol('CLIENTE'), obtenerQRParadas);
router.post('/:id/confirmar-parada', verificarToken, requireRol('CONDUCTOR'), confirmarParada);
router.post('/:id/calificacion', verificarToken, requireRol('CLIENTE'), calificarViaje);
router.get('/:id/remito', verificarToken, obtenerRemito);
router.get('/:id', verificarToken, obtenerViaje);

export default router;
