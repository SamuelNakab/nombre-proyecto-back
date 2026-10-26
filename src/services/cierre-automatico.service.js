// CIERRE AUTOMATICO de los viajes internos en curso a fin del dia, y el aviso de
// "cierre manual habilitado" por tiempo (Tarea 5). SIN pollers (Neon
// scale-to-zero), mismo patron que vencimiento.service:
//   1. Timer por viaje (timers-cierre.js), armado al INICIAR el viaje (fin del
//      dia) y re-armado al llegar a la ULTIMA parada (puede correrse a la hora
//      prevista de fin + CIERRE_EXTENSION_MINUTOS). Al disparar RELEE la fila y se
//      re-arma si todavia no toca.
//   2. Barrido de arranque (barridoInicialCierres): UNA query. Cierra los
//      atrasados (secuencial) y arma los timers del resto.
//   3. Chequeo PEREZOSO (cerrarSiCorresponde) antes de las lecturas y acciones de
//      la PyME y del chofer, scopeado a lo suyo. El panel admin NO lo usa (mismo
//      criterio que el vencimiento: no escribe sobre viajes ajenos).
// Los tres terminan en cerrarViajeInterno(modo AUTOMATICO), cuyo updateMany
// condicionado hace que dispararse de mas, o dos a la vez, sea INOFENSIVO.
import prisma from '../config/prisma.js';
import { cerrarViajeInterno } from './cierre.service.js';
import { vencerSiCorresponde } from './vencimiento.service.js';
import {
  configCierre,
  momentoCierreAutomatico,
  cierreManualDesde,
  llegoALaUltima,
  limiteInicioCandidatos,
} from './cierre-fechas.js';
import { programarTimerCierre } from './timers-cierre.js';
import { ESTADOS_CURSO_INTERNO } from './estado-viaje.service.js';
import { emitirViajeInterno } from '../sockets/salas.js';

// Lo que hace falta para decidir el cierre de un viaje.
const SELECT_CIERRE = {
  id_viaje: true,
  id_organizacion: true,
  estado: true,
  fecha_inicio: true,
  paradas: {
    select: {
      id_parada: true,
      orden: true,
      llegada_real: true,
      salida_real: true,
      salida_detectada: true,
      peon_estimado_horas: true,
    },
  },
};

const enCurso = (viaje) => viaje && viaje.id_organizacion !== null && ESTADOS_CURSO_INTERNO.includes(viaje.estado);

const leer = (id_viaje) => prisma.viaje.findUnique({ where: { id_viaje }, select: SELECT_CIERRE });

// ─── Timers ──────────────────────────────────────────────────────────────────

// Arma (o re-arma) los timers del viaje segun como esta: el cierre automatico
// siempre; el aviso de habilitacion por tiempo si ya llego a la ultima, la hora
// prevista todavia no paso y el GPS no lo habilito antes. Idempotente.
//
// avisarSiYaPaso: al LLEGAR a la ultima parada, si la hora prevista ya paso (peon
// estimado 0 o casi), el aviso sale en el momento: si no, no saldria nunca. El
// barrido de arranque NO lo pide (esos viajes ya se avisaron antes del deploy).
export function programarCierres(io, viaje, cfg = configCierre(), { avisarSiYaPaso = false } = {}) {
  programarTimerCierre('AUTOMATICO', viaje.id_viaje, momentoCierreAutomatico(viaje, cfg), () =>
    cerrarAutomaticoSiCorresponde(io, viaje.id_viaje, { rearmar: true }).catch((e) =>
      console.error(`[cierre-automatico] viaje ${viaje.id_viaje}:`, e.message)
    )
  );

  if (!llegoALaUltima(viaje.paradas)) return;
  const cierre = cierreManualDesde(viaje.paradas, cfg);
  if (cierre.motivo !== 'TIEMPO') return;
  const avisar = () =>
    avisarCierreHabilitado(io, viaje.id_viaje).catch((e) =>
      console.error(`[cierre-automatico] aviso de habilitacion del viaje ${viaje.id_viaje}:`, e.message)
    );
  if (cierre.desde.getTime() > Date.now()) programarTimerCierre('HABILITADO', viaje.id_viaje, cierre.desde, avisar);
  else if (avisarSiYaPaso) avisar();
}

// Relee y re-arma los timers. Lo llaman iniciar y la llegada a la ultima parada
// (esta con avisarSiYaPaso).
export async function reprogramarCierres(io, id_viaje, opciones) {
  const viaje = await leer(id_viaje);
  if (enCurso(viaje)) programarCierres(io, viaje, configCierre(), opciones);
}

