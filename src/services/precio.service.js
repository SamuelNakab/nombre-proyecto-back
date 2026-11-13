// PRECIO de los viajes INTERNOS: elige v1 o v2 y arma lo que se persiste.
//
// Regla de version (Viaje.version_precio):
//   - 2    -> v2 (precio-v2.js) con el SNAPSHOT del viaje (precio_parametros):
//             el medido y el vivo usan los parametros con los que se estimo, no
//             el env actual.
//   - null -> v1 (precio-real.js, la formula de siempre): viajes creados antes
//             de este cambio, o por el codigo viejo de main mientras conviven.
//   Un viaje se cierra SIEMPRE con la version con la que se estimo. Crear, crear
//   serie y editar (este codigo) dejan el viaje en v2.
//
// El marketplace (POST /api/viajes, estimar-costo, cerrarViaje legacy) no pasa
// por aca: sigue con estimarCosto / precioDesdeMediciones.
import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.js';
import { configPrecio } from '../config/precio.js';
import { reportarError } from '../config/sentry.js';
import { ErrorNegocio } from './error-negocio.js';
import { calcularPrecioV2, VERSION_V2 } from './precio-v2.js';
import { entradasEstimado, entradasMedido, validarDatosPrecio, CAMPOS_DECLARADOS } from './precio-entradas.js';
import { estimarRecorrido, tiempoPeonMinutos } from './estimacion.service.js';
import { calcularTramo } from './maps/index.js';
import { clasificarZona } from './zona.service.js';
import { precioDesdeMediciones } from './precio-real.js';
import { horasAMinutos } from './duracion.service.js';

export const esV2 = (viaje) => viaje?.version_precio === VERSION_V2;

// ─── Validacion de lo declarado (Parte B) ────────────────────────────────────

// 400 si lo declarado no cierra con el servicio o con el acceso de las paradas
// (estado RESULTANTE: en editar, lo guardado + lo que llega).
export function exigirDatosPrecio({ tipo_servicio, ayudantes, paradas }) {
  const mensaje = validarDatosPrecio({ tipo_servicio, ayudantes, paradas }, configPrecio());
  if (mensaje) throw new ErrorNegocio(400, mensaje);
}

export async function facturaAPorDefecto(id_organizacion) {
  const org = await prisma.organizacion.findUnique({
    where: { id_organizacion },
    select: { factura_a_por_defecto: true },
  });
  return org?.factura_a_por_defecto ?? null;
}

// ─── Estimado ────────────────────────────────────────────────────────────────

// Precio v2 a partir de un recorrido ya estimado (sin llamar a Google): crear,
// editar sin cambios de paradas / fecha, series. Devuelve { total, bajo, alto,
// desglose, snapshot }.
export function precioV2DesdeRecorrido({ paradas, totales, declarados, facturaAOrganizacion, parametros = configPrecio() }) {
  const { entradas, snapshot } = entradasEstimado(
    {
      paradas,
      manejo_horas: totales.manejo_horas,
      distancia_km: totales.distancia_km,
      declarados,
      facturaAOrganizacion,
    },
    parametros
  );
  return { ...calcularPrecioV2(entradas, parametros), snapshot };
}

// Estimacion COMPLETA (Google): recorrido (manejo con transito + peon, ver
// estimacion.service) + precio v2. Tira ErrorMaps si Google falla: va SIEMPRE
// antes de cualquier transaccion.
export async function estimarPrecioInterno({ paradas, fecha_programada, declarados, facturaAOrganizacion }) {
  const zona = clasificarZona(paradas);
  const recorrido = await estimarRecorrido({
    paradas,
    inicio: new Date(fecha_programada),
    peonMinutos: tiempoPeonMinutos(),
    calcularTramo,
  });
  const precio = precioV2DesdeRecorrido({ paradas, totales: recorrido.totales, declarados, facturaAOrganizacion });
  return { zona, recorrido, precio };
}

// Columnas del viaje para un precio v2 estimado. Compatibilidad con el codigo
// viejo (misma base): zona se sigue escribiendo; tarifa_hora = PRECIO_HORA del
// servicio y tarifa_km = PRECIO_KM_IDA (del snapshot); precio_estimado = total.
// tiempo_capital / distancia_provincia quedan null en v2. Lo declarado se guarda
// tal cual (null = no declarado).
export function columnasPrecioV2(precio, zona, declarados) {
  const p = precio.snapshot.parametros;
  const out = {
    version_precio: VERSION_V2,
    zona,
    tarifa_hora: p[`PRECIO_HORA_${precio.desglose.servicio}`],
    tarifa_km: p.PRECIO_KM_IDA,
    tiempo_capital: null,
    distancia_provincia: null,
    precio_estimado: precio.total,
    precio_estimado_min: precio.bajo,
    precio_estimado_max: precio.alto,
    precio_estimado_desglose: precio.desglose,
    precio_parametros: precio.snapshot,
    fuente_peajes: precio.snapshot.entradas.fuente_peajes,
  };
  for (const c of CAMPOS_DECLARADOS) out[c] = declarados[c] ?? null;
  return out;
}

