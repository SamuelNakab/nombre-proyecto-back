# Fleter — Backend

## Descripcion del proyecto
Plataforma marketplace de fletes para PyMEs argentinas.
Similar a Uber pero para fletes. El cliente solicita un viaje,
el sistema lo publica a conductores elegibles via WebSocket,
el primero en aceptar queda asignado.

## Estado actual del proyecto
- Fase 1 COMPLETA: autenticacion, registro, login, perfiles
- Fase 2 COMPLETA: creacion de viajes, estimacion de costo, listado para conductores
- Fase 3 EN DESARROLLO: matching en tiempo real con Socket.io

## Stack
- Node.js 22 con ES Modules (import/export — NUNCA require)
- Express
- PostgreSQL en Neon — Prisma 6 (version fija sin caret)
- Firebase Admin SDK para autenticacion
- Socket.io v4 para WebSockets — SE IMPLEMENTA EN ESTA FASE
- Redis con ioredis (proximas fases — el cliente ya esta configurado)
- Zod para validacion
- BullMQ (proximas fases)
- Google Maps API (mock activo — GOOGLE_MAPS_API_KEY vacia)

## Reglas de codigo
- ES Modules siempre. NUNCA require().
- Modulos CommonJS: import pkg from 'modulo'; const { X } = pkg;
- Async/await siempre. Nada de .then() encadenados.
- Validar todos los inputs con Zod en endpoints REST.
- Respuestas de error REST: { error: "mensaje" }
- Errores Socket.io: emitir evento 'error' con { error: "mensaje" }
- Variables de entorno: todas en .env, nunca hardcodeadas.
- Nombres de archivos: kebab-case.
- Named exports en controllers y services.
- Nunca modificar la DB directamente. Todo via schema.prisma + migrate.

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
│   ├── costo.service.js
│   ├── elegibilidad.service.js
│   └── matching.service.js     ← nuevo en Fase 3
├── middlewares/
│   └── auth.middleware.js
├── sockets/
│   ├── index.js                ← nuevo en Fase 3 — setup de Socket.io
│   ├── matching.socket.js      ← nuevo en Fase 3 — logica de rooms y aceptacion
│   └── auth.socket.js          ← nuevo en Fase 3 — verificacion JWT en conexion
└── app.js                      ← modificar para integrar Socket.io
prisma/
├── schema.prisma
└── migrations/

## Autenticacion WebSocket
Las conexiones Socket.io se autentican igual que los endpoints REST:
- El cliente manda el JWT de Firebase en el handshake:
    socket = io(URL, { auth: { token: "Bearer eyJ..." } })
- El servidor verifica el token en el middleware de Socket.io
- Si el token es invalido: desconectar con socket.disconnect()
- Si es valido: adjuntar socket.data.usuario con los datos del usuario

## Sistema de rooms
- Cada viaje tiene un room con ID: "viaje:{id_viaje}"
- Al crear un viaje: el servidor hace join del socket del cliente al room
- Al conectarse un conductor: el servidor hace join a todos los rooms de viajes
  donde es elegible y que esten en estado BUSCANDO_CONDUCTOR
- Al finalizar o cancelarse un viaje: el servidor hace leave del room

## Logica de matching
1. Cliente crea viaje via POST /api/viajes (ya existente en Fase 2)
2. El controller modifica: despues de crear el viaje, llama a matching.service
3. matching.service busca conductores elegibles conectados y emite viaje:disponible
4. Conductor recibe viaje:disponible y puede emitir viaje:aceptar
5. El servidor usa prisma.$transaction() para verificar que el viaje sigue en
   BUSCANDO_CONDUCTOR y actualizarlo a CONDUCTOR_ASIGNADO atomicamente
6. Si gana: emitir viaje:conductor_asignado al room
7. Si pierde (race condition): emitir viaje:ya_asignado solo al conductor perdedor
8. Timer: si nadie acepta en MATCHING_TIMEOUT_MINUTOS, cancelar automaticamente

## Variables de entorno
Todas en .env. Ver .env.example.
MATCHING_TIMEOUT_MINUTOS=10  ← nueva variable para Fase 3
                               (cuantos minutos esperar antes de cancelar el viaje)

## Endpoints REST existentes (no modificar)
POST /api/auth/registro-cliente
POST /api/auth/registro-conductor
POST /api/auth/registro-gerente
POST /api/auth/login
GET  /api/auth/me
PUT  /api/auth/perfil
POST /api/viajes/estimar-costo
POST /api/viajes                 ← modificar: agregar emision de socket despues de crear
GET  /api/viajes/disponibles
GET  /api/viajes/mis-viajes
GET  /api/viajes/:id
GET  /health

## Eventos Socket.io — Fase 3
viaje:disponible      servidor → conductores elegibles conectados
viaje:aceptar         conductor → servidor
viaje:conductor_asignado  servidor → room del viaje
viaje:ya_asignado     servidor → conductor que llego tarde
viaje:cancelado_sin_conductor  servidor → cliente del viaje

## Comandos importantes
npm run dev                                → desarrollo local
npm run start                              → produccion (incluye prisma generate)
npx prisma migrate dev --name descripcion  → nueva migracion
npx prisma studio                          → UI para ver la DB