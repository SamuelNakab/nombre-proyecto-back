import 'dotenv/config';
// Sentry PRIMERO (despues de dotenv): no-op sin SENTRY_DSN. Ver config/sentry.js.
import { instalarManejadoresProceso, reportarError } from './config/sentry.js';
// Mensajes de validacion de Zod en español (customError global). Antes que las rutas.
import './services/errores-validacion.js';
import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { configurarCors } from './config/cors.js';
import { limitarGeneral } from './middlewares/rate-limit.middleware.js';
import { manejarErrores, rutaNoEncontrada } from './middlewares/errores.middleware.js';
import { saltosProxy } from './sockets/limite-handshake.js';
import authRoutes from './routes/auth.routes.js';
import viajesRoutes from './routes/viajes.routes.js';
import conductoresRoutes from './routes/conductores.routes.js';
import empresasRoutes from './routes/empresas.routes.js';
import afiliacionesRoutes from './routes/afiliaciones.routes.js';
import adminRoutes from './routes/admin.routes.js';
import organizacionesRoutes from './routes/organizaciones.routes.js';
import invitacionesRoutes from './routes/invitaciones.routes.js';
import choferesRoutes from './routes/choferes.routes.js';
import { inicializarSockets } from './sockets/index.js';
import { secretoInvitaciones } from './services/invitacion.service.js';
import { barridoInicialReservas } from './services/reserva.service.js';
import {
  barridoInicialVencimientos,
  barridoInicialVencimientosInternos,
} from './services/vencimiento.service.js';
import { marketplaceHabilitado } from './middlewares/flags.middleware.js';
import { barridoInicialCierres } from './services/cierre-automatico.service.js';

instalarManejadoresProceso();

const app = express();

// La IP real del cliente detras del proxy de Railway (TRUST_PROXY saltos, default
// 1: el proxy AGREGA la IP que vio al final de X-Forwarded-For). La usan el rate
// limit y el canje de codigos.
app.set('trust proxy', saltosProxy());

const corsConfig = configurarCors();

// API JSON: CSP que no permite cargar nada ni embeber la API en un iframe.
app.use(
  helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
  })
);
app.use(cors(corsConfig.express));

// `capacidades`: lo que este deploy sabe hacer. Lo usa el job e2e-staging de CI
// para esperar a que staging tenga el codigo nuevo antes de correr el e2e (una
// ruta nueva no sirve de sonda: todo /api/organizaciones/* da 401 sin token
// tambien en el codigo viejo). Para una capacidad futura: sumar el string aca y
// buscarlo en el poll de ci.yml.
const CAPACIDADES = ['viaje-interno'];

// /health NO toca la base (UptimeRobot lo consulta cada 5 minutos y Neon tiene que
// poder dormirse) y queda FUERA del rate limit. `version` = commit corto del deploy
// (Railway inyecta RAILWAY_GIT_COMMIT_SHA), `uptime_segundos` = del proceso.
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    capacidades: CAPACIDADES,
    version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || null,
    uptime_segundos: Math.round(process.uptime()),
  });
});

// Rate limit general por IP (despues de /health). Los estrictos van en las rutas.
app.use(limitarGeneral);
app.use(express.json({ limit: '100kb' }));

