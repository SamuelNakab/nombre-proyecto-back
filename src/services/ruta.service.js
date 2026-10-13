import prisma from '../config/prisma.js';
import { guardarRuta, obtenerRuta } from './gps.service.js';
import { calcularRuta } from './maps/index.js';

// Servicio de ruta planeada del viaje. La ruta es un array de puntos [lng, lat]
// (orden longitud, latitud). Se cachea en Redis (gps:{id_viaje}:ruta) y se
// sirve al front al crear el viaje, al asignar conductor y al consultar el
// detalle.
//
// Al crear y al editar, la ruta sale de la MISMA estimacion que el precio: se
// concatenan las polilineas de los tramos (ver estimacion.service), sin una
// llamada aparte a Google. calcularYGuardarRuta queda para el fallback de
// gps.socket (viaje sin ruta en Redis, p. ej. porque vencio su TTL).
//
// No hay "ruta recta" de emergencia: si Google falla, tira ErrorMaps y el
// llamador decide (gps.socket sigue sin ruta; el desvio mantiene la anterior).

// Guarda en Redis una ruta ya calculada (la polilinea de la estimacion).
export async function guardarRutaPlaneada(id_viaje, polilinea) {
  await guardarRuta(id_viaje, polilinea);
  return polilinea;
}

// Calcula la ruta planeada del viaje con UNA llamada (calcularRuta, por todas
// las paradas) y la guarda en Redis. TIRA si Google falla o el viaje no tiene
// suficientes paradas.
export async function calcularYGuardarRuta(id_viaje) {
  const paradas = await prisma.parada.findMany({
    where: { id_viaje },
    orderBy: { orden: 'asc' },
  });
  if (paradas.length < 2) throw new Error('El viaje no tiene suficientes paradas para una ruta');

  const ruta = await calcularRuta(paradas);
  await guardarRuta(id_viaje, ruta);
  return ruta;
}

// Lee la ruta planeada cacheada en Redis. Solo LEE: devuelve null si no existe
// (por ejemplo viaje finalizado/cancelado con Redis ya limpio). No recalcula.
export async function obtenerRutaPlaneada(id_viaje) {
  return obtenerRuta(id_viaje);
}
