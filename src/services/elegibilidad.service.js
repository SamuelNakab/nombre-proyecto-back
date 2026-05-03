import prisma from '../config/prisma.js';

export async function obtenerConductoresElegibles(condicionesRequeridas) {
  const where =
    condicionesRequeridas && condicionesRequeridas.length > 0
      ? {
          conductor_vehiculos: {
            some: {
              vehiculo: {
                condiciones: {
                  every: {
                    condicion: { in: condicionesRequeridas },
                  },
                },
              },
            },
          },
        }
      : {};

  return prisma.conductor.findMany({
    where,
    include: {
      usuario: {
        select: { nombre: true, apellido: true, email: true },
      },
      conductor_vehiculos: {
        include: {
          vehiculo: {
            include: { condiciones: true },
          },
        },
      },
    },
  });
}
