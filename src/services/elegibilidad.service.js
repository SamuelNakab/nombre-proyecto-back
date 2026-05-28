import prisma from '../config/prisma.js';

export async function obtenerConductoresElegibles(condicionesRequeridas) {
  if (!condicionesRequeridas || condicionesRequeridas.length === 0) {
    return prisma.conductor.findMany({
      include: {
        usuario: { select: { nombre: true, apellido: true, email: true } },
        conductor_vehiculos: { include: { vehiculo: { include: { condiciones: true } } } },
        vehiculos_propios: { include: { condiciones: true } },
      },
    });
  }

  const conductoresEmpresa = await prisma.conductor.findMany({
    where: {
      conductor_vehiculos: {
        some: {
          vehiculo: {
            condiciones: {
              some: { condicion: { in: condicionesRequeridas } },
            },
          },
        },
      },
    },
    include: {
      usuario: { select: { nombre: true, apellido: true, email: true } },
      conductor_vehiculos: { include: { vehiculo: { include: { condiciones: true } } } },
      vehiculos_propios: { include: { condiciones: true } },
    },
  });

  const conductoresEmpresaFiltrados = conductoresEmpresa.filter((conductor) =>
    conductor.conductor_vehiculos.some((cv) => {
      const conds = cv.vehiculo.condiciones.map((c) => c.condicion);
      return condicionesRequeridas.every((cr) => conds.includes(cr));
    })
  );

  const conductoresPropios = await prisma.conductor.findMany({
    where: {
      vehiculos_propios: {
        some: {
          condiciones: {
            some: { condicion: { in: condicionesRequeridas } },
          },
        },
      },
    },
    include: {
      usuario: { select: { nombre: true, apellido: true, email: true } },
      conductor_vehiculos: { include: { vehiculo: { include: { condiciones: true } } } },
      vehiculos_propios: { include: { condiciones: true } },
    },
  });

  const conductoresPropiosFiltrados = conductoresPropios.filter((conductor) =>
    conductor.vehiculos_propios.some((vehiculo) => {
      const conds = vehiculo.condiciones.map((c) => c.condicion);
      return condicionesRequeridas.every((cr) => conds.includes(cr));
    })
  );

  const idsVistos = new Set();
  const resultado = [];
  for (const c of [...conductoresEmpresaFiltrados, ...conductoresPropiosFiltrados]) {
    if (!idsVistos.has(c.id_conductor)) {
      idsVistos.add(c.id_conductor);
      resultado.push(c);
    }
  }

  return resultado;
}
