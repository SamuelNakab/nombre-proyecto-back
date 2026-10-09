import { Router } from 'express';
import { verificarToken, requireRol } from '../middlewares/auth.middleware.js';
import { misOrganizaciones, desvincularme } from '../controllers/choferes.controller.js';
import {
  listarViajesChoferHttp,
  obtenerViajeChoferHttp,
  confirmarViaje,
  rechazarViaje,
  iniciarViaje,
  salirDeParadaHttp,
  cancelarViajeChofer,
} from '../controllers/viajes-internos.controller.js';

const router = Router();

// Las PyMEs del chofer (cuenta CONDUCTOR). Router propio, aparte de
// /api/conductores (vehiculos), para no mezclar la identidad nueva con lo viejo.
router.use(verificarToken, requireRol('CONDUCTOR'));

router.get('/mis-organizaciones', misOrganizaciones);
router.delete('/mis-organizaciones/:id', desvincularme);

// Viajes INTERNOS del chofer (Paso 2), de TODAS sus PyMEs. Ciclo por parada
// (Paso 3): iniciar = llega a la 1, confirmar-parada (en /api/viajes/:id) =
// llega a la siguiente, salir = se va de la actual (la ultima finaliza).
router.get('/viajes', listarViajesChoferHttp);
router.get('/viajes/:id', obtenerViajeChoferHttp);
router.post('/viajes/:id/confirmar', confirmarViaje);
router.post('/viajes/:id/rechazar', rechazarViaje);
router.post('/viajes/:id/iniciar', iniciarViaje);
router.post('/viajes/:id/salir', salirDeParadaHttp);
router.post('/viajes/:id/cancelar', cancelarViajeChofer);

export default router;
