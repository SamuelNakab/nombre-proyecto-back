import { createHmac, randomInt } from 'crypto';
import prisma from '../config/prisma.js';
import { ErrorNegocio } from './error-negocio.js';
import {
  OPCIONES_TX,
  bloquearUsuario,
  asegurarCupoMembresia,
} from './organizacion.service.js';

// ─── Codigo ──────────────────────────────────────────────────────────────────

// Mismo alfabeto que el codigo_afiliacion de las empresas: sin caracteres
// ambiguos (0/O, 1/I/L), para dictarlo por telefono sin errores. Se replica en
// vez de importarlo porque afiliacion.service no lo exporta y es del Paso 2.
export const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const LARGO_CODIGO = 10;

// 31^10 ≈ 8e14 combinaciones, con crypto.randomInt (no Math.random).
export function generarCodigo() {
  let codigo = '';
  for (let i = 0; i < LARGO_CODIGO; i++) {
    codigo += ALFABETO_CODIGO[randomInt(ALFABETO_CODIGO.length)];
  }
  return codigo;
}

// Como se le muestra al usuario: XXXXX-XXXXX.
export function formatearCodigo(codigo) {
  return `${codigo.slice(0, 5)}-${codigo.slice(5)}`;
}

// El canje ignora guiones, espacios y mayusculas.
export function normalizarCodigo(raw) {
  return String(raw ?? '').replace(/[-\s]/g, '').toUpperCase();
}

// ─── Secreto y configuracion ─────────────────────────────────────────────────

// null si falta (o esta vacio). Sin secreto el server arranca igual, pero los
// endpoints de invitaciones responden 503 (requireInvitacionesConfiguradas).
// Se lee en cada llamada: no se cachea en el modulo.
export function secretoInvitaciones() {
  const s = process.env.INVITACION_SECRETO;
  return s && s.trim() ? s : null;
}

// En la base se guarda SOLO esto: HMAC-SHA256 del codigo normalizado. Con el
// hash solo no se puede reconstruir el codigo, y sin el secreto tampoco se puede
// probar un codigo contra la tabla.
export function hashCodigo(codigoNormalizado, secreto = secretoInvitaciones()) {
  if (!secreto) throw new Error('INVITACION_SECRETO no configurado');
  return createHmac('sha256', secreto).update(codigoNormalizado).digest('hex');
}

function numeroPositivo(valor, porDefecto) {
  const n = parseFloat(valor);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}

export const vigenciaHoras = () => numeroPositivo(process.env.INVITACION_VIGENCIA_HORAS, 72);
export const intentosMaxCanje = () => Math.floor(numeroPositivo(process.env.INVITACION_INTENTOS_MAX, 5));
export const ventanaCanjeMinutos = () => numeroPositivo(process.env.INVITACION_VENTANA_MINUTOS, 15);

// ─── Alta, listado y revocacion ──────────────────────────────────────────────

// Devuelve el codigo EN CLARO. Es la unica vez que existe fuera de la memoria
// del proceso: despues solo queda el hash.
export async function crearInvitacion({ id_organizacion, tipo, id_usuario }) {
  const fecha_vencimiento = new Date(Date.now() + vigenciaHoras() * 3600 * 1000);

  // Una colision de hash (mismo codigo generado dos veces) choca contra el
  // @unique de codigo_hash: se reintenta con otro codigo.
  for (let intento = 0; intento < 5; intento++) {
    const codigo = generarCodigo();
    try {
      const inv = await prisma.invitacion.create({
        data: {
          id_organizacion,
          tipo,
          codigo_hash: hashCodigo(codigo),
          creada_por_id_usuario: id_usuario,
          fecha_vencimiento,
        },
      });
      return {
        id_invitacion: inv.id_invitacion,
        tipo: inv.tipo,
        codigo: formatearCodigo(codigo),
        fecha_creacion: inv.fecha_creacion,
        fecha_vencimiento: inv.fecha_vencimiento,
      };
    } catch (err) {
      if (err.code !== 'P2002') throw err;
    }
  }
  throw new Error('No se pudo generar un codigo de invitacion unico');
}

const wherePendiente = (ahora) => ({
  fecha_uso: null,
  fecha_revocacion: null,
  fecha_vencimiento: { gt: ahora },
});

// Pendientes = sin usar, sin revocar y sin vencer. Nunca muestra el codigo (no
// se tiene) ni el hash.
export async function listarPendientes(id_organizacion) {
  const invitaciones = await prisma.invitacion.findMany({
    where: { id_organizacion, ...wherePendiente(new Date()) },
    orderBy: [{ fecha_creacion: 'desc' }, { id_invitacion: 'desc' }],
    select: {
      id_invitacion: true,
      tipo: true,
      fecha_creacion: true,
      fecha_vencimiento: true,
      creada_por_id_usuario: true,
    },
  });

  // creada_por_id_usuario no tiene FK (mismo criterio que el historial): los
  // nombres se resuelven en una sola query aparte.
  const ids = [...new Set(invitaciones.map((i) => i.creada_por_id_usuario))];
  const usuarios = await prisma.usuario.findMany({
    where: { id_usuario: { in: ids } },
    select: { id_usuario: true, nombre: true, apellido: true },
  });
  const porId = new Map(usuarios.map((u) => [u.id_usuario, u]));

  return invitaciones.map(({ creada_por_id_usuario, ...inv }) => ({
    ...inv,
    creada_por: porId.get(creada_por_id_usuario) ?? { id_usuario: creada_por_id_usuario },
  }));
}

