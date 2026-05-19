# Fleter — Backend

## Descripcion del proyecto
Plataforma marketplace de fletes para PyMEs argentinas.

## Estado actual
Branch: debug — creada desde main.
Main tiene Fases 0 a 3 completas.
Esta branch existe SOLO para corregir bugs reportados por el equipo.
NO agregar funcionalidades nuevas. Solo corregir lo que se indica.

## Stack
- Node.js 22 con ES Modules (import/export — NUNCA require)
- Express
- PostgreSQL en Neon — Prisma 6 (version fija sin caret)
- Firebase Admin SDK
- Socket.io v4
- Redis con ioredis
- Zod

## Reglas de codigo
- ES Modules siempre. NUNCA require().
- Modulos CommonJS: import pkg from 'modulo'; const { X } = pkg;
- Async/await siempre.
- Named exports en controllers y services.

## BUGS A CORREGIR EN ESTA BRANCH

### BUG 1 — condiciones_req no llegan al front
El evento viaje:disponible emitido en matching.service.js
y el endpoint GET /api/viajes/disponibles no estan incluyendo
condiciones_req en sus respuestas.

Archivos a revisar y corregir:
  src/services/matching.service.js → payload del evento viaje:disponible
  src/controllers/viajes.controller.js → include de condiciones_req en
    la query de listarViajesDisponibles y en crearViaje

### BUG 2 — Todos los conductores aparecen como aceptados
El evento viaje:conductor_asignado se emite al room completo.
Todos los conductores en el room lo reciben.
El payload no incluye el id_usuario del conductor asignado,
por lo que el front no puede distinguir si fue el o no.

Archivo a corregir:
  src/sockets/matching.socket.js → agregar id_usuario_conductor al payload

El payload correcto debe ser:
{
  id_viaje,
  id_usuario_conductor: <id_usuario del conductor que gano>,
  conductor: { nombre, apellido, calificacion_promedio },
  vehiculo: { patente, marca, modelo, tipo_vehiculo }
}

## Estructura de carpetas relevante
src/
├── controllers/viajes.controller.js
├── services/matching.service.js
└── sockets/matching.socket.js

## Variables de entorno
Todas en .env. Ver .env.example.

## Comandos
npm run dev
npx prisma studio