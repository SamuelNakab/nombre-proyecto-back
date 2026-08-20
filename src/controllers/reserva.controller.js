import { z } from 'zod';
import prisma from '../config/prisma.js';
import { validarTransicion } from '../services/estado-viaje.service.js';
import {
  validarConductorYVehiculo,
  liberarReserva,
  programarTimeoutReserva,
  cancelarTimeoutReserva,
} from '../services/reserva.service.js';
import { io } from '../sockets/index.js';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const schemaReservar = z.object({
  // Opcional: si el gerente tiene una sola empresa se infiere.
  id_empresa: z.number().int().positive().optional(),
});

const schemaAsignar = z.object({
  id_conductor: z.number().int().positive(),
  id_vehiculo: z.number().int().positive(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function idParam(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Resuelve con que empresa opera el gerente al reservar. Si viene id_empresa lo
// valida (debe ser suya); si no viene y tiene una sola empresa, usa esa.
async function resolverEmpresaGerente(id_usuario, idEmpresaBody) {
  const empresas = await prisma.empresa.findMany({
    where: { id_gerente: id_usuario },
    select: { id_empresa: true },
  });
  if (empresas.length === 0) {
    return { status: 400, error: 'No tenes una empresa registrada' };
  }
  if (idEmpresaBody != null) {
    if (!empresas.some((e) => e.id_empresa === idEmpresaBody)) {
      return { status: 403, error: 'Esa empresa no es tuya' };
    }
    return { id_empresa: idEmpresaBody };
  }
  if (empresas.length > 1) {
    return { status: 400, error: 'Especifica id_empresa: tenes mas de una empresa' };
  }
  return { id_empresa: empresas[0].id_empresa };
}

// Verifica que el usuario sea el gerente de la empresa del viaje.
async function verificarGerenteDeEmpresa(id_empresa, id_usuario) {
  if (id_empresa == null) {
    return { status: 400, error: 'El viaje no tiene empresa asociada' };
  }
  const empresa = await prisma.empresa.findUnique({ where: { id_empresa } });
  if (!empresa) return { status: 404, error: 'Empresa no encontrada' };
  if (empresa.id_gerente !== id_usuario) {
    return { status: 403, error: 'No sos el gerente de la empresa de este viaje' };
  }
  return { empresa };
}

// Efectos post-asignacion, compartidos por asignar y reasignar: avisar al
// conductor en su room personal y sumar al gerente al room del viaje para que
// reciba tracking (mapa:actualizar / eta:actualizar) igual que el cliente.
function notificarAsignacion(gerenteIdUsuario, viaje, conductor, vehiculo) {
  if (!io) return;

  io.to(`usuario:${conductor.usuario.id_usuario}`).emit('viaje:asignado', {
    id_viaje: viaje.id_viaje,
    id_empresa: viaje.id_empresa,
    fecha_programada: viaje.fecha_programada,
    vehiculo: {
      id_vehiculo: vehiculo.id_vehiculo,
      patente: vehiculo.patente,
      marca: vehiculo.marca,
      modelo: vehiculo.modelo,
      tipo_vehiculo: vehiculo.tipo_vehiculo,
    },
    paradas: (viaje.paradas ?? []).map((p) => ({ orden: p.orden, direccion: p.direccion })),
  });

  io.in(`usuario:${gerenteIdUsuario}`).socketsJoin(`viaje:${viaje.id_viaje}`);
}

// ─── POST /api/viajes/:id/reservar ───────────────────────────────────────────

export async function reservarViaje(req, res) {
  const parsed = schemaReservar.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const id_viaje = idParam(req.params.id);
  if (!id_viaje) return res.status(400).json({ error: 'id de viaje invalido' });

  const empresaResuelta = await resolverEmpresaGerente(req.usuario.id_usuario, parsed.data.id_empresa);
  if (empresaResuelta.error) {
    return res.status(empresaResuelta.status).json({ error: empresaResuelta.error });
  }
  const { id_empresa } = empresaResuelta;

  const viaje = await prisma.viaje.findUnique({ where: { id_viaje } });
  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });

  try {
    validarTransicion(viaje.estado, 'RESERVADO_POR_EMPRESA');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Atomico (mismo patron que el aceptar): solo una reserva gana la fila que
  // todavia esta en BUSCANDO_CONDUCTOR; el resto matchea 0 filas.
  const resultado = await prisma.viaje.updateMany({
    where: { id_viaje, estado: 'BUSCANDO_CONDUCTOR' },
    data: { estado: 'RESERVADO_POR_EMPRESA', id_empresa, fecha_reserva: new Date() },
  });
  if (resultado.count === 0) {
    return res.status(409).json({ error: 'El viaje ya no esta disponible para reservar' });
  }

  // Timeout de la reserva: un setTimeout propio de ESTE viaje, programado recien
  // ahora que sabemos que la reserva se gano. Reemplaza al viejo job periodico
  // que polleaba la DB buscando vencidas.
  programarTimeoutReserva(io, id_viaje);

  // Sacar el viaje del pool del resto (conductores y otros gerentes del room).
  if (io) {
    io.to(`viaje:${id_viaje}`).emit('viaje:reservado', { id_viaje, id_empresa });
  }

  return res.status(200).json({
    mensaje: 'Viaje reservado',
    id_viaje,
    id_empresa,
    estado: 'RESERVADO_POR_EMPRESA',
  });
}

// ─── POST /api/viajes/:id/asignar ────────────────────────────────────────────

export async function asignarViaje(req, res) {
  const parsed = schemaAsignar.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const id_viaje = idParam(req.params.id);
  if (!id_viaje) return res.status(400).json({ error: 'id de viaje invalido' });

  const { id_conductor, id_vehiculo } = parsed.data;

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: { condiciones_req: true, paradas: { orderBy: { orden: 'asc' } } },
  });
  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (viaje.estado !== 'RESERVADO_POR_EMPRESA') {
    return res.status(400).json({
      error: `El viaje debe estar en RESERVADO_POR_EMPRESA, esta en ${viaje.estado}`,
    });
  }

  const duenio = await verificarGerenteDeEmpresa(viaje.id_empresa, req.usuario.id_usuario);
  if (duenio.error) return res.status(duenio.status).json({ error: duenio.error });

  const val = await validarConductorYVehiculo(viaje, id_conductor, id_vehiculo);
  if (!val.ok) return res.status(val.status).json({ error: val.error });

  try {
    validarTransicion(viaje.estado, 'CONDUCTOR_ASIGNADO');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Atomico, mismo patron que reservar y que el aceptar del conductor: el
  // WHERE compuesto (id + estado) hace que, de dos asignaciones concurrentes
  // sobre el mismo viaje reservado, solo una matchee la fila y la pase a
  // CONDUCTOR_ASIGNADO. Antes era un update plano sobre una lectura ya vieja:
  // un doble-submit escribia dos veces, el ultimo id_conductor/id_vehiculo
  // pisaba al primero, y los DOS conductores recibian viaje:asignado — uno de
  // ellos para un viaje que no tenia.
  const resultado = await prisma.viaje.updateMany({
    where: { id_viaje, estado: 'RESERVADO_POR_EMPRESA' },
    data: { estado: 'CONDUCTOR_ASIGNADO', id_conductor, id_vehiculo },
  });
  if (resultado.count === 0) {
    return res.status(409).json({ error: 'El viaje ya no esta en RESERVADO_POR_EMPRESA' });
  }

  // La reserva dejo de estar activa: el viaje ya tiene conductor. Sin esto, el
  // timer quedaria huerfano y dispararia sobre un viaje YA asignado (el
  // updateMany condicionado de liberarReserva lo frenaria igual, pero no
  // dependemos de eso: el camino correcto es cancelarlo).
  cancelarTimeoutReserva(id_viaje);

  notificarAsignacion(req.usuario.id_usuario, viaje, val.conductor, val.vehiculo);

  return res.status(200).json({
    mensaje: 'Conductor asignado',
    id_viaje,
    id_conductor,
    id_vehiculo,
    estado: 'CONDUCTOR_ASIGNADO',
  });
}

// ─── POST /api/viajes/:id/reasignar ──────────────────────────────────────────

export async function reasignarViaje(req, res) {
  const parsed = schemaAsignar.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const id_viaje = idParam(req.params.id);
  if (!id_viaje) return res.status(400).json({ error: 'id de viaje invalido' });

  const { id_conductor, id_vehiculo } = parsed.data;

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: { condiciones_req: true, paradas: { orderBy: { orden: 'asc' } } },
  });
  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (viaje.estado !== 'CONDUCTOR_ASIGNADO') {
    return res.status(400).json({
      error: `El viaje debe estar en CONDUCTOR_ASIGNADO, esta en ${viaje.estado}`,
    });
  }
  if (viaje.fecha_inicio !== null) {
    return res.status(400).json({ error: 'El viaje ya arranco, no se puede reasignar' });
  }

  const duenio = await verificarGerenteDeEmpresa(viaje.id_empresa, req.usuario.id_usuario);
  if (duenio.error) return res.status(duenio.status).json({ error: duenio.error });

  const val = await validarConductorYVehiculo(viaje, id_conductor, id_vehiculo);
  if (!val.ok) return res.status(val.status).json({ error: val.error });

  // No hay cambio de estado (sigue CONDUCTOR_ASIGNADO): es un swap de
  // conductor/vehiculo, por eso no pasa por validarTransicion.
  //
  // Mismo criterio atomico que asignar: las dos condiciones que se chequearon
  // sobre la lectura de arriba (estado y "todavia no arranco") viajan al WHERE
  // del UPDATE. Lo que cierra es la carrera contra POST /:id/iniciar — con el
  // update plano, entre el findUnique y el update el conductor podia apretar
  // "Iniciar viaje" y la reasignacion le cambiaba el conductor a un viaje ya en
  // curso. Ahora esa escritura matchea 0 filas y devuelve 409.
  //
  // Dos reasignaciones concurrentes con el MISMO body son idempotentes; con
  // bodies distintos sigue ganando la ultima (no hay un estado del que salir,
  // el viaje ya esta en CONDUCTOR_ASIGNADO), pero ambas son asignaciones
  // legitimas del mismo gerente y la fila queda consistente.
  const resultado = await prisma.viaje.updateMany({
    where: { id_viaje, estado: 'CONDUCTOR_ASIGNADO', fecha_inicio: null },
    data: { id_conductor, id_vehiculo },
  });
  if (resultado.count === 0) {
    return res
      .status(409)
      .json({ error: 'El viaje ya no se puede reasignar (cambio de estado o ya arranco)' });
  }

  notificarAsignacion(req.usuario.id_usuario, viaje, val.conductor, val.vehiculo);

  return res.status(200).json({
    mensaje: 'Viaje reasignado',
    id_viaje,
    id_conductor,
    id_vehiculo,
    estado: 'CONDUCTOR_ASIGNADO',
  });
}

