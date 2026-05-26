# Fleter — Backend

## Descripcion del proyecto
Plataforma marketplace de fletes para PyMEs argentinas.
El cliente solicita un viaje, el sistema lo publica a conductores
elegibles via WebSocket, el primero en aceptar queda asignado.

## Estado actual del proyecto
- Fase 1 COMPLETA: autenticacion, registro, login, perfiles
- Fase 2 COMPLETA: creacion de viajes, estimacion de costo con desglose
- Fase 3 COMPLETA: matching en tiempo real con Socket.io
- Bugs corregidos: condiciones_req en eventos, id_usuario_conductor,
  conductores/clientes que conectan tarde
- Fase 4 EN DESARROLLO en branch develop

## Stack
- Node.js 22 con ES Modules (import/export — NUNCA require)
- Express
- PostgreSQL en Neon — Prisma 6 (version fija sin caret)
- Firebase Admin SDK para autenticacion
- Socket.io v4
- Redis con ioredis — EN USO en Fase 4 para coordenadas GPS
- Turf.js — algoritmos geograficos en Fase 4
- Zod para validacion
- BullMQ (proximas fases)
- Google Maps API — disponible, GOOGLE_MAPS_API_KEY en .env

## Reglas de codigo
- ES Modules siempre. NUNCA require().
- Modulos CommonJS: import pkg from 'modulo'; const { X } = pkg;
- Async/await siempre.
- Validar inputs con Zod en todos los endpoints REST.
- Respuestas de error: { error: "mensaje" }
- Variables de entorno: todas en .env, nunca hardcodeadas.
- Nombres de archivos: kebab-case.
- Named exports en controllers y services.

## ESTRATEGIA MOCK — Google Maps
Si GOOGLE_MAPS_API_KEY esta vacia o la llamada falla:
- Ruta optima: linea recta entre paradas del viaje
- ETA: 15 minutos fijo
Cuando la key esta presente todo funciona con datos reales sin cambiar codigo.

## MODELO DE TARIFAS (implementado)
El usuario NO manda tarifa_hora ni tarifa_km.
tarifa.service.js las calcula segun zona y hora del dia.
Las tarifas se guardan en el Viaje en DB para calcular el costo real.

## DESGLOSE DE PRECIO (implementado)
Toda respuesta con precio incluye campo desglose:
{ precio_por_tiempo, precio_por_distancia, tiempo_horas,
  distancia_km, tarifa_hora, tarifa_km, es_hora_pico }

## REDIS — keys para GPS
Las coordenadas GPS NO van a PostgreSQL. Van a Redis:
  "gps:{id_viaje}:ultima"         → { lat, lng, timestamp } — expire 2h
  "gps:{id_viaje}:historial"      → lista ultimas 20 coords — LPUSH+LTRIM
  "gps:{id_viaje}:ruta"           → array [[lng,lat],...] — expire 24h
  "gps:{id_viaje}:acumulado"      → { tiempo_horas, distancia_km,
                                       ultima_lat, ultima_lng,
                                       ultima_actualizacion } — expire 24h
  "gps:{id_viaje}:pings_detenido" → contador pings lentos — INCR

Al finalizar el viaje: persistir acumulado en DB y DEL todas las keys.

## ALGORITMOS FASE 4 (version simplificada)
Desvios:
  Ruta = linea recta entre primera y ultima parada (mock sin API key)
  Con cada ping: Turf nearestPointOnLine calcula distancia a esa linea
  Si > DESVIO_UMBRAL_METROS: emitir alerta:desvio

Paradas sospechosas (solo CABA y MIXTO):
  Calcular velocidad entre ping anterior y actual
  Si < PARADA_SOSPECHOSA_VELOCIDAD_KMH: INCR contador Redis
  Si contador * 15seg >= PARADA_SOSPECHOSA_MINUTOS * 60:
    Verificar que no esta dentro de 150m de una parada del viaje
    Si no: emitir alerta:parada
  Si velocidad >= umbral: DEL contador (resetear)

Acumulador: sumar deltas con cada ping. Emitir costo:actualizar ~cada 60s.

## CAMBIO AUTOMATICO DE ESTADO
Primer ping GPS en viaje CONDUCTOR_ASIGNADO
  → actualizar a EN_CAMINO_A_ORIGEN + emitir viaje:estado_cambiado

## Estructura de carpetas
src/
├── config/
│   ├── firebase.js
│   ├── prisma.js
│   ├── redis.js
│   └── storage.js
├── routes/
│   ├── auth.routes.js
│   └── viajes.routes.js
├── controllers/
│   ├── auth.controller.js
│   └── viajes.controller.js
├── services/
│   ├── tarifa.service.js
│   ├── costo.service.js
│   ├── elegibilidad.service.js
│   ├── matching.service.js
│   ├── gps.service.js          ← NUEVO
│   ├── desvio.service.js       ← NUEVO
│   ├── parada.service.js       ← NUEVO
│   └── eta.service.js          ← NUEVO
├── middlewares/
│   └── auth.middleware.js
├── sockets/
│   ├── index.js
│   ├── auth.socket.js
│   ├── matching.socket.js
│   └── gps.socket.js           ← NUEVO
└── app.js
scripts/
├── seed-test.js
├── simular-gps.js              ← NUEVO
└── test-fase4.js               ← NUEVO

## Endpoints existentes (no modificar)
GET  /health
POST /api/auth/*
POST /api/viajes/estimar-costo
POST /api/viajes
GET  /api/viajes/disponibles
GET  /api/viajes/mis-viajes
GET  /api/viajes/:id

## Nuevos endpoints Fase 4
PATCH /api/viajes/:id/estado          → conductor cambia estado manual
GET   /api/viajes/:id/costo-acumulado → consultar costo hasta ahora

## Eventos existentes (no tocar)
viaje:disponible, viaje:aceptar, viaje:conductor_asignado,
viaje:ya_asignado, viaje:cancelado_sin_conductor

## Nuevos eventos Fase 4
conductor:ubicacion   conductor→servidor  { id_viaje, lat, lng, timestamp }
mapa:actualizar       servidor→room       { lat, lng, timestamp, velocidad_kmh }
costo:actualizar      servidor→room       { precio_acumulado, desglose }
alerta:desvio         servidor→room       { id_viaje, distancia_metros, mensaje }
alerta:parada         servidor→room       { id_viaje, minutos_detenido, mensaje }
viaje:estado_cambiado servidor→room       { id_viaje, estado_anterior, estado_nuevo }

## Variables de entorno
GOOGLE_MAPS_API_KEY=    (disponible)
DESVIO_UMBRAL_METROS=300
PARADA_SOSPECHOSA_MINUTOS=5
PARADA_SOSPECHOSA_VELOCIDAD_KMH=3

## Comandos
npm run dev
npm run start
npx prisma migrate dev --name descripcion
npx prisma studio
node scripts/test-fase4.js
node scripts/simular-gps.js <id_viaje>