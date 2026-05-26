import 'dotenv/config';
import { io } from 'socket.io-client';

const id_viaje_str = process.argv[2];
if (!id_viaje_str) {
  console.log('Uso: node scripts/simular-gps.js <id_viaje>');
  process.exit(1);
}
const id_viaje = parseInt(id_viaje_str, 10);

const token = process.env.TEST_CONDUCTOR_TOKEN;
if (!token) {
  console.log('Falta TEST_CONDUCTOR_TOKEN en el .env. Agregalo antes de usar este script.');
  process.exit(1);
}

const BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

async function obtenerViaje() {
  const res = await fetch(`${BASE_URL}/api/viajes/${id_viaje}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error(`Error al obtener viaje ${id_viaje}: ${res.status}`, body);
    process.exit(1);
  }
  return res.json();
}

async function main() {
  const viaje = await obtenerViaje();
  const paradas = [...(viaje.paradas ?? [])].sort((a, b) => a.orden - b.orden);

  if (paradas.length < 2) {
    console.error('El viaje necesita al menos 2 paradas para simular una trayectoria.');
    process.exit(1);
  }

  const origen = paradas[0];
  const destino = paradas[paradas.length - 1];
  const PASOS = 12;

  const trayectoria = Array.from({ length: PASOS }, (_, i) => ({
    lat: origen.latitud + ((destino.latitud - origen.latitud) * i) / (PASOS - 1),
    lng: origen.longitud + ((destino.longitud - origen.longitud) * i) / (PASOS - 1),
  }));

  const socket = io(BASE_URL, {
    auth: { token: `Bearer ${token}` },
  });

  socket.on('connect', () => {
    console.log(`Conectado. Iniciando simulacion de GPS para viaje ${id_viaje}`);
    let paso = 0;

    const intervalo = setInterval(() => {
      if (paso >= PASOS) {
        clearInterval(intervalo);
        console.log('Simulacion finalizada');
        socket.disconnect();
        return;
      }

      const { lat, lng } = trayectoria[paso];
      const payload = { id_viaje, lat, lng, timestamp: Date.now() };
      socket.emit('conductor:ubicacion', payload);
      console.log(`[Ping ${paso + 1}/${PASOS}] lat=${lat.toFixed(6)} lng=${lng.toFixed(6)}`);
      paso++;
    }, 15000);
  });

  socket.on('connect_error', (err) => {
    console.error('Error de conexion:', err.message);
    process.exit(1);
  });

  socket.on('mapa:actualizar', (data) => console.log('[mapa:actualizar]', data));
  socket.on('costo:actualizar', (data) => console.log('[costo:actualizar]', data));
  socket.on('alerta:desvio', (data) => console.log('[alerta:desvio]', data));
  socket.on('alerta:parada', (data) => console.log('[alerta:parada]', data));
  socket.on('viaje:estado_cambiado', (data) => console.log('[viaje:estado_cambiado]', data));
  socket.on('error', (data) => console.error('[error]', data));
}

main().catch((err) => {
  console.error('Error inesperado:', err);
  process.exit(1);
});
