// GET /api/admin/precios/dataset — el DATASET para recalibrar el precio v2.
// Una fila por viaje v2 FINALIZADO: lo declarado, lo usado (snapshot), lo
// medido, los peajes (Google, PyME y pagados), el estimado con su rango, el
// medido, lo pagado y los parametros. Paginado (page / limit, como el resto del
// admin) y ?formato=csv opcional. Filtro opcional por el fin del viaje
// (desde / hasta sobre fecha_corte_precio).
import { z } from 'zod';
import prisma from '../config/prisma.js';
import { responder400 } from '../services/errores-validacion.js';
import { aCsv } from '../services/csv.js';

const fechaOpcional = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: 'Fecha invalida (usar ISO 8601)' })
  .optional();

const schema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Hasta 1000 por pagina (el CSV se baja de a paginas grandes).
  limit: z.coerce.number().int().min(1).default(200).transform((n) => Math.min(n, 1000)),
  formato: z.enum(['json', 'csv']).default('json'),
  desde: fechaOpcional,
  hasta: fechaOpcional,
});

export const COLUMNAS_DATASET = [
  'id_viaje',
  'id_organizacion',
  'id_serie',
  'fecha_programada',
  'fecha_inicio',
  'fecha_fin',
  'cerrado_por',
  'incompleto',
  'cantidad_paradas',
  'zona',
  // Declarado por la PyME (null = no declarado)
  'declarado_tipo_servicio',
  'declarado_ayudantes',
  'declarado_factura_a',
  'factura_a_organizacion',
  // Usado en el calculo (snapshot)
  'servicio',
  'ayudantes',
  'factura_a',
  'fuente_factura_a',
  'provincia',
  'escalera',
  'paradas_extra',
  'pisos_max',
  // Estimado
  'km_estimado',
  'horas_precio_estimadas',
  'manejo_estimado_horas',
  'manejo_sin_transito_horas',
  'peon_estimado_horas',
  // Medido
  'km_medido',
  'fuente_km',
  'km_gps',
  'horas_medidas',
  'manejo_real_horas',
  'peon_real_horas',
  'distancia_real_km',
  'gps_puntos',
  'gps_mayor_hueco_segundos',
  // Peajes
  'peajes_google',
  'peajes_pyme',
  'peajes_usados',
  'fuente_peajes',
  'peajes_pagados',
  // Precios
  'estimado_total',
  'estimado_bajo',
  'estimado_alto',
  'estimado_subtotal_sin_iva',
  'estimado_regimen',
  'medido_total',
  'medido_subtotal_sin_iva',
  'medido_iva',
  'medido_regimen',
  // Pagado
  'pagado_monto',
  'pagado_incluye_iva',
  'pagado_metodo',
  'pagado_ayudantes_reales',
  'pagado_comentario',
  'pagado_ediciones',
  // Carga y vehiculo
  'tipo_carga',
  'bultos',
  'peso_kg',
  'volumen_m3',
  'pallets',
  'valor_declarado',
  'vehiculo_tipo',
  // Parametros del snapshot (JSON)
  'parametros',
];

const suma = (xs) => (xs.some((x) => x != null) ? xs.reduce((a, x) => a + (x ?? 0), 0) : null);