app.use('/api/auth', authRoutes);
app.use('/api/viajes', viajesRoutes);
app.use('/api/conductores', conductoresRoutes);
app.use('/api/empresas', empresasRoutes);
app.use('/api/afiliaciones', afiliacionesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/organizaciones', organizacionesRoutes);
app.use('/api/invitaciones', invitacionesRoutes);
app.use('/api/choferes', choferesRoutes);

// Ruta inexistente -> 404 JSON; y el manejador global: un input invalido nunca es
// un 500 (JSON mal formado, ids, errores de Prisma). Ver errores.middleware.js.
app.use(rutaNoEncontrada);
app.use(manejarErrores);

// Sin secreto el server arranca igual: solo los endpoints de invitaciones
// responden 503 (requireInvitacionesConfiguradas). Se avisa fuerte al arrancar.
if (!secretoInvitaciones()) {
  console.error('[invitaciones] INVITACION_SECRETO no configurado: los endpoints de invitaciones van a responder 503');
}

const httpServer = createServer(app);
const io = inicializarSockets(httpServer, { origenPermitido: corsConfig.permitido });

// Barrido UNICO al arrancar (NO hay poller): reconstruye los timers de las
// reservas vivas y libera las que vencieron mientras el proceso estaba caido.
// Ver programarTimeoutReserva en reserva.service.js — el timeout de cada reserva
// es un setTimeout propio, no un setInterval que pollea la DB.
//
// RESERVA_BARRIDO_ARRANQUE=0 lo desactiva. Existe SOLO para los tests: la DB de
// Neon esta compartida con produccion, asi que un server efimero levantado con
// RESERVA_TIMEOUT_MINUTOS=0.1 (6 segundos) barreria al arrancar TODA reserva de
// mas de 6 segundos, incluidas las reales. En produccion no se setea nunca.
// Con MARKETPLACE_HABILITADO en false tampoco corre: no hay reservas nuevas, y
// las que quedaran se liberarian al pool dormido.
if (process.env.RESERVA_BARRIDO_ARRANQUE === '0') {
  console.log('[reserva-timeout] barrido de arranque DESACTIVADO (RESERVA_BARRIDO_ARRANQUE=0)');
} else if (!marketplaceHabilitado()) {
  console.log('[reserva-timeout] barrido de arranque DESACTIVADO (MARKETPLACE_HABILITADO no esta en true)');
} else {
  barridoInicialReservas(io).catch((e) => {
    console.error('[reserva-timeout] barrido de arranque fallo:', e.message);
    reportarError(e, { contexto: 'barrido:reservas' });
  });
}

// Segundo barrido UNICO al arrancar, mismo patron que el de reservas: los
// avisos de vencimiento tambien son setTimeout en memoria y un deploy los
// pierde. Esto los reconstruye para los viajes cuya fecha_programada TODAVIA NO
// llego, con el tiempo restante contado desde esa fecha.
//
// Los que vencieron mientras el proceso estaba caido NO se avisan: emitir al
// arrancar seria tirar el evento al vacio (nadie conectado todavia). Esos los
// cubre el flag `vencido` del read. Ver vencimiento.service.js.
//
// A diferencia del de reservas, este NO lleva kill-switch: no escribe nada en la
// DB de Neon compartida con produccion, solo lee y arma timers en memoria.
barridoInicialVencimientos(io).catch((e) => {
  console.error('[viaje-vencido] barrido de arranque fallo:', e.message);
  reportarError(e, { contexto: 'barrido:vencimientos' });
});

// Tercer barrido UNICO: los viajes del ciclo INTERNO (Paso 2) en ASIGNADO o
// CONFIRMADO. Los que vencieron mientras el proceso estaba caido pasan a VENCIDO
// ahora; al resto se le arma el timer por el tiempo restante.
//
// ESTE si lleva kill-switch (VENCIMIENTO_BARRIDO_ARRANQUE=0, SOLO tests): a
// diferencia del aviso legacy, ESCRIBE en la DB compartida con produccion y arma
// timers con la VENTANA_INICIO_DESPUES_MINUTOS de ESTE proceso. Un server
// efimero de test con una ventana de segundos venceria viajes reales.
if (process.env.VENCIMIENTO_BARRIDO_ARRANQUE === '0') {
  console.log('[viaje-vencido] barrido de arranque del ciclo interno DESACTIVADO (VENCIMIENTO_BARRIDO_ARRANQUE=0)');
} else {
  barridoInicialVencimientosInternos(io).catch((e) => {
    console.error('[viaje-vencido] barrido de arranque del ciclo interno fallo:', e.message);
    reportarError(e, { contexto: 'barrido:vencimientos-internos' });
  });
}

// Cuarto barrido UNICO (Tarea 5): los viajes INTERNOS en curso. Los que pasaron
// su cierre automatico (fin del dia) mientras el proceso estaba caido se cierran
// ahora (FINALIZADO, completo o incompleto); al resto se le arman los timers.
//
// Lleva kill-switch (CIERRE_BARRIDO_ARRANQUE=0, SOLO tests): ESCRIBE en la DB
// compartida con produccion, y un server efimero con CIERRE_FIN_DIA_SEGUNDOS_TEST
// cerraria viajes reales. CIERRE_BARRIDO_ID_ORGANIZACION (SOLO tests) lo limita a
// una PyME: lo usa el test del barrido.
if (process.env.CIERRE_BARRIDO_ARRANQUE === '0') {
  console.log('[cierre-automatico] barrido de arranque DESACTIVADO (CIERRE_BARRIDO_ARRANQUE=0)');
} else {
  const idOrg = Number(process.env.CIERRE_BARRIDO_ID_ORGANIZACION);
  barridoInicialCierres(io, { id_organizacion: Number.isInteger(idOrg) && idOrg > 0 ? idOrg : null }).catch((e) => {
    console.error('[cierre-automatico] barrido de arranque fallo:', e.message);
    reportarError(e, { contexto: 'barrido:cierres' });
  });
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
  console.log(`Socket.io escuchando en el puerto ${PORT}`);
});
