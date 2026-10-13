// HTTP de los LUGARES GUARDADOS de una PyME (Paso 4): Zod + respuesta. La logica
// vive en lugar.service.js. Rutas bajo /api/organizaciones/:id/lugares, cualquier
// miembro activo (requireMiembro deja req.id_organizacion). Un lugar de otra PyME
// da 404, igual que uno que no existe.
import { z } from 'zod';
import { responderErrorNegocio } from '../services/error-negocio.js';
import { listarLugares, crearLugar, editarLugar, borrarLugar } from '../services/lugar.service.js';

const nombre = z
  .string({ error: 'nombre es requerido' })
  .trim()
  .min(1, 'nombre es requerido')
  .max(80, 'nombre puede tener como maximo 80 caracteres');
const direccion = z
  .string({ error: 'direccion es requerida' })
  .trim()
  .min(1, 'direccion es requerida')
  .max(300, 'direccion puede tener como maximo 300 caracteres');
const lat = z.number({ error: 'lat es requerido' }).min(-90, 'lat invalida').max(90, 'lat invalida');
const lng = z.number({ error: 'lng es requerido' }).min(-180, 'lng invalida').max(180, 'lng invalida');

const schemaCrear = z.object({ nombre, direccion, lat, lng });
const schemaEditar = z
  .object({ nombre: nombre.optional(), direccion: direccion.optional(), lat: lat.optional(), lng: lng.optional() })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: 'Mandá al menos un campo para editar (nombre, direccion, lat o lng)',
  });

const error400 = (res, parsed) => res.status(400).json({ error: parsed.error.issues[0].message });

const manejar = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (err) {
    return responderErrorNegocio(res, err);
  }
};

function idLugarDe(req, res) {
  const n = Number(req.params.idLugar);
  if (Number.isInteger(n) && n > 0) return n;
  res.status(400).json({ error: 'id de lugar invalido' });
  return null;
}

// GET /api/organizaciones/:id/lugares
export const listar = manejar(async (req, res) => res.status(200).json(await listarLugares(req.id_organizacion)));

// POST /api/organizaciones/:id/lugares
export const crear = manejar(async (req, res) => {
  const parsed = schemaCrear.safeParse(req.body ?? {});
  if (!parsed.success) return error400(res, parsed);
  const lugar = await crearLugar({
    id_organizacion: req.id_organizacion,
    id_usuario: req.usuario.id_usuario,
    datos: parsed.data,
  });
  return res.status(201).json(lugar);
});

// PUT /api/organizaciones/:id/lugares/:idLugar
export const editar = manejar(async (req, res) => {
  const id_lugar = idLugarDe(req, res);
  if (!id_lugar) return;
  const parsed = schemaEditar.safeParse(req.body ?? {});
  if (!parsed.success) return error400(res, parsed);
  return res
    .status(200)
    .json(await editarLugar({ id_organizacion: req.id_organizacion, id_lugar, datos: parsed.data }));
});

// DELETE /api/organizaciones/:id/lugares/:idLugar (soft delete)
export const borrar = manejar(async (req, res) => {
  const id_lugar = idLugarDe(req, res);
  if (!id_lugar) return;
  return res.status(200).json(
    await borrarLugar({ id_organizacion: req.id_organizacion, id_usuario: req.usuario.id_usuario, id_lugar })
  );
});
