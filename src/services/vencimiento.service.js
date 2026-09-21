// Viajes VENCIDOS: los que llegaron a su fecha_programada sin haber avanzado.
//
// Un viaje en BUSCANDO_CONDUCTOR que nadie toma, o en CONDUCTOR_ASIGNADO que
// nadie inicia, se queda asi para siempre. DECISION DE PRODUCTO: NO se
// auto-cancela ni cambia de estado — quien decide cancelar es el cliente. Lo
// unico que hace este modulo es que el viaje deje de ser invisible.
//
// Dos canales, con jerarquia explicita:
//   - `vencido`, el flag calculado en el read (esViajeVencido). Es la fuente de
//     verdad DURABLE: se ve apenas el front carga sus viajes y sobrevive a
//     cualquier caida del proceso.
//   - `viaje:vencido`, el evento de socket. Es el aviso EN VIVO y es
//     BEST-EFFORT: si nadie esta conectado en ese instante se pierde, y esta
//     bien. El front NO debe depender solo del evento.
//
// El mecanismo de timers es el mismo patron que reserva.service.js (un
// setTimeout por viaje, cero pollers, barrido al arrancar). Ver las dos
// diferencias deliberadas mas abajo: el re-armado ante el overflow de
// setTimeout, y el barrido sin kill-switch.
import prisma from '../config/prisma.js';
import { INCLUDE_ACCESO_VIAJE } from './acceso-viaje.service.js';

// Estados en los que un viaje que ya paso su hora cuenta como VENCIDO. Es el
// criterio del flag Y el del evento: los dos salen de esta lista, asi no se
// pueden desincronizar.
export const ESTADOS_VENCIBLES = ['BUSCANDO_CONDUCTOR', 'CONDUCTOR_ASIGNADO'];

// Estados anteriores al inicio del viaje. Mientras el viaje este en uno de
// estos, su aviso sigue armado. Incluye RESERVADO_POR_EMPRESA aunque NO sea
// vencible: desde ahi el viaje puede volver a BUSCANDO_CONDUCTOR (timeout de la
// reserva, cancelar-reserva) antes de su hora, y en ese caso el aviso tiene que
// seguir vivo.
export const ESTADOS_PRE_INICIO = [...ESTADOS_VENCIBLES, 'RESERVADO_POR_EMPRESA'];

// ─── El flag ─────────────────────────────────────────────────────────────────

// true si el viaje llego a su fecha_programada sin avanzar. Se calcula en el
// READ, no se persiste — mismo criterio que calcularDuracionRealMinutos.
//
// Tira error si falta alguno de los dos campos, igual que
// calcularDuracionRealMinutos con `paradas` y que puedeVerViaje con sus
// relaciones: un `select` al que se le olvido `estado` o `fecha_programada`
// devolveria `vencido: false` en silencio, que es justo el bug que este helper
// viene a evitar. Preferimos que explote fuerte.
export function esViajeVencido(viaje) {
  if (viaje.estado === undefined || viaje.fecha_programada === undefined) {
    throw new Error(
      'esViajeVencido: el viaje debe traer estado y fecha_programada'
    );
  }

  if (!ESTADOS_VENCIBLES.includes(viaje.estado)) return false;

  return new Date(viaje.fecha_programada).getTime() < Date.now();
}

// ─── Timers de aviso por viaje ───────────────────────────────────────────────

// Mismo patron que los timers de reserva: UN setTimeout por viaje vivo, cero
// pollers, cero queries cuando no hay nada programado.
//
// A diferencia de las reservas, aca alcanza con UN SOLO timer por viaje, armado
// al crearlo: fecha_programada es INMUTABLE (el unico write en todo src/ es el
// create de crearViaje, no hay endpoint de reprogramacion), asi que el momento
// del aviso no se mueve nunca. Por eso no hay que reprogramar en cada camino que
// entra a un estado vencible, como si hacia falta con fecha_reserva.
//
// LIMITACION CONOCIDA, compartida con los timers de reserva: el Map vive en la
// memoria de UN proceso. Con mas de una instancia, una instancia solo conoce los
// viajes que ella misma creo. Hoy se corre una sola. El dia que se escale, esto
// se mueve a una cola persistente (BullMQ sobre el Redis que ya usamos).
const timers = new Map(); // id_viaje → Timeout

// setTimeout desborda arriba de 2^31-1 ms (~24.8 dias) y dispara de inmediato.
const MAX_DELAY_MS = 2 ** 31 - 1;

// Programa el aviso de vencimiento de un viaje para su fecha_programada.
// Idempotente: si ya habia un timer para ese viaje, lo reemplaza.
export function programarAvisoVencimiento(io, id_viaje, fechaProgramada) {
  cancelarAvisoVencimiento(id_viaje);

  const restante = new Date(fechaProgramada).getTime() - Date.now();
  const ms = Math.min(Math.max(0, restante), MAX_DELAY_MS);

  const handle = setTimeout(() => {
    timers.delete(id_viaje);
    avisarVencimiento(io, id_viaje).catch((e) =>
      console.error(`[viaje-vencido] viaje ${id_viaje}:`, e.message)
    );
  }, ms);

  timers.set(id_viaje, handle);
}

