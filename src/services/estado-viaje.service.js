// Maquina de estados del viaje. Unica fuente de verdad de que transiciones son
// validas. La usa el PATCH /api/viajes/:id/estado y debe usarla TODO endpoint
// nuevo que cambie el estado de un viaje (reserva, asignacion, etc.).
//
// matching.service, cierre.service y cancelacion.service todavia setean un
// estado fijo sin pasar por aca — se migran despues, a proposito.

// Estados desde los que ya no se puede transicionar (terminales).
export const ESTADOS_TERMINALES = ['FINALIZADO', 'CANCELADO'];

// Para cada estado, la lista de estados destino validos. La regla
// "cualquiera (no terminal) -> CANCELADO" (cancelacion por admin/cliente) esta
// incluida explicitamente en cada estado no terminal.
export const TRANSICIONES = {
  BUSCANDO_CONDUCTOR: ['CONDUCTOR_ASIGNADO', 'RESERVADO_POR_EMPRESA', 'CANCELADO'],
  RESERVADO_POR_EMPRESA: ['CONDUCTOR_ASIGNADO', 'BUSCANDO_CONDUCTOR', 'CANCELADO'],
  CONDUCTOR_ASIGNADO: [
    'EN_CAMINO_A_ORIGEN',
    'BUSCANDO_CONDUCTOR',
    'RESERVADO_POR_EMPRESA',
    'CANCELADO',
  ],
  EN_CAMINO_A_ORIGEN: ['CARGANDO', 'CANCELADO'],
  CARGANDO: ['EN_RUTA', 'CANCELADO'],
  EN_RUTA: ['DESCARGANDO', 'CANCELADO'],
  DESCARGANDO: ['FINALIZADO', 'CANCELADO'],
  FINALIZADO: [],
  CANCELADO: [],
};

// Tira Error si la transicion no esta permitida. No devuelve nada si es valida.
// El caller la envuelve en try/catch y responde 400 con err.message.
export function validarTransicion(estadoActual, estadoDestino) {
  const destinosValidos = TRANSICIONES[estadoActual];

  if (!destinosValidos) {
    throw new Error(`Estado de viaje desconocido: ${estadoActual}`);
  }

  if (!destinosValidos.includes(estadoDestino)) {
    throw new Error(
      `Transicion invalida: no se puede pasar de ${estadoActual} a ${estadoDestino}`
    );
  }
}
