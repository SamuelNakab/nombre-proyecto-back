import { Router } from 'express';
import { verificarToken, requireRol } from '../middlewares/auth.middleware.js';
import {
  estimarCosto,
  crearViaje,
  listarViajesDisponibles,
  listarMisViajes,
  listarMisViajesConductor,
  listarViajesAsignados,
  obtenerViaje,
  cambiarEstado,
  iniciarViaje,
  cancelarViajeConductor,
  cancelarViajeCliente,
  obtenerCostoAcumulado,
  confirmarParada,
  calificarViaje,
  obtenerRemito,
} from '../controllers/viajes.controller.js';
import {
  reservarViaje,
  asignarViaje,
  reasignarViaje,
  cancelarReserva,
} from '../controllers/reserva.controller.js';

const router = Router();

router.post('/estimar-costo', verificarToken, requireRol('CLIENTE'), estimarCosto);
router.post('/', verificarToken, requireRol('CLIENTE'), crearViaje);
router.get('/disponibles', verificarToken, requireRol('CONDUCTOR'), listarViajesDisponibles);
router.get('/mis-viajes', verificarToken, requireRol('CLIENTE'), listarMisViajes);
router.get('/mis-viajes-conductor', verificarToken, requireRol('CONDUCTOR'), listarMisViajesConductor);
router.get('/asignados', verificarToken, requireRol('CONDUCTOR'), listarViajesAsignados);
router.patch('/:id/estado', verificarToken, requireRol('CONDUCTOR'), cambiarEstado);
// Iniciar lo puede disparar el conductor asignado O el gerente de la empresa.
router.post('/:id/iniciar', verificarToken, requireRol('CONDUCTOR', 'GERENTE'), iniciarViaje);
router.post('/:id/cancelar-conductor', verificarToken, requireRol('CONDUCTOR'), cancelarViajeConductor);
router.post('/:id/cancelar-cliente', verificarToken, requireRol('CLIENTE'), cancelarViajeCliente);
// Reserva y asignacion por parte del gerente de una empresa.
router.post('/:id/reservar', verificarToken, requireRol('GERENTE'), reservarViaje);
router.post('/:id/asignar', verificarToken, requireRol('GERENTE'), asignarViaje);
router.post('/:id/reasignar', verificarToken, requireRol('GERENTE'), reasignarViaje);
router.post('/:id/cancelar-reserva', verificarToken, requireRol('GERENTE'), cancelarReserva);
router.get('/:id/costo-acumulado', verificarToken, obtenerCostoAcumulado);
router.post('/:id/confirmar-parada', verificarToken, requireRol('CONDUCTOR'), confirmarParada);
router.post('/:id/calificacion', verificarToken, requireRol('CLIENTE'), calificarViaje);
router.get('/:id/remito', verificarToken, obtenerRemito);
router.get('/:id', verificarToken, obtenerViaje);

export default router;