// Cierra el viaje si ya llego su momento. true si lo cerro.
export async function cerrarAutomaticoSiCorresponde(io, id_viaje, { rearmar = false } = {}) {
  const viaje = await leer(id_viaje);
  if (!enCurso(viaje)) return false;

  const cfg = configCierre();
  if (Date.now() < momentoCierreAutomatico(viaje, cfg).getTime()) {
    if (rearmar) programarCierres(io, viaje, cfg);
    return false;
  }

  // Si pierde la carrera contra otra accion del chofer (un confirmar en el
  // medio), el viaje sigue en curso y vencido: un reintento.
  for (let intento = 0; intento < 2; intento++) {
    if (await cerrarViajeInterno({ io, id_viaje, modo: 'AUTOMATICO' })) return true;
    if (!enCurso(await leer(id_viaje))) return false;
  }
  return false;
}

// La hora prevista de fin llego: avisa a la PyME que ya puede finalizar a mano.
// UNA vez: si el GPS lo habilito antes, ya se aviso con motivo GPS.
async function avisarCierreHabilitado(io, id_viaje) {
  const viaje = await leer(id_viaje);
  if (!enCurso(viaje) || !llegoALaUltima(viaje.paradas)) return false;
  const cfg = configCierre();
  const cierre = cierreManualDesde(viaje.paradas, cfg);
  if (cierre.motivo !== 'TIEMPO') return false;
  if (Date.now() < cierre.desde.getTime()) {
    programarCierres(io, viaje, cfg);
    return false;
  }
  emitirViajeInterno(io, { id_organizacion: viaje.id_organizacion }, 'viaje:cierre_habilitado', {
    id_viaje,
    id_organizacion: viaje.id_organizacion,
    motivo: 'TIEMPO',
    cierre_manual_desde: cierre.desde,
    hora_prevista_fin: cierre.hora_prevista_fin,
    salida_detectada: null,
  });
  return true;
}

// ─── Chequeo perezoso ────────────────────────────────────────────────────────

// Cierra, de a uno, los viajes internos en curso cuyo momento de cierre ya paso
// y que matcheen `where` ({ id_organizacion }, { id_conductor } o { id_viaje }).
// Filtro grueso en SQL (fecha_inicio), decision exacta en JS. Devuelve cuantos
// cerro.
export async function cerrarSiCorresponde(io, where) {
  const cfg = configCierre();
  const ahora = Date.now();
  const limite = limiteInicioCandidatos(ahora, cfg);
  const candidatos = await prisma.viaje.findMany({
    where: {
      ...where,
      id_organizacion: where.id_organizacion ?? { not: null },
      estado: { in: ESTADOS_CURSO_INTERNO },
      ...(limite ? { fecha_inicio: { lt: limite } } : {}),
    },
    select: SELECT_CIERRE,
  });

  let cerrados = 0;
  for (const viaje of candidatos) {
    if (ahora < momentoCierreAutomatico(viaje, cfg).getTime()) continue;
    if (await cerrarAutomaticoSiCorresponde(io, viaje.id_viaje)) cerrados++;
  }
  return cerrados;
}

// Los dos chequeos perezosos de los viajes internos, en el orden de sus estados:
// vencer los que no arrancaron y cerrar los que se quedaron en curso.
export async function ponerAlDia(io, where) {
  await vencerSiCorresponde(io, where);
  await cerrarSiCorresponde(io, where);
}

// ─── Barrido de arranque ─────────────────────────────────────────────────────

// UNA query al levantar el server. Los timers viven en memoria y un deploy los
// pierde: esto cierra los viajes cuyo momento paso mientras el proceso estaba
// caido (secuencial, como los otros barridos) y le arma los timers al resto.
//
// ESCRIBE en la DB compartida con produccion: lleva kill-switch
// (CIERRE_BARRIDO_ARRANQUE=0, solo tests; ver app.js). `id_organizacion`
// (CIERRE_BARRIDO_ID_ORGANIZACION, solo tests) lo limita a una PyME para que el
// test del barrido no cierre viajes reales.
export async function barridoInicialCierres(io, { id_organizacion = null } = {}) {
  const viajes = await prisma.viaje.findMany({
    where: {
      id_organizacion: id_organizacion ?? { not: null },
      estado: { in: ESTADOS_CURSO_INTERNO },
    },
    select: SELECT_CIERRE,
  });

  const cfg = configCierre();
  let cerrados = 0;
  let programados = 0;
  for (const viaje of viajes) {
    if (Date.now() >= momentoCierreAutomatico(viaje, cfg).getTime()) {
      if (await cerrarAutomaticoSiCorresponde(io, viaje.id_viaje)) cerrados++;
    } else {
      programarCierres(io, viaje, cfg);
      programados++;
    }
  }

  console.log(
    `[cierre-automatico] barrido de arranque: ${viajes.length} viajes en curso, ` +
      `${cerrados} cerrados, ${programados} con timer programado`
  );
  return { encontrados: viajes.length, cerrados, programados };
}
