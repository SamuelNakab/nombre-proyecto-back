import prisma from '../src/config/prisma.js';

async function main() {
  const [u1, u2] = await Promise.all([
    prisma.usuario.findUnique({ where: { email: 'conductor@test.com' }, include: { conductor: true } }),
    prisma.usuario.findUnique({ where: { email: 'conductor2@test.com' }, include: { conductor: true } }),
  ]);

  if (!u1?.conductor || !u2?.conductor) {
    console.error('Conductores no encontrados en DB');
    process.exit(1);
  }

  const empresa = await prisma.empresa.upsert({
    where: { cuit: '20-99999999-9' },
    update: {},
    create: { id_gerente: u1.id_usuario, cuit: '20-99999999-9', nombre: 'Empresa Test' },
  });

  const vehiculo = await prisma.vehiculo.upsert({
    where: { patente: 'TEST001' },
    update: {},
    create: {
      id_empresa: empresa.id_empresa,
      patente: 'TEST001',
      marca: 'Ford',
      modelo: 'Transit',
      anio: 2022,
      color: 'Blanco',
      tipo_vehiculo: 'FURGON',
    },
  });

  await prisma.condicionVehiculo.upsert({
    where: { id_vehiculo_condicion: { id_vehiculo: vehiculo.id_vehiculo, condicion: 'FRAGIL' } },
    update: {},
    create: { id_vehiculo: vehiculo.id_vehiculo, condicion: 'FRAGIL' },
  });
  await prisma.condicionVehiculo.upsert({
    where: { id_vehiculo_condicion: { id_vehiculo: vehiculo.id_vehiculo, condicion: 'REFRIGERADO' } },
    update: {},
    create: { id_vehiculo: vehiculo.id_vehiculo, condicion: 'REFRIGERADO' },
  });

  await prisma.conductorVehiculo.upsert({
    where: { id_vehiculo_id_conductor: { id_vehiculo: vehiculo.id_vehiculo, id_conductor: u1.conductor.id_conductor } },
    update: {},
    create: { id_vehiculo: vehiculo.id_vehiculo, id_conductor: u1.conductor.id_conductor },
  });
  await prisma.conductorVehiculo.upsert({
    where: { id_vehiculo_id_conductor: { id_vehiculo: vehiculo.id_vehiculo, id_conductor: u2.conductor.id_conductor } },
    update: {},
    create: { id_vehiculo: vehiculo.id_vehiculo, id_conductor: u2.conductor.id_conductor },
  });

  console.log(`Seed OK: vehiculo ${vehiculo.patente} con FRAGIL+REFRIGERADO → conductor ${u1.conductor.id_conductor} y ${u2.conductor.id_conductor}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
