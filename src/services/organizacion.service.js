import prisma from '../config/prisma.js';
import { validarCuit } from './cuit.service.js';
import { ErrorNegocio } from './error-negocio.js';

// ─── Configuracion ───────────────────────────────────────────────────────────

// Cuantas PyMEs ACTIVAS puede tener un usuario a la vez. El schema permite N
// (miembros_organizacion no tiene unique por usuario); el limite es de aca.
// Se lee en cada llamada, no se cachea.
export function maxOrganizacionesPorUsuario() {
  const n = parseInt(process.env.MAX_ORGANIZACIONES_POR_USUARIO, 10);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

// Las transacciones de identidad pueden esperar un lock de fila (dos operaciones
// sobre la misma PyME o el mismo usuario a la vez). Los defaults de Prisma
// (maxWait 2s, timeout 5s) son justos contra Neon desde Argentina.
export const OPCIONES_TX = { maxWait: 10000, timeout: 20000 };

export const MENSAJE_YA_TIENE_PYME = 'Ya perteneces a una PyME';
export const MENSAJE_ULTIMO_RESPONSABLE =
  'La PyME tiene que tener al menos un responsable activo: promove a otro miembro antes';

// ─── Locks ───────────────────────────────────────────────────────────────────
//
// Las invariantes de identidad no se pueden expresar como constraints (el
// pedido fue explicito: nada de constraints nuevos sobre CUIT, y "una PyME
// activa por usuario" / "al menos un responsable" no son constraints de fila).
// Se sostienen serializando las operaciones que las pueden romper:
//
// - Lock de la fila del USUARIO: crear PyME y canjear un codigo. Dos canjes del
//   mismo usuario, o crear una PyME mientras canjea, quedan en fila y el segundo
//   ve la membresia que creo el primero.
// - Lock de la fila de la ORGANIZACION: cambiar rol, eliminar e irse. Dos
//   responsables degradandose a la vez quedan en fila y el segundo ve que es el
//   ultimo.
// - Advisory lock por CUIT: crear y editar. Sin constraint, dos altas con el
//   mismo CUIT a la vez pasarian las dos el findFirst.
//
// Los dos primeros nunca se toman en la misma transaccion, asi que no hay orden
// de locks que pueda hacer deadlock.

export async function bloquearUsuario(tx, id_usuario) {
  await tx.$executeRaw`SELECT 1 FROM usuarios WHERE id_usuario = ${id_usuario} FOR UPDATE`;
}

async function bloquearOrganizacion(tx, id_organizacion) {
  const n = await tx.$executeRaw`SELECT 1 FROM organizaciones WHERE id_organizacion = ${id_organizacion} FOR UPDATE`;
  if (n === 0) throw new ErrorNegocio(404, 'PyME no encontrada');
}

async function bloquearCuit(tx, cuit) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'org-cuit:' + cuit}::text))`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export const MENSAJE_SUSPENDIDA_VIAJES = 'La PyME esta suspendida: no puede crear ni modificar viajes';

// 403 si la PyME esta SUSPENDIDA: no puede generar trabajo nuevo (crear, editar
// y reasignar viajes; crear series; crear y editar lugares). Cancelar sigue
// permitido. El mensaje lo elige el caller.
export async function exigirPymeOperativa(id_organizacion, mensaje = MENSAJE_SUSPENDIDA_VIAJES) {
  const org = await prisma.organizacion.findUnique({
    where: { id_organizacion },
    select: { estado: true },
  });
  if (!org) throw new ErrorNegocio(404, 'PyME no encontrada');
  if (org.estado === 'SUSPENDIDA') throw new ErrorNegocio(403, mensaje);
}

// Tira 409 si el usuario ya llego al tope de PyMEs activas. Con `db` = tx se
// usa DESPUES de bloquearUsuario; con `db` = prisma es el chequeo previo que da
// el error explicito antes de tocar nada.
export async function asegurarCupoMembresia(db, id_usuario) {
  const activas = await db.miembroOrganizacion.count({ where: { id_usuario, activo: true } });
  if (activas >= maxOrganizacionesPorUsuario()) {
    throw new ErrorNegocio(409, MENSAJE_YA_TIENE_PYME);
  }
}

async function asegurarCuitLibre(tx, cuit, idExcluir = null) {
  const otra = await tx.organizacion.findFirst({
    where: { cuit, ...(idExcluir ? { id_organizacion: { not: idExcluir } } : {}) },
    select: { id_organizacion: true },
  });
  if (otra) throw new ErrorNegocio(409, 'Ya existe una PyME con ese CUIT');
}

function validarCuitONegocio(raw) {
  const v = validarCuit(raw);
  if (!v.ok) throw new ErrorNegocio(400, v.error);
  return v.cuit;
}

const membresiaActiva = (db, id_organizacion, id_usuario) =>
  db.miembroOrganizacion.findFirst({ where: { id_organizacion, id_usuario, activo: true } });

const contarResponsables = (tx, id_organizacion) =>
  tx.miembroOrganizacion.count({ where: { id_organizacion, activo: true, rol: 'RESPONSABLE' } });

// El permiso se chequea en el middleware, pero las operaciones sobre miembros lo
// RE-chequean adentro de la transaccion, ya con la PyME bloqueada: entre el
// middleware y el lock otro responsable lo pudo haber degradado o eliminado.
async function exigirResponsable(tx, id_organizacion, id_usuario) {
  const m = await membresiaActiva(tx, id_organizacion, id_usuario);
  if (!m || m.rol !== 'RESPONSABLE') {
    throw new ErrorNegocio(403, 'Solo un responsable puede hacer esto');
  }
}

export function serializarOrganizacion(org, mi_rol) {
  return {
    id_organizacion: org.id_organizacion,
    nombre: org.nombre,
    cuit: org.cuit,
    razon_social: org.razon_social,
    direccion: org.direccion,
    estado: org.estado,
    creado_en: org.creado_en,
    actualizado_en: org.actualizado_en,
    mi_rol,
  };
}

// ─── Organizacion ────────────────────────────────────────────────────────────

// Solo un usuario sin membresia activa. En la MISMA transaccion queda como
// RESPONSABLE: no existe una PyME sin responsable ni por un instante.
export async function crearOrganizacion({ id_usuario, nombre, cuit, razon_social, direccion }) {
  // Chequeo previo, sin lock: da el error explicito "ya tenes PyME" sin abrir
  // una transaccion. El que vale es el de adentro.
  await asegurarCupoMembresia(prisma, id_usuario);
  const cuitNormalizado = validarCuitONegocio(cuit);

  const org = await prisma.$transaction(async (tx) => {
    await bloquearUsuario(tx, id_usuario);
    await asegurarCupoMembresia(tx, id_usuario);
    await bloquearCuit(tx, cuitNormalizado);
    await asegurarCuitLibre(tx, cuitNormalizado);
    return tx.organizacion.create({
      data: {
        nombre,
        cuit: cuitNormalizado,
        razon_social: razon_social ?? null,
        direccion: direccion ?? null,
        miembros: { create: { id_usuario, rol: 'RESPONSABLE' } },
      },
    });
  }, OPCIONES_TX);

  return serializarOrganizacion(org, 'RESPONSABLE');
}

export async function obtenerOrganizacion(id_organizacion, mi_rol) {
  const org = await prisma.organizacion.findUnique({ where: { id_organizacion } });
  if (!org) throw new ErrorNegocio(404, 'PyME no encontrada');
  return serializarOrganizacion(org, mi_rol);
}

// Campos parciales: solo se tocan los que vienen. razon_social y direccion
// aceptan null para borrarlos.
export async function editarOrganizacion({ id_organizacion, id_usuario, datos }) {
  const data = {};
  if (datos.nombre !== undefined) data.nombre = datos.nombre;
  if (datos.razon_social !== undefined) data.razon_social = datos.razon_social;
  if (datos.direccion !== undefined) data.direccion = datos.direccion;
  if (datos.cuit !== undefined) data.cuit = validarCuitONegocio(datos.cuit);

  const org = await prisma.$transaction(async (tx) => {
    await bloquearOrganizacion(tx, id_organizacion);
    await exigirResponsable(tx, id_organizacion, id_usuario);
    if (data.cuit) {
      await bloquearCuit(tx, data.cuit);
      await asegurarCuitLibre(tx, data.cuit, id_organizacion);
    }
    return tx.organizacion.update({ where: { id_organizacion }, data });
  }, OPCIONES_TX);

  return serializarOrganizacion(org, 'RESPONSABLE');
}

// Para GET /api/auth/me de un CLIENTE: su PyME activa, o null si es huerfano.
// Con MAX_ORGANIZACIONES_POR_USUARIO > 1 devolveria la mas reciente; el perfil
// todavia modela una sola.
export async function organizacionActivaDe(id_usuario) {
  const m = await prisma.miembroOrganizacion.findFirst({
    where: { id_usuario, activo: true },
    orderBy: { fecha_alta: 'desc' },
    include: { organizacion: { select: { id_organizacion: true, nombre: true, estado: true } } },
  });
  if (!m) return null;
  return { ...m.organizacion, rol: m.rol };
}

// ─── Miembros ────────────────────────────────────────────────────────────────

export async function listarMiembros(id_organizacion) {
  const miembros = await prisma.miembroOrganizacion.findMany({
    where: { id_organizacion, activo: true },
    orderBy: [{ fecha_alta: 'asc' }, { id_miembro: 'asc' }],
    include: {
      usuario: { select: { id_usuario: true, nombre: true, apellido: true, email: true, telefono: true } },
    },
  });
  return miembros.map((m) => ({ ...m.usuario, rol: m.rol, fecha_alta: m.fecha_alta }));
}

// Promover (MIEMBRO -> RESPONSABLE) o degradar (RESPONSABLE -> MIEMBRO). Un
// responsable se puede degradar a si mismo, salvo que sea el ultimo.
export async function cambiarRol({ id_organizacion, id_actor, id_usuario, rol }) {
  return prisma.$transaction(async (tx) => {
    await bloquearOrganizacion(tx, id_organizacion);
    await exigirResponsable(tx, id_organizacion, id_actor);

    const m = await membresiaActiva(tx, id_organizacion, id_usuario);
    if (!m) throw new ErrorNegocio(404, 'Miembro no encontrado');
    if (m.rol === rol) return { id_usuario, rol };

    if (m.rol === 'RESPONSABLE' && (await contarResponsables(tx, id_organizacion)) <= 1) {
      throw new ErrorNegocio(409, MENSAJE_ULTIMO_RESPONSABLE);
    }
    await tx.miembroOrganizacion.update({ where: { id_miembro: m.id_miembro }, data: { rol } });
    return { id_usuario, rol };
  }, OPCIONES_TX);
}

// Baja de una membresia, compartida por "eliminar" e "irse". Con la PyME ya
// bloqueada: si el que se va es responsable, cuenta cuantos quedan.
async function darDeBaja(tx, id_organizacion, m, motivo, baja_por_id_usuario) {
  if (m.rol === 'RESPONSABLE' && (await contarResponsables(tx, id_organizacion)) <= 1) {
    throw new ErrorNegocio(409, MENSAJE_ULTIMO_RESPONSABLE);
  }
  await tx.miembroOrganizacion.update({
    where: { id_miembro: m.id_miembro },
    data: { activo: false, fecha_baja: new Date(), motivo_baja: motivo, baja_por_id_usuario },
  });
}

// Un responsable elimina a otro miembro (o a otro responsable). Si se elimina a
// SI MISMO cuenta como irse (motivo SE_FUE) — y es el unico camino por el que
// eliminar puede chocar con "ultimo responsable": si el actor es responsable y
// el target es otro responsable, hay al menos dos.
export async function eliminarMiembro({ id_organizacion, id_actor, id_usuario }) {
  await prisma.$transaction(async (tx) => {
    await bloquearOrganizacion(tx, id_organizacion);
    await exigirResponsable(tx, id_organizacion, id_actor);
    const m = await membresiaActiva(tx, id_organizacion, id_usuario);
    if (!m) throw new ErrorNegocio(404, 'Miembro no encontrado');
    const motivo = id_actor === id_usuario ? 'SE_FUE' : 'ELIMINADO';
    await darDeBaja(tx, id_organizacion, m, motivo, id_actor);
  }, OPCIONES_TX);
}

export async function salirDeOrganizacion({ id_organizacion, id_usuario }) {
  await prisma.$transaction(async (tx) => {
    await bloquearOrganizacion(tx, id_organizacion);
    const m = await membresiaActiva(tx, id_organizacion, id_usuario);
    if (!m) throw new ErrorNegocio(403, 'No perteneces a esta PyME');
    await darDeBaja(tx, id_organizacion, m, 'SE_FUE', id_usuario);
  }, OPCIONES_TX);
}
