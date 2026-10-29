import admin from '../config/firebase.js';
import prisma from '../config/prisma.js';

export async function verificarToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  const token = authHeader.slice(7);
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch {
    return res.status(401).json({ error: 'Token invalido o expirado' });
  }

  // Fuera del try del token: un error de la base va al manejador global (503 /
  // 500 y Sentry). Antes salia como "Token invalido o expirado", una caida de la
  // DB disfrazada de 401.
  const usuario = await prisma.usuario.findUnique({
    where: { firebase_uid: decoded.uid },
  });
  if (!usuario) {
    return res.status(404).json({ error: 'Usuario no registrado' });
  }
  req.usuario = usuario;
  next();
}

export function requireRol(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.usuario.rol)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    next();
  };
}