// Corta el aviso de un viaje que ya no puede vencer. Idempotente: si no hay
// timer (o el viaje nunca tuvo uno) no hace nada.
export function cancelarAvisoVencimiento(id_viaje) {
  const handle = timers.get(id_viaje);
  if (handle) {
    clearTimeout(handle);
    timers.delete(id_viaje);
  }
}

// Lo que corre cuando el timer dispara. RELEE el viaje de la DB en vez de
// confiar en lo que sabiamos al programarlo — ese chequeo es el equivalente al
// updateMany condicionado de liberarReserva: hace que un timer que sobrevivio de
// mas sea INOFENSIVO.
//
// DIFERENCIA DELIBERADA con el clamp de reserva.service: alla, clampear a
// MAX_DELAY_MS degrada a "muy tarde" y no rompe nada. Aca un viaje programado a
// mas de 24.8 dias dispararia ANTES de tiempo y emitiria un viaje:vencido FALSO.
// Por eso, si al disparar la fecha todavia no llego, el aviso se RE-ARMA por lo
// que reste en vez de emitir. El mismo guard cubre un reloj corrido.
//
// Exportada para poder testearla sin esperar al timer.
export async function avisarVencimiento(io, id_viaje) {
  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    select: {
      id_viaje: true,
      estado: true,
      fecha_programada: true,
      // Trae cliente.id_usuario, conductor.id_usuario y empresa.id_gerente, que
      // son exactamente los tres destinatarios. Se reusa el include del helper
      // de acceso en vez de escribir uno nuevo.
      ...INCLUDE_ACCESO_VIAJE,
    },
  });

  // El viaje se borro (no deberia pasar: nada lo hace hoy).
  if (!viaje) return false;

  // Todavia no le toca: re-armar por lo que reste (overflow de setTimeout o
  // reloj corrido). No se emite nada.
  const restante = viaje.fecha_programada.getTime() - Date.now();
  if (restante > 0) {
    programarAvisoVencimiento(io, id_viaje, viaje.fecha_programada);
    return false;
  }

  // El viaje avanzo o se cancelo antes de su hora: no se emite nada, y el timer
  // no se re-arma.
  if (!ESTADOS_VENCIBLES.includes(viaje.estado)) return false;

  const payload = {
    id_viaje: viaje.id_viaje,
    estado: viaje.estado,
    fecha_programada: viaje.fecha_programada,
  };

  if (io) {
    // Destinatarios, siempre al room personal usuario:{id_usuario}:
    //   BUSCANDO_CONDUCTOR         → cliente
    //   CONDUCTOR_ASIGNADO s/empresa → cliente + conductor
    //   CONDUCTOR_ASIGNADO c/empresa → cliente + conductor + gerente
    // El cliente siempre; el conductor y el gerente solo existen cuando el viaje
    // ya paso por CONDUCTOR_ASIGNADO / una reserva de empresa.
    io.to(`usuario:${viaje.cliente.id_usuario}`).emit('viaje:vencido', payload);

    // OJO: el room es por id_usuario del conductor, NO por id_conductor (mismo
    // cuidado que viaje:asignado).
    if (viaje.conductor) {
      io.to(`usuario:${viaje.conductor.id_usuario}`).emit('viaje:vencido', payload);
    }
    if (viaje.empresa) {
      io.to(`usuario:${viaje.empresa.id_gerente}`).emit('viaje:vencido', payload);
    }
  }

  console.log(`[viaje-vencido] viaje ${id_viaje} vencido en estado ${viaje.estado}`);
  return true;
}

// ─── Barrido de arranque ─────────────────────────────────────────────────────

// UNA sola consulta al levantar el server (no es un poller). Los timers viven en
// memoria, asi que un deploy los pierde: esto los reconstruye para los viajes
// cuya fecha_programada TODAVIA NO LLEGO, con el tiempo restante contado desde
// su fecha_programada.
//
// Los viajes cuya hora paso mientras el proceso estaba caido NO entran en la
// query y NO se avisan: emitir al arrancar seria tirar el evento al vacio
// (todavia no hay nadie conectado). Esos ya estan cubiertos por el flag
// `vencido`, que el cliente ve apenas reconecta y carga sus viajes.
//
// A diferencia de barridoInicialReservas, este NO lleva kill-switch de entorno:
// aquel ESCRIBE en la DB de Neon compartida con produccion (liberaba reservas
// reales), este solo LEE y arma timers en la memoria del proceso. Un server
// efimero de test que llegue a emitir viaje:vencido de un viaje real lo emite a
// sus propios rooms, y como no hay adapter de Redis en socket.io, nadie del lado
// de :3000 lo recibe.
export async function barridoInicialVencimientos(io) {
  const pendientes = await prisma.viaje.findMany({
    where: {
      estado: { in: ESTADOS_PRE_INICIO },
      fecha_programada: { gt: new Date() },
    },
    select: { id_viaje: true, fecha_programada: true },
  });

  for (const viaje of pendientes) {
    programarAvisoVencimiento(io, viaje.id_viaje, viaje.fecha_programada);
  }

  console.log(
    `[viaje-vencido] barrido de arranque: ${pendientes.length} viajes pre-inicio con aviso programado`
  );

  return { programados: pendientes.length };
}
