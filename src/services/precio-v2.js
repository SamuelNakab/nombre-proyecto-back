// FORMULA del precio v2 de los viajes internos (PyME). PURA: recibe las entradas
// efectivas y los parametros (los del snapshot del viaje o los vigentes) y
// devuelve total, rango y desglose. Calibrada con 52 presupuestos reales de
// fleteros. La v1 (precio-real.js) NO cambia: sigue para los viajes con
// version_precio null y para el marketplace.
//
// Algoritmo (los nombres de parametros son las variables de config/precio.js):
//   min_h    = PRECIO_MINIMO_HORAS_<SERVICIO>
//   fraccion = PRECIO_FRACCION_MINUTOS / 60
//   h        = max(min_h, ceil(horas / fraccion) * fraccion)
//   tiempo   = PRECIO_MINIMO_<SERVICIO> + (h - min_h) * PRECIO_HORA_<SERVICIO>
//              (+ h * ayudantes * PRECIO_HORA_AYUDANTE si el servicio no es EQUIPO)
//   distancia = km_ida * PRECIO_KM_IDA
//   precio   = max(tiempo, distancia); regimen TIEMPO si distancia <= tiempo
//   provincia, regimen TIEMPO y servicio != CAMION -> + tiempo * RECARGO_PROVINCIA %
//   escalera -> + tiempo * RECARGO_ESCALERA %
//   + paradas_extra * PRECIO_PARADA_EXTRA
//   iva = factura_a ? subtotal * IVA % : 0         (los peajes NO llevan IVA)
//   total = redondear(subtotal + iva + peajes); bajo / alto = total -/+ RANGO %
//
// Pesos enteros: cada componente se redondea al peso (mitades hacia arriba) y el
// subtotal es la suma de los componentes enteros, asi el desglose cierra exacto;
// total / bajo / alto van al multiplo de PRECIO_REDONDEO mas cercano y la
// diferencia queda en ajuste_redondeo.

export const SERVICIOS = ['LIVIANO', 'EQUIPO', 'CAMION'];
export const VERSION_V2 = 2;

// Tolerancia de float: 66.3 * 4500 = 298349.99999999994, y horas que vienen de
// sumar tramos pueden quedar en 1.0000000002 (no tienen que subir de fraccion).
const EPS = 1e-7;

// Al peso entero, mitades hacia arriba (montos >= 0).
export const aPesos = (x) => Math.floor(x + 0.5 + EPS);

// Al multiplo de `redondeo` mas cercano, mitades hacia arriba.
export function redondearPrecio(x, redondeo) {
  return Math.floor(x / redondeo + 0.5 + EPS) * redondeo;
}

// Horas facturables: el minimo del servicio o las horas subidas a la fraccion.
export function horasFacturables(horas, minimoHoras, fraccionMinutos) {
  const fraccion = fraccionMinutos / 60;
  const subidas = Math.ceil(Math.max(0, horas) / fraccion - EPS) * fraccion;
  return Math.max(minimoHoras, subidas);
}

// Lo que el desglose guarda de los parametros: solo los que usa ESTE calculo.
function parametrosUsados(p, servicio) {
  return {
    minimo: p[`PRECIO_MINIMO_${servicio}`],
    minimo_horas: p[`PRECIO_MINIMO_HORAS_${servicio}`],
    hora: p[`PRECIO_HORA_${servicio}`],
    hora_ayudante: p.PRECIO_HORA_AYUDANTE,
    km_ida: p.PRECIO_KM_IDA,
    recargo_provincia_porcentaje: p.PRECIO_RECARGO_PROVINCIA_PORCENTAJE,
    recargo_escalera_porcentaje: p.PRECIO_RECARGO_ESCALERA_PORCENTAJE,
    parada_extra: p.PRECIO_PARADA_EXTRA,
    fraccion_minutos: p.PRECIO_FRACCION_MINUTOS,
    iva_porcentaje: p.PRECIO_IVA_PORCENTAJE,
    redondeo: p.PRECIO_REDONDEO,
    rango_bajo_porcentaje: p.PRECIO_RANGO_BAJO_PORCENTAJE,
    rango_alto_porcentaje: p.PRECIO_RANGO_ALTO_PORCENTAJE,
  };
}

