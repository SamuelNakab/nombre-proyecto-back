import { z } from 'zod';

// Piezas de validacion de un viaje compartidas por la ruta LEGACY
// (POST /api/viajes) y la del ciclo INTERNO (POST/PUT
// /api/organizaciones/:id/viajes, y la plantilla de las series). Estaban inline
// en viajes.controller; se extrajeron para que las rutas no se puedan
// desincronizar (mismo formato de paradas, mismo tope, mismas condiciones, mismo
// minimo de anticipacion y mismo mensaje).

export const CONDICIONES = ['FRAGIL', 'REFRIGERADO', 'CARGA_PESADA', 'PELIGROSO', 'VOLUMINOSO'];

// ─── Tope de paradas por viaje ───────────────────────────────────────────────

// MAX_PARADAS_POR_VIAJE: tope GLOBAL (crear interno, editar, estimar-costo,
// POST /api/viajes legacy y la plantilla de las series). Cada parada de mas es
// un tramo mas a Google: una llamada Pro por viaje, y por cada viaje de una
// serie. Se lee en CADA validacion. Basura o < 2 (un viaje necesita al menos 2)
// -> default. `env` es inyectable para los tests.
export const MAX_PARADAS_DEFAULT = 10;

export function maxParadasPorViaje(env = process.env) {
  const crudo = env.MAX_PARADAS_POR_VIAJE;
  if (crudo === undefined || crudo === null || String(crudo).trim() === '') return MAX_PARADAS_DEFAULT;
  const n = Number(crudo);
  return Number.isInteger(n) && n >= 2 ? n : MAX_PARADAS_DEFAULT;
}

export const mensajeTopeParadas = (max) => `Un viaje puede tener como máximo ${max} paradas`;

// min(2) + el tope. En EDITAR el schema va .optional(): el tope solo aplica si
// llegan paradas, asi un viaje viejo que ya lo supere no se rompe al cambiarle la
// fecha o la descripcion.
const conTopeParadas = (item) =>
  z
    .array(item)
    .min(2)
    .superRefine((paradas, ctx) => {
      const max = maxParadasPorViaje();
      if (paradas.length > max) ctx.addIssue({ code: 'custom', message: mensajeTopeParadas(max) });
    });

const paradaCoordenadas = z.object({
  lat: z.number(),
  lng: z.number(),
  direccion: z.string().min(1).optional(),
});

// Paradas de la ruta LEGACY y de estimar-costo: solo coordenadas.
export const schemaParadas = conTopeParadas(paradaCoordenadas);

// Paradas del ciclo INTERNO y de las series (Paso 4): cada una es un lugar
// guardado { id_lugar } O coordenadas { lat, lng, direccion? }, nunca las dos
// cosas (no hay forma razonable de decidir cual gana).
const paradaInterna = z
  .object({
    id_lugar: z.number().int('id_lugar invalido').positive('id_lugar invalido').optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    direccion: z.string().min(1).optional(),
  })
  .superRefine((p, ctx) => {
    const tieneCoordenadas = p.lat !== undefined || p.lng !== undefined || p.direccion !== undefined;
    if (p.id_lugar !== undefined) {
      if (tieneCoordenadas) {
        ctx.addIssue({ code: 'custom', message: 'Cada parada lleva id_lugar o lat y lng, no las dos cosas' });
      }
      return;
    }
    if (p.lat === undefined || p.lng === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Cada parada lleva id_lugar o lat y lng' });
    }
  });

export const schemaParadasInternas = conTopeParadas(paradaInterna);

export const schemaCondiciones = z.array(z.enum(CONDICIONES));

export const camposBase = {
  // `zona` se acepta SOLO por compatibilidad con el front actual, que la sigue
  // mandando. Su valor se IGNORA: la zona real se calcula en el servidor a
  // partir de las coordenadas de las paradas (clasificarZona). Ver zona.service.
  zona: z.enum(['CABA', 'PROVINCIA', 'MIXTO']).optional(),
  paradas: schemaParadas,
};

// ─── Fecha programada ────────────────────────────────────────────────────────

// Anticipacion minima para programar un viaje. Configurable porque en
// staging/local hay que poder crear viajes y debuggearlos sin esperar una hora.
// Se lee en CADA request (no se cachea en el modulo) para que el umbral y el
// mensaje de error no se puedan desincronizar, y para poder cambiarla sin
// redeploy de codigo.
const ANTICIPACION_MINIMA_DEFAULT = 60;

export function anticipacionMinimaMinutos() {
  const valor = Number(process.env.ANTICIPACION_MINIMA_MINUTOS ?? ANTICIPACION_MINIMA_DEFAULT);
  // Un valor basura (NaN) o negativo se ignora: sin este guard, NaN haria que
  // TODA comparacion diera false y no se pudiera crear ningun viaje.
  if (!Number.isFinite(valor) || valor < 0) return ANTICIPACION_MINIMA_DEFAULT;
  return valor;
}

export const schemaFechaProgramada = z.string().superRefine((val, ctx) => {
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
});

// ─── Paradas -> filas ────────────────────────────────────────────────────────

// SNAPSHOT de los lugares guardados (Paso 4). Pura: `lugaresPorId` es un Map
// id_lugar -> fila de Lugar, ya validada (activa y de la PyME: eso lo hace
// resolverParadas en lugar.service). Una parada { id_lugar } pasa a llevar una
// COPIA de la direccion y las coordenadas del lugar, mas su id_lugar: editar o
// borrar el lugar despues no cambia nada. El NOMBRE del lugar NO se copia: no
// viaja nunca en la fila de la parada, asi que ningun serializador que spreadee
// la fila cruda se lo puede mostrar al chofer. Una parada con coordenadas queda
// igual, con id_lugar null.
export function snapshotParadas(paradas, lugaresPorId) {
  return paradas.map((p) => {
    if (p.id_lugar === undefined || p.id_lugar === null) {
      return { lat: p.lat, lng: p.lng, ...(p.direccion ? { direccion: p.direccion } : {}), id_lugar: null };
    }
    const lugar = lugaresPorId.get(p.id_lugar);
    if (!lugar) throw new Error(`snapshotParadas: falta el lugar ${p.id_lugar}`);
    return { lat: lugar.latitud, lng: lugar.longitud, direccion: lugar.direccion, id_lugar: lugar.id_lugar };
  });
}

// Paradas (del body, o ya resueltas por snapshotParadas) -> filas de Parada.
// Mismo mapeo en la ruta legacy, la interna y las series.
export function paradasParaCrear(paradas) {
  return paradas.map((p, i) => ({
    orden: i + 1,
    latitud: p.lat,
    longitud: p.lng,
    direccion: p.direccion ?? `${p.lat},${p.lng}`,
    id_lugar: p.id_lugar ?? null,
  }));
}
