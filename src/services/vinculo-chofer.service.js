import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.js';
import { ErrorNegocio } from './error-negocio.js';
import { OPCIONES_TX } from './organizacion.service.js';
import { ESTADOS_TERMINALES, ESTADOS_EN_CURSO, ORIGEN_HISTORIAL } from './estado-viaje.service.js';
import { registrarCambioEstado } from './historial-estado.service.js';
import { cancelarAvisoVencimiento } from './vencimiento.service.js';
import { limpiarViajeActivo } from './cancelacion.service.js';
import { guardarMedicionParcial } from './medicion-real.service.js';
import { emitirViajeInterno } from '../sockets/salas.js';

// ─── Lecturas ────────────────────────────────────────────────────────────────

// Lo que una PyME ve de sus choferes: datos de contacto y sus vehiculos PROPIOS
// (patente y caracteristicas). NUNCA a que otras PyMEs esta vinculado — por eso
// el include no baja a conductor.vinculos_organizacion — ni la flota de las
// empresas de logistica donde pueda trabajar (conductor_vehiculos), que es de
// otra organizacion.
export async function listarChoferes(id_organizacion) {
  const vinculos = await prisma.vinculoChofer.findMany({
    where: { id_organizacion, activo: true },
    orderBy: [{ fecha_alta: 'asc' }, { id_vinculo: 'asc' }],
    include: {
      conductor: {
        select: {
          id_conductor: true,
          usuario: { select: { id_usuario: true, nombre: true, apellido: true, telefono: true } },
          vehiculos_propios: {
            orderBy: { id_vehiculo: 'asc' },
            include: { condiciones: { select: { condicion: true } } },
          },
        },
      },
    },
  });

  return vinculos.map((v) => ({
    id_conductor: v.conductor.id_conductor,
    id_usuario: v.conductor.usuario.id_usuario,
    nombre: v.conductor.usuario.nombre,
    apellido: v.conductor.usuario.apellido,
    telefono: v.conductor.usuario.telefono,
    fecha_alta: v.fecha_alta,
    metodo_cobro: v.metodo_cobro,
    vehiculos: v.conductor.vehiculos_propios.map((veh) => ({
      id_vehiculo: veh.id_vehiculo,
      patente: veh.patente,
      marca: veh.marca,
      modelo: veh.modelo,
      anio: veh.anio,
      color: veh.color,
      tipo_vehiculo: veh.tipo_vehiculo,
      condiciones: veh.condiciones.map((c) => c.condicion),
    })),
  }));
}

// Lo que el chofer ve de sus PyMEs: el nombre (y desde cuando).
export async function organizacionesDeChofer(id_conductor) {
  const vinculos = await prisma.vinculoChofer.findMany({
    where: { id_conductor, activo: true },
    orderBy: [{ fecha_alta: 'asc' }, { id_vinculo: 'asc' }],
    include: { organizacion: { select: { id_organizacion: true, nombre: true } } },
  });
  return vinculos.map((v) => ({ ...v.organizacion, fecha_alta: v.fecha_alta }));
}

// ─── Desvinculacion ──────────────────────────────────────────────────────────

const ESTADOS_FINALES_SQL = Prisma.join(ESTADOS_TERMINALES);

// UNICA funcion que corta un vinculo PyME-chofer. La usan los DOS caminos:
//   - DELETE /api/organizaciones/:id/choferes/:idConductor  (origen ORGANIZACION)
//   - DELETE /api/choferes/mis-organizaciones/:id           (origen CHOFER)
// actor = { id_usuario, origen: 'CHOFER' | 'ORGANIZACION' }.
//
// Que sea una sola funcion es lo que garantiza que el enganche del Paso 2 corre
// en los dos caminos: en la MISMA transaccion que corta el vinculo, se cancelan
// TODOS los viajes no finales de este chofer con esta PyME, INCLUSO uno en
// curso, con causa DESVINCULACION. Los viajes del chofer con OTRAS PyMEs no se
// tocan.
//
// Locks, en este orden (el mismo que crear / reasignar: vinculo -> viaje):
//   1. updateMany del vinculo condicionado a activo: toma el lock de la fila.
//      Dos desvinculaciones a la vez (el chofer y la PyME): gana una, la otra
//      matchea 0 filas y recibe 404. Un crear / reasignar concurrente, que
//      bloquea el mismo vinculo, espera y despues lo ve inactivo.
//   2. SELECT ... FOR UPDATE de los viajes no finales: un iniciar / confirmar
//      concurrente espera al commit y despues matchea 0 filas (409); si gano el
//      iniciar, el viaje ya esta en CARGANDO y se cancela igual.
//
// Fuera de la tx: historial, timers, limpieza de ETA/GPS/Redis y eventos.
// Devuelve los ids de los viajes cancelados.
export async function desvincularChofer({ id_organizacion, id_conductor, actor, io = null }) {
  const ahora = new Date();
  const cancelados = await prisma.$transaction(async (tx) => {
    const r = await tx.vinculoChofer.updateMany({
      where: { id_organizacion, id_conductor, activo: true },
      data: {
        activo: false,
        fecha_baja: new Date(),
        desvinculado_por: actor.origen,
        desvinculado_por_id_usuario: actor.id_usuario,
      },
    });
    if (r.count === 0) {
      throw new ErrorNegocio(404, 'No hay un vinculo activo con ese chofer');
    }

    const viajes = await tx.$queryRaw`
      SELECT id_viaje, estado::text AS estado
      FROM viajes
      WHERE id_organizacion = ${id_organizacion}
        AND id_conductor = ${id_conductor}
        AND estado::text NOT IN (${ESTADOS_FINALES_SQL})
      ORDER BY id_viaje
      FOR UPDATE`;
    if (viajes.length === 0) return [];

    await tx.viaje.updateMany({
      where: {
        id_viaje: { in: viajes.map((v) => v.id_viaje) },
        estado: { notIn: ESTADOS_TERMINALES },
      },
      data: { estado: 'CANCELADO', causa_cancelacion: 'DESVINCULACION' },
    });
    return viajes;
  }, OPCIONES_TX);

  if (cancelados.length > 0) {
    const chofer = await prisma.conductor.findUnique({
      where: { id_conductor },
      select: { id_usuario: true },
    });
    const origen = actor.origen === 'CHOFER' ? ORIGEN_HISTORIAL.CHOFER : ORIGEN_HISTORIAL.PYME;

    for (const { id_viaje, estado } of cancelados) {
      await registrarCambioEstado({
        id_viaje,
        estado: 'CANCELADO',
        id_usuario: actor.id_usuario,
        origen,
      });
      cancelarAvisoVencimiento(id_viaje);
      // Cancelado EN CURSO: se guarda lo medido hasta la desvinculacion, ANTES
      // de limpiar Redis. Nunca tira.
      if (ESTADOS_EN_CURSO.includes(estado)) {
        await guardarMedicionParcial(id_viaje, ahora);
      }
      // Idempotente: en los pre-inicio no hay nada, en los en curso corta el
      // emisor de ETA y borra todas las keys gps:{id}:*.
      await limpiarViajeActivo(id_viaje);
      emitirViajeInterno(
        io,
        { id_viaje, id_organizacion, id_usuario_chofer: chofer?.id_usuario },
        'viaje:cancelado',
        {
          id_viaje,
          id_organizacion,
          estado: 'CANCELADO',
          estado_anterior: estado,
          causa: 'DESVINCULACION',
          motivo: null,
        }
      );
    }
  }

  return cancelados.map((v) => v.id_viaje);
}
