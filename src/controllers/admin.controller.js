import { z } from 'zod';
import prisma from '../config/prisma.js';
import { limpiarViajeActivo } from '../services/cancelacion.service.js';
import { io } from '../sockets/index.js';

// ─── Constantes ──────────────────────────────────────────────────────────────

const ROLES = ['CLIENTE', 'CONDUCTOR', 'GERENTE', 'ADMIN'];
const ESTADOS_VIAJE = [
  'BUSCANDO_CONDUCTOR',
  'CONDUCTOR_ASIGNADO',
  'EN_CAMINO_A_ORIGEN',
  'CARGANDO',
  'EN_RUTA',
  'DESCARGANDO',
  'FINALIZADO',
  'CANCELADO',
];
const ZONAS = ['CABA', 'PROVINCIA', 'MIXTO'];

// Porcentaje de fee de la app sobre cada viaje (entero, %). Default 10.
function feePorcentaje() {
  const raw = parseFloat(process.env.FEE_PORCENTAJE);
  return Number.isFinite(raw) ? raw : 10;
}

// Campos publicos del usuario (sin firebase_uid).
const USUARIO_PUBLICO = {
  id_usuario: true,
  nombre: true,
  apellido: true,
  dni: true,
  email: true,
  telefono: true,
  rol: true,
  fecha_registro: true,
};

// ─── Schemas de validacion de query params ───────────────────────────────────

const paginacion = {
  page: z.coerce.number().int().min(1).default(1),
  // limit se clampa a 200 como maximo (no es un error pedir mas, se topa).
  limit: z.coerce.number().int().min(1).default(50).transform((n) => Math.min(n, 200)),
};

const schemaUsuarios = z.object({
  rol: z.enum(ROLES).optional(),
  ...paginacion,
});

const fechaOpcional = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: 'Fecha invalida (usar ISO 8601)' })
  .optional();

const schemaViajes = z.object({
  estado: z.enum(ESTADOS_VIAJE).optional(),
  cantidad_paradas: z.coerce.number().int().min(0).optional(),
  zona: z.enum(ZONAS).optional(),
  desde: fechaOpcional,
  hasta: fechaOpcional,
  ...paginacion,
});

const schemaCancelar = z.object({
  motivo: z.string().optional(),
});

// ─── 1. GET /api/admin/usuarios ──────────────────────────────────────────────

export async function listarUsuarios(req, res) {
  const parsed = schemaUsuarios.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { rol, page, limit } = parsed.data;
  const where = rol ? { rol } : {};
  const skip = (page - 1) * limit;

  const [total, usuarios] = await Promise.all([
    prisma.usuario.count({ where }),
    prisma.usuario.findMany({
      where,
      select: {
        ...USUARIO_PUBLICO,
        cliente: true,
        conductor: true,
        empresas_gerente: true,
      },
      orderBy: { id_usuario: 'asc' },
      skip,
      take: limit,
    }),
  ]);

  return res.status(200).json({ total, page, limit, usuarios });
}

// ─── 2. GET /api/admin/usuarios/:id ──────────────────────────────────────────

