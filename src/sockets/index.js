import { Server } from 'socket.io';
import prisma from '../config/prisma.js';
import { autenticarSocket } from './auth.socket.js';
import { manejarAceptarViaje } from './matching.socket.js';
import { registrarHandlersGPS } from './gps.socket.js';
import { conductorEsElegible } from '../services/elegibilidad.service.js';
import { marketplaceHabilitado } from '../middlewares/flags.middleware.js';
import { salaOrganizacion } from './salas.js';

export let io = null;

export function inicializarSockets(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*' },
  });

  io.use(autenticarSocket);

  io.on('connection', (socket) => {
    const { rol, id_usuario } = socket.data.usuario;
    socket.join('usuario:' + id_usuario);
    console.log(`[Socket] conectado: ${rol} id:${socket.id}`);

    if (rol === 'CONDUCTOR') {
      unirseARoomsDisponibles(socket);
    } else if (rol === 'CLIENTE') {
      unirseARoomsCliente(socket);
    }

    manejarAceptarViaje(socket, io);
    registrarHandlersGPS(socket, io);

    socket.on('disconnect', () => {
      console.log(`[Socket] desconectado: ${rol} uid:${id_usuario} id:${socket.id}`);
    });
  });

  return io;
}

async function unirseARoomsDisponibles(socket) {
  const conductor = await prisma.conductor.findUnique({
    where: { id_usuario: socket.data.usuario.id_usuario },
    include: {
      conductor_vehiculos: {
        include: { vehiculo: { include: { condiciones: true } } },
      },
      vehiculos_propios: { include: { condiciones: true } },
    },
  });
  if (!conductor) return;

  // Cache del id_conductor para verificar propiedad en cada ping GPS (B-003)
  // sin re-query por ping. El handler de conductor:ubicacion lo reutiliza.
  socket.data.id_conductor = conductor.id_conductor;

  // Con el marketplace dormido no hay pool abierto: el chofer recibe sus viajes
  // de PyME por su sala personal (usuario:{id}).
  if (!marketplaceHabilitado()) return;

  const viajes = await prisma.viaje.findMany({
    where: { estado: 'BUSCANDO_CONDUCTOR', fecha_programada: { gt: new Date() } },
    include: { condiciones_req: true },
  });

  let joined = 0;
  for (const viaje of viajes) {
    const condiciones = viaje.condiciones_req.map((c) => c.condicion);
    if (conductorEsElegible(conductor.conductor_vehiculos, conductor.vehiculos_propios, condiciones)) {
      socket.join(`viaje:${viaje.id_viaje}`);
      joined++;
    }
  }

  console.log(`[Socket] conductor ${conductor.id_conductor} unido a ${joined} rooms`);
}

async function unirseARoomsCliente(socket) {
  // Sala de cada PyME donde el usuario es miembro ACTIVO: eventos y tracking de
  // TODOS los viajes de la organizacion. Despues se sincroniza al crear la
  // PyME, canjear un codigo, salir o ser eliminado (sincronizarSalaOrganizacion).
  const membresias = await prisma.miembroOrganizacion.findMany({
    where: { id_usuario: socket.data.usuario.id_usuario, activo: true },
    select: { id_organizacion: true },
  });
  for (const m of membresias) {
    socket.join(salaOrganizacion(m.id_organizacion));
  }

  // Rooms de los viajes LEGACY propios. Los de PyME NO se scopean por usuario
  // (un ex miembro no tiene que seguir recibiendolos): van por la sala de la PyME.
  const viajes = await prisma.viaje.findMany({
    where: {
      cliente: { id_usuario: socket.data.usuario.id_usuario },
      id_organizacion: null,
      estado: { notIn: ['FINALIZADO', 'CANCELADO'] },
    },
    select: { id_viaje: true },
  });
  for (const v of viajes) {
    socket.join(`viaje:${v.id_viaje}`);
  }
  console.log(
    `[Socket] cliente unido a ${membresias.length} salas de PyME y ${viajes.length} rooms de viajes activos`
  );
}

