import { z } from 'zod';
import * as turf from '@turf/turf';
import prisma from '../config/prisma.js';
import { estimarCosto as estimarCostoService } from '../services/costo.service.js';
import { conductorEsElegible } from '../services/elegibilidad.service.js';
import { publicarViajeAConductoresElegibles } from '../services/matching.service.js';
import { obtenerAcumulado } from '../services/gps.service.js';
import { cerrarViaje } from '../services/cierre.service.js';
import { recalcularEtaInmediato } from '../services/eta-emisor.js';
import { limpiarViajeActivo } from '../services/cancelacion.service.js';
import {
  programarTimeoutReserva,
  cancelarTimeoutReserva,
} from '../services/reserva.service.js';
import { calcularYGuardarRuta, obtenerRutaPlaneada } from '../services/ruta.service.js';
import { validarTransicion } from '../services/estado-viaje.service.js';
import { repartirPorZona } from '../services/zona.service.js';
import { horasAMinutos, calcularDuracionRealMinutos } from '../services/duracion.service.js';
import {
  puedeVerViaje,
  puedeVerViajeDisponible,
  INCLUDE_ACCESO_VIAJE,
} from '../services/acceso-viaje.service.js';
import { io } from '../sockets/index.js';

// ─── Schemas de validacion ───────────────────────────────────────────────────

const CONDICIONES = ['FRAGIL', 'REFRIGERADO', 'CARGA_PESADA', 'PELIGROSO', 'VOLUMINOSO'];

const camposBase = {
  // `zona` se acepta SOLO por compatibilidad con el front actual, que la sigue
  // mandando. Su valor se IGNORA: la zona real se calcula en el servidor a
  // partir de las coordenadas de las paradas (clasificarZona). Ver zona.service.
  zona: z.enum(['CABA', 'PROVINCIA', 'MIXTO']).optional(),
  paradas: z
    .array(
      z.object({
        lat: z.number(),
        lng: z.number(),
        direccion: z.string().min(1).optional(),
      })
    )
    .min(2),
};

const schemaEstimar = z.object({
  ...camposBase,
  fecha_programada: z.string().optional(),
});

// Anticipacion minima para programar un viaje. Configurable porque en
// staging/local hay que poder crear viajes y debuggearlos sin esperar una hora.
// Se lee en CADA request (no se cachea en el modulo) para que el umbral y el
// mensaje de error no se puedan desincronizar, y para poder cambiarla sin
// redeploy de codigo.
const ANTICIPACION_MINIMA_DEFAULT = 60;

function anticipacionMinimaMinutos() {
  const valor = Number(process.env.ANTICIPACION_MINIMA_MINUTOS ?? ANTICIPACION_MINIMA_DEFAULT);
  // Un valor basura (NaN) o negativo se ignora: sin este guard, NaN haria que
  // TODA comparacion diera false y no se pudiera crear ningun viaje.
  if (!Number.isFinite(valor) || valor < 0) return ANTICIPACION_MINIMA_DEFAULT;
  return valor;
}

const schemaCrear = z.object({
  ...camposBase,
  fecha_programada: z.string().superRefine((val, ctx) => {
    const minutos = anticipacionMinimaMinutos();
    const date = new Date(val);
    // El piso es "futura" y no depende de la variable: con la anticipacion en 0
    // el minimo queda en `ahora` y la comparacion estricta (<=) igual rechaza el
    // presente y el pasado. Por eso anticipacionMinimaMinutos() nunca devuelve
    // un negativo: correria el minimo hacia atras y dejaria pasar fechas pasadas.
    const minimo = new Date(Date.now() + minutos * 60 * 1000);
    if (isNaN(date.getTime()) || date <= minimo) {
      ctx.addIssue({
        code: 'custom',
        message: `fecha_programada debe ser una fecha ISO futura (al menos ${minutos} minutos desde ahora)`,
      });
    }
  }),
  condiciones_requeridas: z
    .array(z.enum(CONDICIONES))
    .optional()
    .default([]),
  descripcion: z.string().max(500).optional(),
});

// ─── Controllers ─────────────────────────────────────────────────────────────

