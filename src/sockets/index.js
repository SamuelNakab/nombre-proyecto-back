import { Server } from 'socket.io';
import prisma from '../config/prisma.js';
import { autenticarSocket } from './auth.socket.js';
import { manejarAceptarViaje } from './matching.socket.js';

export let io = null;

export function inicializarSockets(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*' },
  });

  io.use(autenticarSocket);

  io.on('connection', (socket) => {
    const { rol, id_usuario } = socket.data.usuario;
    console.log(`[Socket] conectado: ${rol} id:${socket.id}`);

    if (rol === 'CONDUCTOR') {
      unirseARoomsDisponibles(socket);
    }

    manejarAceptarViaje(socket, io);

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
    },
  });
  if (!conductor) return;

  const viajes = await prisma.viaje.findMany({
    where: { estado: 'BUSCANDO_CONDUCTOR', fecha_programada: { gt: new Date() } },
    include: { condiciones_req: true },
  });

  let joined = 0;
  for (const viaje of viajes) {
    const condiciones = viaje.condiciones_req.map((c) => c.condicion);
    if (conductorEsElegible(conductor.conductor_vehiculos, condiciones)) {
      socket.join(`viaje:${viaje.id_viaje}`);
      joined++;
    }
  }

  console.log(`[Socket] conductor ${conductor.id_conductor} unido a ${joined} rooms`);
}

function conductorEsElegible(vehiculosConductor, condicionesViaje) {
  if (condicionesViaje.length === 0) return true;
  return vehiculosConductor.some((cv) => {
    const tiene = cv.vehiculo.condiciones.map((c) => c.condicion);
    return condicionesViaje.every((req) => tiene.includes(req));
  });
}
