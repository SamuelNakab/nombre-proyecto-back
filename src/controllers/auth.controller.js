import { z } from 'zod';
import admin from '../config/firebase.js';
import prisma from '../config/prisma.js';

// ─── Schemas de validacion ───────────────────────────────────────────────────

const schemaBase = z.object({
  nombre: z.string().min(1),
  apellido: z.string().min(1),
  dni: z.string().min(7).max(9),
  email: z.string().email(),
  contrasena: z.string().min(6),
  telefono: z.string().optional(),
});

const schemaCliente = schemaBase.extend({
  cuit: z.string().optional(),
  nombre_empresa: z.string().optional(),
  direccion_principal: z.string().optional(),
});

const schemaConductor = schemaBase.extend({
  nro_licencia: z.string().min(1),
  licencia_vencimiento: z.string().datetime(),
});

const schemaGerente = schemaBase.extend({
  cuit_empresa: z.string().min(11).max(13),
  nombre_empresa: z.string().min(1),
});

const schemaActualizarPerfil = z.object({
  nombre: z.string().min(1).optional(),
  apellido: z.string().min(1).optional(),
  telefono: z.string().optional(),
});

// ─── Helper: crear usuario en Firebase con manejo de errores conocidos ───────

async function crearEnFirebase(email, contrasena) {
  try {
    return await admin.auth().createUser({ email, password: contrasena });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      return { conflicto: 'email' };
    }
    throw err;
  }
}

// ─── Helper: rollback Firebase si la DB falla ────────────────────────────────

async function rollbackFirebase(uid) {
  try {
    await admin.auth().deleteUser(uid);
  } catch {
    // rollback best-effort
  }
}

// ─── Controllers ─────────────────────────────────────────────────────────────

export async function registrarCliente(req, res) {
  const parsed = schemaCliente.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { nombre, apellido, dni, email, contrasena, telefono, cuit, nombre_empresa, direccion_principal } = parsed.data;

  const firebaseUser = await crearEnFirebase(email, contrasena);
  if (firebaseUser.conflicto === 'email') {
    return res.status(409).json({ error: 'El email ya esta registrado' });
  }

  try {
    const usuario = await prisma.usuario.create({
      data: {
        firebase_uid: firebaseUser.uid,
        nombre,
        apellido,
        dni,
        email,
        telefono,
        rol: 'CLIENTE',
        cliente: {
          create: { cuit, nombre_empresa, direccion_principal },
        },
      },
    });
    return res.status(201).json({ mensaje: 'Registrado correctamente', id_usuario: usuario.id_usuario });
  } catch (err) {
    await rollbackFirebase(firebaseUser.uid);
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'El DNI ya esta registrado' });
    }
    throw err;
  }
}

export async function registrarConductor(req, res) {
  const parsed = schemaConductor.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { nombre, apellido, dni, email, contrasena, telefono, nro_licencia, licencia_vencimiento } = parsed.data;

  const firebaseUser = await crearEnFirebase(email, contrasena);
  if (firebaseUser.conflicto === 'email') {
    return res.status(409).json({ error: 'El email ya esta registrado' });
  }

  try {
    const usuario = await prisma.usuario.create({
      data: {
        firebase_uid: firebaseUser.uid,
        nombre,
        apellido,
        dni,
        email,
        telefono,
        rol: 'CONDUCTOR',
        conductor: {
          create: {
            nro_licencia,
            licencia_vencimiento: new Date(licencia_vencimiento),
          },
        },
      },
    });
    return res.status(201).json({ mensaje: 'Registrado correctamente', id_usuario: usuario.id_usuario });
  } catch (err) {
    await rollbackFirebase(firebaseUser.uid);
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'El DNI ya esta registrado' });
    }
    throw err;
  }
}

export async function registrarGerente(req, res) {
  const parsed = schemaGerente.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { nombre, apellido, dni, email, contrasena, telefono, cuit_empresa, nombre_empresa } = parsed.data;

  const firebaseUser = await crearEnFirebase(email, contrasena);
  if (firebaseUser.conflicto === 'email') {
    return res.status(409).json({ error: 'El email ya esta registrado' });
  }

  try {
    const usuario = await prisma.usuario.create({
      data: {
        firebase_uid: firebaseUser.uid,
        nombre,
        apellido,
        dni,
        email,
        telefono,
        rol: 'GERENTE',
        empresas_gerente: {
          create: { cuit: cuit_empresa, nombre: nombre_empresa },
        },
      },
    });
    return res.status(201).json({ mensaje: 'Registrado correctamente', id_usuario: usuario.id_usuario });
  } catch (err) {
    await rollbackFirebase(firebaseUser.uid);
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'El DNI ya esta registrado' });
    }
    throw err;
  }
}

export function login(req, res) {
  const { id_usuario, nombre, apellido, email, rol } = req.usuario;
  return res.status(200).json({ id_usuario, nombre, apellido, email, rol });
}

export function getMe(req, res) {
  return res.status(200).json(req.usuario);
}

export async function actualizarPerfil(req, res) {
  const parsed = schemaActualizarPerfil.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const campos = Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => v !== undefined)
  );

  const usuario = await prisma.usuario.update({
    where: { id_usuario: req.usuario.id_usuario },
    data: campos,
  });
  return res.status(200).json(usuario);
}
