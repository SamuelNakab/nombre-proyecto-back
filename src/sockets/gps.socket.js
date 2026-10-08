import prisma from '../config/prisma.js';
import {
  guardarCoordenada,
  obtenerUltimaCoordenada,
  actualizarAcumulado,
  calcularVelocidad,
} from '../services/gps.service.js';
import { manejarDesvio } from '../services/desvio.service.js';
import { obtenerRutaPlaneada, calcularYGuardarRuta } from '../services/ruta.service.js';
import { verificarParadaSospechosa, distanciaMetros } from '../services/parada.service.js';
import { iniciarEmisorEta } from '../services/eta-emisor.js';
import { ESTADOS_EN_CURSO, ESTADOS_TERMINALES } from '../services/estado-viaje.service.js';
import { salasDeViaje } from './salas.js';
import { relimpiarSiCerrado } from '../services/cancelacion.service.js';

export function registrarHandlersGPS(socket, io) {
  socket.on('conductor:ubicacion', async (data) => {
    // Antes de leer el estado: si el viaje se limpia (cancela / cierra) DESPUES
    // de este instante, las escrituras de este ping se re-limpian al final.
    const inicioPing = Date.now();
    try {
      const { id_viaje, lat, lng, timestamp } = data ?? {};

      if (socket.data.usuario.rol !== 'CONDUCTOR') {
        socket.emit('error', { error: 'Solo conductores pueden enviar GPS' });
        return;
      }

      if (
        id_viaje == null || lat == null || lng == null || timestamp == null ||
        typeof lat !== 'number' || typeof lng !== 'number' || typeof timestamp !== 'number'
      ) {
        socket.emit('error', { error: 'Datos GPS invalidos' });
        return;
      }

      // Rango geografico valido: lat [-90, 90], lng [-180, 180]. Corre ANTES
      // de tocar Redis o calcular distancia, asi un ping fuera de rango (ej.
      // lat=200) no se guarda en gps:{id}:ultima ni contamina el acumulado.
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        socket.emit('error', { error: 'Coordenadas fuera de rango' });
        return;
      }

      const viaje = await prisma.viaje.findUnique({
        where: { id_viaje },
        // orderBy para que paradas[0] sea el ORIGEN (orden 1), que es contra lo
        // que se mide la llegada. verificarParadaSospechosa usa .some(), asi
        // que el orden no la afecta.
        include: { paradas: { orderBy: { orden: 'asc' } } },
      });

      // B-003: solo el conductor ASIGNADO puede enviar pings de este viaje.
      // Otro conductor autenticado no puede falsificar posicion/distancia ni
      // disparar alertas en un viaje ajeno. id_conductor se cachea en
      // socket.data al conectar (unirseARoomsDisponibles, ver sockets/index.js);
      // fallback a query si no esta (ej. ping antes de terminar el join).
      let id_conductor = socket.data.id_conductor;
      if (id_conductor == null) {
        const conductor = await prisma.conductor.findUnique({
          where: { id_usuario: socket.data.usuario.id_usuario },
        });
        if (conductor) {
          id_conductor = conductor.id_conductor;
          socket.data.id_conductor = id_conductor;
        }
      }
      if (!viaje || id_conductor == null || viaje.id_conductor !== id_conductor) {
        socket.emit('error', { error: 'No autorizado para este viaje' });
        return;
      }

      // Un viaje terminado (FINALIZADO, CANCELADO, RECHAZADO, VENCIDO) ignora el
      // ping en silencio, como siempre.
      if (ESTADOS_TERMINALES.includes(viaje.estado)) return;

      // El viaje debe estar iniciado con el boton "Iniciar viaje" (legacy: POST
      // /api/viajes/:id/iniciar; PyME: POST /api/choferes/viajes/:id/iniciar).
      // WHITELIST de estados en curso: un ping de un viaje que todavia no arranco
      // (BUSCANDO_CONDUCTOR, RESERVADO_POR_EMPRESA, CONDUCTOR_ASIGNADO, ASIGNADO,
      // CONFIRMADO) se rechaza SIN ningun efecto secundario: no toca Redis
      // (ultima/acumulado/historial), no emite mapa:actualizar, no arranca el ETA.
      // El flujo correcto del mobile es: boton → 200 → recien ahi arrancar el GPS.
      if (!ESTADOS_EN_CURSO.includes(viaje.estado)) {
        socket.emit('error', { error: 'El viaje no fue iniciado' });
        return;
      }

      // viaje:{id} y, si es de una PyME, organizacion:{id}: la PyME sigue el
      // tracking de todos sus viajes por su sala (por eso los payloads llevan
      // id_viaje).
      const salas = salasDeViaje(viaje);

      // LLEGADA AL ORIGEN — la senial de la que sale la puntualidad.
      //
      // La confirmacion de la primera parada NO sirve para esto: confirmarParada
      // exige EN_RUTA o DESCARGANDO, asi que el origen recien se puede confirmar
      // DESPUES de cargar y salir. Llega tarde por construccion.
      //
      // Asi que se toma el PRIMER ping que cae dentro del radio del origen
      // mientras el viaje sigue yendo hacia alla. Si nunca llega ninguno (sin
      // señal, GPS apagado), el paso a CARGANDO lo rellena como respaldo de
      // ultimo recurso (ver cambiarEstado en viajes.controller).
      //
      // NO es un estado nuevo ni una fila del historial: es un evento de GPS,
      // no una transicion formal.
      if (viaje.estado === 'EN_CAMINO_A_ORIGEN' && viaje.fecha_llegada_origen === null) {
        const origen = viaje.paradas[0];
        const radio_metros = parseFloat(process.env.RADIO_CONFIRMACION_METROS || '50');

        if (origen && distanciaMetros(lat, lng, origen) <= radio_metros) {
          // Hora del SERVIDOR, no el timestamp del ping: el ping lo manda el
          // celular y es falsificable, y esto alimenta una metrica de desempeño
          // del conductor. confirmarParada usa hora de servidor por lo mismo.
          //
          // updateMany con fecha_llegada_origen null en el WHERE: dos pings
          // concurrentes no se pisan, gana el primero. Mismo patron de guard
          // atomico que reservar/asignar/liberarReserva.
          await prisma.viaje.updateMany({
            where: { id_viaje, fecha_llegada_origen: null },
            data: { fecha_llegada_origen: new Date() },
          });
        }
      }

      const anterior = await obtenerUltimaCoordenada(id_viaje);
      await guardarCoordenada(id_viaje, lat, lng, timestamp);
      const acumulado = await actualizarAcumulado(id_viaje, lat, lng, timestamp);

      const velocidad_kmh = anterior
        ? calcularVelocidad(anterior.lat, anterior.lng, anterior.timestamp, lat, lng, timestamp)
        : 0;

      // El viaje se cancelo / cerro mientras este ping estaba en vuelo (el estado
      // se valido arriba, antes de las escrituras): la limpieza ya corrio, asi que
      // las keys que acabamos de escribir quedarian huerfanas. Re-limpiar y cortar
      // sin arrancar el ETA ni emitir.
      if (await relimpiarSiCerrado(id_viaje, inicioPing)) return;

      // El viaje tiene GPS activo: arrancamos el emisor periodico de ETA
      // (idempotente — si ya corre, no hace nada). Se detiene al cerrar/cancelar.
      iniciarEmisorEta(io, id_viaje, salas);

      io.to(salas).emit('mapa:actualizar', {
        id_viaje,
        lat,
        lng,
        timestamp,
        velocidad_kmh: Math.round(velocidad_kmh),
      });

      if (timestamp % 60000 < 16000) {
        const hora = new Date().getHours();
        const es_hora_pico = (hora >= 7 && hora <= 10) || (hora >= 17 && hora <= 20);

        let precio_acumulado = 0;
        let precio_por_tiempo = null;
        let precio_por_distancia = null;

        if (viaje.zona === 'CABA') {
          precio_por_tiempo = acumulado.tiempo_horas * (viaje.tarifa_hora || 0);
          precio_acumulado = precio_por_tiempo;
        } else if (viaje.zona === 'PROVINCIA') {
          precio_por_distancia = acumulado.distancia_km * (viaje.tarifa_km || 0);
          precio_acumulado = precio_por_distancia;
        } else {
          precio_por_tiempo = acumulado.tiempo_horas * (viaje.tarifa_hora || 0);
          precio_por_distancia = acumulado.distancia_km * (viaje.tarifa_km || 0);
          precio_acumulado = precio_por_tiempo + precio_por_distancia;
        }

        io.to(salas).emit('costo:actualizar', {
          id_viaje,
          precio_acumulado,
          desglose: {
            precio_por_tiempo,
            precio_por_distancia,
            tiempo_horas: acumulado.tiempo_horas,
            distancia_km: acumulado.distancia_km,
            tarifa_hora: viaje.tarifa_hora,
            tarifa_km: viaje.tarifa_km,
            es_hora_pico,
          },
        });
      }

      // La ruta planeada se calcula al crear el viaje. Fallback para viajes
      // viejos (creados antes de este cambio) o cuya ruta fallo en la creacion.
      let ruta = await obtenerRutaPlaneada(id_viaje);
      if (!ruta) {
        console.warn(`[gps.socket] viaje ${id_viaje} sin ruta en Redis — recalculando como fallback`);
        try {
          ruta = await calcularYGuardarRuta(id_viaje);
        } catch (e) {
          console.error(`[gps.socket] fallback de ruta fallo para viaje ${id_viaje}:`, e.message);
          ruta = null;
        }
      }

      if (viaje.estado === 'EN_RUTA') {
        // Deteccion de desvio + recalculo de ruta (2 pings consecutivos
        // desviados con cooldown). Lee/escribe la ruta vigente en Redis.
        if (ruta) {
          await manejarDesvio(io, id_viaje, lat, lng, ruta, salas);
        }

        const parada_result = await verificarParadaSospechosa(
          id_viaje, viaje.zona, velocidad_kmh, lat, lng, viaje.paradas
        );
        if (parada_result.sospechosa) {
          io.to(salas).emit('alerta:parada', {
            id_viaje,
            minutos_detenido: parada_result.minutos_detenido,
            mensaje: `El conductor lleva ${parada_result.minutos_detenido} minutos detenido`,
          });
        }
      }

      // Segundo chequeo al final: si el cierre llego durante el resto del handler
      // (ruta de fallback, desvio, emisor de ETA recien arrancado), lo mismo.
      await relimpiarSiCerrado(id_viaje, inicioPing);
    } catch (err) {
      console.error('[gps.socket] Error en conductor:ubicacion:', err);
      socket.emit('error', { error: 'Error interno al procesar ubicacion' });
    }
  });
}
