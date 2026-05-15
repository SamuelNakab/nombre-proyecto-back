# Fleter — Backend

## Descripcion del proyecto
Plataforma marketplace de fletes para PyMEs argentinas.
Similar a Uber pero para fletes. El cliente solicita un viaje,
el sistema lo publica a conductores elegibles via WebSocket,
el primero en aceptar queda asignado.

## Estado actual del proyecto
- Fase 1 COMPLETA: autenticacion, registro, login, perfiles
- Fase 2 COMPLETA: creacion de viajes, matching, listado para conductores
- Fase 3 COMPLETA: matching en tiempo real con Socket.io
- MODIFICACION EN CURSO: eliminar tarifas del body del usuario,
  el backend las calcula con tarifa.service.js

## Stack
- Node.js 22 con ES Modules (import/export — NUNCA require)
- Express
- PostgreSQL en Neon — Prisma 6 (version fija sin caret)
- Firebase Admin SDK para autenticacion
- Socket.io v4
- Redis con ioredis
- Zod para validacion
- BullMQ (proximas fases)
- Google Maps API (mock activo — GOOGLE_MAPS_API_KEY vacia)

## Reglas de codigo
- ES Modules siempre. NUNCA require().
- Modulos CommonJS: import pkg from 'modulo'; const { X } = pkg;
- Async/await siempre.
- Validar todos los inputs con Zod.
- Respuestas de error: { error: "mensaje" }
- Variables de entorno: todas en .env, nunca hardcodeadas.
- Nombres de archivos: kebab-case.
- Named exports en controllers y services.

## MODELO DE TARIFAS — CAMBIO IMPORTANTE
El usuario YA NO manda tarifa_hora ni tarifa_km en el body.
El backend calcula las tarifas con tarifa.service.js.

El algoritmo simple (placeholder hasta tener uno real):
- Hora pico (7-10hs y 17-20hs): usar TARIFA_PICO_HORA_CABA o TARIFA_PICO_KM_PROVINCIA
- Resto del dia: usar TARIFA_BASE_HORA_CABA o TARIFA_BASE_KM_PROVINCIA
- Las variables de entorno definen las tarifas base

Variables de entorno de tarifas:
  TARIFA_BASE_HORA_CABA=3500       (ARS por hora, horario normal)
  TARIFA_PICO_HORA_CABA=5000       (ARS por hora, hora pico)
  TARIFA_BASE_KM_PROVINCIA=150     (ARS por km, horario normal)
  TARIFA_PICO_KM_PROVINCIA=200     (ARS por km, hora pico)

## DESGLOSE DE PRECIO — OBLIGATORIO
Toda respuesta que incluya un precio DEBE incluir el desglose.
El desglose explica como se llego al precio total.

Estructura del desglose:
{
  "precio_total": 3250,
  "desglose": {
    "precio_por_tiempo": 2100,     (null si zona es PROVINCIA)
    "precio_por_distancia": 1150,  (null si zona es CABA)
    "tiempo_horas": 0.6,
    "distancia_km": 10.5,
    "tarifa_hora": 3500,           (null si zona es PROVINCIA)
    "tarifa_km": null,             (null si zona es CABA)
    "es_hora_pico": false
  }
}

Esto aplica a:
- POST /api/viajes/estimar-costo
- POST /api/viajes (campo desglose_estimado)
- Al finalizar el viaje (campo desglose_real)

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
│   ├── tarifa.service.js      ← NUEVO: calcula tarifas segun zona y hora
│   ├── costo.service.js       ← MODIFICAR: ya no recibe tarifas del usuario
│   ├── elegibilidad.service.js
│   └── matching.service.js
├── middlewares/
│   └── auth.middleware.js
├── sockets/
│   ├── index.js
│   ├── matching.socket.js
│   └── auth.socket.js
└── app.js
prisma/
├── schema.prisma
└── migrations/

## Variables de entorno
Todas en .env. Ver .env.example.
Nuevas variables de tarifas:
  TARIFA_BASE_HORA_CABA=3500
  TARIFA_PICO_HORA_CABA=5000
  TARIFA_BASE_KM_PROVINCIA=150
  TARIFA_PICO_KM_PROVINCIA=200

## Endpoints existentes
POST /api/auth/registro-cliente
POST /api/auth/registro-conductor
POST /api/auth/registro-gerente
POST /api/auth/login
GET  /api/auth/me
PUT  /api/auth/perfil
POST /api/viajes/estimar-costo   ← MODIFICAR: quitar tarifas del body
POST /api/viajes                 ← MODIFICAR: quitar tarifas del body
GET  /api/viajes/disponibles
GET  /api/viajes/mis-viajes
GET  /api/viajes/:id
GET  /health

## Comandos importantes
npm run dev
npm run start
npx prisma migrate dev --name descripcion
npx prisma studio