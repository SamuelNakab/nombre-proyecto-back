import { z } from 'zod';
import prisma from '../config/prisma.js';
import {
  estimarCosto as estimarCostoService,
  serializarEstimacion,
  calcularCostoAcumulado,
} from '../services/costo.service.js';
import { columnasEstimadasViaje, conEstimacionPorParada } from '../services/estimacion.service.js';
import { responderErrorNegocio } from '../services/error-negocio.js';
import { conductorEsElegible } from '../services/elegibilidad.service.js';
import { publicarViajeAConductoresElegibles } from '../services/matching.service.js';
import { cerrarViaje } from '../services/cierre.service.js';
import { recalcularEtaInmediato } from '../services/eta-emisor.js';
import { limpiarViajeActivo } from '../services/cancelacion.service.js';
import {
  programarTimeoutReserva,
  cancelarTimeoutReserva,
} from '../services/reserva.service.js';
import { guardarRutaPlaneada, obtenerRutaPlaneada } from '../services/ruta.service.js';
import { validarTransicion, cicloDe } from '../services/estado-viaje.service.js';
import { ventanaInicioAntesMinutosLegacy } from '../services/ventana-inicio.js';
import { salasDeViaje } from '../sockets/salas.js';
import { horasAMinutos, calcularMetricasViaje } from '../services/duracion.service.js';
import { calcularPuntualidadInicio } from '../services/puntualidad.service.js';
import {
  registrarCambioEstado,
  INCLUDE_HISTORIAL,
} from '../services/historial-estado.service.js';
import { distanciaMetros } from '../services/parada.service.js';
import { confirmarParadaInterna } from '../services/viaje-interno.service.js';
import {
  esViajeVencido,
  programarAvisoVencimiento,
  cancelarAvisoVencimiento,
} from '../services/vencimiento.service.js';
import {
  puedeVerViaje,
  puedeVerViajeDisponible,
  INCLUDE_ACCESO_VIAJE,
} from '../services/acceso-viaje.service.js';
import {
  camposBase,
  schemaCondiciones,
  schemaFechaProgramada,
  paradasParaCrear,
} from '../services/viaje-validacion.js';
import { io } from '../sockets/index.js';

// ─── Schemas de validacion ───────────────────────────────────────────────────

const schemaEstimar = z.object({
  ...camposBase,
  fecha_programada: z.string().optional(),
});

const schemaCrear = z.object({
  ...camposBase,
  fecha_programada: schemaFechaProgramada,
  condiciones_requeridas: schemaCondiciones.optional().default([]),
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

  // Si Google falla: 503 (o 400 si no hay ruta posible) via ErrorMaps.
  try {
    const resultado = await estimarCostoService({ paradas, fecha_programada: fechaEfectiva });
    return res.status(200).json(serializarEstimacion(resultado));
  } catch (err) {
    return responderErrorNegocio(res, err);
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

  // Antes de escribir nada: si Google falla, 503 (o 400 sin ruta) y no se crea
  // el viaje.
  let resultado;
  try {
    resultado = await estimarCostoService({ paradas, fecha_programada });
  } catch (err) {
    return responderErrorNegocio(res, err);
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
      // Duracion TOTAL (manejo + peon), manejo, peon y distancia de la MISMA
      // estimacion que el precio, en HORAS / km. Ver estimacion.service.
      ...columnasEstimadasViaje(resultado.recorrido.totales),
      paradas: { create: conEstimacionPorParada(paradasParaCrear(paradas), resultado.recorrido) },
      condiciones_req: {
        create: condiciones_requeridas.map((condicion) => ({ condicion })),
      },
    },
    include: {
      paradas: true,
      condiciones_req: true,
    },
  });

  // SITIO 1/12 del historial. El estado no va en el `data` del create: sale del
  // @default(BUSCANDO_CONDUCTOR) del schema. Es igual de real que los demas y
  // es el unico origen de la primera fila de todo viaje.
  await registrarCambioEstado({
    id_viaje: viaje.id_viaje,
    estado: viaje.estado,
    id_usuario: req.usuario.id_usuario,
    origen: 'CLIENTE',
  });

  // Ruta planeada: la polilinea de los tramos de la estimacion (sin otra
  // llamada a Google). Misma key de Redis y mismo formato [lng, lat].
  const ruta_planeada = await guardarRutaPlaneada(viaje.id_viaje, resultado.recorrido.polilinea);

  // Aviso de vencimiento: un setTimeout propio de ESTE viaje que dispara en su
  // fecha_programada y, si para entonces el viaje sigue colgado, emite
  // viaje:vencido. Es el UNICO lugar donde se programa (fuera del barrido de
  // arranque): fecha_programada no cambia nunca, asi que el aviso no se mueve.
  programarAvisoVencimiento(io, viaje.id_viaje, viaje.fecha_programada);

  if (io) {
    await publicarViajeAConductoresElegibles(io, viaje, req.usuario.id_usuario);
  }

  return res.status(201).json({
    ...viaje,
    ruta_planeada,
    // Siempre null aca (el viaje ni arranco). Pisa a la columna MUERTA del
    // mismo nombre que viene en el spread — ver puntualidad.service.js.
    puntualidad_inicio: calcularPuntualidadInicio(viaje),
    // Siempre false aca (la fecha tiene que ser futura para poder crear el
    // viaje). Se devuelve igual para que el contrato sea uniforme.
    vencido: esViajeVencido(viaje),
    desglose_estimado: resultado.desglose,
  });
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

  // vencido es siempre false aca: el where de arriba filtra por
  // fecha_programada > ahora, asi que un viaje vencido nunca entra a esta lista
  // (decision explicita, ver CLAUDE.md). Se devuelve para uniformar el contrato.
  //
  // puntualidad_inicio es siempre null aca (son viajes sin conductor), pero se
  // calcula igual para pisar a la columna MUERTA que viene en el spread.
  return res.status(200).json(
    viajesElegibles.map((viaje) => ({
      ...viaje,
      puntualidad_inicio: calcularPuntualidadInicio(viaje),
      vencido: esViajeVencido(viaje),
    }))
  );
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
      // Canal 1/6 de las metricas por etapa (tiempo de peon, duracion real,
      // aproximacion y puntualidad). Ver calcularMetricasViaje.
      ...INCLUDE_HISTORIAL,
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
    // Las cinco metricas del historial. puntualidad_inicio va aca adentro y
    // pisa a la columna MUERTA del mismo nombre que trae el spread.
    ...calcularMetricasViaje(viaje),
    // Calculado en el read, igual que las duraciones: no hay columna.
    vencido: esViajeVencido(viaje),
    ruta_planeada,
  });
}