export async function obtenerUsuario(req, res) {
  const id_usuario = Number(req.params.id);
  if (!Number.isInteger(id_usuario)) {
    return res.status(400).json({ error: 'id de usuario invalido' });
  }

  const base = await prisma.usuario.findUnique({
    where: { id_usuario },
    select: USUARIO_PUBLICO,
  });
  if (!base) {
    return res.status(404).json({ error: 'Usuario no encontrado' });
  }

  const detalle = { ...base };

  // Include condicional segun el rol. Un CLIENTE no tiene vehiculos ni licencia;
  // un CONDUCTOR si; un GERENTE tiene empresa(s). ADMIN: solo datos personales.
  if (base.rol === 'CLIENTE') {
    const cliente = await prisma.cliente.findUnique({
      where: { id_usuario },
      include: {
        viajes: {
          orderBy: { creado_en: 'desc' },
          include: { paradas: { orderBy: { orden: 'asc' } } },
        },
      },
    });
    detalle.cliente = cliente; // .viajes = historial de viajes creados
  } else if (base.rol === 'CONDUCTOR') {
    const conductor = await prisma.conductor.findUnique({
      where: { id_usuario },
      include: {
        vehiculos_propios: { include: { condiciones: true } },
        conductor_vehiculos: { include: { vehiculo: { include: { condiciones: true } } } },
        viajes: { orderBy: { creado_en: 'desc' } }, // historial de viajes aceptados
      },
    });
    if (conductor) {
      // vehiculos = propios + asignados via empresa, en un solo array plano.
      const vehiculos = [
        ...conductor.vehiculos_propios,
        ...conductor.conductor_vehiculos.map((cv) => cv.vehiculo),
      ];
      detalle.conductor = { ...conductor, vehiculos };
    } else {
      detalle.conductor = null;
    }
  } else if (base.rol === 'GERENTE') {
    // El gerente puede no tener empresa asociada todavia (MVP). Puede venir vacio.
    const empresas = await prisma.empresa.findMany({
      where: { id_gerente: id_usuario },
      include: {
        conductor_empresas: {
          include: {
            conductor: { include: { usuario: { select: { nombre: true, apellido: true } } } },
          },
        },
        vehiculos: { include: { condiciones: true } },
      },
    });
    detalle.empresas = empresas;
  }
  // ADMIN: no se agrega nada mas.

  return res.status(200).json(detalle);
}

// ─── 3. GET /api/admin/viajes ────────────────────────────────────────────────

const INCLUDE_VIAJE_LISTA = {
  cliente: { include: { usuario: { select: { nombre: true, apellido: true, email: true } } } },
  conductor: { include: { usuario: { select: { nombre: true, apellido: true } } } },
  _count: { select: { paradas: true } },
};

export async function listarViajes(req, res) {
  const parsed = schemaViajes.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { estado, cantidad_paradas, zona, desde, hasta, page, limit } = parsed.data;
  const skip = (page - 1) * limit;

  const where = {};
  if (estado) where.estado = estado;
  if (zona) where.zona = zona;
  if (desde || hasta) {
    where.creado_en = {};
    if (desde) where.creado_en.gte = new Date(desde);
    if (hasta) where.creado_en.lte = new Date(hasta);
  }

  // Prisma no soporta filtrar por conteo exacto de una relacion en el `where`.
  // Cuando se pide cantidad_paradas exacta, traemos los que matchean el resto de
  // filtros (con el _count de paradas) y filtramos + paginamos en memoria.
  if (cantidad_paradas !== undefined) {
    const todos = await prisma.viaje.findMany({
      where,
      include: INCLUDE_VIAJE_LISTA,
      orderBy: { creado_en: 'desc' },
    });
    const filtrados = todos.filter((v) => v._count.paradas === cantidad_paradas);
    const viajes = filtrados.slice(skip, skip + limit);
    return res.status(200).json({ total: filtrados.length, page, limit, viajes });
  }

  const [total, viajes] = await Promise.all([
    prisma.viaje.count({ where }),
    prisma.viaje.findMany({
      where,
      include: INCLUDE_VIAJE_LISTA,
      orderBy: { creado_en: 'desc' },
      skip,
      take: limit,
    }),
  ]);

  return res.status(200).json({ total, page, limit, viajes });
}

// ─── 4. GET /api/admin/viajes/:id ────────────────────────────────────────────

export async function obtenerViaje(req, res) {
  const id_viaje = Number(req.params.id);
  if (!Number.isInteger(id_viaje)) {
    return res.status(400).json({ error: 'id de viaje invalido' });
  }

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: {
      paradas: { orderBy: { orden: 'asc' } },
      condiciones_req: true,
      cliente: { include: { usuario: true } },
      conductor: { include: { usuario: true } },
      vehiculo: { include: { condiciones: true } },
      calificacion: true,
      cancelado_por_admin: { select: { id_usuario: true, nombre: true, apellido: true, email: true } },
    },
  });

  if (!viaje) {
    return res.status(404).json({ error: 'Viaje no encontrado' });
  }

  // Fee calculado sobre el precio real (solo tiene sentido si el viaje cobro).
  const fee =
    viaje.precio_real != null ? viaje.precio_real * (feePorcentaje() / 100) : null;

  // El remito solo existe para viajes finalizados.
  const remito_url =
    viaje.estado === 'FINALIZADO'
      ? `${process.env.R2_PUBLIC_URL}/remitos/${viaje.id_viaje}.pdf`
      : null;

  return res.status(200).json({ ...viaje, fee, remito_url });
}