export async function estimarCosto(req, res) {
  const parsed = schemaEstimar.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  // parsed.data.zona se descarta a proposito: estimarCostoService la calcula de
  // las paradas y la devuelve en el resultado.
  const { paradas, fecha_programada } = parsed.data;
  const fechaEfectiva = fecha_programada ?? new Date().toISOString();

  try {
    const resultado = await estimarCostoService({ paradas, fecha_programada: fechaEfectiva });
    return res.status(200).json(resultado);
  } catch {
    return res.status(503).json({ error: 'No se pudo calcular la distancia' });
  }
}

export async function crearViaje(req, res) {
  const parsed = schemaCrear.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  // parsed.data.zona se descarta a proposito: la zona que se persiste es la que
  // calcula el servidor de las coordenadas (resultado.zona), no la del body.
  const { paradas, fecha_programada, condiciones_requeridas, descripcion } = parsed.data;

  const cliente = await prisma.cliente.findUnique({
    where: { id_usuario: req.usuario.id_usuario },
  });
  if (!cliente) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de cliente' });
  }

  let resultado;
  try {
    resultado = await estimarCostoService({ paradas, fecha_programada });
  } catch {
    return res.status(503).json({ error: 'No se pudo calcular la distancia' });
  }

  const { tarifa_hora, tarifa_km } = resultado.desglose;

  const viaje = await prisma.viaje.create({
    data: {
      id_cliente: cliente.id_cliente,
      zona: resultado.zona,
      tarifa_hora,
      tarifa_km,
      fecha_programada: new Date(fecha_programada),
      descripcion: descripcion ?? null,
      precio_estimado: resultado.precio_estimado,
      // Mismo tiempo_horas que se acaba de usar para estimar el precio. Se
      // persiste (en HORAS) para que el detalle del viaje pueda devolver la
      // duracion estimada sin volver a pegarle a Google en cada lectura.
      duracion_estimada_horas: resultado.desglose.tiempo_horas,
      paradas: {
        create: paradas.map((p, i) => ({
          orden: i + 1,
          latitud: p.lat,
          longitud: p.lng,
          direccion: p.direccion ?? `${p.lat},${p.lng}`,
        })),
      },
      condiciones_req: {
        create: condiciones_requeridas.map((condicion) => ({ condicion })),
      },
    },
    include: {
      paradas: true,
      condiciones_req: true,
    },
  });

  // Calcular la ruta planeada ahora, al crear el viaje. Si Google Maps falla,
  // no bloqueamos la creacion: ruta_planeada queda null y se reintenta en el
  // primer ping GPS (fallback en gps.socket.js).
  let ruta_planeada = null;
  try {
    ruta_planeada = await calcularYGuardarRuta(viaje.id_viaje);
  } catch (err) {
    console.error(`[crearViaje] No se pudo calcular la ruta planeada para viaje ${viaje.id_viaje}:`, err.message);
  }

  if (io) {
    await publicarViajeAConductoresElegibles(io, viaje, req.usuario.id_usuario);
  }

  return res.status(201).json({ ...viaje, ruta_planeada, desglose_estimado: resultado.desglose });
}

export async function listarViajesDisponibles(req, res) {
  const conductor = await prisma.conductor.findUnique({
    where: { id_usuario: req.usuario.id_usuario },
    include: {
      conductor_vehiculos: {
        include: {
          vehiculo: {
            include: { condiciones: true },
          },
        },
      },
      vehiculos_propios: {
        include: { condiciones: true },
      },
    },
  });
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const viajes = await prisma.viaje.findMany({
    where: {
      estado: 'BUSCANDO_CONDUCTOR',
      fecha_programada: { gt: new Date() },
    },
    include: {
      paradas: true,
      condiciones_req: true,
      cliente: {
        include: {
          usuario: {
            select: { nombre: true, apellido: true, telefono: true },
          },
        },
      },
    },
    orderBy: { fecha_programada: 'asc' },
  });

  const viajesElegibles = viajes.filter((viaje) => {
    const condicionesViaje = viaje.condiciones_req.map((c) => c.condicion);
    return conductorEsElegible(
      conductor.conductor_vehiculos,
      conductor.vehiculos_propios,
      condicionesViaje
    );
  });

  return res.status(200).json(viajesElegibles);
}

