// Maquina de estados del viaje. Unica fuente de verdad de que transiciones son
// validas. Hay DOS ciclos y cada uno tiene su tabla:
//
// - TRANSICIONES: el ciclo LEGACY del marketplace (BUSCANDO_CONDUCTOR, reservas
//   de empresa, CONDUCTOR_ASIGNADO, EN_CAMINO_A_ORIGEN...). Sin cambios. La usa
//   el PATCH /api/viajes/:id/estado y todo endpoint de la estructura jerarquica.
//   matching.service, cierre.service y cancelacion.service todavia setean un
//   estado fijo sin pasar por aca — se migran despues, a proposito.
//
// - TRANSICIONES_INTERNO: el ciclo del viaje INTERNO (Paso 2), el de un viaje
//   con id_organizacion. Ademas del destino dice QUIEN puede hacer cada
//   transicion y por que accion. Ver la tabla completa en CLAUDE.md.
//
// validarTransicion elige la tabla por el tercer parametro: sin contexto es la
// legacy (todos los callers viejos quedan igual); con { ciclo: 'INTERNO', quien }
// es la interna.

// Estados desde los que ya no se puede transicionar (terminales). Incluye los
// finales de los DOS ciclos: los estados no se pisan entre ciclos, asi que una
// sola lista sirve para "el viaje esta terminado" en cualquiera de los dos.
export const ESTADOS_TERMINALES = ['FINALIZADO', 'CANCELADO', 'RECHAZADO', 'VENCIDO'];

// Estados en los que el viaje esta EN CURSO (arranco y no termino): aceptan
// pings GPS, tienen ETA y tracking. EN_CAMINO_A_ORIGEN solo existe en el ciclo
// legacy; el interno arranca directo en CARGANDO.
export const ESTADOS_EN_CURSO = ['EN_CAMINO_A_ORIGEN', 'CARGANDO', 'EN_RUTA', 'DESCARGANDO'];

// ─── Ciclo LEGACY ────────────────────────────────────────────────────────────

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

// ─── Ciclo INTERNO ───────────────────────────────────────────────────────────

// Quienes pueden disparar una transicion del ciclo interno:
//   CHOFER  — el chofer asignado (cuenta CONDUCTOR)
//   PYME    — cualquier miembro activo de la PyME dueña del viaje
//   ADMIN   — el panel de administracion
//   SISTEMA — sin usuario: vencimiento (timer, barrido, chequeo perezoso) o la
//             cancelacion en cascada de una desvinculacion
export const ACTORES_INTERNO = ['CHOFER', 'PYME', 'ADMIN', 'SISTEMA'];

// En el historial de estados, el origen reusa los valores que ya existen en
// historial-estado.service (ORIGENES): el chofer es una cuenta CONDUCTOR y el
// miembro de la PyME es una cuenta CLIENTE.
export const ORIGEN_HISTORIAL = {
  CHOFER: 'CONDUCTOR',
  PYME: 'CLIENTE',
  ADMIN: 'ADMIN',
  SISTEMA: 'SISTEMA',
};

const CANCELABLE_POR_TODOS = { quien: ['CHOFER', 'PYME', 'ADMIN', 'SISTEMA'], accion: 'cancelar' };
const CANCELABLE_EN_CURSO = { quien: ['PYME', 'ADMIN', 'SISTEMA'], accion: 'cancelar' };
const VENCE = { quien: ['SISTEMA'], accion: 'vencer' };

// desde -> hacia -> { quien, accion }.
//
// ASIGNADO -> ASIGNADO existe (reasignar / editar sin cambio de estado) y NO
// genera fila de historial, igual que reasignarViaje en el ciclo legacy.
//
// CONFIRMADO -> CARGANDO es SOLO por "iniciar" (ventana + proximidad al origen):
// el PATCH /estado no lo permite, ver ACCIONES_PATCH_ESTADO.
//
// EN_RUTA -> FINALIZADO esta porque es lo que ya hace confirmar-parada: si el
// chofer confirma la ULTIMA parada en EN_RUTA, el cierre corre igual. La tabla
// lo dice para no mentir sobre el comportamiento.
export const TRANSICIONES_INTERNO = {
  ASIGNADO: {
    CONFIRMADO: { quien: ['CHOFER'], accion: 'confirmar' },
    RECHAZADO: { quien: ['CHOFER'], accion: 'rechazar' },
    ASIGNADO: { quien: ['PYME'], accion: 'reasignar/editar' },
    CANCELADO: CANCELABLE_POR_TODOS,
    VENCIDO: VENCE,
  },
  CONFIRMADO: {
    CARGANDO: { quien: ['CHOFER'], accion: 'iniciar' },
    ASIGNADO: { quien: ['PYME'], accion: 'reasignar/editar' },
    CANCELADO: CANCELABLE_POR_TODOS,
    VENCIDO: VENCE,
  },
  CARGANDO: {
    EN_RUTA: { quien: ['CHOFER'], accion: 'avanzar' },
    CANCELADO: CANCELABLE_EN_CURSO,
  },
  EN_RUTA: {
    DESCARGANDO: { quien: ['CHOFER'], accion: 'avanzar' },
    FINALIZADO: { quien: ['CHOFER'], accion: 'confirmar-parada' },
    CANCELADO: CANCELABLE_EN_CURSO,
  },
  DESCARGANDO: {
    FINALIZADO: { quien: ['CHOFER'], accion: 'confirmar-parada' },
    CANCELADO: CANCELABLE_EN_CURSO,
  },
  FINALIZADO: {},
  CANCELADO: {},
  RECHAZADO: {},
  VENCIDO: {},
};

// Estados del ciclo interno en los que el viaje todavia no arranco y puede
// vencer. Son tambien los unicos en los que la PyME puede reasignar o editar.
export const ESTADOS_PRE_INICIO_INTERNO = ['ASIGNADO', 'CONFIRMADO'];

// 'INTERNO' si el viaje es de una PyME, 'LEGACY' si es del marketplace.
// TIRA si el viaje no trae id_organizacion: un select al que se le olvido el
// campo trataria un viaje interno como legacy sin que nadie se entere.
export function cicloDe(viaje) {
  if (viaje.id_organizacion === undefined) {
    throw new Error('cicloDe: el viaje debe traer id_organizacion');
  }
  return viaje.id_organizacion === null ? 'LEGACY' : 'INTERNO';
}

// Tira Error si la transicion no esta permitida. No devuelve nada si es valida.
// El caller la envuelve en try/catch y responde 400 con err.message.
//
// contexto (opcional): { ciclo: 'INTERNO', quien }. Sin contexto, o con
// ciclo 'LEGACY', se usa la tabla legacy y `quien` se ignora.
export function validarTransicion(estadoActual, estadoDestino, contexto = undefined) {
  if (contexto?.ciclo === 'INTERNO') {
    return validarTransicionInterna(estadoActual, estadoDestino, contexto.quien);
  }

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

function validarTransicionInterna(estadoActual, estadoDestino, quien) {
  const destinos = TRANSICIONES_INTERNO[estadoActual];
  if (!destinos) {
    throw new Error(`Estado de viaje desconocido: ${estadoActual}`);
  }

  const regla = destinos[estadoDestino];
  if (!regla) {
    throw new Error(
      `Transicion invalida: no se puede pasar de ${estadoActual} a ${estadoDestino}`
    );
  }

  if (!quien || !regla.quien.includes(quien)) {
    throw new Error(
      `Transicion no permitida: ${quien ?? 'nadie'} no puede pasar un viaje de ${estadoActual} a ${estadoDestino}`
    );
  }
}
