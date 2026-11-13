// LECTURA de los peajes de una ruta de Routes API (extraComputations TOLLS).
// PURO: recibe routes[0] de la respuesta y devuelve pesos enteros.
//
// Doc (RouteTravelAdvisory / RouteLegTravelAdvisory .tollInfo):
//   - tollInfo solo viene si se esperan peajes en la ruta / el leg. Sin
//     tollInfo = no hay peajes -> 0.
//   - tollInfo sin estimatedPrice = hay peajes pero con tarifa desconocida.
//   - estimatedPrice: lista de Money { currencyCode, units (string int64),
//     nanos }, una entrada por moneda. units y nanos se OMITEN cuando valen 0.
//   - El precio es el de un vehiculo NO comercial (auto): el multiplicador por
//     servicio se aplica despues (precio-entradas.js).
//
// Solo cuenta ARS: otra moneda es un peaje con tarifa desconocida (incompleto).
//
// Devuelve { ida, incompleto, tramos }:
//   ida        = peaje de IDA de toda la ruta (lo conocido), pesos enteros
//   incompleto = algun peaje sin tarifa o en otra moneda
//   tramos[i]  = peaje del leg que TERMINA en la parada i (la parada 0 es el
//                origen -> null). Leg sin tollInfo -> 0; leg con tollInfo sin
//                ningun monto en ARS -> null (desconocido).

// Money -> pesos (float). units llega como string.
export function dineroAPesos(money) {
  const units = Number(money?.units ?? 0);
  const nanos = Number(money?.nanos ?? 0);
  return (Number.isFinite(units) ? units : 0) + (Number.isFinite(nanos) ? nanos : 0) / 1e9;
}

// tollInfo -> { pesos (float, lo conocido en ARS), hayPeaje, conocido (algun ARS),
// incompleto }.
export function leerTollInfo(tollInfo) {
  if (!tollInfo) return { pesos: 0, hayPeaje: false, conocido: true, incompleto: false };
  const precios = Array.isArray(tollInfo.estimatedPrice) ? tollInfo.estimatedPrice : [];
  if (precios.length === 0) return { pesos: 0, hayPeaje: true, conocido: false, incompleto: true };
  let pesos = 0;
  let conocido = false;
  let incompleto = false;
  for (const m of precios) {
    if (m?.currencyCode === 'ARS') {
      pesos += dineroAPesos(m);
      conocido = true;
    } else {
      incompleto = true;
    }
  }
  return { pesos, hayPeaje: true, conocido, incompleto };
}

// A pesos enteros, redondeo normal (mitades hacia arriba; montos >= 0).
const aEntero = (x) => Math.floor(Math.max(0, x) + 0.5);

export function parsearPeajes(ruta) {
  const legs = Array.isArray(ruta?.legs) ? ruta.legs : [];
  const deLegs = legs.map((l) => leerTollInfo(l?.travelAdvisory?.tollInfo));
  const total = leerTollInfo(ruta?.travelAdvisory?.tollInfo);
  const tramos = [null, ...deLegs.map((t) => (t.hayPeaje && !t.conocido ? null : aEntero(t.pesos)))];
  return {
    ida: aEntero(total.pesos),
    incompleto: total.incompleto || deLegs.some((t) => t.incompleto),
    tramos,
  };
}