export async function obtenerViaje(req, res) {
  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje: Number(req.params.id) },
    include: {
      paradas: { orderBy: { orden: 'asc' } },
      condiciones_req: true,
      cliente: { include: { usuario: true } },
      conductor: { include: { usuario: true } },
      // Vehiculo con el que se hace el viaje: lo elige el conductor al aceptar
      // (independiente) o el gerente al asignar (empresa). null mientras no hay
      // conductor asignado.
      vehiculo: {
        select: {
          id_vehiculo: true,
          patente: true,
          marca: true,
          modelo: true,
          anio: true,
          color: true,
          tipo_vehiculo: true,
        },
      },
      empresa: { select: { id_empresa: true, nombre: true, id_gerente: true } },
      calificacion: true,
    },
  });

  if (!viaje) {
    return res.status(404).json({ error: 'Viaje no encontrado' });
  }

  // Regla compartida con costo-acumulado y remito: cliente dueño, conductor
  // asignado, o gerente de la empresa dueña del viaje.
  //
  // Segunda via, exclusiva del detalle: si el viaje esta en BUSCANDO_CONDUCTOR
  // todavia no tiene empresa, y el gerente cuya flota cumple las condiciones
  // necesita leerlo (paradas, ruta_planeada) para decidir si lo reserva.
  const acceso =
    puedeVerViaje(viaje, req.usuario) || (await puedeVerViajeDisponible(viaje, req.usuario));

  if (!acceso) {
    return res.status(403).json({ error: 'Sin acceso a este viaje' });
  }

  // null si el viaje ya termino (Redis limpio) o si la ruta nunca se calculo.
  const ruta_planeada = await obtenerRutaPlaneada(viaje.id_viaje);

  // duracion_estimada sale de la columna duracion_estimada_horas, que se llena al
  // crear el viaje con el mismo tiempo que se uso para estimar el precio. Se
  // expone en MINUTOS (la columna esta en horas). null en viajes creados antes
  // de que existiera la columna, o si Google no respondio al crear.
  return res.status(200).json({
    ...viaje,
    duracion_estimada: horasAMinutos(viaje.duracion_estimada_horas),
    ruta_planeada,
  });
}

