# Fleter — Backend

## Descripcion del proyecto
Plataforma marketplace de fletes para PyMEs argentinas.
El cliente solicita un viaje, el sistema lo publica a conductores
elegibles via WebSocket, el primero en aceptar queda asignado.

## Estado actual del proyecto
- Fases 1-4 COMPLETAS
- BUGS A CORREGIR EN ESTA SESION (ver seccion BUGS MAS ABAJO)

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
- Validar inputs con Zod en todos los endpoints REST.
- Respuestas de error: { error: "mensaje" }
- Variables de entorno: todas en .env, nunca hardcodeadas.
- Nombres de archivos: kebab-case.
- Named exports en controllers y services.

## BUGS A CORREGIR

### BUG 1 — Endpoint de viajes disponibles para conductores
El equipo frontend reporta que no existe un endpoint para que el conductor
consulte los viajes que puede aceptar.

IMPORTANTE: El endpoint GET /api/viajes/disponibles YA EXISTE desde Fase 2.
Antes de crear nada, verificar que:
  1. El endpoint existe en viajes.routes.js
  2. Requiere rol CONDUCTOR
  3. Devuelve viajes en estado BUSCANDO_CONDUCTOR con fecha futura
  4. Filtra por condiciones del vehiculo del conductor
  5. Incluye paradas y condiciones_req en la respuesta

Si todo esto esta correcto: el bug es del frontend, no del backend.
Reportarlo claramente sin modificar nada del endpoint.
Si algo falta o esta mal: corregirlo.

### BUG 2 — Race condition en WebSocket de matching
PROBLEMA: cuando dos conductores aceptan el mismo viaje al mismo tiempo,
ambos reciben viaje:conductor_asignado aunque solo uno gano la race.

CAUSA: viaje:conductor_asignado se emite al room completo en lugar de
solo al socket del conductor ganador.

FLUJO CORRECTO que debe implementar el backend:

  Evento                  | Destinatario
  ------------------------|------------------------------------------
  viaje:conductor_asignado| Solo el socket del conductor que GANO
  viaje:ya_asignado       | Cada socket que intento aceptar y perdio
  viaje:no_disponible     | Broadcast a todos los demas del room

Payload de viaje:no_disponible (NUEVO):
  { id_viaje: number }

El archivo a modificar es src/sockets/matching.socket.js.

La logica actual probablemente hace:
  io.to('viaje:' + id_viaje).emit('viaje:conductor_asignado', payload)
  (esto emite a TODOS en el room)

Debe cambiarse a:
  socket.emit('viaje:conductor_asignado', payload)
  (esto emite SOLO al socket del conductor ganador)
  
  Y agregar:
  socket.to('viaje:' + id_viaje).emit('viaje:no_disponible', { id_viaje })
  (esto emite a TODOS en el room EXCEPTO al ganador)

VERIFICACION PREVIA: antes de modificar, leer el archivo actual y confirmar
si el bug existe realmente. Si ya emite solo al socket ganador, el bug es
del frontend y no hay que cambiar nada.

## Estructura de carpetas relevante
src/
├── routes/viajes.routes.js
├── controllers/viajes.controller.js
└── sockets/matching.socket.js

## Endpoints de viajes
GET  /api/viajes/disponibles  → CONDUCTOR, lista viajes disponibles
POST /api/viajes              → CLIENTE, crea viaje
GET  /api/viajes/:id          → autenticado, detalle

## Eventos WebSocket de matching
viaje:disponible         → conductores elegibles (al crear viaje)
viaje:aceptar            → conductor → servidor
viaje:conductor_asignado → SOLO al conductor ganador
viaje:ya_asignado        → conductores que intentaron y perdieron
viaje:no_disponible      → resto de conductores del room (NUEVO)
viaje:cancelado_sin_conductor → cliente

## Comandos
npm run dev
node scripts/test-bugs2.js