// ─── 5. GET /api/admin/estadisticas ──────────────────────────────────────────

export async function obtenerEstadisticas(_req, res) {
  const desde30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const fee = feePorcentaje();

  const [
    totalUsuarios,
    porRolRaw,
    registradosUltimoMes,
    usuariosPorDia,
    totalViajes,
    porEstadoRaw,
    viajesPorDia,
    sumaAgg,
    topCondRaw,
    topCliRaw,
  ] = await Promise.all([
    prisma.usuario.count(),
    prisma.usuario.groupBy({ by: ['rol'], _count: { _all: true } }),
    prisma.usuario.count({ where: { fecha_registro: { gte: desde30 } } }),
    prisma.$queryRaw`
      SELECT to_char(date_trunc('day', fecha_registro), 'YYYY-MM-DD') AS fecha,
             count(*)::int AS cantidad
      FROM usuarios
      WHERE fecha_registro >= ${desde30}
      GROUP BY 1 ORDER BY 1`,
    prisma.viaje.count(),
    prisma.viaje.groupBy({ by: ['estado'], _count: { _all: true } }),
    prisma.$queryRaw`
      SELECT to_char(date_trunc('day', creado_en), 'YYYY-MM-DD') AS fecha,
             count(*)::int AS cantidad_creados,
             (count(*) FILTER (WHERE estado::text = 'FINALIZADO'))::int AS cantidad_finalizados
      FROM viajes
      WHERE creado_en >= ${desde30}
      GROUP BY 1 ORDER BY 1`,
    prisma.viaje.aggregate({ where: { estado: 'FINALIZADO' }, _sum: { precio_real: true } }),
    prisma.viaje.groupBy({
      by: ['id_conductor'],
      where: { estado: 'FINALIZADO', id_conductor: { not: null } },
      _sum: { precio_real: true },
      _count: { _all: true },
      orderBy: { _sum: { precio_real: 'desc' } },
      take: 10,
    }),
    prisma.viaje.groupBy({
      by: ['id_cliente'],
      where: { estado: 'FINALIZADO' },
      _sum: { precio_real: true },
      _count: { _all: true },
      orderBy: { _sum: { precio_real: 'desc' } },
      take: 10,
    }),
  ]);

  // usuarios.por_rol con todos los roles en cero por defecto
  const por_rol = { CLIENTE: 0, CONDUCTOR: 0, GERENTE: 0, ADMIN: 0 };
  for (const r of porRolRaw) por_rol[r.rol] = r._count._all;

  // viajes.por_estado con todos los estados en cero por defecto
  const por_estado = Object.fromEntries(ESTADOS_VIAJE.map((e) => [e, 0]));
  for (const r of porEstadoRaw) por_estado[r.estado] = r._count._all;

  const total_precio_real_finalizados = sumaAgg._sum.precio_real ?? 0;
  const total_fee_app = total_precio_real_finalizados * (fee / 100);
  const total_neto_conductores = total_precio_real_finalizados - total_fee_app;

  // Nombres para los tops (join a usuarios via conductor/cliente)
  const condIds = topCondRaw.map((t) => t.id_conductor);
  const cliIds = topCliRaw.map((t) => t.id_cliente);
  const [conductores, clientes] = await Promise.all([
    prisma.conductor.findMany({
      where: { id_conductor: { in: condIds } },
      include: { usuario: { select: { nombre: true, apellido: true } } },
    }),
    prisma.cliente.findMany({
      where: { id_cliente: { in: cliIds } },
      include: { usuario: { select: { nombre: true, apellido: true } } },
    }),
  ]);
  const mapCond = new Map(conductores.map((c) => [c.id_conductor, c.usuario]));
  const mapCli = new Map(clientes.map((c) => [c.id_cliente, c.usuario]));

  const top_conductores_por_ganancia = topCondRaw.map((t) => ({
    id_conductor: t.id_conductor,
    nombre: mapCond.get(t.id_conductor)?.nombre ?? null,
    apellido: mapCond.get(t.id_conductor)?.apellido ?? null,
    total_ganado: t._sum.precio_real ?? 0,
    cantidad_viajes: t._count._all,
  }));

  const top_clientes_por_gasto = topCliRaw.map((t) => ({
    id_cliente: t.id_cliente,
    nombre: mapCli.get(t.id_cliente)?.nombre ?? null,
    apellido: mapCli.get(t.id_cliente)?.apellido ?? null,
    total_gastado: t._sum.precio_real ?? 0,
    cantidad_viajes: t._count._all,
  }));

  return res.status(200).json({
    usuarios: {
      total: totalUsuarios,
      por_rol,
      registrados_ultimo_mes: registradosUltimoMes,
      registrados_por_dia_ultimos_30_dias: usuariosPorDia,
    },
    viajes: {
      total: totalViajes,
      por_estado,
      por_dia_ultimos_30_dias: viajesPorDia,
    },
    plata: {
      total_precio_real_finalizados,
      total_fee_app,
      total_neto_conductores,
      top_conductores_por_ganancia,
      top_clientes_por_gasto,
    },
  });
}