export async function cambiarEstado(req, res) {
  const schema = z.object({ estado: z.enum(['CARGANDO', 'DESCARGANDO', 'EN_RUTA']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const id_viaje = Number(req.params.id);
  const { estado } = parsed.data;

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: { conductor: true },
  });
  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (!viaje.conductor || viaje.conductor.id_usuario !== req.usuario.id_usuario) {
    return res.status(403).json({ error: 'No sos el conductor de este viaje' });
  }

  // La maquina de estados es la unica fuente de verdad de que transiciones son
  // validas. Reemplaza el viejo chequeo ad-hoc de FINALIZADO/CANCELADO y ademas
  // rechaza retrocesos (p. ej. EN_RUTA -> CARGANDO).
  try {
    validarTransicion(viaje.estado, estado);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const estado_anterior = viaje.estado;
  await prisma.viaje.update({ where: { id_viaje }, data: { estado } });

  if (io) {
    io.to(`viaje:${id_viaje}`).emit('viaje:estado_cambiado', {
      id_viaje,
      estado_anterior,
      estado_nuevo: estado,
    });
  }

  return res.status(200).json({ id_viaje, estado_anterior, estado_nuevo: estado });
}

// Inicio MANUAL del viaje (boton "Iniciar viaje" del conductor). Reemplaza al
// viejo inicio automatico por primer ping GPS: es la unica forma de pasar de
// CONDUCTOR_ASIGNADO a EN_CAMINO_A_ORIGEN. Recien despues de este 200 el mobile
// debe arrancar el GPS — los pings previos se rechazan (ver gps.socket.js).
export async function iniciarViaje(req, res) {
  const id_viaje = Number(req.params.id);

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: { conductor: true, cliente: true, empresa: true },
  });

  // 1. El viaje existe.
  if (!viaje) {
    return res.status(404).json({ error: 'Viaje no encontrado' });
  }

  // 2. Lo puede iniciar el conductor asignado O el gerente de la empresa del
  //    viaje. iniciado_por guarda quien apreto el boton. El GPS sigue viniendo
  //    siempre del celular del conductor, sin importar quien inicio.
  const esConductorAsignado =
    viaje.conductor && viaje.conductor.id_usuario === req.usuario.id_usuario;
  const esGerenteDeLaEmpresa =
    viaje.empresa && viaje.empresa.id_gerente === req.usuario.id_usuario;
  if (!esConductorAsignado && !esGerenteDeLaEmpresa) {
    return res.status(403).json({ error: 'No autorizado para iniciar este viaje' });
  }
  const iniciado_por = esConductorAsignado ? 'CONDUCTOR' : 'GERENTE';

  // 3. Solo se puede iniciar desde CONDUCTOR_ASIGNADO.
  if (viaje.estado !== 'CONDUCTOR_ASIGNADO') {
    return res.status(400).json({
      error: `Solo se puede iniciar un viaje en estado CONDUCTOR_ASIGNADO, el viaje actual esta en estado ${viaje.estado}`,
    });
  }

  // 4. Ventana de tiempo: se puede iniciar desde VENTANA_INICIO_MINUTOS antes de
  //    la fecha programada. NO hay limite superior — iniciar tarde siempre se puede.
  const VENTANA_INICIO_MINUTOS = Number(process.env.VENTANA_INICIO_MINUTOS ?? 30);
  const ahora = new Date();
  const aperturaVentana = new Date(
    viaje.fecha_programada.getTime() - VENTANA_INICIO_MINUTOS * 60000
  );
  if (ahora < aperturaVentana) {
    const horaLocal = aperturaVentana.toLocaleTimeString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return res.status(400).json({
      error: `El viaje solo puede iniciarse a partir de las ${horaLocal}`,
    });
  }

  // Puntualidad: retraso (en minutos) del inicio real vs la fecha programada.
  // Iniciar antes de hora da retraso negativo → A_TIEMPO.
  const PUNTUALIDAD_TARDE_MINUTOS = Number(process.env.PUNTUALIDAD_TARDE_MINUTOS ?? 30);
  const PUNTUALIDAD_MUY_TARDE_MINUTOS = Number(process.env.PUNTUALIDAD_MUY_TARDE_MINUTOS ?? 120);
  const retrasoMinutos = (ahora.getTime() - viaje.fecha_programada.getTime()) / 60000;

  let puntualidad_inicio;
  if (retrasoMinutos <= PUNTUALIDAD_TARDE_MINUTOS) {
    puntualidad_inicio = 'A_TIEMPO';
  } else if (retrasoMinutos <= PUNTUALIDAD_MUY_TARDE_MINUTOS) {
    puntualidad_inicio = 'TARDE';
  } else {
    puntualidad_inicio = 'MUY_TARDE';
  }

  const actualizado = await prisma.viaje.update({
    where: { id_viaje },
    data: {
      estado: 'EN_CAMINO_A_ORIGEN',
      fecha_inicio: ahora,
      puntualidad_inicio,
      iniciado_por,
    },
  });

  if (io) {
    io.to('usuario:' + viaje.cliente.id_usuario).emit('viaje:iniciado', {
      id_viaje,
      fecha_inicio: actualizado.fecha_inicio,
      puntualidad_inicio,
    });
  }

  return res.status(200).json({
    mensaje: 'Viaje iniciado',
    id_viaje,
    estado: 'EN_CAMINO_A_ORIGEN',
    fecha_inicio: actualizado.fecha_inicio,
    puntualidad_inicio,
    iniciado_por,
  });
}