// Las de MIEMBRO solo las revoca un responsable; las de CHOFER, cualquier
// miembro. Condicionado a pendiente: una ya usada, vencida o revocada da 409.
export async function revocarInvitacion({ id_organizacion, id_invitacion, id_usuario, esResponsable }) {
  const inv = await prisma.invitacion.findFirst({ where: { id_invitacion, id_organizacion } });
  if (!inv) throw new ErrorNegocio(404, 'Invitacion no encontrada');
  if (inv.tipo === 'MIEMBRO' && !esResponsable) {
    throw new ErrorNegocio(403, 'Solo un responsable puede revocar invitaciones de miembro');
  }
  const r = await prisma.invitacion.updateMany({
    where: { id_invitacion, ...wherePendiente(new Date()) },
    data: { fecha_revocacion: new Date(), revocada_por_id_usuario: id_usuario },
  });
  if (r.count === 0) throw new ErrorNegocio(409, 'La invitacion ya no esta pendiente');
}

// ─── Canje ───────────────────────────────────────────────────────────────────

// EXACTAMENTE el mismo status y mensaje para cualquier falla del codigo: no
// existe, vencido, usado, revocado, de otro tipo, o perdio la carrera contra
// otro canje. Distinguirlos le diria a un atacante que codigos existen.
export const STATUS_CODIGO_INVALIDO = 400;
export const MENSAJE_CODIGO_INVALIDO = 'Codigo invalido';
const codigoInvalido = () => new ErrorNegocio(STATUS_CODIGO_INVALIDO, MENSAJE_CODIGO_INVALIDO);

const FORMATO_CODIGO = new RegExp(`^[${ALFABETO_CODIGO}]{${LARGO_CODIGO}}$`);

// Un CLIENTE solo canjea codigos de MIEMBRO (queda como MIEMBRO); un CONDUCTOR
// solo de CHOFER (queda vinculado). El tipo cruzado es "codigo invalido".
//
// Atomicidad:
// - Lock de la fila del usuario: dos canjes suyos a la vez, o un canje mientras
//   crea una PyME, quedan en fila; el segundo ve lo que hizo el primero.
// - Marcar el codigo como usado es un updateMany condicionado a pendiente, en la
//   MISMA transaccion que crea la membresia o el vinculo. Dos usuarios con el
//   mismo codigo: el segundo UPDATE espera el lock de la fila de la invitacion,
//   re-evalua el WHERE con fecha_uso ya seteada y matchea 0 -> codigo invalido.
export async function canjearCodigo({ usuario, codigo }) {
  const esCliente = usuario.rol === 'CLIENTE';
  const tipoEsperado = esCliente ? 'MIEMBRO' : 'CHOFER';
  const { id_usuario } = usuario;

  // Errores del ESTADO del usuario: explicitos y ANTES de buscar el codigo.
  let id_conductor = null;
  if (esCliente) {
    await asegurarCupoMembresia(prisma, id_usuario);
  } else {
    const conductor = await prisma.conductor.findUnique({ where: { id_usuario }, select: { id_conductor: true } });
    if (!conductor) throw new ErrorNegocio(400, 'El usuario no tiene perfil de conductor');
    id_conductor = conductor.id_conductor;
  }

  const normalizado = normalizarCodigo(codigo);
  if (!FORMATO_CODIGO.test(normalizado)) throw codigoInvalido();
  const codigo_hash = hashCodigo(normalizado);

  return prisma.$transaction(async (tx) => {
    await bloquearUsuario(tx, id_usuario);
    // Re-chequeo con el usuario bloqueado: el previo pudo quedar viejo.
    if (esCliente) await asegurarCupoMembresia(tx, id_usuario);

    const ahora = new Date();
    const inv = await tx.invitacion.findUnique({
      where: { codigo_hash },
      include: { organizacion: { select: { id_organizacion: true, nombre: true, estado: true } } },
    });
    if (
      !inv ||
      inv.tipo !== tipoEsperado ||
      inv.fecha_uso !== null ||
      inv.fecha_revocacion !== null ||
      inv.fecha_vencimiento <= ahora
    ) {
      throw codigoInvalido();
    }

    // "Ya vinculado a ESA PyME" solo se puede saber con el codigo resuelto (es
    // el codigo el que dice de que PyME es). Recien aca, con un codigo valido, y
    // sin consumirlo: solo se entera quien tiene un codigo bueno.
    if (!esCliente) {
      const yaVinculado = await tx.vinculoChofer.count({
        where: { id_organizacion: inv.id_organizacion, id_conductor, activo: true },
      });
      if (yaVinculado > 0) throw new ErrorNegocio(409, 'Ya estas vinculado a esta PyME');
    }

    const marcado = await tx.invitacion.updateMany({
      where: { id_invitacion: inv.id_invitacion, ...wherePendiente(ahora) },
      data: { fecha_uso: ahora, usada_por_id_usuario: id_usuario },
    });
    if (marcado.count === 0) throw codigoInvalido();

    if (esCliente) {
      await tx.miembroOrganizacion.create({
        data: { id_organizacion: inv.id_organizacion, id_usuario, rol: 'MIEMBRO' },
      });
      return {
        mensaje: 'Te uniste a la PyME',
        tipo: 'MIEMBRO',
        organizacion: { ...inv.organizacion, rol: 'MIEMBRO' },
      };
    }

    await tx.vinculoChofer.create({
      data: { id_organizacion: inv.id_organizacion, id_conductor, id_invitacion: inv.id_invitacion },
    });
    return {
      mensaje: 'Quedaste vinculado a la PyME',
      tipo: 'CHOFER',
      organizacion: { id_organizacion: inv.organizacion.id_organizacion, nombre: inv.organizacion.nombre },
    };
  }, OPCIONES_TX);
}
