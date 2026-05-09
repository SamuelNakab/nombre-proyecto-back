import admin from '../config/firebase.js';
import prisma from '../config/prisma.js';

export async function autenticarSocket(socket, next) {
  const raw = socket.handshake.auth?.token;
  if (!raw) {
    return next(new Error('Token no proporcionado'));
  }

  const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const usuario = await prisma.usuario.findUnique({
      where: { firebase_uid: decoded.uid },
    });
    if (!usuario) {
      return next(new Error('Usuario no registrado'));
    }
    socket.data.usuario = usuario;
    next();
  } catch {
    next(new Error('Token invalido'));
  }
}