export async function cancelarViajeConductor(req, res) {
  const id_viaje = Number(req.params.id);

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: { conductor: true, empresa: true },
  });

  // 1. El viaje existe.
  if (!viaje) {
    return res.status(404).json({ error: 'Viaje no encontrado' });
  }

  // 2. Autorizacion: si hay OTRO conductor asignado distinto al autenticado, 403.
  //    Cuando no hay conductor asignado (p. ej. BUSCANDO_CONDUCTOR), no es un
  //    problema de autorizacion sino de estado, y cae al chequeo 3 (400).
  if (viaje.conductor && viaje.conductor.id_usuario !== req.usuario.id_usuario) {
    return res.status(403).json({ error: 'No autorizado para cancelar este viaje' });
  }

  // 3. Solo se puede cancelar desde CONDUCTOR_ASIGNADO.
  if (viaje.estado !== 'CONDUCTOR_ASIGNADO') {
    return res.status(400).json({
      error: `Solo se puede cancelar un viaje en estado CONDUCTOR_ASIGNADO, el viaje actual esta en estado ${viaje.estado}`,
    });
  }

  // Si el viaje es de una empresa, la cancelacion lo devuelve a la empresa
  // (RESERVADO_POR_EMPRESA) para que el gerente reasigne — NO al mercado
  // abierto. Si es independiente, vuelve a BUSCANDO_CONDUCTOR y se republica,
  // igual que hoy. El viaje mantiene su id_viaje en ambos casos.
  const esDeEmpresa = viaje.id_empresa != null;
  const nuevoEstado = esDeEmpresa ? 'RESERVADO_POR_EMPRESA' : 'BUSCANDO_CONDUCTOR';
  validarTransicion(viaje.estado, nuevoEstado);

  await prisma.viaje.update({
    where: { id_viaje },
    data: {
      estado: nuevoEstado,
      id_conductor: null,
      id_vehiculo: null,
      // Reinicia la ventana de reserva para el timeout cuando vuelve a la empresa.
      ...(esDeEmpresa ? { fecha_reserva: new Date() } : {}),
    },
  });

  // El viaje VUELVE a estar reservado (fecha_reserva se reinicia arriba), asi
  // que le corresponde un timeout nuevo. Con el poller esto salia gratis — hoy
  // hay que programarlo a mano o el viaje se quedaria reservado para siempre.
  if (esDeEmpresa) {
    programarTimeoutReserva(io, id_viaje);
  }

  // Cleanup del estado activo del viaje (corta el emisor de ETA y borra TODAS
  // las keys gps:{id_viaje}:*). Idempotente. Mismo helper que la cancelacion por
  // cliente.
  await limpiarViajeActivo(id_viaje);

  // El socket del conductor que cancelo sale del room del viaje (best-effort,
  // no bloqueante), en ambos caminos.
  if (io) {
    try {
      const sockets = await io.in(`viaje:${id_viaje}`).fetchSockets();
      for (const s of sockets) {
        if (s.data?.usuario?.id_usuario === req.usuario.id_usuario) {
          await s.leave(`viaje:${id_viaje}`);
        }
      }
    } catch (err) {
      console.error(
        `[cancelarViajeConductor] No se pudo sacar el socket del conductor del room viaje:${id_viaje}:`,
        err.message
      );
    }
  }

  // Camino EMPRESA: avisar al gerente que el viaje necesita reasignacion. Mismo
  // evento que la desafiliacion, distinto motivo. No se republica al mercado.
  if (esDeEmpresa) {
    if (io && viaje.empresa) {
      io.to(`usuario:${viaje.empresa.id_gerente}`).emit('viaje:requiere_reasignacion', {
        id_viaje,
        id_empresa: viaje.id_empresa,
        motivo: 'conductor_cancelo',
      });
    }
    return res.status(200).json({
      mensaje: 'Viaje devuelto a la empresa para reasignacion',
      id_viaje,
      estado: 'RESERVADO_POR_EMPRESA',
    });
  }

  // Camino INDEPENDIENTE: republicar reutilizando el mismo flujo que la creacion
  // del viaje. El recalculo de ruta_planeada (Google Maps) ocurre cuando el
  // siguiente conductor acepte y se haga el primer ping, igual que un viaje nuevo.
  if (io) {
    const viajeRepublicar = await prisma.viaje.findUnique({
      where: { id_viaje },
      include: {
        paradas: true,
        condiciones_req: true,
        cliente: { include: { usuario: { select: { id_usuario: true } } } },
      },
    });
    await publicarViajeAConductoresElegibles(
      io,
      viajeRepublicar,
      viajeRepublicar.cliente.usuario.id_usuario
    );
  }

  return res.status(200).json({
    mensaje: 'Viaje cancelado y republicado',
    id_viaje,
    estado: 'BUSCANDO_CONDUCTOR',
  });
}

