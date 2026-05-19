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
    } else if (rol === 'CLIENTE') {
      unirseARoomsCliente(socket);
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
    include: { condiciones_req: true, paradas: true },
  });

  let joined = 0;
  for (const viaje of viajes) {
    const condiciones = viaje.condiciones_req.map((c) => c.condicion);
    if (conductorEsElegible(conductor.conductor_vehiculos, condiciones)) {
      socket.join(`viaje:${viaje.id_viaje}`);
      socket.emit('viaje:disponible', {
        id_viaje: viaje.id_viaje,
        zona: viaje.zona,
        precio_estimado: viaje.precio_estimado,
        fecha_programada: viaje.fecha_programada,
        paradas: viaje.paradas.map((p) => ({ orden: p.orden, direccion: p.direccion })),
        condiciones_req: viaje.condiciones_req.map((c) => ({ condicion: c.condicion })),
      });
      joined++;
    }
  }

  console.log(`[Socket] conductor ${conductor.id_conductor} unido a ${joined} rooms`);
}

async function unirseARoomsCliente(socket) {
  const cliente = await prisma.cliente.findUnique({
    where: { id_usuario: socket.data.usuario.id_usuario },
  });
  if (!cliente) return;

  const viajes = await prisma.viaje.findMany({
    where: {
      id_cliente: cliente.id_cliente,
      estado: 'BUSCANDO_CONDUCTOR',
    },
  });

  for (const viaje of viajes) {
    socket.join(`viaje:${viaje.id_viaje}`);
  }

  if (viajes.length > 0) {
    console.log(`[Socket] cliente ${cliente.id_cliente} unido a ${viajes.length} rooms`);
  }
}

function conductorEsElegible(vehiculosConductor, condicionesViaje) {
  if (condicionesViaje.length === 0) return true;
  return vehiculosConductor.some((cv) => {
    const tiene = cv.vehiculo.condiciones.map((c) => c.condicion);
    return condicionesViaje.every((req) => tiene.includes(req));
  });
}
