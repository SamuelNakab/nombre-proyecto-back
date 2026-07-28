import prisma from '../config/prisma.js';
import { validarTransicion } from './estado-viaje.service.js';
import { limpiarViajeActivo } from './cancelacion.service.js';

// Minutos que una reserva puede quedar sin conductor asignado antes de volver
// sola al mercado. Default 10 si no esta en .env (mismo patron que el resto).
export function reservaTimeoutMinutos() {
  return parseInt(process.env.RESERVA_TIMEOUT_MINUTOS) || 10;
}

// ─── Validacion de asignacion ────────────────────────────────────────────────

// Valida que un conductor + vehiculo sean asignables a un viaje de empresa:
// - el conductor esta ACTIVO (vigente) en la empresa del viaje,
// - el vehiculo pertenece a la flota de esa empresa,
// - el vehiculo cumple TODAS las condiciones requeridas del viaje.
// El `viaje` debe venir con id_empresa y condiciones_req. Devuelve
// { ok: true, conductor, vehiculo } o { ok: false, status, error }.
export async function validarConductorYVehiculo(viaje, id_conductor, id_vehiculo) {
  const id_empresa = viaje.id_empresa;

  const afiliacion = await prisma.conductorEmpresa.findUnique({
    where: { id_conductor_id_empresa: { id_conductor, id_empresa } },
  });
  if (!afiliacion || afiliacion.fecha_baja !== null || afiliacion.estado !== 'ACTIVO') {
    return { ok: false, status: 400, error: 'El conductor no esta activo en esta empresa' };
  }

  const conductor = await prisma.conductor.findUnique({
    where: { id_conductor },
    include: { usuario: { select: { id_usuario: true, nombre: true, apellido: true } } },
  });
  if (!conductor) {
    return { ok: false, status: 404, error: 'Conductor no encontrado' };
  }

  const vehiculo = await prisma.vehiculo.findUnique({
    where: { id_vehiculo },
    include: { condiciones: true },
  });
  if (!vehiculo || vehiculo.id_empresa !== id_empresa) {
    return { ok: false, status: 400, error: 'El vehiculo no pertenece a la flota de esta empresa' };
  }

  const requeridas = viaje.condiciones_req.map((c) => c.condicion);
  const tiene = vehiculo.condiciones.map((c) => c.condicion);
  const cumple = requeridas.every((req) => tiene.includes(req));
  if (!cumple) {
    return { ok: false, status: 400, error: 'El vehiculo no cumple las condiciones requeridas del viaje' };
  }

  return { ok: true, conductor, vehiculo };
}

// ─── Liberar reserva ─────────────────────────────────────────────────────────

// Devuelve un viaje reservado al mercado abierto: RESERVADO_POR_EMPRESA ->
// BUSCANDO_CONDUCTOR, limpiando empresa/reserva/conductor/vehiculo y cortando
// tracking (ETA/GPS). Compartido por el endpoint cancelar-reserva y por el job
// de timeout.
export async function liberarReserva(io, id_viaje, estadoActual) {
  validarTransicion(estadoActual, 'BUSCANDO_CONDUCTOR');

  await prisma.viaje.update({
    where: { id_viaje },
    data: {
      estado: 'BUSCANDO_CONDUCTOR',
      id_empresa: null,
      fecha_reserva: null,
      id_conductor: null,
      id_vehiculo: null,
    },
  });

  // Idempotente: si estaba en RESERVADO_POR_EMPRESA no hay ETA/GPS activos, pero
  // limpiarViajeActivo no falla si no encuentra nada.
  await limpiarViajeActivo(id_viaje);

  if (io) {
    io.to(`viaje:${id_viaje}`).emit('viaje:reserva_cancelada', { id_viaje });
  }
}

// ─── Job de timeout de reservas ──────────────────────────────────────────────

const CHECK_INTERVAL_MS = 60 * 1000; // se revisa cada minuto
let jobHandle = null;

// Busca reservas vencidas (RESERVADO_POR_EMPRESA, sin arrancar, con
// fecha_reserva mas vieja que el timeout) y las libera al mercado.
async function liberarReservasVencidas(io) {
  const corte = new Date(Date.now() - reservaTimeoutMinutos() * 60 * 1000);

  const vencidas = await prisma.viaje.findMany({
    where: {
      estado: 'RESERVADO_POR_EMPRESA',
      fecha_inicio: null,
      fecha_reserva: { lt: corte },
    },
    select: { id_viaje: true, estado: true },
  });

  for (const viaje of vencidas) {
    await liberarReserva(io, viaje.id_viaje, viaje.estado);
    console.log(`[reserva-timeout] viaje ${viaje.id_viaje} liberado por timeout`);
  }
}

// Arranca el job periodico (idempotente). Mismo patron que el emisor de ETA:
// un setInterval que corre mientras vive el proceso.
export function iniciarJobTimeoutReservas(io) {
  if (jobHandle) return;

  jobHandle = setInterval(() => {
    liberarReservasVencidas(io).catch((e) => console.error('[reserva-timeout]', e.message));
  }, CHECK_INTERVAL_MS);

  console.log(
    `[reserva-timeout] job iniciado (revisa cada ${CHECK_INTERVAL_MS / 1000}s, timeout ${reservaTimeoutMinutos()} min)`
  );
}
