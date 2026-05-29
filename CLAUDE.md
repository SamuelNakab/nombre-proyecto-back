# Fleter — Backend

## Descripcion del proyecto
Plataforma marketplace de fletes para PyMEs argentinas.
El cliente solicita un viaje, el sistema lo publica a conductores
elegibles via WebSocket, el primero en aceptar queda asignado.

## Estado actual del proyecto
- Fase 1 COMPLETA: autenticacion, registro, login, perfiles
- Fase 2 COMPLETA: creacion de viajes, estimacion de costo, listado
- Fase 3 COMPLETA: matching en tiempo real con Socket.io
- Tarifas calculadas por el backend (tarifa.service.js), no por el usuario
- Desglose de precio incluido en todas las respuestas con precio
- Fase 4 EN DESARROLLO: GPS en tiempo real, algoritmos, costo acumulado

## Stack
- Node.js 22 con ES Modules (import/export — NUNCA require)
- Express
- PostgreSQL en Neon — Prisma 6 (version fija sin caret)
- Firebase Admin SDK para autenticacion
- Socket.io v4
- Redis con ioredis
- Turf.js
- Zod para validacion

## Reglas de codigo
- ES Modules siempre. NUNCA require().
- Modulos CommonJS: import pkg from 'modulo'; const { X } = pkg;
- Async/await siempre.
- Validar inputs con Zod en endpoints REST.
- Respuestas de error: { error: "mensaje" }
- Variables de entorno: todas en .env, nunca hardcodeadas.
- Nombres de archivos: kebab-case.
- Named exports en controllers y services.
- Nunca modificar la DB directamente. Todo via schema.prisma + migrate.

## ESTRATEGIA MOCK — Google Maps no disponible
Todo lo que requiere Google Maps tiene mock que se activa cuando
GOOGLE_MAPS_API_KEY esta vacia o no existe.

- Ruta optima (desvio.service.js): usa linea recta entre paradas
  como mock. console.warn cuando se usa mock.
- ETA (eta.service.js): retorna 15 minutos fijo como mock.
  console.warn cuando se usa mock.
- Distancia/tiempo (costo.service.js): ya implementado,
  usa 10km / 0.5h como mock.

Cuando se agregue GOOGLE_MAPS_API_KEY al .env,
todo funciona con datos reales sin cambiar codigo.

## MODELO DE TARIFAS (implementado en modificacion pre-Fase 4)
El usuario NO manda tarifa_hora ni tarifa_km.
tarifa.service.js las calcula segun zona y hora del dia (pico/normal).
Las tarifas se guardan en el Viaje en DB para calcular el costo real al finalizar.

## DESGLOSE DE PRECIO (implementado)
Toda respuesta con precio incluye campo desglose:
{ precio_por_tiempo, precio_por_distancia, tiempo_horas,
  distancia_km, tarifa_hora, tarifa_km, es_hora_pico }

## ESTRATEGIA DE GPS EN REDIS
Las coordenadas GPS NO se guardan en PostgreSQL.
Se usan estas keys en Redis:
  "gps:{id_viaje}:ultima"       → { lat, lng, timestamp } — SET con expire 2h
  "gps:{id_viaje}:historial"    → lista de ultimas 20 coordenadas — LPUSH + LTRIM
  "gps:{id_viaje}:ruta"         → array de [lng, lat] de la ruta — SET con expire 24h
  "gps:{id_viaje}:acumulado"    → { tiempo_horas, distancia_km, ultima_lat,
                                     ultima_lng, ultima_actualizacion } — SET
  "gps:{id_viaje}:pings_detenido" → contador de pings consecutivos lentos — INCR

Al finalizar el viaje:
  - Persistir tiempo_horas en Viaje.tiempo_capital
  - Persistir distancia_km en Viaje.distancia_provincia
  - DEL todas las keys de Redis del viaje

## ALGORITMOS DE FASE 4 — version simplificada

Desvios:
  - Ruta mock = linea recta entre la primera y ultima parada
  - Con cada ping: Turf nearestPointOnLine para calcular distancia a esa linea
  - Si distancia > DESVIO_UMBRAL_METROS: emitir alerta:desvio

Paradas sospechosas (solo CABA y MIXTO):
  - Calcular velocidad entre el ping anterior y el actual
  - Si velocidad < PARADA_SOSPECHOSA_VELOCIDAD_KMH: INCR contador en Redis
  - Si contador * 15seg >= PARADA_SOSPECHOSA_MINUTOS * 60:
    verificar que no esta dentro de 150m de alguna parada del viaje
    Si es asi: emitir alerta:parada
  - Si velocidad >= umbral: DEL contador (resetear)

Acumulador de costo:
  - Con cada ping: calcular delta de distancia y tiempo desde el ping anterior
  - Acumular en Redis
  - Cada 60 segundos (aproximado): emitir costo:actualizar al room

## CAMBIOS AUTOMATICOS DE ESTADO
Al recibir el primer ping GPS de un viaje en estado CONDUCTOR_ASIGNADO:
  → cambiar automaticamente a EN_CAMINO_A_ORIGEN y emitir viaje:estado_cambiado

Los demas cambios de estado en Fase 4 son manuales via endpoint REST.

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
└── simular-gps.js              ← NUEVO Fase 4 (testing sin mobile)
prisma/
├── schema.prisma
└── migrations/

## Eventos Socket.io existentes (no tocar)
viaje:disponible, viaje:aceptar, viaje:conductor_asignado,
viaje:ya_asignado, viaje:cancelado_sin_conductor

## Nuevos eventos Socket.io — Fase 4
conductor:ubicacion     conductor → servidor  { id_viaje, lat, lng, timestamp }
mapa:actualizar         servidor → room       { lat, lng, timestamp, velocidad_kmh }
costo:actualizar        servidor → room       { precio_acumulado, desglose }
alerta:desvio           servidor → room       { id_viaje, distancia_metros, mensaje }
alerta:parada           servidor → room       { id_viaje, minutos_detenido, mensaje }
viaje:estado_cambiado   servidor → room       { id_viaje, estado_anterior, estado_nuevo }

## Endpoints existentes (no modificar)
GET  /health
POST /api/auth/* (todos)
POST /api/viajes/estimar-costo
POST /api/viajes
GET  /api/viajes/disponibles
GET  /api/viajes/mis-viajes
GET  /api/viajes/:id

## Nuevos endpoints REST — Fase 4
PATCH /api/viajes/:id/estado         → conductor cambia estado manualmente
GET   /api/viajes/:id/costo-acumulado → cliente consulta costo hasta el momento

## Variables de entorno
Todas en .env. Ver .env.example para la lista completa.
Nuevas en Fase 4:
  DESVIO_UMBRAL_METROS=300
  PARADA_SOSPECHOSA_MINUTOS=5
  PARADA_SOSPECHOSA_VELOCIDAD_KMH=3

## Comandos importantes
npm run dev
npm run start
npx prisma migrate dev --name descripcion
npx prisma studio
node scripts/simular-gps.js <id_viaje>   ← para testear GPS sin mobile