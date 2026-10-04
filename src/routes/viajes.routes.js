import { Router } from 'express';
import { verificarToken, requireRol } from '../middlewares/auth.middleware.js';
import { requireMarketplace, requireCalificaciones } from '../middlewares/flags.middleware.js';
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

// requireMarketplace / requireCalificaciones van ANTES de verificarToken: con el
// flag en false la ruta da 404 con o sin token. Lo que NO tiene flag sirve a
// los viajes legacy que sigan vivos (listar, cancelar, iniciar, avanzar,
// confirmar paradas, costo, remito, detalle) o es compartido con el ciclo
// interno (PATCH /estado, confirmar-parada, estimar-costo).
router.post('/estimar-costo', verificarToken, requireRol('CLIENTE'), estimarCosto);
// Crear por la ruta vieja del cliente: el viaje nuevo se crea en
// POST /api/organizaciones/:id/viajes.
router.post('/', requireMarketplace, verificarToken, requireRol('CLIENTE'), crearViaje);
router.get('/disponibles', requireMarketplace, verificarToken, requireRol('CONDUCTOR'), listarViajesDisponibles);
router.get('/mis-viajes', verificarToken, requireRol('CLIENTE'), listarMisViajes);
router.get('/mis-viajes-conductor', verificarToken, requireRol('CONDUCTOR'), listarMisViajesConductor);
router.get('/asignados', verificarToken, requireRol('CONDUCTOR'), listarViajesAsignados);
router.patch('/:id/estado', verificarToken, requireRol('CONDUCTOR'), cambiarEstado);
// Iniciar lo puede disparar el conductor asignado O el gerente de la empresa.
router.post('/:id/iniciar', verificarToken, requireRol('CONDUCTOR', 'GERENTE'), iniciarViaje);
router.post('/:id/cancelar-conductor', verificarToken, requireRol('CONDUCTOR'), cancelarViajeConductor);
router.post('/:id/cancelar-cliente', verificarToken, requireRol('CLIENTE'), cancelarViajeCliente);
// Reserva y asignacion por parte del gerente de una empresa.
router.post('/:id/reservar', requireMarketplace, verificarToken, requireRol('GERENTE'), reservarViaje);
router.post('/:id/asignar', requireMarketplace, verificarToken, requireRol('GERENTE'), asignarViaje);
router.post('/:id/reasignar', requireMarketplace, verificarToken, requireRol('GERENTE'), reasignarViaje);
router.post('/:id/cancelar-reserva', requireMarketplace, verificarToken, requireRol('GERENTE'), cancelarReserva);
router.get('/:id/costo-acumulado', verificarToken, obtenerCostoAcumulado);
router.post('/:id/confirmar-parada', verificarToken, requireRol('CONDUCTOR'), confirmarParada);
router.post('/:id/calificacion', requireCalificaciones, verificarToken, requireRol('CLIENTE'), calificarViaje);
router.get('/:id/remito', verificarToken, obtenerRemito);
router.get('/:id', verificarToken, obtenerViaje);

export default router;
