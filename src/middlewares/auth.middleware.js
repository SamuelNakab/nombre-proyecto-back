import admin from '../config/firebase.js';
import prisma from '../config/prisma.js';

export async function verificarToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const usuario = await prisma.usuario.findUnique({
      where: { firebase_uid: decoded.uid },
    });
    if (!usuario) {
      return res.status(404).json({ error: 'Usuario no registrado' });
    }
    req.usuario = usuario;
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalido o expirado' });
  }
}

export function requireRol(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.usuario.rol)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    next();
  };
}