// ─── POST /api/viajes/:id/cancelar-reserva ───────────────────────────────────

export async function cancelarReserva(req, res) {
  const id_viaje = idParam(req.params.id);
  if (!id_viaje) return res.status(400).json({ error: 'id de viaje invalido' });

  const viaje = await prisma.viaje.findUnique({ where: { id_viaje } });
  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (viaje.estado !== 'RESERVADO_POR_EMPRESA') {
    return res.status(400).json({
      error: `El viaje debe estar en RESERVADO_POR_EMPRESA, esta en ${viaje.estado}`,
    });
  }

  const duenio = await verificarGerenteDeEmpresa(viaje.id_empresa, req.usuario.id_usuario);
  if (duenio.error) return res.status(duenio.status).json({ error: duenio.error });

  // liberarReserva escribe con updateMany condicionado al estado. Si entre el
  // findUnique de arriba y la escritura el viaje salio de RESERVADO_POR_EMPRESA
  // (una asignacion concurrente del mismo gerente, tipicamente), devuelve false
  // y no toca nada. Antes era un update plano: esa carrera pisaba un viaje ya
  // asignado y lo mandaba de vuelta al mercado con conductor y todo.
  const liberado = await liberarReserva(io, id_viaje, viaje.estado);
  if (!liberado) {
    return res.status(409).json({ error: 'El viaje ya no esta en RESERVADO_POR_EMPRESA' });
  }

  return res.status(200).json({
    mensaje: 'Reserva cancelada, viaje devuelto al mercado',
    id_viaje,
    estado: 'BUSCANDO_CONDUCTOR',
  });
}
