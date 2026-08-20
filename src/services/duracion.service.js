// Duraciones de un viaje, y la UNICA conversion de unidades entre la base y la
// API. Existe para que no se mezclen unidades en una misma respuesta.
//
// Convencion, sin excepciones:
//   - En la BASE y en el calculo de precio, el tiempo va en HORAS (float).
//     Es lo que Google Distance Matrix devuelve y lo que consume tarifa_hora:
//     Viaje.duracion_estimada_horas, desglose.tiempo_horas, tiempo_capital.
//   - En la API, toda duracion se expone en MINUTOS (entero redondeado):
//     duracion_estimada y duracion_real.
//
// OJO: desglose_estimado.tiempo_horas y duracion_estimada son el MISMO dato en
// distinta unidad — el primero es el input del calculo de precio (horas, float),
// el segundo es el valor de presentacion (minutos, entero). No confundirlos.

// Horas (float) -> minutos (entero). null/undefined pasan como null: un viaje
// creado antes de que existiera la columna no tiene estimacion guardada.
export function horasAMinutos(horas) {
  if (typeof horas !== 'number' || Number.isNaN(horas)) return null;
  return Math.round(horas * 60);
}

// Duracion REAL del viaje, en minutos. Se calcula en el read — no hay columna.
//
// Fin del viaje = la ultima fecha_entrega de sus paradas. Se usa max() y NO la
// parada de mayor `orden` a proposito: el conductor confirma cada parada por
// proximidad y nada valida el orden, asi que la de mayor orden puede no ser la
// ultima en el tiempo. Confirmar la ultima parada pendiente es lo que
// dispara cerrarViaje, asi que ese maximo ES el momento del cierre.
//
// null si el viaje no arranco (sin fecha_inicio) o todavia no termino (estado
// distinto de FINALIZADO): una duracion "real" a mitad de viaje no es real.
//
// El viaje debe venir con `paradas` incluidas (con fecha_entrega).
export function calcularDuracionRealMinutos(viaje) {
  if (viaje.estado !== 'FINALIZADO') return null;
  if (!viaje.fecha_inicio) return null;

  if (viaje.paradas === undefined) {
    throw new Error(
      'calcularDuracionRealMinutos: el viaje debe venir con la relacion paradas incluida'
    );
  }

  const entregas = viaje.paradas
    .map((p) => p.fecha_entrega)
    .filter((f) => f != null)
    .map((f) => new Date(f).getTime());

  if (entregas.length === 0) return null;

  const fin = Math.max(...entregas);
  const minutos = (fin - new Date(viaje.fecha_inicio).getTime()) / 60000;

  // Defensivo: un reloj corrido o datos viejos no deberian producir una
  // duracion negativa. Preferimos null antes que un numero sin sentido.
  if (minutos < 0) return null;

  return Math.round(minutos);
}