export function filaDataset(v) {
  const snap = v.precio_parametros ?? {};
  const e = snap.entradas ?? {};
  const decl = snap.declarados ?? {};
  const est = v.precio_estimado_desglose ?? {};
  const med = v.precio_medido_desglose ?? {};
  const me = med.entradas ?? {};
  const pp = v.precio_pagado;
  return {
    id_viaje: v.id_viaje,
    id_organizacion: v.id_organizacion,
    id_serie: v.id_serie,
    fecha_programada: v.fecha_programada,
    fecha_inicio: v.fecha_inicio,
    fecha_fin: v.fecha_corte_precio,
    cerrado_por: v.cerrado_por,
    incompleto: v.paradas.some((p) => p.no_visitada === true),
    cantidad_paradas: v.paradas.length,
    zona: v.zona,
    declarado_tipo_servicio: v.tipo_servicio,
    declarado_ayudantes: v.ayudantes,
    declarado_factura_a: v.factura_a,
    factura_a_organizacion: decl.factura_a_organizacion ?? null,
    servicio: e.servicio ?? null,
    ayudantes: e.ayudantes ?? null,
    factura_a: e.factura_a ?? null,
    fuente_factura_a: e.fuente_factura_a ?? null,
    provincia: e.provincia ?? null,
    escalera: e.escalera ?? null,
    paradas_extra: e.paradas_extra ?? null,
    pisos_max: v.paradas.reduce((m, p) => (p.pisos != null && (m == null || p.pisos > m) ? p.pisos : m), null),
    km_estimado: e.km_ida ?? null,
    horas_precio_estimadas: e.horas ?? null,
    manejo_estimado_horas: v.manejo_estimado_horas,
    manejo_sin_transito_horas: suma(v.paradas.map((p) => p.manejo_sin_transito_horas)),
    peon_estimado_horas: v.peon_estimado_horas,
    km_medido: me.km_ida ?? null,
    fuente_km: me.fuente_km ?? null,
    km_gps: me.km_gps ?? null,
    horas_medidas: me.horas ?? null,
    manejo_real_horas: v.manejo_real_horas,
    peon_real_horas: v.peon_real_horas,
    distancia_real_km: v.distancia_real_km,
    gps_puntos: v.gps_puntos,
    gps_mayor_hueco_segundos: v.gps_mayor_hueco_segundos,
    // Peajes de Google: no implementados (el calculo factura Enterprise).
    peajes_google: null,
    peajes_pyme: v.peajes_estimados,
    peajes_usados: e.peajes ?? null,
    fuente_peajes: v.fuente_peajes ?? e.fuente_peajes ?? null,
    peajes_pagados: pp?.monto_peajes ?? null,
    estimado_total: v.precio_estimado,
    estimado_bajo: v.precio_estimado_min,
    estimado_alto: v.precio_estimado_max,
    estimado_subtotal_sin_iva: est.subtotal_sin_iva ?? null,
    estimado_regimen: est.regimen ?? null,
    medido_total: v.precio_medido,
    medido_subtotal_sin_iva: med.subtotal_sin_iva ?? null,
    medido_iva: med.iva ?? null,
    medido_regimen: med.regimen ?? null,
    pagado_monto: pp?.monto ?? null,
    pagado_incluye_iva: pp?.incluye_iva ?? null,
    pagado_metodo: pp?.metodo_pago ?? null,
    pagado_ayudantes_reales: pp?.ayudantes_reales ?? null,
    pagado_comentario: pp?.comentario ?? null,
    pagado_ediciones: pp?.ediciones ?? null,
    tipo_carga: v.tipo_carga,
    bultos: v.bultos,
    peso_kg: v.peso_kg,
    volumen_m3: v.volumen_m3,
    pallets: v.pallets,
    valor_declarado: v.valor_declarado,
    vehiculo_tipo: v.vehiculo_snapshot?.tipo_vehiculo ?? null,
    parametros: snap.parametros ?? null,
  };
}

export async function datasetPrecios(req, res) {
  const parsed = schema.safeParse(req.query ?? {});
  if (!parsed.success) return responder400(res, parsed);
  const { page, limit, formato, desde, hasta } = parsed.data;

  const where = {
    version_precio: 2,
    estado: 'FINALIZADO',
    id_organizacion: { not: null },
    ...(desde || hasta
      ? {
          fecha_corte_precio: {
            ...(desde ? { gte: new Date(desde) } : {}),
            ...(hasta ? { lte: new Date(hasta) } : {}),
          },
        }
      : {}),
  };
  const [total, viajes] = await Promise.all([
    prisma.viaje.count({ where }),
    prisma.viaje.findMany({
      where,
      include: {
        paradas: {
          orderBy: { orden: 'asc' },
          select: { orden: true, pisos: true, no_visitada: true, manejo_sin_transito_horas: true },
        },
        precio_pagado: true,
      },
      orderBy: [{ fecha_corte_precio: 'asc' }, { id_viaje: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  const filas = viajes.map(filaDataset);

  if (formato === 'csv') {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="precios-dataset-p${page}.csv"`);
    res.set('X-Total-Count', String(total));
    return res.status(200).send(aCsv(filas, COLUMNAS_DATASET));
  }
  return res.status(200).json({ total, page, limit, viajes: filas });
}
