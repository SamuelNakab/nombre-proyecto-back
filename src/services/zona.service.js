import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';

// Limite oficial de CABA (poligono real, 1024 vertices). Fuente: IGN via el
// Servicio de Normalizacion de Datos Geograficos de Argentina (georef-ar),
// dataset provincias v12.1.0. Ver src/data/limite-caba.geojson (propiedades
// con fuente y fecha) y CLAUDE.md.
//
// Se lee una sola vez al cargar el modulo: es un archivo estatico del repo.
const limiteCaba = JSON.parse(
  readFileSync(fileURLToPath(new URL('../data/limite-caba.geojson', import.meta.url)), 'utf8')
);

// Las paradas llegan con dos formas distintas segun de donde vengan: del body de
// un request son { lat, lng }, y de la base son { latitud, longitud }. Se
// aceptan las dos para que el caller no tenga que mapear (y no se desincronicen
// el calculo de creacion y el de cierre).
function coordenadas(parada) {
  const lat = parada?.lat ?? parada?.latitud;
  const lng = parada?.lng ?? parada?.longitud;

  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    throw new Error('Parada sin coordenadas validas: se esperaba { lat, lng } o { latitud, longitud }');
  }

  return { lat, lng };
}

// true si el punto cae dentro del poligono de CABA, false si cae afuera
// (Provincia). Un punto exactamente sobre el borde cuenta como dentro.
export function clasificarParada(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    throw new Error('clasificarParada requiere lat y lng numericos');
  }

  return turf.booleanPointInPolygon(turf.point([lng, lat]), limiteCaba);
}

// Cuenta cuantas paradas caen dentro de CABA y cuantas afuera. Se expone aparte
// de clasificarZona porque el reparto proporcional del precio de los viajes
// MIXTO necesita la fraccion, no solo la etiqueta.
export function contarParadasPorZona(paradas) {
  if (!Array.isArray(paradas) || paradas.length === 0) {
    throw new Error('contarParadasPorZona requiere al menos una parada');
  }

  let en_caba = 0;
  for (const parada of paradas) {
    const { lat, lng } = coordenadas(parada);
    if (clasificarParada(lat, lng)) en_caba++;
  }

  const total = paradas.length;

  return {
    en_caba,
    fuera_caba: total - en_caba,
    total,
    fraccion_caba: en_caba / total,
  };
}

// Zona del viaje entero a partir de sus paradas: CABA si TODAS caen dentro,
// PROVINCIA si TODAS caen afuera, MIXTO si hay de las dos. Es la unica fuente
// de verdad de la zona — el valor que manda el cliente en el body se ignora.
export function clasificarZona(paradas) {
  const { en_caba, total } = contarParadasPorZona(paradas);

  if (en_caba === total) return 'CABA';
  if (en_caba === 0) return 'PROVINCIA';
  return 'MIXTO';
}

// Reparte el tiempo y la distancia totales del viaje en las dos magnitudes que
// se facturan: tiempo_capital (se cobra por hora, tarifa CABA) y
// distancia_provincia (se cobra por km, tarifa Provincia). null = no se cobra
// por ese concepto.
//
//   CABA      -> se cobra todo el tiempo, nada de distancia.
//   PROVINCIA -> se cobra toda la distancia, nada de tiempo.
//   MIXTO     -> se reparte proporcionalmente.
//
// APROXIMACION: en MIXTO el reparto se hace por CANTIDAD DE PARADAS
// (fraccion_caba = paradas_en_caba / total_paradas), NO por el recorrido real.
// Un viaje con 1 parada en CABA y 1 en Provincia factura mitad y mitad aunque
// el tramo real dentro de CABA haya sido mucho mas corto o mas largo.
// Antes de esto se cobraba el tiempo total Y la distancia total (doble cobro),
// asi que esto ya es estrictamente mejor. PENDIENTE: prorratear por tramo GPS
// real, clasificando cada punto del recorrido con clasificarParada.
//
// Unica definicion del reparto: la usan la estimacion (costo.service), el cierre
// (cierre.service) y el precio acumulado en vivo (viajes.controller), para que
// no se puedan desincronizar entre si.
export function repartirPorZona({ zona, paradas, tiempo_horas, distancia_km }) {
  if (zona === 'CABA') {
    return { tiempo_capital: tiempo_horas, distancia_provincia: null, fraccion_caba: 1 };
  }

  if (zona === 'PROVINCIA') {
    return { tiempo_capital: null, distancia_provincia: distancia_km, fraccion_caba: 0 };
  }

  const { fraccion_caba } = contarParadasPorZona(paradas);

  return {
    tiempo_capital: tiempo_horas * fraccion_caba,
    distancia_provincia: distancia_km * (1 - fraccion_caba),
    fraccion_caba,
  };
}
