// Calculo PURO de los tiempos reales de manejo y peon (sin DB ni Redis: se
// testea sin red en tiempos-reales.test.js). Lo usa medicion-real.service, que
// es quien los escribe. Ver la explicacion completa alli.

const HORA_MS = 3_600_000;
const horasEntre = (desde, hasta) => (new Date(hasta).getTime() - new Date(desde).getTime()) / HORA_MS;

// paradas: con orden, llegada_real y salida_real (en cualquier orden de array).
// fin (opcional): instante de una cancelacion en curso. La parada ABIERTA
// (llego y no salio) se cierra en `fin` solo para el calculo, y el tramo que se
// estaba manejando suma al manejo del VIAJE (no es de ninguna parada: no llego).
//
// Devuelve null si el viaje no arranco (la parada 1 no tiene llegada).
// Si no: { paradas: [{ id_parada, orden, peon_real_horas, manejo_real_horas }],
//          manejo_horas, peon_horas, total_horas }
export function tiemposRealesDesdeParadas(paradas, fin = null) {
  const ordenadas = [...paradas].sort((a, b) => a.orden - b.orden);
  if (!ordenadas[0]?.llegada_real) return null;

  let manejo_horas = 0;
  let peon_horas = 0;
  let ultimaSalida = null;
  const resultado = [];

  for (const p of ordenadas) {
    if (!p.llegada_real) break; // de aca en adelante todavia no llego a ninguna

    const manejo = ultimaSalida ? horasEntre(ultimaSalida, p.llegada_real) : null;
    const salida = p.salida_real ?? fin;
    const peon = salida ? horasEntre(p.llegada_real, salida) : null;

    if (manejo !== null) manejo_horas += manejo;
    if (peon !== null) peon_horas += peon;
    resultado.push({
      id_parada: p.id_parada,
      orden: p.orden,
      peon_real_horas: peon,
      manejo_real_horas: manejo,
    });
    ultimaSalida = p.salida_real ?? null;
  }

  // Cancelado manejando: salio de una parada y no llego a la siguiente.
  if (fin && ultimaSalida && resultado.length < ordenadas.length) {
    manejo_horas += horasEntre(ultimaSalida, fin);
  }

  return { paradas: resultado, manejo_horas, peon_horas, total_horas: manejo_horas + peon_horas };
}

const PEON_LEGACY = ['CARGANDO', 'DESCARGANDO'];
const MANEJO_LEGACY = ['EN_RUTA'];

// historial: filas { estado, fecha } (en cualquier orden). Cada fila abre un
// tramo que cierra la fila siguiente; el ultimo cierra en `fin` (el cierre o
// la cancelacion). null si el viaje nunca estuvo en CARGANDO / EN_RUTA /
// DESCARGANDO.
export function tiemposRealesDesdeHistorial(historial, fin) {
  const filas = [...historial].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  let manejo_horas = 0;
  let peon_horas = 0;
  let midio = false;

  filas.forEach((fila, i) => {
    const esPeon = PEON_LEGACY.includes(fila.estado);
    const esManejo = MANEJO_LEGACY.includes(fila.estado);
    if (!esPeon && !esManejo) return;
    const hasta = filas[i + 1]?.fecha ?? fin;
    if (!hasta) return;
    const horas = Math.max(0, horasEntre(fila.fecha, hasta));
    midio = true;
    if (esPeon) peon_horas += horas;
    else manejo_horas += horas;
  });

  return midio ? { manejo_horas, peon_horas, total_horas: manejo_horas + peon_horas } : null;
}
