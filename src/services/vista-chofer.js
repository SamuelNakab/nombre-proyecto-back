// Que ve el CHOFER de un viaje INTERNO. PURO.
//
// Dos reglas:
//   1. El chofer NO ve precios, peajes ni tarifas de un viaje de PyME (Parte E
//      del precio v2): la PyME y el admin si.
//   2. El chofer NO ve datos personales de otros usuarios (email, DNI, telefono,
//      firebase_uid, ids internos de usuario): solo el nombre de la PyME y su
//      propio perfil (nombre, apellido, telefono).
//
// LISTA BLANCA: cada columna escalar de Viaje esta clasificada aca en VISIBLES o
// OCULTAS. vista-chofer.test.js recorre Prisma.ViajeScalarFieldEnum y FALLA si
// aparece una columna sin clasificar: una columna nueva no le puede llegar al
// chofer sin que alguien decida que si. Las relaciones se arman con campos
// EXPLICITOS (nunca un spread de una fila de Usuario o Conductor).

export const VISIBLES_CHOFER = [
  'id_viaje',
  'id_conductor',
  'id_vehiculo',
  'id_empresa',
  'zona',
  'duracion_estimada_horas',
  'fecha_programada',
  'descripcion',
  'motivo',
  'estado',
  'fecha_inicio',
  // La columna es MUERTA: el serializador la pisa con el valor calculado.
  'puntualidad_inicio',
  'fecha_llegada_origen',
  'fecha_reserva',
  'iniciado_por',
  'creado_en',
  'motivo_cancelacion',
  'id_organizacion',
  'metodo_cobro',
  'fecha_confirmacion',
  'fecha_rechazo',
  'causa_cancelacion',
  'manejo_estimado_horas',
  'peon_estimado_horas',
  'distancia_estimada_km',
  'manejo_real_horas',
  'peon_real_horas',
  'distancia_real_km',
  'id_serie',
  'cerrado_por',
  // Un instante, no un monto.
  'fecha_corte_precio',
  // Lo operativo que declaro la PyME: el chofer lo necesita para el viaje.
  'tipo_servicio',
  'ayudantes',
  // Si la PyME pide factura A (el chofer la emite); no es un monto.
  'factura_a',
  'tipo_carga',
  'bultos',
  'peso_kg',
  'volumen_m3',
  'pallets',
  // Valor de la mercaderia (seguro), no el precio del viaje.
  'valor_declarado',
  'gps_puntos',
  'gps_mayor_hueco_segundos',
  // Su propio vehiculo al confirmar.
  'vehiculo_snapshot',
];

export const OCULTAS_CHOFER = [
  // Precio, tarifas y peajes.
  'tarifa_hora',
  'tarifa_km',
  'distancia_provincia',
  'tiempo_capital',
  'precio_estimado',
  'precio_real',
  'version_precio',
  'precio_parametros',
  'precio_estimado_desglose',
  'precio_estimado_min',
  'precio_estimado_max',
  'precio_medido',
  'precio_medido_desglose',
  'peajes_estimados',
  'fuente_peajes',
  // Ids internos de OTROS usuarios (el creador de la PyME, el admin).
  'id_cliente',
  'id_creador',
  'cancelado_por_admin_id',
];

// Campos calculados por el serializador que el chofer si recibe.
const CALCULADOS_CHOFER = [
  'paradas',
  'estimado',
  'real',
  'duracion_estimada',
  'duracion_real',
  'duracion_carga',
  'duracion_descarga',
  'duracion_aproximacion_origen',
  'vencido',
  'cierre',
  'remito_url',
  'ruta_planeada',
];

const elegir = (obj, campos) => {
  const out = {};
  for (const c of campos) if (obj[c] !== undefined) out[c] = obj[c];
  return out;
};

// serializado: la salida del serializador comun de viajes internos (la fila
// cruda + los calculados) con las paradas ya en la vista del chofer.
export function viajeVistaChofer(serializado) {
  const v = serializado;
  return {
    ...elegir(v, VISIBLES_CHOFER),
    ...elegir(v, CALCULADOS_CHOFER),
    organizacion: v.organizacion
      ? { id_organizacion: v.organizacion.id_organizacion, nombre: v.organizacion.nombre, cuit: v.organizacion.cuit }
      : (v.organizacion ?? null),
    // Su propio perfil: lo que la pantalla necesita.
    conductor: v.conductor
      ? elegir(v.conductor, ['id_conductor', 'id_usuario', 'nombre', 'apellido', 'telefono'])
      : (v.conductor ?? null),
    vehiculo: v.vehiculo
      ? elegir(v.vehiculo, ['id_vehiculo', 'patente', 'marca', 'modelo', 'anio', 'color', 'tipo_vehiculo'])
      : (v.vehiculo ?? null),
    ...(v.historial_estados !== undefined
      ? {
          // Sin id_usuario: quien hizo cada cambio es un id interno de otro usuario.
          historial_estados: v.historial_estados.map((h) => elegir(h, ['id_historial', 'estado', 'fecha', 'origen'])),
        }
      : {}),
  };
}

// resumenViaje (sockets) sin precio, para el chofer.
export function resumenVistaChofer(resumen) {
  // eslint-disable-next-line no-unused-vars
  const { precio_estimado, precio_estimado_min, precio_estimado_max, ...resto } = resumen;
  return resto;
}
