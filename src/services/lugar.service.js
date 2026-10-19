// LUGARES GUARDADOS de una PyME (Paso 4): direcciones frecuentes con nombre
// ("Deposito Pilar"). Cualquier miembro activo los crea, lista, edita y borra.
//
// - Nombre UNICO entre los ACTIVOS de la PyME, sin distinguir mayusculas. No es
//   un constraint (mismo criterio que el CUIT): se sostiene con un advisory lock
//   por (PyME, lower(nombre)) dentro de la transaccion, y despues el SELECT.
//   Dos altas con el mismo nombre a la vez quedan en fila y la segunda ve la
//   primera. El lock se arma con lower() de Postgres, el MISMO que compara: si
//   la clave saliera de toLowerCase de JS, un caracter que los dos bajan
//   distinto daria claves distintas para nombres que la query considera iguales.
// - Borrar = activo false (soft delete). Los viajes y las series que lo usaron no
//   se tocan: guardan una COPIA de direccion y coordenadas (snapshotParadas).
// - Editar o borrar: updateMany condicionado a activo. Lectura previa -> 404;
//   carrera perdida -> 409.
import prisma from '../config/prisma.js';
import { ErrorNegocio } from './error-negocio.js';
import { OPCIONES_TX, exigirPymeOperativa } from './organizacion.service.js';
import { snapshotParadas } from './viaje-validacion.js';

const MENSAJE_SUSPENDIDA = 'La PyME esta suspendida: no puede crear ni modificar lugares';

// "  Deposito   Pilar " -> "Deposito Pilar". Lo que se guarda y lo que se compara.
export const normalizarNombreLugar = (nombre) => nombre.trim().replace(/\s+/g, ' ');

export function serializarLugar(l) {
  return {
    id_lugar: l.id_lugar,
    id_organizacion: l.id_organizacion,
    nombre: l.nombre,
    direccion: l.direccion,
    lat: l.latitud,
    lng: l.longitud,
    activo: l.activo,
    creado_en: l.creado_en,
    actualizado_en: l.actualizado_en,
  };
}

const conflicto = () =>
  new ErrorNegocio(409, 'El lugar cambio mientras se procesaba tu pedido: volve a cargarlo');

// Dentro de la tx: lock por (PyME, nombre) y despues el chequeo. `excluir` es el
// propio lugar al editar (renombrarlo a si mismo con otras mayusculas vale).
async function exigirNombreLibre(tx, id_organizacion, nombre, excluir = 0) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('lugar-nombre:' || ${id_organizacion}::text || ':' || lower(${nombre}::text)))`;
  const filas = await tx.$queryRaw`
    SELECT id_lugar FROM lugares
    WHERE id_organizacion = ${id_organizacion}
      AND activo = true
      AND lower(nombre) = lower(${nombre}::text)
      AND id_lugar <> ${excluir}
    LIMIT 1`;
  if (filas.length > 0) throw new ErrorNegocio(400, 'Ya existe un lugar con ese nombre');
}

async function lugarActivo(id_organizacion, id_lugar) {
  const lugar = await prisma.lugar.findFirst({ where: { id_lugar, id_organizacion, activo: true } });
  // Mismo 404 si no existe, si es de otra PyME o si esta borrado.
  if (!lugar) throw new ErrorNegocio(404, 'Lugar no encontrado');
  return lugar;
}

export async function listarLugares(id_organizacion) {
  const lugares = await prisma.lugar.findMany({
    where: { id_organizacion, activo: true },
    orderBy: [{ nombre: 'asc' }, { id_lugar: 'asc' }],
  });
  return lugares.map(serializarLugar);
}

export async function crearLugar({ id_organizacion, id_usuario, datos }) {
  await exigirPymeOperativa(id_organizacion, MENSAJE_SUSPENDIDA);
  const nombre = normalizarNombreLugar(datos.nombre);

  const lugar = await prisma.$transaction(async (tx) => {
    await exigirNombreLibre(tx, id_organizacion, nombre);
    return tx.lugar.create({
      data: {
        id_organizacion,
        id_creador: id_usuario,
        nombre,
        direccion: datos.direccion.trim(),
        latitud: datos.lat,
        longitud: datos.lng,
      },
    });
  }, OPCIONES_TX);
  return serializarLugar(lugar);
}

export async function editarLugar({ id_organizacion, id_lugar, datos }) {
  await exigirPymeOperativa(id_organizacion, MENSAJE_SUSPENDIDA);
  await lugarActivo(id_organizacion, id_lugar);

  const data = {};
  if (datos.nombre !== undefined) data.nombre = normalizarNombreLugar(datos.nombre);
  if (datos.direccion !== undefined) data.direccion = datos.direccion.trim();
  if (datos.lat !== undefined) data.latitud = datos.lat;
  if (datos.lng !== undefined) data.longitud = datos.lng;

  await prisma.$transaction(async (tx) => {
    if (data.nombre !== undefined) await exigirNombreLibre(tx, id_organizacion, data.nombre, id_lugar);
    const r = await tx.lugar.updateMany({ where: { id_lugar, id_organizacion, activo: true }, data });
    if (r.count === 0) throw conflicto();
  }, OPCIONES_TX);

  // Los viajes y series que ya lo usaron NO cambian (snapshot).
  return serializarLugar(await prisma.lugar.findUnique({ where: { id_lugar } }));
}

// Permitido aunque la PyME este SUSPENDIDA: es sacar algo, como cancelar.
export async function borrarLugar({ id_organizacion, id_usuario, id_lugar }) {
  await lugarActivo(id_organizacion, id_lugar);
  const r = await prisma.lugar.updateMany({
    where: { id_lugar, id_organizacion, activo: true },
    data: { activo: false, fecha_baja: new Date(), baja_por_id_usuario: id_usuario },
  });
  if (r.count === 0) throw conflicto();
  return { mensaje: 'Lugar borrado', id_lugar };
}

// Paradas del body (cada una { id_lugar } o coordenadas) -> paradas con
// coordenadas, direccion e id_lugar (snapshot). UNA query. Un lugar que no
// existe, que es de OTRA PyME o que esta borrado da el MISMO 400: no se filtra
// que ids existen. Fuera de toda tx y sin lock: es una copia, si el lugar se
// borra un instante despues el viaje no depende de el.
export async function resolverParadas(id_organizacion, paradas) {
  const ids = [...new Set(paradas.filter((p) => p.id_lugar != null).map((p) => p.id_lugar))];
  if (ids.length === 0) return snapshotParadas(paradas, new Map());

  const lugares = await prisma.lugar.findMany({
    where: { id_lugar: { in: ids }, id_organizacion, activo: true },
  });
  const porId = new Map(lugares.map((l) => [l.id_lugar, l]));
  const falta = ids.find((id) => !porId.has(id));
  if (falta !== undefined) {
    throw new ErrorNegocio(400, `El lugar ${falta} no existe o no esta activo`);
  }
  return snapshotParadas(paradas, porId);
}
