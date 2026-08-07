import { z } from 'zod';
import prisma from '../config/prisma.js';
import { ejecutarDesafiliacion } from '../services/afiliacion.service.js';

const schemaUnirse = z.object({
  codigo_afiliacion: z.string().min(1),
});

async function getConductor(id_usuario) {
  return prisma.conductor.findUnique({ where: { id_usuario } });
}

// POST /api/afiliaciones — el conductor ingresa el codigo de una empresa y queda
// como solicitud PENDIENTE hasta que el gerente lo apruebe.
export async function unirseAEmpresa(req, res) {
  const parsed = schemaUnirse.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const conductor = await getConductor(req.usuario.id_usuario);
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const codigo = parsed.data.codigo_afiliacion.trim().toUpperCase();
  const empresa = await prisma.empresa.findUnique({ where: { codigo_afiliacion: codigo } });
  if (!empresa) {
    return res.status(404).json({ error: 'Codigo de afiliacion invalido' });
  }
  if (!empresa.activa) {
    return res.status(400).json({ error: 'La empresa no esta activa' });
  }

  const existente = await prisma.conductorEmpresa.findUnique({
    where: {
      id_conductor_id_empresa: {
        id_conductor: conductor.id_conductor,
        id_empresa: empresa.id_empresa,
      },
    },
  });

  // Ya hay un vinculo vigente (no dado de baja): no se puede volver a solicitar.
  if (existente && existente.fecha_baja === null) {
    const msg =
      existente.estado === 'ACTIVO'
        ? 'Ya estas afiliado a esta empresa'
        : 'Ya tenes una solicitud pendiente en esta empresa';
    return res.status(409).json({ error: msg });
  }

  // Si existe pero estaba dado de baja, se reactiva como PENDIENTE (el
  // @@unique impide crear otra fila). Si no existe, se crea. En ambos casos
  // el resultado es una solicitud PENDIENTE.
  const afiliacion = existente
    ? await prisma.conductorEmpresa.update({
        where: { id_conductor_empresa: existente.id_conductor_empresa },
        data: { estado: 'PENDIENTE', fecha_alta: new Date(), fecha_baja: null },
      })
    : await prisma.conductorEmpresa.create({
        data: {
          id_conductor: conductor.id_conductor,
          id_empresa: empresa.id_empresa,
          estado: 'PENDIENTE',
        },
      });

  return res.status(201).json(afiliacion);
}

// GET /api/afiliaciones/mias — todas las afiliaciones vigentes del conductor con
// su estado (PENDIENTE o ACTIVO), para que el front arme la pantalla.
export async function listarMisAfiliaciones(req, res) {
  const conductor = await getConductor(req.usuario.id_usuario);
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const afiliaciones = await prisma.conductorEmpresa.findMany({
    where: { id_conductor: conductor.id_conductor, fecha_baja: null },
    include: {
      empresa: { select: { id_empresa: true, nombre: true, cuit: true, activa: true } },
    },
    orderBy: { fecha_alta: 'desc' },
  });

  return res.status(200).json(afiliaciones);
}

// DELETE /api/afiliaciones/:id — el conductor se va de una empresa. :id es el
// id_conductor_empresa de la afiliacion. Aplica las reglas de desafiliacion.
export async function salirDeEmpresa(req, res) {
  const id_afiliacion = Number(req.params.id);
  if (!Number.isInteger(id_afiliacion) || id_afiliacion <= 0) {
    return res.status(400).json({ error: 'id de afiliacion invalido' });
  }

  const conductor = await getConductor(req.usuario.id_usuario);
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const afiliacion = await prisma.conductorEmpresa.findUnique({
    where: { id_conductor_empresa: id_afiliacion },
  });
  if (!afiliacion || afiliacion.id_conductor !== conductor.id_conductor) {
    return res.status(404).json({ error: 'Afiliacion no encontrada' });
  }
  if (afiliacion.fecha_baja !== null) {
    return res.status(400).json({ error: 'Ya no estas afiliado a esta empresa' });
  }

  const resultado = await ejecutarDesafiliacion(afiliacion.id_conductor, afiliacion.id_empresa);
  if (!resultado.ok) {
    return res.status(400).json({ error: resultado.error });
  }

  return res.status(200).json({
    mensaje: 'Te desafiliaste de la empresa',
    viajes_devueltos: resultado.viajes_devueltos,
  });
}
