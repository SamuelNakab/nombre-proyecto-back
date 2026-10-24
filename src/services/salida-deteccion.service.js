// DETECCION DE SALIDA por GPS (Tarea 5): la parte con Redis, DB y sockets. La
// regla es pura y vive en salida-deteccion.js.
//
// La llama gps.socket en cada ping de un viaje interno que esta EN una parada
// (CARGANDO / DESCARGANDO) cuya llegada ya se confirmo. Usa las paradas que el
// handler ya leyo (cero queries por ping); el estado intermedio vive en Redis
// (gps:{id}:salida, con TTL). Solo escribe en la DB al DETECTAR: una vez por
// parada, con un updateMany condicionado (salida_real y salida_detectada en
// null), asi dos pings a la vez no detectan dos veces y un "Salir" que se adelanto
// gana.
//
// La salida detectada NO cierra la parada ni el viaje por si sola: avisa al
// chofer ("tocá Salir") y a la PyME, y es la salida que usan "Salir" (si es
// anterior al toque) y los cierres sin "Salir" (cierre-plan.js).
import prisma from '../config/prisma.js';
import redis from '../config/redis.js';
import { distanciaMetros } from './parada.service.js';
import { evaluarPingSalida, configDeteccion } from './salida-deteccion.js';
import { configCierre, ultimaParada, cierreManualDesde } from './cierre-fechas.js';
import { emitirViajeInterno } from '../sockets/salas.js';

const keySalida = (id_viaje) => `gps:${id_viaje}:salida`;

// viaje: el del ping, con id_viaje, id_organizacion, id_conductor y paradas.
// parada: la abierta (llego y no salio). ping: { lat, lng, timestamp }.
// Devuelve la Date detectada o null. NUNCA TIRA: un fallo no rompe el ping.
export async function procesarPingSalida(io, viaje, parada, { lat, lng, timestamp }) {
  try {
    const cfg = configDeteccion();
    const raw = await redis.get(keySalida(viaje.id_viaje));
    const previo = raw ? JSON.parse(raw) : null;

    const { estado, detectada } = evaluarPingSalida(
      previo,
      { ts: timestamp, distancia_metros: distanciaMetros(lat, lng, parada) },
      parada,
      { ...cfg, ahora: Date.now() }
    );

    if (!detectada) {
      if (estado) {
        // TTL: la racha mas el margen; si el chofer deja de mandar pings, se
        // borra sola.
        await redis.set(keySalida(viaje.id_viaje), JSON.stringify(estado), 'EX', Math.ceil(cfg.segundos) + 600);
      } else if (previo) {
        await redis.del(keySalida(viaje.id_viaje));
      }
      return null;
    }

    await redis.del(keySalida(viaje.id_viaje));
    const r = await prisma.parada.updateMany({
      where: { id_parada: parada.id_parada, id_viaje: viaje.id_viaje, salida_real: null, salida_detectada: null },
      data: { salida_detectada: detectada },
    });
    if (r.count === 0) return null;

    console.log(
      `[salida-deteccion] viaje ${viaje.id_viaje}: salida detectada de la parada ${parada.orden} a las ${detectada.toISOString()}`
    );
    await avisarSalidaDetectada(io, viaje, parada, detectada);
    return detectada;
  } catch (err) {
    console.error(`[salida-deteccion] viaje ${viaje.id_viaje}: ${err.message}`);
    return null;
  }
}

async function avisarSalidaDetectada(io, viaje, parada, detectada) {
  const chofer = await prisma.conductor.findUnique({
    where: { id_conductor: viaje.id_conductor },
    select: { id_usuario: true },
  });
  const esUltima = ultimaParada(viaje.paradas).id_parada === parada.id_parada;

  emitirViajeInterno(
    io,
    { id_organizacion: viaje.id_organizacion, id_usuario_chofer: chofer?.id_usuario },
    'parada:salida_detectada',
    {
      id_viaje: viaje.id_viaje,
      id_organizacion: viaje.id_organizacion,
      id_parada: parada.id_parada,
      orden: parada.orden,
      salida_detectada: detectada,
      es_ultima: esUltima,
      mensaje: `Parece que ya saliste de la parada ${parada.orden}: tocá "Salir"`,
    }
  );

  // En la ULTIMA parada, la salida detectada habilita el cierre manual de la
  // PyME. Si la hora prevista de fin ya habia pasado, el cierre ya estaba
  // habilitado por TIEMPO (y ya se aviso): no se emite de nuevo.
  if (esUltima) {
    const paradas = viaje.paradas.map((p) =>
      p.id_parada === parada.id_parada ? { ...p, salida_detectada: detectada } : p
    );
    const cierre = cierreManualDesde(paradas, configCierre());
    if (cierre.motivo === 'GPS') {
      emitirViajeInterno(io, { id_organizacion: viaje.id_organizacion }, 'viaje:cierre_habilitado', {
        id_viaje: viaje.id_viaje,
        id_organizacion: viaje.id_organizacion,
        motivo: 'GPS',
        cierre_manual_desde: cierre.desde,
        hora_prevista_fin: cierre.hora_prevista_fin,
        salida_detectada: detectada,
      });
    }
  }
}
