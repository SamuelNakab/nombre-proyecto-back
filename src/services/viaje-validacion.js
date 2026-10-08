import { z } from 'zod';

// Piezas de validacion de un viaje compartidas por la ruta LEGACY
// (POST /api/viajes) y la del ciclo INTERNO (POST/PUT
// /api/organizaciones/:id/viajes). Estaban inline en viajes.controller; se
// extrajeron para que las dos rutas no se puedan desincronizar (mismo formato de
// paradas, mismas condiciones, mismo minimo de anticipacion y mismo mensaje).

export const CONDICIONES = ['FRAGIL', 'REFRIGERADO', 'CARGA_PESADA', 'PELIGROSO', 'VOLUMINOSO'];

export const schemaParadas = z
  .array(
    z.object({
      lat: z.number(),
      lng: z.number(),
      direccion: z.string().min(1).optional(),
    })
  )
  .min(2);

export const schemaCondiciones = z.array(z.enum(CONDICIONES));

export const camposBase = {
  // `zona` se acepta SOLO por compatibilidad con el front actual, que la sigue
  // mandando. Su valor se IGNORA: la zona real se calcula en el servidor a
  // partir de las coordenadas de las paradas (clasificarZona). Ver zona.service.
  zona: z.enum(['CABA', 'PROVINCIA', 'MIXTO']).optional(),
  paradas: schemaParadas,
};

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

// Paradas del body -> filas de Parada. Mismo mapeo en la ruta legacy y la nueva.
export function paradasParaCrear(paradas) {
  return paradas.map((p, i) => ({
    orden: i + 1,
    latitud: p.lat,
    longitud: p.lng,
    direccion: p.direccion ?? `${p.lat},${p.lng}`,
  }));
}
