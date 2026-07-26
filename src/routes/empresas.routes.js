import { Router } from 'express';
import { verificarToken, requireRol } from '../middlewares/auth.middleware.js';
import {
  crearEmpresa,
  listarMisEmpresas,
  obtenerEmpresa,
  regenerarCodigo,
  listarConductores,
  aprobarConductor,
  desafiliarConductor,
  registrarVehiculoFlota,
  listarFlota,
  bajaVehiculoFlota,
  listarViajesEmpresa,
} from '../controllers/empresas.controller.js';

const router = Router();

// Todos los endpoints de empresa requieren token valido + rol GERENTE.
router.use(verificarToken, requireRol('GERENTE'));

// Las rutas concretas (/mias) van antes que /:id para que matcheen primero.
router.post('/', crearEmpresa);
router.get('/mias', listarMisEmpresas);
router.get('/:id', obtenerEmpresa);
router.post('/:id/regenerar-codigo', regenerarCodigo);
router.get('/:id/conductores', listarConductores);
router.post('/:id/conductores/:idc/aprobar', aprobarConductor);
router.delete('/:id/conductores/:idc', desafiliarConductor);
router.post('/:id/vehiculos', registrarVehiculoFlota);
router.get('/:id/vehiculos', listarFlota);
router.delete('/:id/vehiculos/:idv', bajaVehiculoFlota);
router.get('/:id/viajes', listarViajesEmpresa);

export default router;