export async function cancelarViajeCliente(req, res) {
  const id_viaje = Number(req.params.id);

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: { cliente: true },
  });

  // 1. El viaje existe.
  if (!viaje) {
    return res.status(404).json({ error: 'Viaje no encontrado' });
  }

  // 2. El cliente autenticado es el dueño del viaje.
  if (viaje.cliente.id_usuario !== req.usuario.id_usuario) {
    return res.status(403).json({ error: 'No autorizado para cancelar este viaje' });
  }

  // 3. Solo se puede cancelar antes de que el viaje comience.
  const ESTADOS_CANCELABLES = ['BUSCANDO_CONDUCTOR', 'CONDUCTOR_ASIGNADO'];
  if (!ESTADOS_CANCELABLES.includes(viaje.estado)) {
    return res.status(400).json({
      error: `Solo se puede cancelar un viaje antes de que comience, el viaje actual esta en estado ${viaje.estado}`,
    });
  }

  // El viaje pasa a CANCELADO (terminal). NO se tocan id_conductor ni
  // id_vehiculo: se preservan como estaban al momento de cancelar, para
  // conservar el historial de con quien estaba asociado el viaje.
  await prisma.$transaction([
    prisma.viaje.update({
      where: { id_viaje },
      data: { estado: 'CANCELADO' },
    }),
  ]);

  // Defensivo: hoy ESTADOS_CANCELABLES no incluye RESERVADO_POR_EMPRESA, asi que
  // aca nunca hay un timer de reserva vivo. Se cancela igual — es idempotente y
  // gratis — para que el dia que esa lista crezca no quede un timer huerfano.
  cancelarTimeoutReserva(id_viaje);

  // Fuera de la transaccion: cleanup del estado activo. Si estaba en
  // CONDUCTOR_ASIGNADO, esto corta el emisor de ETA y borra las keys GPS. Si
  // estaba en BUSCANDO_CONDUCTOR, limpiarViajeActivo es idempotente (no hay ETA
  // corriendo y limpiarGPS no falla si no encuentra keys), asi que es seguro
  // llamarlo igual.
  await limpiarViajeActivo(id_viaje);

  // Decision explicita: por ahora NO se emite ningun evento WebSocket (ni al
  // conductor asignado, si lo habia). Queda pendiente para el futuro.

  return res.status(200).json({
    mensaje: 'Viaje cancelado',
    id_viaje,
    estado: 'CANCELADO',
  });
}

export async function obtenerCostoAcumulado(req, res) {
  const id_viaje = Number(req.params.id);

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: {
      // Misma regla de acceso que GET /api/viajes/:id (ver acceso-viaje.service).
      ...INCLUDE_ACCESO_VIAJE,
      // Las paradas hacen falta para repartir el precio de los viajes MIXTO.
      paradas: { select: { latitud: true, longitud: true } },
    },
  });
  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });

  // Cliente dueño, conductor asignado, o gerente de la empresa dueña del viaje.
  // La via de "gerente elegible del mercado abierto" NO aplica aca: un viaje en
  // BUSCANDO_CONDUCTOR no tiene costo acumulado.
  if (!puedeVerViaje(viaje, req.usuario)) {
    return res.status(403).json({ error: 'Sin acceso a este viaje' });
  }

  const acumulado = await obtenerAcumulado(id_viaje);
  if (!acumulado) {
    return res.status(200).json({ precio_acumulado: 0, desglose: null });
  }

  // Mismo reparto que usan la estimacion y el cierre: en MIXTO se prorratea en
  // vez de cobrar el tiempo total Y la distancia total.
  const { tiempo_capital, distancia_provincia, fraccion_caba } = repartirPorZona({
    zona: viaje.zona,
    paradas: viaje.paradas,
    tiempo_horas: acumulado.tiempo_horas,
    distancia_km: acumulado.distancia_km,
  });

  const precio_por_tiempo =
    tiempo_capital === null ? null : tiempo_capital * (viaje.tarifa_hora || 0);
  const precio_por_distancia =
    distancia_provincia === null ? null : distancia_provincia * (viaje.tarifa_km || 0);
  const precio_acumulado = (precio_por_tiempo ?? 0) + (precio_por_distancia ?? 0);

  const hora = new Date().getHours();
  const es_hora_pico = (hora >= 7 && hora <= 10) || (hora >= 17 && hora <= 20);

  return res.status(200).json({
    precio_acumulado,
    desglose: {
      precio_por_tiempo,
      precio_por_distancia,
      tiempo_horas: acumulado.tiempo_horas,
      distancia_km: acumulado.distancia_km,
      tiempo_capital,
      distancia_provincia,
      fraccion_caba,
      tarifa_hora: viaje.tarifa_hora,
      tarifa_km: viaje.tarifa_km,
      es_hora_pico,
    },
  });
}

// ─── Fase 5 ───────────────────────────────────────────────────────────────────

