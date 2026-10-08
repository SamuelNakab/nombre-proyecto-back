import { Router } from 'express';
import { verificarToken } from '../middlewares/auth.middleware.js';
import { requireMarketplace } from '../middlewares/flags.middleware.js';
import {
  registrarCliente,
  registrarConductor,
  registrarGerente,
  login,
  getMe,
  actualizarPerfil,
} from '../controllers/auth.controller.js';

const router = Router();

router.post('/registro-cliente', registrarCliente);
router.post('/registro-conductor', registrarConductor);
// El gerente es del marketplace: con el flag en false el registro queda cerrado.
router.post('/registro-gerente', requireMarketplace, registrarGerente);
router.post('/login', verificarToken, login);
router.get('/me', verificarToken, getMe);
router.put('/perfil', verificarToken, actualizarPerfil);

export default router;