// entradas: { km_ida, horas, servicio, ayudantes, provincia, paradas_extra,
//             escalera, factura_a, peajes, fuente_peajes, ...otras (se copian) }
// parametros: los valores de config/precio.js (o los del snapshot).
// TIRA con un servicio desconocido (el caller ya valido; es defensivo).
export function calcularPrecioV2(entradas, parametros) {
  const p = parametros;
  const servicio = entradas.servicio;
  if (!SERVICIOS.includes(servicio)) throw new Error(`calcularPrecioV2: servicio desconocido ${servicio}`);

  const minimoHoras = p[`PRECIO_MINIMO_HORAS_${servicio}`];
  const h = horasFacturables(entradas.horas, minimoHoras, p.PRECIO_FRACCION_MINUTOS);
  const ayudantes = servicio === 'EQUIPO' ? 0 : Math.max(0, entradas.ayudantes ?? 0);

  const tiempo_base = aPesos(p[`PRECIO_MINIMO_${servicio}`] + (h - minimoHoras) * p[`PRECIO_HORA_${servicio}`]);
  const costo_ayudantes = aPesos(h * ayudantes * p.PRECIO_HORA_AYUDANTE);
  const tiempo = tiempo_base + costo_ayudantes;
  const km_ida = Math.max(0, entradas.km_ida ?? 0);
  const distancia = aPesos(km_ida * p.PRECIO_KM_IDA);
  const regimen = distancia <= tiempo ? 'TIEMPO' : 'DISTANCIA';
  const precio_base = Math.max(tiempo, distancia);

  const recargo_provincia =
    entradas.provincia && regimen === 'TIEMPO' && servicio !== 'CAMION'
      ? aPesos((tiempo * p.PRECIO_RECARGO_PROVINCIA_PORCENTAJE) / 100)
      : 0;
  const recargo_escalera = entradas.escalera ? aPesos((tiempo * p.PRECIO_RECARGO_ESCALERA_PORCENTAJE) / 100) : 0;
  const paradas_extra = Math.max(0, entradas.paradas_extra ?? 0);
  const monto_paradas_extra = aPesos(paradas_extra * p.PRECIO_PARADA_EXTRA);

  const subtotal_sin_iva = precio_base + recargo_provincia + recargo_escalera + monto_paradas_extra;
  const iva = entradas.factura_a ? aPesos((subtotal_sin_iva * p.PRECIO_IVA_PORCENTAJE) / 100) : 0;
  const peajes = aPesos(Math.max(0, entradas.peajes ?? 0));
  const sin_redondear = subtotal_sin_iva + iva + peajes;

  const total = redondearPrecio(sin_redondear, p.PRECIO_REDONDEO);
  const bajo = redondearPrecio((total * (100 - p.PRECIO_RANGO_BAJO_PORCENTAJE)) / 100, p.PRECIO_REDONDEO);
  const alto = redondearPrecio((total * (100 + p.PRECIO_RANGO_ALTO_PORCENTAJE)) / 100, p.PRECIO_REDONDEO);

  return {
    version: VERSION_V2,
    total,
    bajo,
    alto,
    desglose: {
      version: VERSION_V2,
      servicio,
      horas: entradas.horas,
      horas_facturables: h,
      tiempo_base,
      ayudantes,
      costo_ayudantes,
      tiempo,
      km_ida,
      distancia,
      regimen,
      precio_base,
      recargo_provincia,
      recargo_escalera,
      paradas_extra,
      monto_paradas_extra,
      subtotal_sin_iva,
      factura_a: Boolean(entradas.factura_a),
      iva,
      peajes,
      fuente_peajes: entradas.fuente_peajes ?? null,
      ajuste_redondeo: total - sin_redondear,
      total,
      bajo,
      alto,
      parametros: parametrosUsados(p, servicio),
      entradas: { ...entradas },
    },
  };
}
