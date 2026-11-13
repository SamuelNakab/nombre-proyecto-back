// Que ve cada uno de una PARADA (Paso 4, lugares guardados; Precio v2). Pura.
//
// REGLA: el chofer NUNCA ve el nombre de un lugar guardado de la PyME, ni los
// peajes que calculo Google. La parada le llega solo con direccion y
// coordenadas (mas sus tiempos y estado). Defensa en dos capas:
//   1. El nombre no esta en la fila de la parada: el snapshot copia direccion y
//      coordenadas, no el nombre (snapshotParadas). Los canales que spreadean la
//      fila cruda (admin, cierre) no lo pueden filtrar.
//   2. Lo que se le serializa al chofer pasa por paradaVistaChofer, que es una
//      LISTA BLANCA: cada columna escalar de Parada esta clasificada aca en
//      VISIBLES u OCULTAS, y vista-parada.test.js recorre
//      Prisma.ParadaScalarFieldEnum y FALLA si aparece una columna sin
//      clasificar. Una columna nueva no le puede llegar al chofer sin que alguien
//      decida que si (antes era un spread que solo sacaba id_lugar y `lugar`).
// Los sockets que reciben a la vez la PyME y el chofer (viaje:asignado,
// viaje:editado, serie:asignada) arman la parada con campos EXPLICITOS
// (resumenViaje) y no llevan ni el lugar ni los peajes: la PyME los ve por REST.

export const VISIBLES_CHOFER_PARADA = [
  'id_parada',
  'id_viaje',
  'orden',
  'direccion',
  'latitud',
  'longitud',
  // Columna SIN USO desde que se saco el QR (API.md avisa que se ignore).
  'qr_token',
  'estado',
  'fecha_entrega',
  'llegada_estimada',
  'salida_estimada',
  'peon_estimado_horas',
  'manejo_estimado_horas',
  'distancia_estimada_km',
  'llegada_real',
  'salida_real',
  'peon_real_horas',
  'manejo_real_horas',
  'salida_detectada',
  'origen_salida',
  'no_visitada',
  // Lo operativo que declaro la PyME para la parada.
  'acceso',
  'pisos',
  'operacion',
  'distancia_real_km',
  'manejo_sin_transito_horas',
];

export const OCULTAS_CHOFER_PARADA = [
  // El lugar guardado de la PyME (el chofer no ve ni el id ni el nombre).
  'id_lugar',
  // Peaje de ida de Google del tramo que llega (Precio v2): un monto.
  'peajes_google_tramo',
];

// Campos calculados que los serializadores le suman a la parada
// (paradasConTiempos -> tiemposParada) y que el chofer SI recibe.
export const CALCULADOS_CHOFER_PARADA = [
  'peon_medido',
  'peon_estimado_min',
  'manejo_estimado_min',
  'peon_real_min',
  'manejo_real_min',
  'manejo_sin_transito_min',
  'diferencia_min',
];

const CAMPOS_CHOFER_PARADA = [...VISIBLES_CHOFER_PARADA, ...CALCULADOS_CHOFER_PARADA];

// Sirve igual para la fila cruda (GET /api/viajes/:id) y para la parada ya con
// sus tiempos (serializarViajeChofer). La relacion `lugar` no se copia nunca.
export function paradaVistaChofer(parada) {
  const out = {};
  for (const c of CAMPOS_CHOFER_PARADA) if (parada[c] !== undefined) out[c] = parada[c];
  return out;
}

// La PyME ve el nombre ACTUAL del lugar (join), aun si se borro (activo false).
// TIRA si la parada viene de un lugar y el include no trajo la relacion: un
// include olvidado devolveria lugar null en silencio (mismo idiom que
// esViajeVencido y puedeVerViaje).
export function paradaVistaPyme(parada) {
  const { lugar, ...resto } = parada;
  if (parada.id_lugar != null && lugar === undefined) {
    throw new Error('paradaVistaPyme: la parada debe venir con la relacion lugar incluida');
  }
  return {
    ...resto,
    lugar: lugar ? { id_lugar: lugar.id_lugar, nombre: lugar.nombre, activo: lugar.activo } : null,
  };
}
