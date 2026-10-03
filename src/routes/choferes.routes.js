import { Router } from 'express';
import { verificarToken, requireRol } from '../middlewares/auth.middleware.js';
import { misOrganizaciones, desvincularme } from '../controllers/choferes.controller.js';

const router = Router();

// Las PyMEs del chofer (cuenta CONDUCTOR). Router propio, aparte de
// /api/conductores (vehiculos), para no mezclar la identidad nueva con lo viejo.
router.use(verificarToken, requireRol('CONDUCTOR'));

router.get('/mis-organizaciones', misOrganizaciones);
router.delete('/mis-organizaciones/:id', desvincularme);

export default router;
