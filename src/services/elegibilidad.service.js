import prisma from '../config/prisma.js';

// Un conductor es elegible si tiene al menos un vehiculo (propio o asignado
// via empresa) que cumpla TODAS las condiciones requeridas del viaje. Si el
// viaje no requiere condiciones, alcanza con tener al menos un vehiculo:
// `condicionesViaje.every(...)` es vacuamente verdadero por vehiculo, pero
// `.some(...)` sobre una lista vacia de vehiculos sigue siendo falso.
export function conductorEsElegible(vehiculosConductor, vehiculosPropios, condicionesViaje) {
  const vehiculoCumple = (vehiculo) => {
    const tiene = vehiculo.condiciones.map((c) => c.condicion);
    return condicionesViaje.every((req) => tiene.includes(req));
  };

  return (
    vehiculosConductor.some((cv) => vehiculoCumple(cv.vehiculo)) ||
    vehiculosPropios.some(vehiculoCumple)
  );
}

export async function obtenerConductoresElegibles(condicionesRequeridas) {
  const condiciones = condicionesRequeridas ?? [];

  const conductores = await prisma.conductor.findMany({
    include: {
      usuario: { select: { nombre: true, apellido: true, email: true } },
      conductor_vehiculos: { include: { vehiculo: { include: { condiciones: true } } } },
      vehiculos_propios: { include: { condiciones: true } },
    },
  });

  return conductores.filter((conductor) =>
    conductorEsElegible(conductor.conductor_vehiculos, conductor.vehiculos_propios, condiciones)
  );
}
