// PLAN DE CIERRE de un viaje INTERNO (Tarea 5). PURO: decide, para cada modo de
// cierre, que se escribe en la parada abierta, que paradas quedan sin visitar y
// en que INSTANTE termina la medicion del precio (el "corte"). NO sabe de
// precios: la formula vive en precio-real.js y las mediciones hasta el corte en
// mediciones-gps.js. Asi la formula se puede reemplazar sin tocar esto.
//
// Modos:
//   CHOFER        "Salir" de la ULTIMA parada (el flujo normal).
//   ORGANIZACION  la PyME finaliza a mano (ya llego a la ultima y el cierre
//                 manual esta habilitado: lo valida el caller).
//   AUTOMATICO    fin del dia; puede no haber llegado a la ultima.
//
// Regla de datos de los cierres SIN "Salir" (PyME / automatico): la salida de la
// parada abierta es la salida detectada por GPS si existe (origen GPS); si no,
// queda VACIA y su peon "no medido". No se inventa nada.
//
// Instante de corte del precio:
//   CHOFER sin deteccion previa           -> el toque (mediciones completas: igual que siempre)
//   CHOFER con deteccion anterior al toque -> la detectada
//   llego a la ultima, con deteccion       -> la detectada
//   llego a la ultima, sin deteccion       -> llegada a la ultima + peon estimado (hora prevista de fin)
//   AUTO sin llegar, en una parada         -> su detectada; si no, su llegada + su peon estimado
//   AUTO sin llegar, EN_RUTA               -> min(ultimo ping, salida anterior + manejo estimado
//                                             del tramo siguiente), nunca antes de esa salida
// Ningun corte es posterior a `ahora`.
import { ultimaParada, finPeonEstimado } from './cierre-fechas.js';

const HORA_MS = 3_600_000;
const ordenadas = (paradas) => [...paradas].sort((a, b) => a.orden - b.orden);
const fecha = (v) => (v ? new Date(v) : null);
const minFecha = (...fs) => new Date(Math.min(...fs.filter(Boolean).map((f) => f.getTime())));
const maxFecha = (...fs) => new Date(Math.max(...fs.filter(Boolean).map((f) => f.getTime())));

// La salida_real de un "Salir": la detectada por GPS si es ANTERIOR al toque;
// si no, el toque.
export function elegirSalidaReal({ salida_detectada, toque }) {
  const detectada = fecha(salida_detectada);
  if (detectada && detectada.getTime() < new Date(toque).getTime()) {
    return { salida_real: detectada, origen_salida: 'GPS' };
  }
  return { salida_real: new Date(toque), origen_salida: 'CHOFER' };
}

// Salida de un cierre SIN "Salir": la detectada, o nada.
const salidaSinToque = (parada) =>
  parada.salida_detectada ? { fecha: new Date(parada.salida_detectada), origen: 'GPS' } : null;

// viaje: { estado, paradas: [{ id_parada, orden, llegada_real, salida_real,
//          salida_detectada, peon_estimado_horas, manejo_estimado_horas }] }
// opciones: { ahora, ultimoPing (Date|null), peonMinutos }
// Devuelve:
//   { estadosEsperados, abierta (id_parada|null), salida ({ fecha, origen }|null),
//     noVisitadas: [id_parada], corte: Date, incompleto }
// TIRA si el modo no aplica al estado del viaje (el caller ya lo valido; es
// defensivo, no un 400).
export function planCierre(viaje, modo, { ahora, ultimoPing = null, peonMinutos }) {
  const paradas = ordenadas(viaje.paradas);
  const ahoraD = new Date(ahora);
  const ultima = ultimaParada(paradas);
  const llego = Boolean(ultima?.llegada_real);
  const cfg = { peonMinutos };

  if (modo === 'CHOFER' || modo === 'ORGANIZACION') {
    if (viaje.estado !== 'DESCARGANDO' || !llego || ultima.salida_real) {
      throw new Error(`planCierre: ${modo} solo cierra en la ultima parada (estado ${viaje.estado})`);
    }
  } else if (modo !== 'AUTOMATICO') {
    throw new Error(`planCierre: modo desconocido ${modo}`);
  }

  const base = { estadosEsperados: [viaje.estado], noVisitadas: [], incompleto: false };

  if (modo === 'CHOFER') {
    const { salida_real, origen_salida } = elegirSalidaReal({
      salida_detectada: ultima.salida_detectada,
      toque: ahoraD,
    });
    return {
      ...base,
      abierta: ultima.id_parada,
      salida: { fecha: salida_real, origen: origen_salida },
      corte: salida_real,
    };
  }

  // Desde aca: cierre sin "Salir" (PyME o automatico).
  const abierta = paradas.find((p) => p.llegada_real && !p.salida_real) ?? null;

  if (llego) {
    const salida = abierta ? salidaSinToque(abierta) : null;
    const corte = salida?.fecha ?? finPeonEstimado(ultima, cfg);
    return {
      ...base,
      abierta: abierta?.id_parada ?? null,
      salida,
      corte: minFecha(corte, ahoraD),
    };
  }

  // AUTOMATICO sin haber llegado a la ultima parada: FINALIZADO incompleto.
  const noVisitadas = paradas.filter((p) => !p.llegada_real).map((p) => p.id_parada);
  let corte;
  let salida = null;
  if (abierta) {
    salida = salidaSinToque(abierta);
    corte = salida?.fecha ?? finPeonEstimado(abierta, cfg);
  } else {
    // EN_RUTA: salio de una parada y no llego a la siguiente.
    const salioDe = [...paradas].reverse().find((p) => p.salida_real);
    const siguiente = paradas.find((p) => !p.llegada_real);
    const salidaAnterior = new Date(salioDe.salida_real);
    const manejoEstimado = siguiente?.manejo_estimado_horas ?? 0;
    const cota = new Date(salidaAnterior.getTime() + manejoEstimado * HORA_MS);
    corte = ultimoPing ? maxFecha(salidaAnterior, minFecha(new Date(ultimoPing), cota)) : salidaAnterior;
  }
  return {
    ...base,
    abierta: abierta?.id_parada ?? null,
    salida,
    noVisitadas,
    corte: minFecha(corte, ahoraD),
    incompleto: true,
  };
}
