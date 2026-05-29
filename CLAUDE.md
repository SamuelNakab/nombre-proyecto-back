# Fleter — Backend

## Descripcion del proyecto
Plataforma marketplace de fletes para PyMEs argentinas.
El cliente solicita un viaje, el sistema lo publica a conductores
elegibles via WebSocket, el primero en aceptar queda asignado.

## Estado actual del proyecto
- Fases 1-4 COMPLETAS
- Registro de vehiculos para conductores implementado
- BUGS CRITICOS EN MATCHING A CORREGIR EN ESTA SESION

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

## BUGS CRITICOS A CORREGIR

### BUG 1 — id_vehiculo obligatorio rompe el contrato
El handler de viaje:aceptar exige id_vehiculo en el payload.
El frontend envia solo { id_viaje } segun el contrato existente.
Resultado: el handler emite error y el conductor se queda colgado.

FIX: id_vehiculo debe ser OPCIONAL.
  Si viene id_vehiculo: validar que pertenece al conductor y cumple condiciones.
  Si NO viene id_vehiculo: el backend elige automaticamente el primer vehiculo
    del conductor que cumpla todas las condiciones requeridas del viaje.
  Si el conductor no tiene ningun vehiculo elegible: emitir error.

### BUG 2 — Verificacion de propiedad de vehiculo rota
El check actual es: vehiculo.id_conductor !== conductor.id_conductor
Para vehiculos de empresa, id_conductor es null.
null !== conductor.id_conductor siempre es true → todos los vehiculos de empresa fallan.

FIX: un vehiculo pertenece al conductor si:
  A) vehiculo.id_conductor === conductor.id_conductor (vehiculo propio), O
  B) existe un registro en ConductorVehiculo con ese vehiculo y ese conductor

### BUG 3 — El cliente no recibe viaje:conductor_asignado
El codigo actual:
  socket.emit('viaje:conductor_asignado', payload)    → solo al conductor ganador
  socket.to(room).emit('viaje:no_disponible', ...)    → a TODOS los demas del room

El cliente esta en el room y recibe viaje:no_disponible en lugar de
viaje:conductor_asignado.

FIX: emitir viaje:conductor_asignado al cliente directamente usando su
room personal 'usuario:{id_usuario}'.

Para esto, en sockets/index.js cada socket debe unirse a su room personal
al conectarse: socket.join('usuario:' + usuario.id_usuario)

En matching.socket.js al asignar conductor:
  1. socket.emit('viaje:conductor_asignado', payload)
     → solo al conductor ganador
  2. io.to('usuario:' + id_usuario_cliente).emit('viaje:conductor_asignado', payload)
     → directamente al cliente
  3. socket.to('viaje:' + id_viaje).emit('viaje:no_disponible', { id_viaje })
     → al resto del room (conductores que no ganaron)

Para obtener el id_usuario del cliente: el viaje tiene id_cliente,
el cliente tiene id_usuario. Hacer el include necesario en la query.

## Archivos a modificar
src/sockets/index.js          → agregar socket.join('usuario:' + id_usuario)
src/sockets/matching.socket.js → los tres fixes descritos arriba

## Flujo correcto esperado
  Evento                   | Destinatario
  -------------------------|------------------------------------------
  viaje:disponible         | Conductores elegibles (al crear viaje)
  viaje:conductor_asignado | Conductor ganador (socket directo)
  viaje:conductor_asignado | Cliente (room usuario:{id})
  viaje:ya_asignado        | Conductor que intento y perdio (socket directo)
  viaje:no_disponible      | Resto del room (conductores que no intentaron)

## Comandos
npm run dev
node scripts/test-matching-fix.js