// Lo que devuelve POST /api/organizaciones/:id/viajes/estimar-precio.
export function serializarEstimacionPrecio({ zona, recorrido, precio }) {
  const e = precio.snapshot.entradas;
  return {
    version_precio: VERSION_V2,
    zona,
    total: precio.total,
    bajo: precio.bajo,
    alto: precio.alto,
    desglose: precio.desglose,
    peajes: {
      pyme: precio.snapshot.declarados.peajes_estimados,
      // Peajes de Google: no implementados (el calculo factura Enterprise).
      google: null,
      google_incompleto: null,
      usados: e.peajes,
      fuente: e.fuente_peajes,
    },
    estimado: {
      manejo_horas: recorrido.totales.manejo_horas,
      peon_horas: recorrido.totales.peon_horas,
      total_horas: recorrido.totales.total_horas,
      distancia_km: recorrido.totales.distancia_km,
      // Las horas que entran en el precio: manejo + PRECIO_MINUTOS_POR_PARADA.
      horas_precio: e.horas,
      inicio_estimado: recorrido.totales.inicio_estimado,
      fin_estimado: recorrido.totales.fin_estimado,
    },
    tramos: recorrido.paradas.map((p) => ({
      orden: p.orden,
      llegada_estimada: p.llegada_estimada,
      salida_estimada: p.salida_estimada,
      peon_estimado_min: horasAMinutos(p.peon_estimado_horas),
      manejo_estimado_min: horasAMinutos(p.manejo_estimado_horas),
      manejo_sin_transito_min: horasAMinutos(p.manejo_sin_transito_horas),
      distancia_estimada_km: p.distancia_estimada_km,
    })),
  };
}

// ─── Medido (cierre, cancelacion en curso) y vivo ────────────────────────────

const ordenadas = (paradas) => [...(paradas ?? [])].sort((a, b) => a.orden - b.orden);

// Desde cuando corre el reloj del precio medido: la llegada a la parada 1 (= el
// iniciar del ciclo interno).
export function inicioDelPrecio(viaje) {
  return ordenadas(viaje.paradas)[0]?.llegada_real ?? viaje.fecha_inicio ?? null;
}

function medidoV2(viaje, { corte, medicion, incompleto }) {
  const entradas = entradasMedido({
    snapshot: viaje.precio_parametros,
    inicio: inicioDelPrecio(viaje),
    corte,
    medicion,
    paradas: viaje.paradas,
    incompleto,
  });
  return calcularPrecioV2(entradas, viaje.precio_parametros.parametros);
}

const desgloseV1 = (precio, mediciones, viaje) => ({
  version: 1,
  precio_por_tiempo: precio.precio_por_tiempo,
  precio_por_distancia: precio.precio_por_distancia,
  tiempo_horas: mediciones.tiempo_horas,
  distancia_km: mediciones.distancia_km,
  tiempo_capital: precio.tiempo_capital,
  distancia_provincia: precio.distancia_provincia,
  fraccion_caba: precio.fraccion_caba,
  tarifa_hora: viaje.tarifa_hora,
  tarifa_km: viaje.tarifa_km,
});

const parametrosV1 = (viaje) => ({ version: 1, zona: viaje.zona, tarifa_hora: viaje.tarifa_hora, tarifa_km: viaje.tarifa_km });

// Precio MEDIDO de un viaje interno: al cierre (los tres modos) y al cancelar en
// curso. El viaje trae version_precio, precio_parametros, zona, tarifas,
// fecha_inicio y paradas (orden, latitud, longitud, llegada_real,
// distancia_estimada_km). `mediciones`: medicionesHasta(corte) (con pings).
// `incompleto`: cierre sin haber llegado a la ultima, o cancelado en curso
// (fallback de km PARCIAL).
// Devuelve { version, total, bajo, alto, desglose, parametros, columnas } donde
// columnas es lo que escribe el cierre (precio_real siempre: contrato).
export function precioMedido(viaje, mediciones, { corte, incompleto }) {
  if (esV2(viaje) && viaje.precio_parametros) {
    const r = medidoV2(viaje, { corte, medicion: mediciones, incompleto });
    return {
      version: VERSION_V2,
      total: r.total,
      bajo: r.bajo,
      alto: r.alto,
      desglose: r.desglose,
      parametros: viaje.precio_parametros,
      columnas: {
        precio_real: r.total,
        precio_medido: r.total,
        precio_medido_desglose: r.desglose,
        tiempo_capital: null,
        distancia_provincia: null,
      },
    };
  }
  if (esV2(viaje)) {
    console.error(`[precio] viaje ${viaje.id_viaje} con version_precio 2 sin snapshot: se cierra con v1`);
  }
  const p = precioDesdeMediciones(viaje, mediciones);
  return {
    version: 1,
    total: Math.round(p.precio_real),
    bajo: null,
    alto: null,
    desglose: desgloseV1(p, mediciones, viaje),
    parametros: parametrosV1(viaje),
    precio_v1: p,
    columnas: {
      precio_real: p.precio_real,
      tiempo_capital: p.tiempo_capital,
      distancia_provincia: p.distancia_provincia,
    },
  };
}

