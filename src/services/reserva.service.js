import prisma from '../config/prisma.js';
import { validarTransicion } from './estado-viaje.service.js';
import { limpiarViajeActivo } from './cancelacion.service.js';
import { publicarViajeAConductoresElegibles } from './matching.service.js';

// Minutos que una reserva puede quedar sin conductor asignado antes de volver
// sola al mercado. Default 10 si no esta en .env (mismo patron que el resto).
//
// parseFloat y NO parseInt: el valor tiene que admitir fraccionarios para que
// los tests puedan usar 0.1 (= 6 segundos) en vez de esperar minutos enteros.
// Con parseInt, '0.1' daba 0, que es falsy, y caia al default 10 en silencio.
// La guarda es la misma que feePorcentaje(): basura, negativo o 0 → default.
export function reservaTimeoutMinutos() {
  const raw = parseFloat(process.env.RESERVA_TIMEOUT_MINUTOS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
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
// BUSCANDO_CONDUCTOR, limpiando empresa/reserva/conductor/vehiculo, cortando
// tracking (ETA/GPS) y REPUBLICANDO el viaje de cero. Compartido por el endpoint
// cancelar-reserva, por el timer de la reserva y por el barrido de arranque.
//
// Devuelve true si REALMENTE libero el viaje, false si la fila ya no estaba en
// RESERVADO_POR_EMPRESA (otro camino se le adelanto). La escritura es un
// updateMany con el estado esperado en el WHERE, no un update plano sobre una
// lectura previa: ese es el guard que hace que un timer que dispara de mas
// (viaje ya asignado, ya cancelado, o reservado de nuevo despues) sea
// INOFENSIVO — matchea 0 filas, no toca nada y no republica.
export async function liberarReserva(io, id_viaje, estadoActual) {
  validarTransicion(estadoActual, 'BUSCANDO_CONDUCTOR');

  // El timer de esta reserva ya no aplica pase lo que pase: si la liberacion
  // gana, la reserva dejo de existir; si pierde, el viaje salio de
  // RESERVADO_POR_EMPRESA por otro camino y ese camino ya lo cancelo.
  cancelarTimeoutReserva(id_viaje);

  const resultado = await prisma.viaje.updateMany({
    where: { id_viaje, estado: 'RESERVADO_POR_EMPRESA' },
    data: {
      estado: 'BUSCANDO_CONDUCTOR',
      id_empresa: null,
      fecha_reserva: null,
      id_conductor: null,
      id_vehiculo: null,
    },
  });
  if (resultado.count === 0) return false;

  // Idempotente: si estaba en RESERVADO_POR_EMPRESA no hay ETA/GPS activos, pero
  // limpiarViajeActivo no falla si no encuentra nada.
  await limpiarViajeActivo(id_viaje);

  if (io) {
    // Avisar a quienes ya estan en el room que la reserva se cancelo.
    io.to(`viaje:${id_viaje}`).emit('viaje:reserva_cancelada', { id_viaje });

    // Republicar de cero reusando el MISMO flujo que la cancelacion de un
    // conductor independiente: re-corre la elegibilidad (conductores propios +
    // obtenerGerentesElegibles), suma a esa gente al room y emite
    // viaje:disponible. Asi, alguien que se conecto DESPUES de la reserva
    // original tambien recibe el viaje (no alcanza con cambiar el estado en DB).
    const viajeRepublicar = await prisma.viaje.findUnique({
      where: { id_viaje },
      include: {
        paradas: true,
        condiciones_req: true,
        cliente: { include: { usuario: { select: { id_usuario: true } } } },
      },
    });
    await publicarViajeAConductoresElegibles(
      io,
      viajeRepublicar,
      viajeRepublicar.cliente.usuario.id_usuario
    );
  }

  return true;
}

// ─── Timers de timeout por reserva ───────────────────────────────────────────

// Antes esto era un setInterval que cada RESERVA_CHECK_INTERVAL_MS pegaba un
// SELECT a la DB buscando reservas vencidas. Ese poller corria SIEMPRE, hubiera
// o no reservas, y mantenia despierta la base de Neon 24/7 (1440 queries por
// dia por instancia): se comio la cuota de CU-horas. Ahora hay UN setTimeout por
// reserva viva — cero reservas, cero timers, cero queries.
//
// LIMITACION CONOCIDA: los timers viven en la memoria de UN proceso. Si se corre
// mas de una instancia, cada una solo conoce las reservas que ella misma
// atendio; y un reinicio pierde los timers en vuelo. Lo segundo lo cubre el
// barrido de arranque (barridoInicialReservas); lo primero NO, y el dia que se
// escale a mas de una instancia hay que mover esto a una cola persistente
// (BullMQ sobre el Redis que ya usamos) en vez de setTimeout en memoria.

const timers = new Map(); // id_viaje → Timeout

// setTimeout desborda arriba de 2^31-1 ms (~24.8 dias) y dispara de inmediato.
// Con un RESERVA_TIMEOUT_MINUTOS absurdo eso liberaria toda reserva al instante,
// asi que clampeamos: degrada a "muy tarde" en vez de a "ya mismo".
const MAX_DELAY_MS = 2 ** 31 - 1;

// Programa la liberacion automatica de una reserva. `msRestantes` solo lo pasa
// el barrido de arranque (tiempo que le queda a una reserva que ya venia de
// antes); el resto de los callers programan el timeout completo.
// Idempotente: si ya habia un timer para ese viaje, lo reemplaza.
export function programarTimeoutReserva(io, id_viaje, msRestantes = null) {
  cancelarTimeoutReserva(id_viaje);

  const ms = Math.min(
    Math.max(0, msRestantes ?? reservaTimeoutMinutos() * 60 * 1000),
    MAX_DELAY_MS
  );

  const handle = setTimeout(() => {
    timers.delete(id_viaje);
    // El estado que le pasamos es el esperado, no uno leido: la verdad la pone
    // el WHERE del updateMany de liberarReserva. Si el viaje ya salio de
    // RESERVADO_POR_EMPRESA, devuelve false y no hace nada.
    liberarReserva(io, id_viaje, 'RESERVADO_POR_EMPRESA')
      .then((liberado) => {
        if (liberado) {
          console.log(`[reserva-timeout] viaje ${id_viaje} liberado por timeout`);
        }
      })
      .catch((e) => console.error(`[reserva-timeout] viaje ${id_viaje}:`, e.message));
  }, ms);

  timers.set(id_viaje, handle);
}

// Corta el timer de una reserva que dejo de estar activa. Idempotente: si no hay
// timer (o el viaje nunca estuvo reservado) no hace nada.
export function cancelarTimeoutReserva(id_viaje) {
  const handle = timers.get(id_viaje);
  if (handle) {
    clearTimeout(handle);
    timers.delete(id_viaje);
  }
}

// ─── Barrido de arranque ─────────────────────────────────────────────────────

// UNA sola consulta al levantar el server (no es un poller). Los timers viven en
// memoria, asi que un reinicio los pierde: esto reconstruye el estado.
// - Reserva ya vencida mientras el proceso estaba caido → se libera ahora.
// - Reserva todavia vigente → se le programa el timer por el tiempo RESTANTE,
//   contado desde su fecha_reserva, no desde el arranque (si no, cada deploy le
//   regalaria el timeout completo de nuevo).
// La liberacion es SECUENCIAL a proposito: cada una emite sockets y re-corre la
// elegibilidad, y no queremos una tormenta de queries justo en el arranque.
export async function barridoInicialReservas(io) {
  const reservadas = await prisma.viaje.findMany({
    where: { estado: 'RESERVADO_POR_EMPRESA', fecha_inicio: null },
    select: { id_viaje: true, fecha_reserva: true },
  });

  const timeoutMs = reservaTimeoutMinutos() * 60 * 1000;
  const ahora = Date.now();
  let liberadas = 0;
  let reprogramadas = 0;

  for (const viaje of reservadas) {
    // fecha_reserva null no deberia existir en RESERVADO_POR_EMPRESA; si pasa,
    // no hay ventana desde la cual contar y lo tratamos como vencido.
    const restante = viaje.fecha_reserva
      ? viaje.fecha_reserva.getTime() + timeoutMs - ahora
      : -1;

    if (restante <= 0) {
      if (await liberarReserva(io, viaje.id_viaje, 'RESERVADO_POR_EMPRESA')) liberadas++;
    } else {
      programarTimeoutReserva(io, viaje.id_viaje, restante);
      reprogramadas++;
    }
  }

  console.log(
    `[reserva-timeout] barrido de arranque: ${reservadas.length} reservas activas, ` +
      `${liberadas} liberadas por vencimiento, ${reprogramadas} con timer reprogramado ` +
      `(timeout ${reservaTimeoutMinutos()} min)`
  );

  return { encontradas: reservadas.length, liberadas, reprogramadas };
}
