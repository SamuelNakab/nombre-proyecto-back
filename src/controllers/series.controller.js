// HTTP de las SERIES de viajes de una PyME (Paso 4): Zod + respuesta. La logica
// vive en serie.service.js (fechas en serie-fechas.js). Rutas bajo
// /api/organizaciones/:id/series, cualquier miembro activo. Una serie de otra
// PyME da 404. El chofer NO tiene rutas de series: ve los viajes generados como
// viajes normales (con id_serie) en /api/choferes/viajes.
import { z } from 'zod';
import { responderErrorNegocio } from '../services/error-negocio.js';
import { schemaParadasInternas, schemaCondiciones } from '../services/viaje-validacion.js';
import { esHoraValida } from '../services/serie-fechas.js';
import { crearSerie, listarSeries, obtenerSerie, cancelarSerie } from '../services/serie.service.js';
import { io } from '../sockets/index.js';

const ESTADOS_SERIE = ['ACTIVA', 'CANCELADA', 'BORRADA'];

const diaSemana = (campo) =>
  z
    .number({ error: `${campo} es requerido` })
    .int(`${campo} debe ser un dia de 1 (lunes) a 7 (domingo)`)
    .min(1, `${campo} debe ser un dia de 1 (lunes) a 7 (domingo)`)
    .max(7, `${campo} debe ser un dia de 1 (lunes) a 7 (domingo)`);

const base = {
  id_conductor: z
    .number({ error: 'id_conductor es requerido' })
    .int('id_conductor invalido')
    .positive('id_conductor invalido'),
  hora: z
    .string({ error: 'hora es requerida' })
    .refine(esHoraValida, 'hora debe tener el formato HH:MM (00:00 a 23:59), hora de Argentina'),
  fecha_desde: z.string({ error: 'fecha_desde es requerida' }),
  fecha_hasta: z.string().optional(),
  paradas: schemaParadasInternas,
  condiciones_requeridas: schemaCondiciones.optional().default([]),
  descripcion: z.string().max(500).optional(),
};

const schemaCrear = z.discriminatedUnion(
  'frecuencia',
  [
    z.object({ frecuencia: z.literal('DIARIA'), ...base }),
    z.object({
      frecuencia: z.literal('DIAS_SEMANA'),
      ...base,
      dias_semana: z
        .array(diaSemana('dias_semana'), { error: 'dias_semana es requerido para DIAS_SEMANA' })
        .min(1, 'dias_semana tiene que tener al menos un dia')
        .refine((dias) => new Set(dias).size === dias.length, 'dias_semana tiene dias repetidos'),
    }),
    z.object({ frecuencia: z.literal('SEMANAL'), ...base, dia_semana: diaSemana('dia_semana') }),
    z.object({
      frecuencia: z.literal('MENSUAL'),
      ...base,
      dia_mes: z
        .number({ error: 'dia_mes es requerido para MENSUAL' })
        .int('dia_mes debe ser un dia de 1 a 31')
        .min(1, 'dia_mes debe ser un dia de 1 a 31')
        .max(31, 'dia_mes debe ser un dia de 1 a 31'),
    }),
  ],
  { error: 'frecuencia debe ser DIARIA, DIAS_SEMANA, SEMANAL o MENSUAL' }
);

const schemaFiltros = z.object({
  estado: z.enum(ESTADOS_SERIE, { error: `estado debe ser ${ESTADOS_SERIE.join(', ')}` }).optional(),
});

const error400 = (res, parsed) => res.status(400).json({ error: parsed.error.issues[0].message });

const manejar = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (err) {
    return responderErrorNegocio(res, err);
  }
};

function idSerieDe(req, res) {
  const n = Number(req.params.idSerie);
  if (Number.isInteger(n) && n > 0) return n;
  res.status(400).json({ error: 'id de serie invalido' });
  return null;
}

// POST /api/organizaciones/:id/series
export const crear = manejar(async (req, res) => {
  const parsed = schemaCrear.safeParse(req.body ?? {});
  if (!parsed.success) return error400(res, parsed);
  const r = await crearSerie({
    io,
    id_organizacion: req.id_organizacion,
    id_usuario: req.usuario.id_usuario,
    datos: parsed.data,
  });
  return res.status(201).json(r);
});

// GET /api/organizaciones/:id/series?estado=
export const listar = manejar(async (req, res) => {
  const parsed = schemaFiltros.safeParse(req.query ?? {});
  if (!parsed.success) return error400(res, parsed);
  return res.status(200).json(await listarSeries(io, req.id_organizacion, parsed.data));
});

// GET /api/organizaciones/:id/series/:idSerie
export const obtener = manejar(async (req, res) => {
  const id_serie = idSerieDe(req, res);
  if (!id_serie) return;
  return res.status(200).json(await obtenerSerie(io, req.id_organizacion, id_serie));
});

// POST /api/organizaciones/:id/series/:idSerie/cancelar
export const cancelar = manejar(async (req, res) => {
  const id_serie = idSerieDe(req, res);
  if (!id_serie) return;
  return res.status(200).json(
    await cancelarSerie({ io, id_organizacion: req.id_organizacion, id_usuario: req.usuario.id_usuario, id_serie })
  );
});
