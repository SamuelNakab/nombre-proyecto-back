import { z } from 'zod';
import prisma from '../config/prisma.js';
import { generarCodigoUnico, ejecutarDesafiliacion } from '../services/afiliacion.service.js';

const TIPOS_CONDICION = ['FRAGIL', 'REFRIGERADO', 'CARGA_PESADA', 'PELIGROSO', 'VOLUMINOSO'];

// ─── Schemas ─────────────────────────────────────────────────────────────────

const schemaCrearEmpresa = z.object({
  nombre: z.string().min(1),
  cuit: z.string().refine((v) => v.replace(/\D/g, '').length === 11, {
    message: 'CUIT invalido (deben ser 11 digitos)',
  }),
});

const schemaVehiculoFlota = z.object({
  patente: z.string().min(6).max(8),
  marca: z.string().min(1),
  modelo: z.string().min(1),
  anio: z.number().int().min(1990).max(new Date().getFullYear()),
  color: z.string().min(1),
  tipo_vehiculo: z.string().min(1),
  condiciones: z.array(z.enum(TIPOS_CONDICION)).optional().default([]),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Parsea un :param numerico. Devuelve el entero positivo o null si es invalido.
function idParam(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Trae la empresa y verifica que el usuario autenticado sea su gerente.
// Devuelve { empresa } en exito, o { status, error } para cortar la request.
async function empresaDelGerente(id_empresa, id_usuario) {
  const empresa = await prisma.empresa.findUnique({ where: { id_empresa } });
  if (!empresa) return { status: 404, error: 'Empresa no encontrada' };
  if (empresa.id_gerente !== id_usuario) {
    return { status: 403, error: 'No sos el gerente de esta empresa' };
  }
  return { empresa };
}

// ─── Empresa ─────────────────────────────────────────────────────────────────

export async function crearEmpresa(req, res) {
  const parsed = schemaCrearEmpresa.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { nombre, cuit } = parsed.data;

  const existe = await prisma.empresa.findUnique({ where: { cuit } });
  if (existe) {
    return res.status(409).json({ error: 'Ya existe una empresa con ese CUIT' });
  }

  const codigo_afiliacion = await generarCodigoUnico();

  const empresa = await prisma.empresa.create({
    data: {
      nombre,
      cuit,
      codigo_afiliacion,
      id_gerente: req.usuario.id_usuario,
    },
  });

  return res.status(201).json(empresa);
}

export async function listarMisEmpresas(req, res) {
  const empresas = await prisma.empresa.findMany({
    where: { id_gerente: req.usuario.id_usuario },
    include: {
      _count: {
        select: {
          // Solo afiliaciones vigentes (no dadas de baja).
          conductor_empresas: { where: { fecha_baja: null } },
          vehiculos: true,
          viajes: true,
        },
      },
    },
    orderBy: { fecha_registro: 'desc' },
  });

  return res.status(200).json(empresas);
}

export async function obtenerEmpresa(req, res) {
  const id_empresa = idParam(req.params.id);
  if (!id_empresa) return res.status(400).json({ error: 'id de empresa invalido' });

  const acceso = await empresaDelGerente(id_empresa, req.usuario.id_usuario);
  if (acceso.error) return res.status(acceso.status).json({ error: acceso.error });

  // calificacion_promedio = promedio del calificacion_promedio de los
  // conductores ACTIVOS (vigentes) que YA tienen al menos una calificacion
  // propia. Se calcula en el read, no se denormaliza. Los conductores sin
  // calificaciones NO cuentan (no arrastran un 0). Si ninguno tiene, es null.
  // Nota: Conductor.calificacion_promedio es Float @default(0) (nunca null),
  // asi que "tiene calificaciones" se detecta contando sus filas Calificacion.
  const activos = await prisma.conductorEmpresa.findMany({
    where: { id_empresa, estado: 'ACTIVO', fecha_baja: null },
    include: {
      conductor: {
        select: {
          calificacion_promedio: true,
          _count: { select: { calificaciones: true } },
        },
      },
    },
  });

  const calificados = activos.filter((ce) => ce.conductor._count.calificaciones > 0);
  const calificacion_promedio =
    calificados.length > 0
      ? calificados.reduce((sum, ce) => sum + ce.conductor.calificacion_promedio, 0) /
        calificados.length
      : null;

  return res.status(200).json({
    ...acceso.empresa,
    calificacion_promedio,
    cantidad_conductores_activos: activos.length,
  });
}

export async function regenerarCodigo(req, res) {
  const id_empresa = idParam(req.params.id);
  if (!id_empresa) return res.status(400).json({ error: 'id de empresa invalido' });

  const acceso = await empresaDelGerente(id_empresa, req.usuario.id_usuario);
  if (acceso.error) return res.status(acceso.status).json({ error: acceso.error });

  const codigo_afiliacion = await generarCodigoUnico();
  await prisma.empresa.update({
    where: { id_empresa },
    data: { codigo_afiliacion },
  });

  return res.status(200).json({ id_empresa, codigo_afiliacion });
}

// ─── Conductores de la empresa ───────────────────────────────────────────────

export async function listarConductores(req, res) {
  const id_empresa = idParam(req.params.id);
  if (!id_empresa) return res.status(400).json({ error: 'id de empresa invalido' });

  const acceso = await empresaDelGerente(id_empresa, req.usuario.id_usuario);
  if (acceso.error) return res.status(acceso.status).json({ error: acceso.error });

  // Vigentes (fecha_baja null), tanto ACTIVO como PENDIENTE.
  const conductores = await prisma.conductorEmpresa.findMany({
    where: { id_empresa, fecha_baja: null },
    include: {
      conductor: {
        include: {
          usuario: { select: { nombre: true, apellido: true, email: true, telefono: true } },
        },
      },
    },
    orderBy: { fecha_alta: 'desc' },
  });

  return res.status(200).json(conductores);
}

export async function aprobarConductor(req, res) {
  const id_empresa = idParam(req.params.id);
  const id_conductor = idParam(req.params.idc);
  if (!id_empresa || !id_conductor) {
    return res.status(400).json({ error: 'id invalido' });
  }

  const acceso = await empresaDelGerente(id_empresa, req.usuario.id_usuario);
  if (acceso.error) return res.status(acceso.status).json({ error: acceso.error });

  const afiliacion = await prisma.conductorEmpresa.findUnique({
    where: { id_conductor_id_empresa: { id_conductor, id_empresa } },
  });
  if (!afiliacion || afiliacion.fecha_baja !== null) {
    return res.status(404).json({ error: 'No hay una solicitud de afiliacion de ese conductor' });
  }
  if (afiliacion.estado === 'ACTIVO') {
    return res.status(409).json({ error: 'El conductor ya esta activo en la empresa' });
  }

  const actualizada = await prisma.conductorEmpresa.update({
    where: { id_conductor_id_empresa: { id_conductor, id_empresa } },
    data: { estado: 'ACTIVO' },
  });

  return res.status(200).json(actualizada);
}

export async function desafiliarConductor(req, res) {
  const id_empresa = idParam(req.params.id);
  const id_conductor = idParam(req.params.idc);
  if (!id_empresa || !id_conductor) {
    return res.status(400).json({ error: 'id invalido' });
  }

  const acceso = await empresaDelGerente(id_empresa, req.usuario.id_usuario);
  if (acceso.error) return res.status(acceso.status).json({ error: acceso.error });

  const afiliacion = await prisma.conductorEmpresa.findUnique({
    where: { id_conductor_id_empresa: { id_conductor, id_empresa } },
  });
  if (!afiliacion || afiliacion.fecha_baja !== null) {
    return res.status(404).json({ error: 'El conductor no esta afiliado a esta empresa' });
  }

  const resultado = await ejecutarDesafiliacion(id_conductor, id_empresa);
  if (!resultado.ok) {
    return res.status(400).json({ error: resultado.error });
  }

  return res.status(200).json({
    mensaje: 'Conductor desafiliado',
    viajes_devueltos: resultado.viajes_devueltos,
  });
}

// ─── Flota (vehiculos de la empresa) ─────────────────────────────────────────

export async function registrarVehiculoFlota(req, res) {
  const id_empresa = idParam(req.params.id);
  if (!id_empresa) return res.status(400).json({ error: 'id de empresa invalido' });

  const acceso = await empresaDelGerente(id_empresa, req.usuario.id_usuario);
  if (acceso.error) return res.status(acceso.status).json({ error: acceso.error });

  const parsed = schemaVehiculoFlota.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { patente, marca, modelo, anio, color, tipo_vehiculo, condiciones } = parsed.data;

  const existe = await prisma.vehiculo.findUnique({ where: { patente } });
  if (existe) {
    return res.status(409).json({ error: 'La patente ya esta registrada' });
  }

  const vehiculo = await prisma.vehiculo.create({
    data: {
      id_empresa,
      patente,
      marca,
      modelo,
      anio,
      color,
      tipo_vehiculo,
      condiciones: { create: condiciones.map((c) => ({ condicion: c })) },
    },
    include: { condiciones: true },
  });

  return res.status(201).json(vehiculo);
}

export async function listarFlota(req, res) {
  const id_empresa = idParam(req.params.id);
  if (!id_empresa) return res.status(400).json({ error: 'id de empresa invalido' });

  const acceso = await empresaDelGerente(id_empresa, req.usuario.id_usuario);
  if (acceso.error) return res.status(acceso.status).json({ error: acceso.error });

  const vehiculos = await prisma.vehiculo.findMany({
    where: { id_empresa },
    include: { condiciones: true },
  });

  return res.status(200).json(vehiculos);
}

export async function bajaVehiculoFlota(req, res) {
  const id_empresa = idParam(req.params.id);
  const id_vehiculo = idParam(req.params.idv);
  if (!id_empresa || !id_vehiculo) {
    return res.status(400).json({ error: 'id invalido' });
  }

  const acceso = await empresaDelGerente(id_empresa, req.usuario.id_usuario);
  if (acceso.error) return res.status(acceso.status).json({ error: acceso.error });

  const vehiculo = await prisma.vehiculo.findUnique({ where: { id_vehiculo } });
  if (!vehiculo || vehiculo.id_empresa !== id_empresa) {
    return res.status(404).json({ error: 'Vehiculo no encontrado en la flota de esta empresa' });
  }

  const viajeActivo = await prisma.viaje.findFirst({
    where: { id_vehiculo, estado: { notIn: ['FINALIZADO', 'CANCELADO'] } },
  });
  if (viajeActivo) {
    return res.status(400).json({ error: 'No se puede dar de baja un vehiculo en uso' });
  }

  await prisma.condicionVehiculo.deleteMany({ where: { id_vehiculo } });
  await prisma.vehiculo.delete({ where: { id_vehiculo } });

  return res.status(200).json({ mensaje: 'Vehiculo dado de baja' });
}

// ─── Viajes de la empresa ────────────────────────────────────────────────────

export async function listarViajesEmpresa(req, res) {
  const id_empresa = idParam(req.params.id);
  if (!id_empresa) return res.status(400).json({ error: 'id de empresa invalido' });

  const acceso = await empresaDelGerente(id_empresa, req.usuario.id_usuario);
  if (acceso.error) return res.status(acceso.status).json({ error: acceso.error });

  const viajes = await prisma.viaje.findMany({
    where: { id_empresa },
    include: {
      paradas: { orderBy: { orden: 'asc' } },
      cliente: { include: { usuario: { select: { nombre: true, apellido: true, telefono: true } } } },
      conductor: { include: { usuario: { select: { nombre: true, apellido: true, telefono: true } } } },
    },
    orderBy: { creado_en: 'desc' },
  });

  return res.status(200).json(viajes);
}
