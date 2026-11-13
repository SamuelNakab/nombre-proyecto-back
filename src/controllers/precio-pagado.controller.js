// HTTP del feedback del PRECIO PAGADO (Parte D del precio v2). La logica vive en
// precio-pagado.service.js. Rutas bajo /api/organizaciones/:id/viajes, cualquier
// miembro activo (RESPONSABLE o MIEMBRO). El chofer no llega: el router exige
// rol CLIENTE y membresia.
import { z } from 'zod';
import { responderErrorNegocio } from '../services/error-negocio.js';
import { responder400 } from '../services/errores-validacion.js';
import { idParam } from '../services/id-param.js';
import { configPrecio } from '../config/precio.js';
import { obtenerPrecioPagado, guardarPrecioPagado, listarPendientes } from '../services/precio-pagado.service.js';

export const METODOS_PAGO = ['EFECTIVO', 'TRANSFERENCIA', 'OTRO'];
export const AYUDANTES_REALES_MAX = 10;
export const COMENTARIO_MAX = 500;

// El tope del monto sale del env en cada request (FEEDBACK_PRECIO_MONTO_MAX).
const schemaPrecioPagado = () => {
  const max = configPrecio().FEEDBACK_PRECIO_MONTO_MAX;
  return z.object({
    monto: z
      .number({ error: (i) => (i.input === undefined ? 'monto es requerido' : 'monto debe ser un numero') })
      .int('monto debe ser un entero (pesos)')
      .positive('monto debe ser mayor a 0')
      .max(max, `monto puede ser como máximo ${max}`),
    incluye_iva: z.boolean({
      error: (i) => (i.input === undefined ? 'incluye_iva es requerido' : 'incluye_iva debe ser true o false'),
    }),
    monto_peajes: z
      .number()
      .int('monto_peajes debe ser un entero (pesos)')
      .min(0, 'monto_peajes no puede ser negativo')
      .max(max, `monto_peajes puede ser como máximo ${max}`)
      .nullable()
      .optional(),
    metodo_pago: z.enum(METODOS_PAGO).nullable().optional(),
    ayudantes_reales: z
      .number()
      .int('ayudantes_reales debe ser un entero')
      .min(0, 'ayudantes_reales no puede ser negativo')
      .max(AYUDANTES_REALES_MAX, `ayudantes_reales puede ser como máximo ${AYUDANTES_REALES_MAX}`)
      .nullable()
      .optional(),
    comentario: z
      .string()
      .trim()
      .min(1, 'comentario no puede estar vacio')
      .max(COMENTARIO_MAX, `comentario puede tener como máximo ${COMENTARIO_MAX} caracteres`)
      .nullable()
      .optional(),
  });
};

const schemaPaginacion = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).default(50).transform((n) => Math.min(n, 200)),
});

const manejar = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (err) {
    return responderErrorNegocio(res, err);
  }
};

function idViajeDe(req, res) {
  const id = idParam(req.params.idViaje);
  if (!id) res.status(400).json({ error: 'id de viaje invalido' });
  return id;
}

// GET /api/organizaciones/:id/viajes/:idViaje/precio-pagado
export const obtener = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res);
  if (!id_viaje) return;
  return res.status(200).json(await obtenerPrecioPagado(req.id_organizacion, id_viaje));
});

// PUT /api/organizaciones/:id/viajes/:idViaje/precio-pagado
export const guardar = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res);
  if (!id_viaje) return;
  const parsed = schemaPrecioPagado().safeParse(req.body ?? {});
  if (!parsed.success) return responder400(res, parsed);
  const r = await guardarPrecioPagado({
    id_organizacion: req.id_organizacion,
    id_viaje,
    id_usuario: req.usuario.id_usuario,
    datos: parsed.data,
  });
  return res.status(r.creado ? 201 : 200).json(r);
});

// GET /api/organizaciones/:id/viajes/precio-pagado/pendientes?page=&limit=
export const pendientes = manejar(async (req, res) => {
  const parsed = schemaPaginacion.safeParse(req.query ?? {});
  if (!parsed.success) return responder400(res, parsed);
  return res.status(200).json(await listarPendientes(req.id_organizacion, parsed.data));
});
