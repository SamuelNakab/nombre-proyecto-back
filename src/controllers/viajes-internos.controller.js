// HTTP del ciclo del viaje INTERNO (Paso 2): Zod + respuesta. La logica vive en
// viaje-interno.service.js.
//
// - PyME:   /api/organizaciones/:id/viajes...   (requireMiembro deja
//           req.id_organizacion; cualquier miembro activo)
// - Chofer: /api/choferes/viajes...             (rol CONDUCTOR)
//
// Ciclo por parada (Paso 3): la llegada a cada parada se confirma con
// POST /api/viajes/:id/confirmar-parada y la salida con
// POST /api/choferes/viajes/:id/salir. PATCH /api/viajes/:id/estado NO aplica a
// viajes internos.
import { z } from 'zod';
import { responderErrorNegocio } from '../services/error-negocio.js';
import { calcularCostoAcumulado } from '../services/costo.service.js';
import {
  schemaParadasInternas,
  schemaFechaProgramada,
  schemaMotivo,
  schemaDescripcion,
} from '../services/viaje-validacion.js';
import {
  ESTADOS_INTERNOS,
  GRUPOS_PYME,
  GRUPOS_CHOFER,
  listarViajesOrganizacion,
  obtenerViajeOrganizacion,
  listarViajesChofer,
  obtenerViajeChofer,
  remitoOrganizacion,
  viajeParaCostoAcumulado,
  crearViajeInterno,
  confirmarViaje as confirmarViajeSrv,
  rechazarViaje as rechazarViajeSrv,
  iniciarViajeInterno,
  salirDeParada,
  cancelarViajeChofer as cancelarViajeChoferSrv,
  cancelarViajeOrganizacion,
  finalizarViajeOrganizacion,
  reasignarViaje as reasignarViajeSrv,
  editarViaje as editarViajeSrv,
} from '../services/viaje-interno.service.js';
import { io } from '../sockets/index.js';
import { responder400 } from '../services/errores-validacion.js';
import { idParam } from '../services/id-param.js';
import { ID_MAX } from '../services/id-param.js';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const idPositivo = (campo) =>
  z
    .number({ error: `${campo} es requerido` })
    .int(`${campo} invalido`)
    .positive(`${campo} invalido`)
    .max(ID_MAX, `${campo} invalido`);

// Sin condiciones_requeridas (pedido del front 20-10-2026): el ciclo interno no
// las pide ni las valida. Si un cliente viejo las manda, z.object las descarta
// sin error (y lo mismo `zona`, que se acepta y se ignora como en la legacy).
const schemaCrear = z.object({
  id_conductor: idPositivo('id_conductor'),
  zona: z.enum(['CABA', 'PROVINCIA', 'MIXTO']).optional(),
  paradas: schemaParadasInternas,
  fecha_programada: schemaFechaProgramada,
  motivo: schemaMotivo,
  descripcion: schemaDescripcion,
});

// motivo y descripcion opcionales en el body, pero si llegan, con las mismas
// reglas (null o vacio -> 400). Que el viaje QUEDE con los dos lo chequea el
// service (faltantesContenido): un viaje viejo sin motivo no se edita sin
// mandarlo.
const schemaEditar = z
  .object({
    zona: z.enum(['CABA', 'PROVINCIA', 'MIXTO']).optional(),
    paradas: schemaParadasInternas.optional(),
    fecha_programada: schemaFechaProgramada.optional(),
    motivo: schemaMotivo.optional(),
    descripcion: schemaDescripcion.optional(),
  })
  .refine(
    (d) =>
      d.paradas !== undefined ||
      d.fecha_programada !== undefined ||
      d.motivo !== undefined ||
      d.descripcion !== undefined,
    { message: 'Mandá al menos un campo para editar (paradas, fecha_programada, motivo o descripcion)' }
  );

const schemaReasignar = z.object({ id_conductor: idPositivo('id_conductor') });
const schemaConfirmar = z.object({ id_vehiculo: idPositivo('id_vehiculo') });
const schemaIniciar = z.object({
  lat: z.number({ error: 'lat es requerido' }),
  lng: z.number({ error: 'lng es requerido' }),
});
const schemaCancelar = z.object({ motivo: z.string().trim().min(1).max(500).optional() });

const schemaFiltros = (grupos) =>
  z.object({
    estado: z.enum(ESTADOS_INTERNOS, { error: 'Estado invalido' }).optional(),
    grupo: z
      .enum(Object.keys(grupos), { error: `grupo debe ser ${Object.keys(grupos).join(', ')}` })
      .optional(),
  });
const schemaFiltrosPyme = schemaFiltros(GRUPOS_PYME);
const schemaFiltrosChofer = schemaFiltros(GRUPOS_CHOFER);

// Envuelve un handler: los ErrorNegocio salen como { error } con su status; el
// resto lo toma el manejador global (errores.middleware.js).
const manejar = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (err) {
    return responderErrorNegocio(res, err);
  }
};

function idViajeDe(req, res, param) {
  const id = idParam(req.params[param]);
  if (!id) res.status(400).json({ error: 'id de viaje invalido' });
  return id;
}

// ─── PyME ────────────────────────────────────────────────────────────────────

// POST /api/organizaciones/:id/viajes
export const crearViaje = manejar(async (req, res) => {
  const parsed = schemaCrear.safeParse(req.body ?? {});
  if (!parsed.success) return responder400(res, parsed);
  const viaje = await crearViajeInterno({
    io,
    id_organizacion: req.id_organizacion,
    id_usuario: req.usuario.id_usuario,
    datos: parsed.data,
  });
  return res.status(201).json(viaje);
});

