// Reglas PURAS del feedback del precio pagado (Parte D).
//
// Fin del viaje = Viaje.fecha_corte_precio: lo escriben los tres cierres del
// ciclo interno desde la Tarea 5 (en el flujo normal es la salida de la ultima
// parada). Un FINALIZADO sin esa fecha (cerrado antes de la Tarea 5) no admite
// feedback: su ventana ya vencio de todas formas.
//
// Editable hasta FEEDBACK_PRECIO_EDICION_DIAS dias desde el fin del viaje.

const DIA_MS = 86_400_000;

export function finDelViaje(viaje) {
  return viaje.fecha_corte_precio ? new Date(viaje.fecha_corte_precio) : null;
}

export function editableHasta(viaje, dias) {
  const fin = finDelViaje(viaje);
  return fin ? new Date(fin.getTime() + dias * DIA_MS) : null;
}

// 'NO_FINALIZADO' | 'VENCIDO' | null (se puede cargar / editar).
export function motivoNoEditable(viaje, ahora, dias) {
  if (viaje.estado !== 'FINALIZADO') return 'NO_FINALIZADO';
  const hasta = editableHasta(viaje, dias);
  if (!hasta || new Date(ahora).getTime() > hasta.getTime()) return 'VENCIDO';
  return null;
}

// true si la PyME todavia tiene que cargar el precio pagado: FINALIZADO, dentro
// de la ventana y sin feedback. El viaje tiene que traer la relacion
// precio_pagado (null si no hay): TIRA si no viene, mismo idiom que
// esViajeVencido (un include olvidado daria "pendiente" en silencio).
export function precioPagadoPendiente(viaje, ahora, dias) {
  if (viaje.precio_pagado === undefined) {
    throw new Error('precioPagadoPendiente: el viaje debe traer la relacion precio_pagado');
  }
  return viaje.precio_pagado === null && motivoNoEditable(viaje, ahora, dias) === null;
}

// Lo que se devuelve del feedback (sin id_viaje redundante en las listas).
export function serializarPrecioPagado(pp) {
  if (!pp) return null;
  return {
    monto: pp.monto,
    incluye_iva: pp.incluye_iva,
    monto_peajes: pp.monto_peajes,
    metodo_pago: pp.metodo_pago,
    ayudantes_reales: pp.ayudantes_reales,
    comentario: pp.comentario,
    id_usuario: pp.id_usuario,
    creado_en: pp.creado_en,
    actualizado_en: pp.actualizado_en,
    ediciones: pp.ediciones,
  };
}
