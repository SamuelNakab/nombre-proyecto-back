# Fleter — Backend

## Descripcion del proyecto
Plataforma marketplace de fletes para PyMEs argentinas.
El cliente solicita un viaje, el sistema lo publica a conductores
elegibles via WebSocket, el primero en aceptar queda asignado.

## Estado actual del proyecto
- Fase 1 COMPLETA: autenticacion, registro, login, perfiles
- Fase 2 COMPLETA: creacion de viajes, estimacion de costo con desglose
- Fase 3 COMPLETA: matching en tiempo real con Socket.io
- Bugs corregidos: condiciones_req en eventos, id_usuario_conductor
  en matching, conductores que conectan tarde reciben viajes disponibles
- Fase 4 EN DESARROLLO en branch develop

## Stack
- Node.js 22 con ES Modules (import/export — NUNCA require)
- Express
- PostgreSQL en Neon — Prisma 6 (version fija sin caret)
- Firebase Admin SDK para autenticacion
- Socket.io v4
- Redis con ioredis — EN USO en Fase 4 para GPS
- Turf.js — para algoritmos geograficos en Fase 4
- Zod para validacion
- BullMQ (proximas fases)
- Google Maps API — SIN KEY todavia, usar mocks

## Reglas de codigo
- ES Modules siempre. NUNCA require().
- Modulos CommonJS: import pkg from 'modulo'; const { X } = pkg;
- Async/await siempre.
- Validar inputs con Zod en todos los endpoints REST.
- Respuestas de error: { error: "mensaje" }
- Variables de entorno: todas en .env, nunca hardcodeadas.
- Nombres de archivos: kebab-case.
- Named exports en controllers y services.

## ESTRATEGIA MOCK — Google Maps no disponible
Cuando GOOGLE_MAPS_API_KEY esta vacia o no existe:
- Ruta optima: linea recta entre la primera y ultima parada
  console.warn('[desvio.service] Sin API key — usando ruta recta mock')
- ETA: retornar 15 minutos fijo
  console.warn('[eta.service] Sin API key — usando ETA mock')
- Distancia/tiempo: ya implementado (10km / 0.5h)
Cuando se agregue la key al .env todo funciona con datos reales sin
cambiar codigo.

## MODELO DE TARIFAS (implementado)
El usuario NO manda tarifa_hora ni tarifa_km.
tarifa.service.js las calcula segun zona y hora del dia.
Las tarifas se guardan en el Viaje en DB para calcular el costo real.

## DESGLOSE DE PRECIO (implementado)
Toda respuesta con precio incluye campo desglose con:
precio_por_tiempo, precio_por_distancia, tiempo_horas, distancia_km,
tarifa_hora, tarifa_km, es_hora_pico.

## REDIS — estrategia de keys para GPS
Las coordenadas GPS NO van a PostgreSQL. Van a Redis:
  "gps:{id_viaje}:ultima"       → { lat, lng, timestamp } — expire 2h
  "gps:{id_viaje}:historial"    → lista de ultimas 20 coords — LPUSH+LTRIM
  "gps:{id_viaje}:ruta"         → array [[lng,lat],...] — expire 24h
  "gps:{id_viaje}:acumulado"    → { tiempo_horas, distancia_km,
                                     ultima_lat, ultima_lng,
                                     ultima_actualizacion } — expire 24h
  "gps:{id_viaje}:pings_detenido" → contador pings lentos — INCR

Al finalizar el viaje:
  - Persistir acumulado en Viaje.tiempo_capital y Viaje.distancia_provincia
  - DEL todas las keys del viaje

## ALGORITMOS (version simplificada para desarrollo)
Desvios:
  Ruta mock = linea recta entre primera y ultima parada del viaje
  Con cada ping: Turf nearestPointOnLine calcula distancia a esa linea
  Si > DESVIO_UMBRAL_METROS: emitir alerta:desvio

Paradas sospechosas (solo CABA y MIXTO):
  Calcular velocidad entre ping anterior y actual
  Si velocidad < PARADA_SOSPECHOSA_VELOCIDAD_KMH: INCR contador Redis
  Si contador * 15seg >= PARADA_SOSPECHOSA_MINUTOS * 60:
    Verificar que no esta dentro de 150m de alguna parada del viaje
    Si no: emitir alerta:parada
  Si velocidad >= umbral: DEL contador (resetear)

Acumulador de costo:
  Con cada ping: sumar delta de distancia y tiempo al acumulado en Redis
  Cada ~60 segundos: emitir costo:actualizar al room

## CAMBIO AUTOMATICO DE ESTADO
Primer ping GPS en viaje CONDUCTOR_ASIGNADO
  → actualizar a EN_CAMINO_A_ORIGEN
  → emitir viaje:estado_cambiado al room

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
│   ├── gps.service.js          ← NUEVO Fase 4
│   ├── desvio.service.js       ← NUEVO Fase 4
│   ├── parada.service.js       ← NUEVO Fase 4
│   └── eta.service.js          ← NUEVO Fase 4
├── middlewares/
│   └── auth.middleware.js
├── sockets/
│   ├── index.js
│   ├── auth.socket.js
│   ├── matching.socket.js
│   └── gps.socket.js           ← NUEVO Fase 4
└── app.js
scripts/
├── seed-test.js                ← ya existe
├── simular-gps.js              ← NUEVO Fase 4
└── test-fase4.js               ← NUEVO Fase 4
prisma/
├── schema.prisma
└── migrations/

## Endpoints existentes (no modificar)
GET  /health
POST /api/auth/* (todos)
POST /api/viajes/estimar-costo
POST /api/viajes
GET  /api/viajes/disponibles
GET  /api/viajes/mis-viajes
GET  /api/viajes/:id

## Nuevos endpoints Fase 4
PATCH /api/viajes/:id/estado          → conductor cambia estado manual
GET   /api/viajes/:id/costo-acumulado → cliente consulta costo hasta ahora

## Eventos Socket.io existentes (no tocar)
viaje:disponible, viaje:aceptar, viaje:conductor_asignado,
viaje:ya_asignado, viaje:cancelado_sin_conductor

## Eventos Socket.io nuevos Fase 4
conductor:ubicacion   conductor→servidor  { id_viaje, lat, lng, timestamp }
mapa:actualizar       servidor→room       { lat, lng, timestamp, velocidad_kmh }
costo:actualizar      servidor→room       { precio_acumulado, desglose }
alerta:desvio         servidor→room       { id_viaje, distancia_metros, mensaje }
alerta:parada         servidor→room       { id_viaje, minutos_detenido, mensaje }
viaje:estado_cambiado servidor→room       { id_viaje, estado_anterior, estado_nuevo }

## Variables de entorno Fase 4 (nuevas)
DESVIO_UMBRAL_METROS=300
PARADA_SOSPECHOSA_MINUTOS=5
PARADA_SOSPECHOSA_VELOCIDAD_KMH=3

## Comandos
npm run dev
npm run start
npx prisma migrate dev --name descripcion
npx prisma studio
node scripts/test-fase4.js    ← test completo de Fase 4
node scripts/simular-gps.js <id_viaje>  ← simular GPS manual