// GET /api/organizaciones/:id/viajes?estado=&grupo=
export const listarViajes = manejar(async (req, res) => {
  const parsed = schemaFiltrosPyme.safeParse(req.query ?? {});
  if (!parsed.success) return responder400(res, parsed);
  return res.status(200).json(await listarViajesOrganizacion(io, req.id_organizacion, parsed.data));
});

// GET /api/organizaciones/:id/viajes/:idViaje
export const obtenerViaje = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res, 'idViaje');
  if (!id_viaje) return;
  return res.status(200).json(await obtenerViajeOrganizacion(io, req.id_organizacion, id_viaje));
});

// PUT /api/organizaciones/:id/viajes/:idViaje
export const editarViaje = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res, 'idViaje');
  if (!id_viaje) return;
  const parsed = schemaEditar.safeParse(req.body ?? {});
  if (!parsed.success) return responder400(res, parsed);
  const viaje = await editarViajeSrv({
    io,
    id_organizacion: req.id_organizacion,
    id_usuario: req.usuario.id_usuario,
    id_viaje,
    datos: parsed.data,
  });
  return res.status(200).json(viaje);
});

// POST /api/organizaciones/:id/viajes/:idViaje/reasignar
export const reasignarViaje = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res, 'idViaje');
  if (!id_viaje) return;
  const parsed = schemaReasignar.safeParse(req.body ?? {});
  if (!parsed.success) return responder400(res, parsed);
  const viaje = await reasignarViajeSrv({
    io,
    id_organizacion: req.id_organizacion,
    id_usuario: req.usuario.id_usuario,
    id_viaje,
    id_conductor: parsed.data.id_conductor,
  });
  return res.status(200).json(viaje);
});

// POST /api/organizaciones/:id/viajes/:idViaje/cancelar
export const cancelarViajePyme = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res, 'idViaje');
  if (!id_viaje) return;
  const parsed = schemaCancelar.safeParse(req.body ?? {});
  if (!parsed.success) return responder400(res, parsed);
  const r = await cancelarViajeOrganizacion({
    io,
    id_organizacion: req.id_organizacion,
    id_usuario: req.usuario.id_usuario,
    id_viaje,
    motivo: parsed.data.motivo,
  });
  return res.status(200).json(r);
});

// POST /api/organizaciones/:id/viajes/:idViaje/finalizar — sin body (Tarea 5).
export const finalizarViajePyme = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res, 'idViaje');
  if (!id_viaje) return;
  const r = await finalizarViajeOrganizacion({
    io,
    id_organizacion: req.id_organizacion,
    id_usuario: req.usuario.id_usuario,
    id_viaje,
  });
  return res.status(200).json(r);
});

// GET /api/organizaciones/:id/viajes/:idViaje/costo-acumulado
export const costoAcumulado = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res, 'idViaje');
  if (!id_viaje) return;
  const viaje = await viajeParaCostoAcumulado(req.id_organizacion, id_viaje);
  return res.status(200).json(await calcularCostoAcumulado(viaje));
});

// GET /api/organizaciones/:id/viajes/:idViaje/remito
export const remito = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res, 'idViaje');
  if (!id_viaje) return;
  return res.status(200).json(await remitoOrganizacion(req.id_organizacion, id_viaje));
});

// ─── Chofer ──────────────────────────────────────────────────────────────────

// GET /api/choferes/viajes?grupo=&estado=
export const listarViajesChoferHttp = manejar(async (req, res) => {
  const parsed = schemaFiltrosChofer.safeParse(req.query ?? {});
  if (!parsed.success) return responder400(res, parsed);
  return res.status(200).json(await listarViajesChofer(io, req.usuario.id_usuario, parsed.data));
});

// GET /api/choferes/viajes/:id
export const obtenerViajeChoferHttp = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res, 'id');
  if (!id_viaje) return;
  return res.status(200).json(await obtenerViajeChofer(io, req.usuario.id_usuario, id_viaje));
});

// POST /api/choferes/viajes/:id/confirmar
export const confirmarViaje = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res, 'id');
  if (!id_viaje) return;
  const parsed = schemaConfirmar.safeParse(req.body ?? {});
  if (!parsed.success) return responder400(res, parsed);
  const r = await confirmarViajeSrv({
    io,
    id_usuario: req.usuario.id_usuario,
    id_viaje,
    id_vehiculo: parsed.data.id_vehiculo,
  });
  return res.status(200).json(r);
});

// POST /api/choferes/viajes/:id/rechazar
export const rechazarViaje = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res, 'id');
  if (!id_viaje) return;
  return res.status(200).json(await rechazarViajeSrv({ io, id_usuario: req.usuario.id_usuario, id_viaje }));
});

// POST /api/choferes/viajes/:id/iniciar
export const iniciarViaje = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res, 'id');
  if (!id_viaje) return;
  const parsed = schemaIniciar.safeParse(req.body ?? {});
  if (!parsed.success) return responder400(res, parsed);
  const r = await iniciarViajeInterno({
    io,
    id_usuario: req.usuario.id_usuario,
    id_viaje,
    lat: parsed.data.lat,
    lng: parsed.data.lng,
  });
  return res.status(200).json(r);
});

// POST /api/choferes/viajes/:id/salir — sin body.
export const salirDeParadaHttp = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res, 'id');
  if (!id_viaje) return;
  return res.status(200).json(await salirDeParada({ io, id_usuario: req.usuario.id_usuario, id_viaje }));
});

// POST /api/choferes/viajes/:id/cancelar
export const cancelarViajeChofer = manejar(async (req, res) => {
  const id_viaje = idViajeDe(req, res, 'id');
  if (!id_viaje) return;
  return res
    .status(200)
    .json(await cancelarViajeChoferSrv({ io, id_usuario: req.usuario.id_usuario, id_viaje }));
});
