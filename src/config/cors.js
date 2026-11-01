// CORS (Tarea 6). Un solo criterio para Express y Socket.io.
//
// CORS_ORIGINS: origenes permitidos separados por coma, sin barra final
// ("https://app.fleter.com.ar,https://*.vercel.app"). Un `*` reemplaza
// exactamente UNA etiqueta del host (para previews): https://*.vercel.app deja
// pasar https://pr-12.vercel.app pero no https://a.b.vercel.app ni
// http://pr-12.vercel.app. El resto se compara exacto.
//
// - Sin CORS_ORIGINS: igual que antes (cualquier origen) + warning al arrancar.
//   Asi se puede mergear sin romper la web y se cierra cargando la variable.
// - Un request SIN header Origin (mobile, curl, server-to-server, el simulador)
//   pasa SIEMPRE: CORS es una defensa del navegador.
// - Se lee al ARRANCAR (cors y socket.io arman su config una vez).

const escapar = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// -> null (variable no definida o vacia = sin restriccion) | [{ exacto } | { patron }]
export function parsearOrigenes(valor) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return null;
  return String(valor)
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .map((o) =>
      o.includes('*')
        ? { origen: o, patron: new RegExp(`^${o.split('*').map(escapar).join('[^./:]+')}$`, 'i') }
        : { origen: o, exacto: o.toLowerCase() }
    );
}

export function origenPermitido(origin, lista) {
  if (!origin) return true;
  if (!lista) return true;
  const o = String(origin).replace(/\/+$/, '').toLowerCase();
  return lista.some((r) => (r.exacto ? r.exacto === o : r.patron.test(o)));
}

export function configurarCors(env = process.env) {
  const lista = parsearOrigenes(env.CORS_ORIGINS);
  if (!lista) {
    const prod = (env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV) === 'production';
    console.warn(
      `[cors] ${prod ? 'ATENCION (production): ' : ''}CORS_ORIGINS no configurado: se aceptan TODOS los origenes (igual que antes). Cargala para cerrar CORS.`
    );
  } else {
    console.log(`[cors] origenes permitidos: ${lista.map((r) => r.origen).join(', ')}`);
  }
  const permitido = (origin) => origenPermitido(origin, lista);
  return {
    lista,
    permitido,
    // Para el paquete `cors` de Express. Un origen no permitido sale SIN headers
    // CORS (el navegador lo bloquea); no se responde 403.
    // Sin lista, '*' literal: exactamente el header de antes.
    express: {
      origin: lista ? (origin, cb) => cb(null, permitido(origin)) : '*',
      maxAge: 600,
      // Sin exponerlos, el front web no puede leer Retry-After ni los RateLimit.
      exposedHeaders: ['Retry-After', 'RateLimit', 'RateLimit-Policy'],
    },
  };
}
