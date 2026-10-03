import prisma from '../config/prisma.js';

// Historial de estados del viaje: una fila por CADA cambio de estado.
//
// POR QUE NO SE CENTRALIZA EN validarTransicion (la opcion comoda y mala):
// - Solo 6 de los 12 sitios que cambian estado la llaman. Quedan afuera
//   matching.socket (aceptar), cierre.service, iniciarViaje,
//   cancelarViajeCliente y el cancelar de admin. El historial quedaria con
//   agujeros SILENCIOSOS justo en los caminos mas importantes.
// - Corre ANTES de la escritura, y la escritura puede no ocurrir: los
//   updateMany condicionados devuelven count === 0 -> 409. Registrar ahi
//   guardaria transiciones que nunca pasaron.
// - Ni siquiera sabe de que viaje habla: su firma es (estadoActual, destino).
//
// Tampoco se hace con una extension de Prisma ($extends sobre viaje.update):
// es el unico mecanismo del que ningun caller se puede olvidar, pero no conoce
// al actor (el timer y el barrido no tienen request), updateMany devuelve solo
// { count }, y crearViaje ni pasa estado en el data (sale del @default).
//
// Se escribe en CADA caller, con esta funcion. La lista COMPLETA de los 12
// sitios esta en CLAUDE.md, seccion "Historial de estados".

// Quien disparo el cambio. String y no enum, mismo criterio que
// Viaje.iniciado_por. SISTEMA = sin usuario (timer de reserva, barrido de
// arranque).
export const ORIGENES = ['CLIENTE', 'CONDUCTOR', 'GERENTE', 'ADMIN', 'SISTEMA'];

// El include que necesitan las funciones que leen el historial
// (fechaDeEstado y, a traves de ella, las duraciones por etapa).
//
// El desempate por id_historial NO es decorativo: dos filas escritas en el
// mismo milisegundo ordenarian ambiguo si se fuera solo por fecha, y el orden
// es justamente lo que el historial tiene que preservar.
export const INCLUDE_HISTORIAL = {
  historial_estados: {
    orderBy: [{ fecha: 'asc' }, { id_historial: 'asc' }],
  },
};

// Registra un cambio de estado. NUNCA TIRA.
//
// Esta es la garantia de que un fallo del historial no rompe la operacion: el
// cambio de estado ya se escribio cuando se llama a esto, y si el insert falla
// solo se pierde una fila de auditoria. Preferimos un historial con un hueco
// antes que un viaje que no se puede cancelar porque la tabla de auditoria
// esta caida.
//
// Devuelve true si registro, false si fallo. Los callers pueden ignorarlo.
//
// REGLAS DE LLAMADA:
// - Siempre DESPUES de que la escritura del estado haya tenido exito. En los
//   updateMany condicionados, recien despues de verificar count > 0.
// - Siempre FUERA de la $transaction. Adentro, un fallo del historial haria
//   rollback del cambio de estado — exactamente lo contrario de lo que queremos.
export async function registrarCambioEstado({ id_viaje, estado, id_usuario, origen }) {
  try {
    await prisma.historialEstadoViaje.create({
      data: {
        id_viaje,
        estado,
        id_usuario: id_usuario ?? null,
        origen: origen ?? null,
      },
    });
    return true;
  } catch (err) {
    console.error(
      `[historial-estado] no se pudo registrar ${estado} del viaje ${id_viaje}: ${err.message}`
    );
    return false;
  }
}

// Momento en que el viaje entro por PRIMERA vez a `estado`, o null si nunca
// entro (viaje viejo sin historial, o transicion que todavia no ocurrio).
//
// Se toma la primera aparicion: CARGANDO, EN_RUTA, DESCARGANDO y FINALIZADO
// tienen cada uno un unico predecesor en TRANSICIONES, asi que en un viaje bien
// formado no pueden repetirse. Tomar la primera lo hace deterministico igual si
// alguna vez se repitieran.
//
// TIRA si el viaje no viene con el historial incluido — mismo idiom defensivo
// que esViajeVencido, calcularDuracionRealMinutos y puedeVerViaje: un select al
// que se le olvido el include devolveria null en silencio y todas las
// duraciones por etapa saldrian vacias sin que nadie se entere.
export function fechaDeEstado(viaje, estado) {
  if (viaje.historial_estados === undefined) {
    throw new Error(
      'fechaDeEstado: el viaje debe venir con la relacion historial_estados incluida (INCLUDE_HISTORIAL)'
    );
  }

  const fila = viaje.historial_estados.find((h) => h.estado === estado);
  return fila ? new Date(fila.fecha) : null;
}
