import { Router } from 'express';
import { verificarToken, requireRol } from '../middlewares/auth.middleware.js';
import { requireInvitacionesConfiguradas } from '../middlewares/organizacion.middleware.js';
import { canjear } from '../controllers/invitaciones.controller.js';

const router = Router();

// Endpoint UNICO de canje: un CLIENTE canjea codigos de MIEMBRO y un CONDUCTOR
// codigos de CHOFER. El tipo cruzado es "Codigo invalido" (lo decide el servicio).
router.post('/canjear', verificarToken, requireRol('CLIENTE', 'CONDUCTOR'), requireInvitacionesConfiguradas, canjear);

export default router;
