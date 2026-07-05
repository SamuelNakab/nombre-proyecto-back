import 'dotenv/config';
import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import authRoutes from './routes/auth.routes.js';
import viajesRoutes from './routes/viajes.routes.js';
import conductoresRoutes from './routes/conductores.routes.js';
import adminRoutes from './routes/admin.routes.js';
import { inicializarSockets } from './sockets/index.js';

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
app.use('/api/admin', adminRoutes);

const httpServer = createServer(app);
inicializarSockets(httpServer);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
  console.log(`Socket.io escuchando en el puerto ${PORT}`);
});
