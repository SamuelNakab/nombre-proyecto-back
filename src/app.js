import 'dotenv/config';
import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import authRoutes from './routes/auth.routes.js';
import viajesRoutes from './routes/viajes.routes.js';
import conductoresRoutes from './routes/conductores.routes.js';
import empresasRoutes from './routes/empresas.routes.js';
import afiliacionesRoutes from './routes/afiliaciones.routes.js';
import adminRoutes from './routes/admin.routes.js';
import { inicializarSockets } from './sockets/index.js';
import { barridoInicialReservas } from './services/reserva.service.js';

const app = express();

app.use(express.json());
app.use(cors());
app.use(helmet());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

app.use('/api/auth', authRoutes);
app.use('/api/viajes', viajesRoutes);
app.use('/api/conductores', conductoresRoutes);
app.use('/api/empresas', empresasRoutes);
app.use('/api/afiliaciones', afiliacionesRoutes);
app.use('/api/admin', adminRoutes);

const httpServer = createServer(app);
const io = inicializarSockets(httpServer);

// Barrido UNICO al arrancar (NO hay poller): reconstruye los timers de las
// reservas vivas y libera las que vencieron mientras el proceso estaba caido.
// Ver programarTimeoutReserva en reserva.service.js — el timeout de cada reserva
// es un setTimeout propio, no un setInterval que pollea la DB.
//
// RESERVA_BARRIDO_ARRANQUE=0 lo desactiva. Existe SOLO para los tests: la DB de
// Neon esta compartida con produccion, asi que un server efimero levantado con
// RESERVA_TIMEOUT_MINUTOS=0.1 (6 segundos) barreria al arrancar TODA reserva de
// mas de 6 segundos, incluidas las reales. En produccion no se setea nunca.
if (process.env.RESERVA_BARRIDO_ARRANQUE === '0') {
  console.log('[reserva-timeout] barrido de arranque DESACTIVADO (RESERVA_BARRIDO_ARRANQUE=0)');
} else {
  barridoInicialReservas(io).catch((e) =>
    console.error('[reserva-timeout] barrido de arranque fallo:', e.message)
  );
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
  console.log(`Socket.io escuchando en el puerto ${PORT}`);
});
