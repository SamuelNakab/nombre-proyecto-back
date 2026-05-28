import { z } from 'zod';
import prisma from '../config/prisma.js';

const TIPOS_CONDICION = ['FRAGIL', 'REFRIGERADO', 'CARGA_PESADA', 'PELIGROSO', 'VOLUMINOSO'];

const schemaRegistrar = z.object({
  patente: z.string().min(6).max(8),
  marca: z.string().min(1),
  modelo: z.string().min(1),
  anio: z.number().int().min(1990).max(new Date().getFullYear()),
  color: z.string().min(1),
  tipo_vehiculo: z.string().min(1),
  condiciones: z.array(z.enum(TIPOS_CONDICION)).optional().default([]),
});

const schemaActualizar = z.object({
  marca: z.string().min(1).optional(),
  modelo: z.string().min(1).optional(),
  anio: z.number().int().min(1990).max(new Date().getFullYear()).optional(),
  color: z.string().min(1).optional(),
  tipo_vehiculo: z.string().min(1).optional(),
});

async function getConductor(id_usuario) {
  return prisma.conductor.findUnique({ where: { id_usuario } });
}

export async function registrarVehiculo(req, res) {
  const parsed = schemaRegistrar.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const conductor = await getConductor(req.usuario.id_usuario);
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const { patente, marca, modelo, anio, color, tipo_vehiculo, condiciones } = parsed.data;

  const existe = await prisma.vehiculo.findUnique({ where: { patente } });
  if (existe) {
    return res.status(409).json({ error: 'La patente ya esta registrada' });
  }

  const vehiculo = await prisma.vehiculo.create({
    data: {
      id_conductor: conductor.id_conductor,
      patente,
      marca,
      modelo,
      anio,
      color,
      tipo_vehiculo,
      condiciones: {
        create: condiciones.map((c) => ({ condicion: c })),
      },
    },
    include: { condiciones: true },
  });

  return res.status(201).json(vehiculo);
}

export async function listarMisVehiculos(req, res) {
  const conductor = await getConductor(req.usuario.id_usuario);
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const vehiculos = await prisma.vehiculo.findMany({
    where: { id_conductor: conductor.id_conductor },
    include: { condiciones: true },
  });

  return res.status(200).json(vehiculos);
}

export async function actualizarVehiculo(req, res) {
  const parsed = schemaActualizar.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const conductor = await getConductor(req.usuario.id_usuario);
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const id_vehiculo = parseInt(req.params.id);
  const vehiculo = await prisma.vehiculo.findUnique({ where: { id_vehiculo } });
  if (!vehiculo) {
    return res.status(404).json({ error: 'Vehiculo no encontrado' });
  }

  if (vehiculo.id_conductor !== conductor.id_conductor) {
    return res.status(403).json({ error: 'Este vehiculo no te pertenece' });
  }

  const actualizado = await prisma.vehiculo.update({
    where: { id_vehiculo },
    data: parsed.data,
    include: { condiciones: true },
  });

  return res.status(200).json(actualizado);
}

export async function eliminarVehiculo(req, res) {
  const conductor = await getConductor(req.usuario.id_usuario);
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const id_vehiculo = parseInt(req.params.id);
  const vehiculo = await prisma.vehiculo.findUnique({ where: { id_vehiculo } });
  if (!vehiculo) {
    return res.status(404).json({ error: 'Vehiculo no encontrado' });
  }

  if (vehiculo.id_conductor !== conductor.id_conductor) {
    return res.status(403).json({ error: 'Este vehiculo no te pertenece' });
  }

  const viajeActivo = await prisma.viaje.findFirst({
    where: {
      id_vehiculo,
      estado: { notIn: ['FINALIZADO', 'CANCELADO'] },
    },
  });
  if (viajeActivo) {
    return res.status(400).json({ error: 'No se puede eliminar un vehiculo en uso' });
  }

  await prisma.condicionVehiculo.deleteMany({ where: { id_vehiculo } });
  await prisma.vehiculo.delete({ where: { id_vehiculo } });

  return res.status(200).json({ mensaje: 'Vehiculo eliminado' });
}

export async function agregarCondicion(req, res) {
  const condicion = req.params.condicion;
  if (!TIPOS_CONDICION.includes(condicion)) {
    return res.status(400).json({ error: 'Condicion invalida' });
  }

  const conductor = await getConductor(req.usuario.id_usuario);
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const id_vehiculo = parseInt(req.params.id);
  const vehiculo = await prisma.vehiculo.findUnique({
    where: { id_vehiculo },
    include: { condiciones: true },
  });
  if (!vehiculo) {
    return res.status(404).json({ error: 'Vehiculo no encontrado' });
  }

  if (vehiculo.id_conductor !== conductor.id_conductor) {
    return res.status(403).json({ error: 'Este vehiculo no te pertenece' });
  }

  const yaExiste = vehiculo.condiciones.some((c) => c.condicion === condicion);
  if (yaExiste) {
    return res.status(409).json({ error: 'El vehiculo ya tiene esa condicion' });
  }

  await prisma.condicionVehiculo.create({ data: { id_vehiculo, condicion } });

  const actualizado = await prisma.vehiculo.findUnique({
    where: { id_vehiculo },
    include: { condiciones: true },
  });

  return res.status(201).json(actualizado);
}

export async function quitarCondicion(req, res) {
  const condicion = req.params.condicion;
  if (!TIPOS_CONDICION.includes(condicion)) {
    return res.status(400).json({ error: 'Condicion invalida' });
  }

  const conductor = await getConductor(req.usuario.id_usuario);
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const id_vehiculo = parseInt(req.params.id);
  const vehiculo = await prisma.vehiculo.findUnique({ where: { id_vehiculo } });
  if (!vehiculo) {
    return res.status(404).json({ error: 'Vehiculo no encontrado' });
  }

  if (vehiculo.id_conductor !== conductor.id_conductor) {
    return res.status(403).json({ error: 'Este vehiculo no te pertenece' });
  }

  await prisma.condicionVehiculo.deleteMany({ where: { id_vehiculo, condicion } });

  const actualizado = await prisma.vehiculo.findUnique({
    where: { id_vehiculo },
    include: { condiciones: true },
  });

  return res.status(200).json(actualizado);
}