const MENSAJE_PATCH_INTERNO =
  'En un viaje de PyME el estado cambia con iniciar (POST /api/choferes/viajes/:id/iniciar), confirmar parada (POST /api/viajes/:id/confirmar-parada) y salir (POST /api/choferes/viajes/:id/salir)';

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

  // Viaje INTERNO: este endpoint NO aplica. Desde el Paso 3 (ciclo por
  // parada) todo cambio de estado va por iniciar, confirmar parada y salir,
  // que registran la llegada y la salida de cada parada.
  if (cicloDe(viaje) === 'INTERNO') {
    return res.status(400).json({ error: MENSAJE_PATCH_INTERNO });
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

  // RESPALDO DE ULTIMO RECURSO de la llegada al origen: si el viaje llego a
  // CARGANDO sin que ningun ping GPS haya registrado la llegada (sin señal, GPS
  // apagado), se usa este instante. Es la señal PEOR de las dos — el conductor
  // marca CARGANDO cuando EMPIEZA A CARGAR, no cuando llega, asi que una demora
  // del cliente en la carga lo perjudica — pero es mejor que no tener nada.
  //
  // Solo rellena si sigue null: un ping que ya la registro nunca se pisa.
  const rellenaLlegada = estado === 'CARGANDO' && viaje.fecha_llegada_origen === null;

  // GUARD ATOMICO: el estado leido va en el WHERE. Antes era un update plano:
  // una cancelacion concurrente (la PyME cancela un viaje en curso) quedaba
  // pisada por este avance, que devolvia el viaje CANCELADO a EN_RUTA.
  const actualizado = await prisma.viaje.updateMany({
    where: { id_viaje, estado: estado_anterior },
    data: {
      estado,
      ...(rellenaLlegada ? { fecha_llegada_origen: new Date() } : {}),
    },
  });
  if (actualizado.count === 0) {
    return res.status(409).json({ error: 'El viaje cambio de estado mientras se procesaba tu pedido' });
  }

  // SITIO 3/12 del historial.
  await registrarCambioEstado({
    id_viaje,
    estado,
    id_usuario: req.usuario.id_usuario,
    origen: 'CONDUCTOR',
  });

  if (io) {
    // viaje:{id} y, si es de una PyME, organizacion:{id}.
    io.to(salasDeViaje(viaje)).emit('viaje:estado_cambiado', {
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

  // 4. Ventana de tiempo: se puede iniciar desde VENTANA_INICIO_ANTES_MINUTOS
  //    antes de la fecha programada (fallback a la vieja VENTANA_INICIO_MINUTOS,
  //    que esa variable reemplazo). NO hay limite superior en el ciclo LEGACY —
  //    iniciar tarde siempre se puede. El ciclo interno tiene su propio iniciar.
  const VENTANA_INICIO_MINUTOS = ventanaInicioAntesMinutosLegacy();
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

  // GUARD ATOMICO. Antes esto era un update plano sobre la lectura de arriba: el
  // estado se chequeaba en memoria (paso 3) y no en el WHERE, asi que dos POST
  // concurrentes pasaban los dos el chequeo y devolvian los DOS 200, con
  // fecha_inicio e iniciado_por last-write-wins. No es teorico: el endpoint
  // autoriza al conductor asignado Y al gerente de la empresa, o sea que hay dos
  // personas distintas que pueden apretar el boton al mismo tiempo.
  //
  // Mismo patron que reservar, asignar y liberarReserva. El chequeo en memoria
  // del paso 3 se CONSERVA: sigue dando el 400 descriptivo de siempre en el caso
  // secuencial (doble inicio normal), y este 409 queda para la carrera real.
  const actualizado = await prisma.viaje.updateMany({
    where: { id_viaje, estado: 'CONDUCTOR_ASIGNADO' },
    data: {
      estado: 'EN_CAMINO_A_ORIGEN',
      fecha_inicio: ahora,
      iniciado_por,
    },
  });
  if (actualizado.count === 0) {
    return res.status(409).json({ error: 'El viaje ya fue iniciado por otra persona' });
  }

  // SITIO 4/12 del historial. iniciado_por y el origen son lo mismo aca: quien
  // apreto el boton.
  await registrarCambioEstado({
    id_viaje,
    estado: 'EN_CAMINO_A_ORIGEN',
    id_usuario: req.usuario.id_usuario,
    origen: iniciado_por,
  });

  // El viaje arranco: ya no puede vencer. Es la salida de CONDUCTOR_ASIGNADO
  // mas facil de olvidar.
  cancelarAvisoVencimiento(id_viaje);

  // OJO: ya NO se calcula ni se persiste la puntualidad aca. Se medida en la
  // SALIDA hacia el origen, que no es llegar: ahora se calcula en el read desde
  // fecha_llegada_origen. Ver puntualidad.service.js.
  if (io) {
    io.to('usuario:' + viaje.cliente.id_usuario).emit('viaje:iniciado', {
      id_viaje,
      fecha_inicio: ahora,
    });
  }

  return res.status(200).json({
    mensaje: 'Viaje iniciado',
    id_viaje,
    estado: 'EN_CAMINO_A_ORIGEN',
    fecha_inicio: ahora,
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

  // SITIO 5/12 del historial. Las DOS ramas (a empresa o al mercado) generan
  // fila: el estado cambio en las dos.
  await registrarCambioEstado({
    id_viaje,
    estado: nuevoEstado,
    id_usuario: req.usuario.id_usuario,
    origen: 'CONDUCTOR',
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

  // SITIO 6/12 del historial. FUERA de la $transaction a proposito: adentro, un
  // fallo del insert haria rollback de la cancelacion, que es exactamente lo
  // contrario de lo que queremos (el cambio de estado tiene que ocurrir igual).
  await registrarCambioEstado({
    id_viaje,
    estado: 'CANCELADO',
    id_usuario: req.usuario.id_usuario,
    origen: 'CLIENTE',
  });

  // Defensivo: hoy ESTADOS_CANCELABLES no incluye RESERVADO_POR_EMPRESA, asi que
  // aca nunca hay un timer de reserva vivo. Se cancela igual — es idempotente y
  // gratis — para que el dia que esa lista crezca no quede un timer huerfano.
  cancelarTimeoutReserva(id_viaje);

  // CANCELADO es terminal: el viaje ya no puede vencer.
  cancelarAvisoVencimiento(id_viaje);

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

  return res.status(200).json(await calcularCostoAcumulado(viaje));
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

  // Viaje INTERNO (ciclo por parada, Paso 3): solo en EN_RUTA, solo la
  // SIGUIENTE parada en orden, y pasa a DESCARGANDO; confirmar la ultima ya no
  // finaliza (finaliza el "salir" de la ultima). Ver viaje-interno.service.
  if (cicloDe(viaje) === 'INTERNO') {
    try {
      const r = await confirmarParadaInterna({
        io,
        viaje,
        parada,
        id_usuario: req.usuario.id_usuario,
        lat,
        lng,
      });
      return res.status(200).json(r);
    } catch (err) {
      return responderErrorNegocio(res, err);
    }
  }

  if (viaje.estado !== 'EN_RUTA' && viaje.estado !== 'DESCARGANDO') {
    return res.status(400).json({ error: 'El viaje debe estar en estado EN_RUTA o DESCARGANDO' });
  }

  // Confirmacion por proximidad: reemplaza al QR firmado. El radio es
  // configurable porque 50m es agresivo para GPS urbano con edificios altos y
  // puede necesitar ajuste sin redeploy de codigo.
  const radio_metros = parseFloat(process.env.RADIO_CONFIRMACION_METROS || '50');
  // Misma funcion de distancia que usa la deteccion de llegada al origen en
  // gps.socket.js — estaba inline aca y se extrajo para que no haya dos.
  const distancia_metros = distanciaMetros(lat, lng, parada);
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
    await recalcularEtaInmediato(io, id_viaje, salasDeViaje(viaje));
    return res.status(200).json({ confirmada: true, viaje_finalizado: false });
  }

  // cerrarViaje no conoce al actor: se lo pasamos. El conductor que confirma la
  // ultima parada es quien dispara el FINALIZADO (sitio 11/12 del historial).
  const cierre = await cerrarViaje(id_viaje, io, {
    id_usuario: req.usuario.id_usuario,
    origen: 'CONDUCTOR',
  });
  // null = el cierre perdio la carrera (p. ej. la PyME cancelo el viaje
  // mientras se confirmaba la ultima parada): el viaje NO se finalizo.
  if (!cierre) {
    return res.status(409).json({ error: 'El viaje cambio de estado y no se pudo cerrar' });
  }
  const { precio_real, remito_url } = cierre;
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
  // Los viajes de PyME (ciclo interno) no se califican: id_cliente es solo un
  // ancla del schema, no el dueño del viaje.
  if (viaje.id_organizacion !== null) return res.status(400).json({ error: 'Los viajes de PyME no se califican' });
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
    // Solo viajes LEGACY: los de PyME se listan por membresia en
    // GET /api/organizaciones/:id/viajes, nunca por usuario.
    where: { id_cliente: cliente.id_cliente, id_organizacion: null },
    include: {
      paradas: true,
      conductor: { include: { usuario: true } },
      // Canal 2/6 de las metricas por etapa.
      ...INCLUDE_HISTORIAL,
    },
    orderBy: { creado_en: 'desc' },
  });

  // Las duraciones y la puntualidad se calculan en el read — no hay columnas.
  // En MINUTOS, como todas las duraciones de la API. duracion_real se mide
  // desde la SALIDA del origen (la fila EN_RUTA del historial), no desde
  // fecha_inicio: null mientras el viaje no este FINALIZADO, y null tambien en
  // los viajes anteriores a este cambio, que no tienen historial.
  return res.status(200).json(
    viajes.map((viaje) => ({
      ...viaje,
      ...calcularMetricasViaje(viaje),
      vencido: esViajeVencido(viaje),
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
    // Solo viajes LEGACY: los de PyME estan en GET /api/choferes/viajes.
    where: {
      id_conductor: conductor.id_conductor,
      id_organizacion: null,
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
      // Los tres escalares que necesitan las metricas por etapa. Este endpoint
      // usa select explicito (no spread de la fila cruda), asi que hay que
      // pedirlos a mano o calcularMetricasViaje tira.
      fecha_inicio: true,
      fecha_llegada_origen: true,
      // calcularMetricasViaje elige el ciclo por este campo (siempre null aca).
      id_organizacion: true,
      paradas: {
        select: { orden: true, direccion: true, estado: true, fecha_entrega: true },
        orderBy: { orden: 'asc' },
      },
      cliente: {
        select: {
          usuario: { select: { nombre: true, apellido: true, telefono: true } },
        },
      },
      // Canal 3/6: el conductor ve su propio tiempo de peon en su historial.
      ...INCLUDE_HISTORIAL,
    },
    orderBy: { creado_en: 'desc' },
  });

  return res.status(200).json(
    viajes.map((viaje) => ({
      ...viaje,
      ...calcularMetricasViaje(viaje),
      vencido: esViajeVencido(viaje),
    }))
  );
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
    where: { id_conductor: conductor.id_conductor, estado: 'CONDUCTOR_ASIGNADO', id_organizacion: null },
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

  // Pestaña "asignados" del conductor: es su canal para enterarse de que un
  // viaje que tiene que arrancar ya paso su hora.
  return res.status(200).json(
    viajes.map((viaje) => ({ ...viaje, vencido: esViajeVencido(viaje) }))
  );
}