// Precio EN VIVO (GET costo-acumulado de la PyME y legacy, evento
// costo:actualizar). Sincronica: el acumulado ya lo leyo el caller (el socket lo
// acaba de escribir: cero queries extra por ping). Nombre y forma de siempre
// ({ precio_acumulado, desglose }) + version_precio.
//   v1: la MISMA formula que el cierre v1 (precioDesdeMediciones): en MIXTO
//       prorratea (antes el socket cobraba tiempo total + km total).
//   v2: reloj desde la llegada a la parada 1 hasta ahora y km GPS con el mismo
//       fallback que el cierre (estimada completa). Sin iniciar: 0.
export function precioEnVivo(viaje, acumulado, ahora = new Date()) {
  if (esV2(viaje) && viaje.precio_parametros) {
    if (viaje.estado === 'FINALIZADO' && viaje.precio_medido != null) {
      return { precio_acumulado: viaje.precio_medido, version_precio: VERSION_V2, desglose: viaje.precio_medido_desglose };
    }
    const inicio = inicioDelPrecio(viaje);
    const enCurso = ['CARGANDO', 'EN_RUTA', 'DESCARGANDO'].includes(viaje.estado);
    if (!inicio || !enCurso) return { precio_acumulado: 0, version_precio: VERSION_V2, desglose: null };
    const r = medidoV2(viaje, {
      corte: ahora,
      medicion: {
        distancia_km: acumulado?.distancia_km ?? 0,
        pings: acumulado?.pings ?? 0,
        sin_pings: !acumulado,
      },
      incompleto: false,
    });
    return { precio_acumulado: r.total, version_precio: VERSION_V2, desglose: r.desglose };
  }

  if (!acumulado) return { precio_acumulado: 0, version_precio: 1, desglose: null };
  const p = precioDesdeMediciones(viaje, acumulado);
  const hora = ahora.getHours();
  const es_hora_pico = (hora >= 7 && hora <= 10) || (hora >= 17 && hora <= 20);
  return {
    precio_acumulado: p.precio_real,
    version_precio: 1,
    desglose: {
      precio_por_tiempo: p.precio_por_tiempo,
      precio_por_distancia: p.precio_por_distancia,
      tiempo_horas: acumulado.tiempo_horas,
      distancia_km: acumulado.distancia_km,
      tiempo_capital: p.tiempo_capital,
      distancia_provincia: p.distancia_provincia,
      fraccion_caba: p.fraccion_caba,
      tarifa_hora: viaje.tarifa_hora,
      tarifa_km: viaje.tarifa_km,
      es_hora_pico,
    },
  };
}

// Campos del viaje que necesitan precioMedido / precioEnVivo.
export const SELECT_PRECIO = {
  id_viaje: true,
  id_organizacion: true,
  estado: true,
  zona: true,
  tarifa_hora: true,
  tarifa_km: true,
  fecha_inicio: true,
  version_precio: true,
  precio_parametros: true,
  precio_medido: true,
  precio_medido_desglose: true,
};
export const SELECT_PARADAS_PRECIO = {
  orden: true,
  latitud: true,
  longitud: true,
  llegada_real: true,
  distancia_estimada_km: true,
};

// ─── Historial de precios ────────────────────────────────────────────────────

// Fila de historial a partir de un resultado de precioMedido o de un estimado.
export function filaHistorial({ id_viaje, motivo, id_usuario = null, fecha }, r) {
  return {
    id_viaje,
    version: r.version ?? VERSION_V2,
    motivo,
    total: r.total,
    minimo: r.bajo ?? null,
    maximo: r.alto ?? null,
    desglose: r.desglose,
    parametros: r.parametros ?? r.snapshot ?? Prisma.JsonNull,
    id_usuario,
    ...(fecha ? { fecha } : {}),
  };
}

// Una fila por calculo (CREAR, EDITAR, CIERRE, CANCELACION_EN_CURSO). FUERA de
// la tx del cambio que la origina y NUNCA TIRA (mismo criterio que el historial
// de estados): un fallo deja un hueco en el historial, no un viaje que no se
// puede crear o cerrar.
export async function registrarHistorialPrecio(filas) {
  const lista = Array.isArray(filas) ? filas : [filas];
  if (lista.length === 0) return true;
  try {
    await prisma.historialPrecioViaje.createMany({ data: lista });
    return true;
  } catch (err) {
    const ids = lista.map((f) => f.id_viaje).join(', ');
    console.error(`[historial-precio] no se pudo registrar el calculo de los viajes ${ids}: ${err.message}`);
    reportarError(err, { contexto: 'historial-precio', nivel: 'warning', extra: { ids } });
    return false;
  }
}
