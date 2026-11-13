// CONFIGURACION del precio v2 y del feedback del precio pagado. UNICO lugar con
// los numeros del algoritmo: ningun otro modulo hardcodea un parametro.
//
// Regla de parseo UNICA (configPrecio):
//   - variable ausente                       -> default, sin warning
//   - numero finito >= 0                     -> se usa (el 0 vale)
//   - vacia, invalida o negativa             -> default + warning al arrancar
//   - tipo 'positivo' (horas minimas, fraccion, redondeo): tiene que ser > 0
//   - tipo 'entero' (cantidades y dias): tiene que ser un entero >= 0
//   - tipo 'booleano' (kill switch): true / 1 o false / 0 (sin distinguir
//     mayusculas); cualquier otra cosa -> default + warning
//
// Se lee en cada calculo (convencion del repo: nada se cachea) y el warning sale
// una vez al arrancar (advertirConfigPrecio, en app.js). Un viaje v2 guarda en
// su snapshot (Viaje.precio_parametros) los valores con los que se estimo: el
// medido y el vivo usan ese snapshot, asi que cambiar el env NO altera viajes ya
// creados.
//
// OJO: la DB esta compartida entre staging y production; conviene que las
// PRECIO_* valgan lo mismo en los dos (un viaje creado en uno se edita en el otro).

const NUMERO = 'numero';
const POSITIVO = 'positivo';
const ENTERO = 'entero';
const BOOLEANO = 'booleano';

export const DEFINICION_PRECIO = {
  PRECIO_MINIMO_LIVIANO: [84000, NUMERO],
  PRECIO_MINIMO_EQUIPO: [200000, NUMERO],
  PRECIO_MINIMO_CAMION: [370000, NUMERO],
  PRECIO_MINIMO_HORAS_LIVIANO: [2, POSITIVO],
  PRECIO_MINIMO_HORAS_EQUIPO: [2, POSITIVO],
  PRECIO_MINIMO_HORAS_CAMION: [4, POSITIVO],
  PRECIO_HORA_LIVIANO: [37500, NUMERO],
  PRECIO_HORA_EQUIPO: [100000, NUMERO],
  PRECIO_HORA_CAMION: [56000, NUMERO],
  PRECIO_HORA_AYUDANTE: [12000, NUMERO],
  PRECIO_AYUDANTES_MAX: [1, ENTERO],
  PRECIO_EQUIPO_AYUDANTES: [2, ENTERO],
  PRECIO_KM_IDA: [4500, NUMERO],
  PRECIO_RECARGO_PROVINCIA_PORCENTAJE: [10, NUMERO],
  PRECIO_RECARGO_ESCALERA_PORCENTAJE: [25, NUMERO],
  PRECIO_PARADA_EXTRA: [25000, NUMERO],
  PRECIO_FRACCION_MINUTOS: [30, POSITIVO],
  PRECIO_MINUTOS_POR_PARADA: [15, NUMERO],
  PRECIO_IVA_PORCENTAJE: [21, NUMERO],
  PRECIO_REDONDEO: [1000, POSITIVO],
  PRECIO_RANGO_BAJO_PORCENTAJE: [20, NUMERO],
  PRECIO_RANGO_ALTO_PORCENTAJE: [30, NUMERO],
  PRECIO_GPS_MIN_PUNTOS: [10, ENTERO],
  PRECIO_GPS_DISTANCIA_MIN_PORCENTAJE: [50, NUMERO],
  // Peajes de Google (Routes TOLLS, SKU Enterprise, ver peajes.service.js):
  // monto usado = peaje de ida x FACTOR_VUELTA x MULTIPLICADOR_<SERVICIO>
  // (Google cotiza un auto: el multiplicador lleva a la categoria del vehiculo).
  PRECIO_PEAJES_FACTOR_VUELTA: [2, NUMERO],
  PRECIO_PEAJES_MULTIPLICADOR_LIVIANO: [1, NUMERO],
  PRECIO_PEAJES_MULTIPLICADOR_EQUIPO: [1, NUMERO],
  PRECIO_PEAJES_MULTIPLICADOR_CAMION: [2, NUMERO],
  // Cache en Redis del resultado CRUDO de Google; 0 = sin cache.
  PRECIO_PEAJES_CACHE_SEGUNDOS: [900, ENTERO],
  // Kill switch: false -> no se llama a Google (fuente NINGUNA salvo la PyME).
  PEAJES_GOOGLE_HABILITADO: [true, BOOLEANO],
  FEEDBACK_PRECIO_EDICION_DIAS: [30, ENTERO],
  FEEDBACK_PRECIO_MONTO_MAX: [100000000, ENTERO],
};

function leerBooleano(texto) {
  const t = texto.toLowerCase();
  if (t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  return null;
}

function valido(n, tipo) {
  if (!Number.isFinite(n) || n < 0) return false;
  if (tipo === POSITIVO) return n > 0;
  if (tipo === ENTERO) return Number.isInteger(n);
  return true;
}

// { valores: { NOMBRE: numero }, invalidas: [{ nombre, valor, defecto }] }
export function leerConfigPrecio(env = process.env) {
  const valores = {};
  const invalidas = [];
  for (const [nombre, [defecto, tipo]] of Object.entries(DEFINICION_PRECIO)) {
    const raw = env[nombre];
    if (raw === undefined || raw === null) {
      valores[nombre] = defecto;
      continue;
    }
    const texto = String(raw).trim();
    if (tipo === BOOLEANO) {
      const b = leerBooleano(texto);
      valores[nombre] = b ?? defecto;
      if (b === null) invalidas.push({ nombre, valor: raw, defecto });
      continue;
    }
    const n = texto === '' ? NaN : Number(texto);
    if (valido(n, tipo)) {
      valores[nombre] = n;
    } else {
      valores[nombre] = defecto;
      invalidas.push({ nombre, valor: raw, defecto });
    }
  }
  return { valores, invalidas };
}

// Los parametros vigentes (sin warnings).
export const configPrecio = (env = process.env) => leerConfigPrecio(env).valores;

// Al arrancar: un warning por cada variable invalida (y un aviso si los peajes de
// Google estan apagados). Devuelve las invalidas.
export function advertirConfigPrecio(env = process.env, log = console.warn) {
  const { valores, invalidas } = leerConfigPrecio(env);
  for (const { nombre, valor, defecto } of invalidas) {
    log(`[precio] ${nombre}=${JSON.stringify(valor)} invalido: se usa el default ${defecto}`);
  }
  if (!valores.PEAJES_GOOGLE_HABILITADO) {
    log('[peajes] PEAJES_GOOGLE_HABILITADO=false: no se calculan peajes con Google');
  }
  return invalidas;
}
