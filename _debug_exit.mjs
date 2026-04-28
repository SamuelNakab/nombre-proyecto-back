process.on('exit', (code) => console.log('EXIT CODE:', code));
process.on('uncaughtException', (err) => console.error('UNCAUGHT:', err));
process.on('unhandledRejection', (reason) => console.error('UNHANDLED REJECTION:', reason));

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import authRoutes from './src/routes/auth.routes.js';

const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);

const server = app.listen(3098, () => {
  console.log('Server listening on 3098');
});

server.on('error', (err) => console.error('Server error:', err));
server.on('close', () => console.log('Server closed!'));

// Keep alive check
setTimeout(() => {
  console.log('Still alive after 3 seconds');
}, 3000);
