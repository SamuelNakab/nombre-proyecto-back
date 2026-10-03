import prisma from '../config/prisma.js';
import { ErrorNegocio } from './error-negocio.js';

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

// UNICA funcion que corta un vinculo PyME-chofer. La usan los DOS caminos:
//   - DELETE /api/organizaciones/:id/choferes/:idConductor  (origen ORGANIZACION)
//   - DELETE /api/choferes/mis-organizaciones/:id           (origen CHOFER)
// actor = { id_usuario, origen: 'CHOFER' | 'ORGANIZACION' }.
//
// PASO 2 — PUNTO DE ENGANCHE: aca se va a sumar la cancelacion de TODOS los
// viajes de este chofer con esta PyME, incluso uno en curso. Hoy solo cambia el
// vinculo. Que sea una sola funcion es justamente para que ese agregado no se
// pueda olvidar en uno de los dos caminos.
//
// updateMany condicionado a activo: dos desvinculaciones a la vez (el chofer y
// la PyME) — gana una, la otra matchea 0 filas y recibe 404.
export async function desvincularChofer({ id_organizacion, id_conductor, actor }) {
  const r = await prisma.vinculoChofer.updateMany({
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
}
