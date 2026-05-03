import { z } from 'zod';
import prisma from '../config/prisma.js';
import {
  estimarCosto as estimarCostoService,
} from '../services/costo.service.js';

// ─── Schemas de validacion ───────────────────────────────────────────────────

const CONDICIONES = ['FRAGIL', 'REFRIGERADO', 'CARGA_PESADA', 'PELIGROSO', 'VOLUMINOSO'];

const camposBase = {
  zona: z.enum(['CABA', 'PROVINCIA', 'MIXTO']),
  paradas: z
    .array(
      z.object({
        lat: z.number(),
        lng: z.number(),
        direccion: z.string().min(1),
      })
    )
    .min(2),
  tarifa_hora: z.number().positive().optional(),
  tarifa_km: z.number().positive().optional(),
};

function refineTarifas(data, ctx) {
  if (['CABA', 'MIXTO'].includes(data.zona) && data.tarifa_hora == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'tarifa_hora es requerida para zona CABA o MIXTO',
      path: ['tarifa_hora'],
    });
  }
  if (['PROVINCIA', 'MIXTO'].includes(data.zona) && data.tarifa_km == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'tarifa_km es requerida para zona PROVINCIA o MIXTO',
      path: ['tarifa_km'],
    });
  }
}

const schemaEstimar = z.object(camposBase).superRefine(refineTarifas);

const schemaCrear = z
  .object({
    ...camposBase,
    fecha_programada: z.string().refine(
      (val) => {
        const date = new Date(val);
        return !isNaN(date.getTime()) && date > new Date(Date.now() + 60 * 60 * 1000);
      },
      { message: 'fecha_programada debe ser una fecha ISO futura (al menos 1 hora desde ahora)' }
    ),
    condiciones_requeridas: z
      .array(z.enum(CONDICIONES))
      .optional()
      .default([]),
  })
  .superRefine(refineTarifas);

// ─── Helper de elegibilidad en memoria ──────────────────────────────────────

function conductorEsElegible(vehiculosConductor, condicionesViaje) {
  if (condicionesViaje.length === 0) return true;
  return vehiculosConductor.some((cv) => {
    const tiene = cv.vehiculo.condiciones.map((c) => c.condicion);
    return condicionesViaje.every((req) => tiene.includes(req));
  });
}

// ─── Controllers ─────────────────────────────────────────────────────────────

export async function estimarCosto(req, res) {
  const parsed = schemaEstimar.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { zona, paradas, tarifa_hora, tarifa_km } = parsed.data;

  try {
    const resultado = await estimarCostoService({ zona, paradas, tarifa_hora, tarifa_km });
    return res.status(200).json(resultado);
  } catch {
    return res.status(503).json({ error: 'No se pudo calcular la distancia' });
  }
}

export async function crearViaje(req, res) {
  const parsed = schemaCrear.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { zona, paradas, tarifa_hora, tarifa_km, fecha_programada, condiciones_requeridas } =
    parsed.data;

  const cliente = await prisma.cliente.findUnique({
    where: { id_usuario: req.usuario.id_usuario },
  });
  if (!cliente) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de cliente' });
  }

  let resultado;
  try {
    resultado = await estimarCostoService({ zona, paradas, tarifa_hora, tarifa_km });
  } catch {
    return res.status(503).json({ error: 'No se pudo calcular la distancia' });
  }

  const viaje = await prisma.viaje.create({
    data: {
      id_cliente: cliente.id_cliente,
      zona,
      tarifa_hora,
      tarifa_km,
      fecha_programada: new Date(fecha_programada),
      precio_estimado: resultado.precio_estimado,
      paradas: {
        create: paradas.map((p, i) => ({
          orden: i + 1,
          lat: p.lat,
          lng: p.lng,
          direccion: p.direccion,
        })),
      },
      condiciones_req: {
        create: condiciones_requeridas.map((condicion) => ({ condicion })),
      },
    },
    include: {
      paradas: true,
      condiciones_req: true,
    },
  });

  return res.status(201).json(viaje);
}

export async function listarViajesDisponibles(req, res) {
  const conductor = await prisma.conductor.findUnique({
    where: { id_usuario: req.usuario.id_usuario },
    include: {
      conductor_vehiculos: {
        include: {
          vehiculo: {
            include: { condiciones: true },
          },
        },
      },
    },
  });
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const viajes = await prisma.viaje.findMany({
    where: {
      estado: 'BUSCANDO_CONDUCTOR',
      fecha_programada: { gt: new Date() },
    },
    include: {
      paradas: true,
      condiciones_req: true,
      cliente: {
        include: {
          usuario: {
            select: { nombre: true, apellido: true, telefono: true },
          },
        },
      },
    },
    orderBy: { fecha_programada: 'asc' },
  });

  const viajesElegibles = viajes.filter((viaje) => {
    const condicionesViaje = viaje.condiciones_req.map((c) => c.condicion);
    return conductorEsElegible(conductor.conductor_vehiculos, condicionesViaje);
  });

  return res.status(200).json(viajesElegibles);
}

export async function obtenerViaje(req, res) {
  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje: Number(req.params.id) },
    include: {
      paradas: true,
      condiciones_req: true,
      cliente: { include: { usuario: true } },
      conductor: { include: { usuario: true } },
    },
  });

  if (!viaje) {
    return res.status(404).json({ error: 'Viaje no encontrado' });
  }

  const esCliente = viaje.cliente.id_usuario === req.usuario.id_usuario;
  const esConductor =
    viaje.conductor !== null && viaje.conductor.id_usuario === req.usuario.id_usuario;

  if (!esCliente && !esConductor) {
    return res.status(403).json({ error: 'Sin acceso a este viaje' });
  }

  return res.status(200).json(viaje);
}

export async function listarMisViajes(req, res) {
  const cliente = await prisma.cliente.findUnique({
    where: { id_usuario: req.usuario.id_usuario },
  });
  if (!cliente) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de cliente' });
  }

  const viajes = await prisma.viaje.findMany({
    where: { id_cliente: cliente.id_cliente },
    include: {
      paradas: true,
      conductor: { include: { usuario: true } },
    },
    orderBy: { creado_en: 'desc' },
  });

  return res.status(200).json(viajes);
}
