import { Router } from 'express';
import { verificarToken } from '../middlewares/auth.middleware.js';
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
router.post('/registro-gerente', registrarGerente);
router.post('/login', verificarToken, login);
router.get('/me', verificarToken, getMe);
router.put('/perfil', verificarToken, actualizarPerfil);

export default router;
