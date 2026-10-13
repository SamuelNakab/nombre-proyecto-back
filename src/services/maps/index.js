// CAPA UNICA DE GOOGLE. Es el UNICO modulo del backend que habla con Google
// Maps: nadie mas hace fetch a routes.googleapis.com ni a maps.googleapis.com.
//
// Tres operaciones:
//   - calcularTramo: un tramo origen -> destino saliendo a una hora dada, con
//     trafico. Distancia, manejo y polilinea. Lo usa la estimacion (crear,
//     editar, estimar-costo). SKU Pro.
//   - calcularEta: desde la posicion del chofer hasta la proxima parada, con el
//     trafico de ahora. Lo usa el emisor de ETA. SKU Pro.
//   - calcularRuta: una ruta por N puntos en UNA llamada, sin trafico. La usan
//     el recalculo por desvio y el fallback de ruta de gps.socket. SKU
//     Essentials (Pro con mas de 10 intermedios).
//
// REGLA: NUNCA devuelve valores inventados. Si Google falla tira ErrorMaps:
// NO_DISPONIBLE (503) o SIN_RUTA (400). Cada caller decide: crear / editar /
// estimar responden el error; el ETA saltea ese ciclo; el desvio mantiene la
// ruta anterior.
//
// MAPS_PROVIDER=routes (default) | legacy (Directions; rollback temporal).
// MAPS_TIMEOUT_MS (default 8000): timeout por llamada. Los dos se leen en cada
// llamada.
import * as routes from './routes.js';
import * as legacy from './legacy.js';
import { ErrorMaps, errorDeRed, errorDesdeHttp, noDisponible } from './comun.js';

export { ErrorMaps } from './comun.js';

const PROVEEDORES = { routes, legacy };
const TIMEOUT_DEFAULT_MS = 8000;

export function proveedorMaps() {
  return process.env.MAPS_PROVIDER === 'legacy' ? 'legacy' : 'routes';
}

export function timeoutMapsMs() {
  const valor = Number(process.env.MAPS_TIMEOUT_MS);
  return Number.isFinite(valor) && valor > 0 ? valor : TIMEOUT_DEFAULT_MS;
}

// Contador por proceso, para el reporte de cuota. Cuenta los pedidos que
// salieron hacia Google (no los que cortamos antes por falta de key).
const llamadasPorSku = {};
const llamadasPorOperacion = {};

export function estadisticasMaps() {
  return { por_sku: { ...llamadasPorSku }, por_operacion: { ...llamadasPorOperacion } };
}

const resumenSku = () =>
  Object.entries(llamadasPorSku)
    .map(([sku, n]) => `${sku}=${n}`)
    .join(' ');

// Hace UNA llamada: arma el pedido con el proveedor, fetch con timeout, lee la
// respuesta y loguea operacion, ms y status. Nunca loguea la URL (en legacy
// lleva la key) ni la key.
async function llamar(operacion, datos) {
  const nombre = proveedorMaps();
  const proveedor = PROVEEDORES[nombre];
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    const err = noDisponible('sin GOOGLE_MAPS_API_KEY');
    console.error(`[maps] ${nombre} ${operacion} sin llamar: ${err.detalle}`);
    throw err;
  }

  const sufijo = operacion[0].toUpperCase() + operacion.slice(1);
  const pedido = proveedor[`pedido${sufijo}`]({ ...datos, apiKey });
  llamadasPorSku[pedido.sku] = (llamadasPorSku[pedido.sku] ?? 0) + 1;
  llamadasPorOperacion[operacion] = (llamadasPorOperacion[operacion] ?? 0) + 1;

  const inicio = Date.now();
  let status = 'ERR';
  try {
    let cuerpo;
    try {
      const res = await fetch(pedido.url, { ...pedido.init, signal: AbortSignal.timeout(timeoutMapsMs()) });
      status = res.status;
      cuerpo = await res.json().catch(() => null);
      if (!res.ok) throw errorDesdeHttp(res.status, cuerpo);
    } catch (err) {
      throw errorDeRed(err);
    }
    const resultado = proveedor[`leer${sufijo}`](cuerpo);
    console.log(`[maps] ${nombre} ${operacion} ${status} ${Date.now() - inicio}ms (${resumenSku()})`);
    return resultado;
  } catch (err) {
    const e = err instanceof ErrorMaps ? err : noDisponible(err?.message);
    console.error(
      `[maps] ${nombre} ${operacion} ${status} ${Date.now() - inicio}ms ${e.tipo}: ${e.detalle} (${resumenSku()})`
    );
    throw e;
  }
}

// { origen, destino, salida: Date, ahora?: Date } -> { distancia_km, manejo_horas, polilinea }
export function calcularTramo({ origen, destino, salida, ahora = new Date() }) {
  return llamar('tramo', { origen, destino, salida, ahora });
}

// { origen, destino } -> { segundos, distancia_metros }
export function calcularEta({ origen, destino }) {
  return llamar('eta', { origen, destino });
}

// [punto, ...] (>= 2) -> [[lng, lat], ...]
export function calcularRuta(puntos) {
  if (!Array.isArray(puntos) || puntos.length < 2) {
    throw new Error('calcularRuta: hacen falta al menos 2 puntos');
  }
  return llamar('ruta', { puntos });
}