// ─── 6. POST /api/admin/viajes/:id/cancelar ──────────────────────────────────

export async function cancelarViaje(req, res) {
  const parsed = schemaCancelar.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const motivo = parsed.data.motivo ?? null;

  const id_viaje = Number(req.params.id);
  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: { cliente: { include: { usuario: { select: { id_usuario: true } } } } },
  });

  // 1. El viaje existe.
  if (!viaje) {
    return res.status(404).json({ error: 'Viaje no encontrado' });
  }

  // 2. No se puede cancelar un viaje ya terminal (FINALIZADO o CANCELADO).
  if (viaje.estado === 'FINALIZADO' || viaje.estado === 'CANCELADO') {
    return res.status(400).json({
      error: `No se puede cancelar un viaje en estado ${viaje.estado}`,
    });
  }

  const estadoAnterior = viaje.estado;

  // El viaje pasa a CANCELADO. Se guarda el motivo y quien lo cancelo. NO se
  // tocan id_conductor/id_vehiculo ni las paradas ya ENTREGADO (historial).
  await prisma.$transaction([
    prisma.viaje.update({
      where: { id_viaje },
      data: {
        estado: 'CANCELADO',
        motivo_cancelacion: motivo,
        cancelado_por_admin_id: req.usuario.id_usuario,
      },
    }),
  ]);

  // Si habia (o hubo) tracking activo — CONDUCTOR_ASIGNADO en adelante — cortar
  // el emisor de ETA y limpiar todas las keys gps:{id_viaje}:*. En
  // BUSCANDO_CONDUCTOR no hay nada que limpiar. limpiarViajeActivo es idempotente.
  if (estadoAnterior !== 'BUSCANDO_CONDUCTOR') {
    await limpiarViajeActivo(id_viaje);
  }

  // Notificar por WebSocket al room del viaje (conductor/cliente conectados) y al
  // room personal del cliente.
  if (io) {
    const payload = { id_viaje, motivo, estado: 'CANCELADO' };
    io.to(`viaje:${id_viaje}`).emit('viaje:cancelado_por_admin', payload);
    const idUsuarioCliente = viaje.cliente?.usuario?.id_usuario;
    if (idUsuarioCliente) {
      io.to(`usuario:${idUsuarioCliente}`).emit('viaje:cancelado_por_admin', payload);
    }
  }

  return res.status(200).json({
    mensaje: 'Viaje cancelado por admin',
    id_viaje,
    estado: 'CANCELADO',
    motivo,
  });
}