export async function confirmarParada(req, res) {
  const schema = z.object({
    id_parada: z.number().int().positive(),
    lat: z.number(),
    lng: z.number(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const { id_parada, lat, lng } = parsed.data;
  const id_viaje = Number(req.params.id);

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: {
      conductor: true,
      paradas: true,
    },
  });

  // Orden de validaciones fijado por contrato (mismo orden en API.md): primero
  // lo que identifica al recurso y a quien lo pide, despues el estado, y la
  // proximidad al final — es la unica que necesita las coordenadas del body.
  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (!viaje.conductor || viaje.conductor.id_usuario !== req.usuario.id_usuario) {
    return res.status(403).json({ error: 'No sos el conductor de este viaje' });
  }

  // 400 y no 404: la parada puede existir perfectamente, solo que no es de este
  // viaje. El recurso de la URL (el viaje) si existe.
  const parada = viaje.paradas.find((p) => p.id_parada === id_parada);
  if (!parada) return res.status(400).json({ error: 'La parada no pertenece a este viaje' });
  if (parada.fecha_entrega !== null) {
    return res.status(400).json({ error: 'La parada ya fue confirmada' });
  }

  if (viaje.estado !== 'EN_RUTA' && viaje.estado !== 'DESCARGANDO') {
    return res.status(400).json({ error: 'El viaje debe estar en estado EN_RUTA o DESCARGANDO' });
  }

  // Confirmacion por proximidad: reemplaza al QR firmado. El radio es
  // configurable porque 50m es agresivo para GPS urbano con edificios altos y
  // puede necesitar ajuste sin redeploy de codigo.
  const radio_metros = parseFloat(process.env.RADIO_CONFIRMACION_METROS || '50');
  const distancia_metros = turf.distance(
    turf.point([lng, lat]),
    turf.point([parada.longitud, parada.latitud]),
    { units: 'meters' }
  );
  if (distancia_metros > radio_metros) {
    return res.status(400).json({
      error: `Estas a ${Math.round(distancia_metros)}m de la parada. Debes estar a menos de ${radio_metros}m`,
    });
  }

  await prisma.parada.update({
    where: { id_parada: parada.id_parada },
    data: { estado: 'ENTREGADO', fecha_entrega: new Date() },
  });

  const pendientes = await prisma.parada.count({
    where: { id_viaje, estado: 'PENDIENTE' },
  });

  if (pendientes > 0) {
    // La proxima parada pendiente cambio: forzamos recalculo de ETA inmediato.
    await recalcularEtaInmediato(io, id_viaje);
    return res.status(200).json({ confirmada: true, viaje_finalizado: false });
  }

  const { precio_real, remito_url } = await cerrarViaje(id_viaje, io);
  return res.status(200).json({ confirmada: true, viaje_finalizado: true, precio_real, remito_url });
}

export async function calificarViaje(req, res) {
  const schema = z.object({
    puntuacion: z.number().int().min(1).max(5),
    comentario: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const { puntuacion, comentario } = parsed.data;
  const id_viaje = Number(req.params.id);

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: {
      cliente: true,
      conductor: true,
      calificacion: true,
    },
  });

  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (viaje.estado !== 'FINALIZADO') return res.status(400).json({ error: 'Solo se puede calificar un viaje finalizado' });
  if (viaje.cliente.id_usuario !== req.usuario.id_usuario) return res.status(403).json({ error: 'Sin acceso a este viaje' });
  if (viaje.calificacion) return res.status(409).json({ error: 'Este viaje ya tiene una calificacion' });
  if (!viaje.conductor) return res.status(400).json({ error: 'El viaje no tiene conductor asignado' });

  const calificacion = await prisma.calificacion.create({
    data: {
      id_viaje,
      id_cliente: viaje.cliente.id_cliente,
      id_conductor: viaje.conductor.id_conductor,
      puntaje: puntuacion,
      comentario: comentario ?? null,
    },
  });

  const promedio = await prisma.calificacion.aggregate({
    where: { id_conductor: viaje.conductor.id_conductor },
    _avg: { puntaje: true },
  });

  await prisma.conductor.update({
    where: { id_conductor: viaje.conductor.id_conductor },
    data: { calificacion_promedio: promedio._avg.puntaje ?? 0 },
  });

  return res.status(201).json({
    id_calificacion: calificacion.id_calificacion,
    puntuacion: calificacion.puntaje,
    comentario: calificacion.comentario,
  });
}

export async function obtenerRemito(req, res) {
  const id_viaje = Number(req.params.id);

  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    // Misma regla de acceso que GET /api/viajes/:id (ver acceso-viaje.service).
    include: INCLUDE_ACCESO_VIAJE,
  });

  if (!viaje) return res.status(404).json({ error: 'Viaje no encontrado' });

  // Cliente dueño, conductor asignado, o gerente de la empresa dueña del viaje.
  // La via de "gerente elegible del mercado abierto" NO aplica aca: un viaje en
  // BUSCANDO_CONDUCTOR no tiene remito.
  if (!puedeVerViaje(viaje, req.usuario)) {
    return res.status(403).json({ error: 'Sin acceso a este viaje' });
  }
  if (viaje.estado !== 'FINALIZADO') return res.status(400).json({ error: 'El remito solo esta disponible para viajes finalizados' });

  return res.status(200).json({ remito_url: `${process.env.R2_PUBLIC_URL}/remitos/${id_viaje}.pdf` });
}

export async function listarMisViajes(req, res) {
  const cliente = await prisma.cliente.findUnique({
    where: { id_usuario: req.usuario.id_usuario },
  });
  if (!cliente) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de cliente' });
  }

  const viajes = await prisma.viaje.findMany({
    where: { id_cliente: cliente.id_cliente },
    include: {
      paradas: true,
      conductor: { include: { usuario: true } },
    },
    orderBy: { creado_en: 'desc' },
  });

  // duracion_real se calcula en el read a partir de fecha_inicio y la ultima
  // fecha_entrega de las paradas — no hay columna. En MINUTOS, como todas las
  // duraciones de la API. null mientras el viaje no este FINALIZADO.
  return res.status(200).json(
    viajes.map((viaje) => ({
      ...viaje,
      duracion_real: calcularDuracionRealMinutos(viaje),
    }))
  );
}

const ESTADOS_VIAJE = [
  'BUSCANDO_CONDUCTOR',
  'CONDUCTOR_ASIGNADO',
  'EN_CAMINO_A_ORIGEN',
  'CARGANDO',
  'EN_RUTA',
  'DESCARGANDO',
  'FINALIZADO',
  'CANCELADO',
];

export async function listarMisViajesConductor(req, res) {
  const conductor = await prisma.conductor.findUnique({
    where: { id_usuario: req.usuario.id_usuario },
  });
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const { estado } = req.query;
  if (estado !== undefined && !ESTADOS_VIAJE.includes(estado)) {
    return res.status(400).json({ error: 'Estado invalido' });
  }

  const viajes = await prisma.viaje.findMany({
    where: {
      id_conductor: conductor.id_conductor,
      ...(estado ? { estado } : {}),
    },
    select: {
      id_viaje: true,
      zona: true,
      precio_estimado: true,
      precio_real: true,
      estado: true,
      fecha_programada: true,
      descripcion: true,
      creado_en: true,
      paradas: {
        select: { orden: true, direccion: true, estado: true, fecha_entrega: true },
        orderBy: { orden: 'asc' },
      },
      cliente: {
        select: {
          usuario: { select: { nombre: true, apellido: true, telefono: true } },
        },
      },
    },
    orderBy: { creado_en: 'desc' },
  });

  return res.status(200).json(viajes);
}

// GET /api/viajes/asignados — pestaña "asignados" del conductor: viajes que un
// gerente le asigno y todavia no arrancaron (CONDUCTOR_ASIGNADO). Devuelve las
// paradas (origen/destino), la hora de inicio (fecha_programada) y el vehiculo
// asignado por la empresa.
export async function listarViajesAsignados(req, res) {
  const conductor = await prisma.conductor.findUnique({
    where: { id_usuario: req.usuario.id_usuario },
  });
  if (!conductor) {
    return res.status(400).json({ error: 'El usuario no tiene perfil de conductor' });
  }

  const viajes = await prisma.viaje.findMany({
    where: { id_conductor: conductor.id_conductor, estado: 'CONDUCTOR_ASIGNADO' },
    select: {
      id_viaje: true,
      zona: true,
      precio_estimado: true,
      estado: true,
      fecha_programada: true,
      descripcion: true,
      paradas: {
        select: { orden: true, direccion: true, latitud: true, longitud: true },
        orderBy: { orden: 'asc' },
      },
      vehiculo: {
        select: {
          id_vehiculo: true,
          patente: true,
          marca: true,
          modelo: true,
          tipo_vehiculo: true,
        },
      },
      empresa: { select: { id_empresa: true, nombre: true } },
      cliente: {
        select: {
          usuario: { select: { nombre: true, apellido: true, telefono: true } },
        },
      },
    },
    orderBy: { fecha_programada: 'asc' },
  });

  return res.status(200).json(viajes);
}
