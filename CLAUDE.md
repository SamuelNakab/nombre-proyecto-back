CLAUDE.md
markdown# Fleter — Backend

## Descripcion del proyecto
Plataforma de fletes para PyMEs argentinas.
El cliente crea un viaje, el sistema lo publica a conductores
elegibles via WebSocket, el primero en aceptar queda asignado.
Fee porcentual por viaje. MVP: CABA + Gran Buenos Aires.

## Estado actual del proyecto
- Fases 0-4 COMPLETAS
- Registro y gestion de vehiculos para conductores (extra, fuera de fases) COMPLETO
- Bugs de matching corregidos (ver historial de bugs abajo)
- **Siguiente: Fase 5 — Confirmacion y cierre (QR, costo real, remito PDF)**

## Stack
- Node.js 22 con ES Modules (import/export — NUNCA require)
- Express
- PostgreSQL en Neon — Prisma 6 (version fija sin caret)
- Firebase Admin SDK para autenticacion (JWT verification)
- Socket.io v4
- Redis con ioredis
- Turf.js para algoritmos geograficos
- Zod para validacion de inputs
- Helmet + CORS para seguridad HTTP

## Reglas de codigo
- ES Modules siempre. NUNCA require().
- Modulos CommonJS: import pkg from 'modulo'; const { X } = pkg;
- Async/await siempre. Nada de .then() encadenados.
- Validar inputs con Zod en todos los endpoints REST.
- Respuestas de error siempre como: { error: "mensaje" }
- Variables de entorno: todas en .env, nunca hardcodeadas.
- Nombres de archivos: kebab-case.
- Named exports en controllers y services.
- Instancia unica de PrismaClient en src/config/prisma.js

## Estructura de carpetas
src/
├── config/
│   ├── firebase.js
│   ├── prisma.js
│   ├── redis.js
│   └── storage.js        (Fase 5)
├── routes/
│   ├── auth.routes.js
│   ├── viajes.routes.js
│   └── conductores.routes.js
├── controllers/
│   ├── auth.controller.js
│   ├── viajes.controller.js
│   └── conductores.controller.js
├── services/
│   ├── tarifa.service.js
│   ├── costo.service.js
│   ├── elegibilidad.service.js
│   ├── matching.service.js
│   ├── gps.service.js
│   ├── desvio.service.js
│   ├── parada.service.js
│   └── eta.service.js
├── middlewares/
│   └── auth.middleware.js
├── sockets/
│   ├── index.js           → inicializacion + auth + room personal usuario:{id}
│   ├── auth.socket.js
│   ├── matching.socket.js → handler viaje:aceptar
│   └── gps.socket.js
└── app.js
scripts/
├── seed-test.js
├── simular-gps.js
└── test-fase4.js
prisma/
├── schema.prisma
└── migrations/

## Autenticacion — Firebase
- El backend NUNCA guarda contrasenas. Firebase es dueno de las credenciales.
- Cada usuario tiene firebase_uid VARCHAR UNIQUE NOT NULL en la tabla usuarios.
- Flujo registro: backend llama admin.auth().createUser() → obtiene uid → crea registro en DB.
  Si falla la DB: rollback con admin.auth().deleteUser(uid).
- Flujo login: el cliente autentica directamente con Firebase → obtiene JWT (dura 1h) →
  manda JWT como Bearer en cada request → backend verifica con admin.auth().verifyIdToken(token).
- Para testing:
  POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<FIREBASE_WEB_API_KEY>
  Body: { "email": "...", "password": "...", "returnSecureToken": true }
  El campo idToken es el Bearer token.

## WebSockets — Flujo de eventos correcto

### Rooms
- Cada viaje tiene un room: `viaje:{id_viaje}`
- Cada usuario tiene un room personal: `usuario:{id_usuario}` (se une al conectarse en sockets/index.js)
- Los rooms personales permiten enviar eventos al cliente sin que los conductores del room lo reciban.

### Tabla de eventos implementados

| Evento                        | Direccion            | Destinatario                                     |
|-------------------------------|----------------------|--------------------------------------------------|
| viaje:disponible              | servidor → conductor | Conductores elegibles (socket directo a cada uno)|
| viaje:aceptar                 | conductor → servidor | —                                                |
| viaje:conductor_asignado      | servidor → conductor | Socket directo al conductor ganador              |
| viaje:conductor_asignado      | servidor → cliente   | Room personal `usuario:{id_usuario_cliente}`     |
| viaje:ya_asignado             | servidor → conductor | Socket directo al conductor que llego tarde      |
| viaje:no_disponible           | servidor → room      | Room `viaje:{id_viaje}` (conductores restantes)  |
| viaje:cancelado_sin_conductor | servidor → cliente   | Room personal `usuario:{id_usuario_cliente}`     |
| conductor:ubicacion           | conductor → servidor | —                                                |
| mapa:actualizar               | servidor → room      | Room `viaje:{id_viaje}`                          |
| costo:actualizar              | servidor → room      | Room `viaje:{id_viaje}` (~cada 60s)              |
| alerta:desvio                 | servidor → room      | Room `viaje:{id_viaje}`                          |
| alerta:parada                 | servidor → room      | Room `viaje:{id_viaje}`                          |
| viaje:estado_cambiado         | servidor → room      | Room `viaje:{id_viaje}`                          |

### Logica de viaje:aceptar (matching.socket.js)
1. Validar id_viaje del payload (requerido, number).
2. id_vehiculo es OPCIONAL:
   - Si viene: validar que pertenece al conductor Y cumple condiciones del viaje.
   - Si NO viene: el backend elige automaticamente el primer vehiculo del conductor
     que cumpla todas las condiciones requeridas.
   - Si no hay ningun vehiculo elegible: emitir error al socket del conductor.
3. Verificacion de propiedad — un vehiculo pertenece al conductor si:
   A) vehiculo.id_conductor === conductor.id_conductor (vehiculo propio), O
   B) existe un registro en ConductorVehiculo con ese vehiculo y ese conductor.
   (NO solo chequear id_conductor porque vehiculos de empresa tienen id_conductor = null)
4. Transaccion atomica para evitar race conditions.
5. Al asignar exitosamente:
   - socket.emit('viaje:conductor_asignado', payload)             → solo al conductor ganador
   - io.to('usuario:' + id_usuario_cliente).emit('viaje:conductor_asignado', payload) → al cliente
   - socket.to('viaje:' + id_viaje).emit('viaje:no_disponible', { id_viaje })         → al resto
6. Si el viaje ya fue asignado por otro:
   - socket.emit('viaje:ya_asignado', { id_viaje, mensaje })      → al conductor que llego tarde

## Redis — Keys de GPS
gps:{id_viaje}:ultima         → { lat, lng, timestamp } — expire 2h
gps:{id_viaje}:historial      → lista ultimas 20 coordenadas (LPUSH + LTRIM)
gps:{id_viaje}:ruta           → array [[lng,lat],...] — expire 24h
gps:{id_viaje}:acumulado      → { tiempo_horas, distancia_km, ultima_lat, ultima_lng,
ultima_actualizacion } — expire 24h
gps:{id_viaje}:pings_detenido → contador pings lentos (INCR)
Al finalizar el viaje: persistir tiempo_horas y distancia_km en DB, DEL todas las keys.

## Variables de entorno requeridas
DATABASE_URL=
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
REDIS_URL=
GOOGLE_MAPS_API_KEY=
R2_ACCOUNT_ID=              (pendiente Fase 5)
R2_ACCESS_KEY_ID=           (pendiente Fase 5)
R2_SECRET_ACCESS_KEY=       (pendiente Fase 5)
R2_BUCKET_NAME=             (pendiente Fase 5)
R2_PUBLIC_URL=              (pendiente Fase 5)
MERCADOPAGO_ACCESS_TOKEN=   (pendiente Fase 6)
PORT=3000
NODE_ENV=development
MATCHING_TIMEOUT_MINUTOS=10
TARIFA_BASE_HORA_CABA=3500
TARIFA_PICO_HORA_CABA=5000
TARIFA_BASE_KM_PROVINCIA=150
TARIFA_PICO_KM_PROVINCIA=200
DESVIO_UMBRAL_METROS=300
PARADA_SOSPECHOSA_MINUTOS=5
PARADA_SOSPECHOSA_VELOCIDAD_KMH=3

## Deploy
- Backend: Railway (plan Hobby $5/mes). Script de start: `prisma generate && node src/app.js`
- DB: Neon (PostgreSQL serverless gratuito)
- Web: Vercel — https://fleter-mu.vercel.app
- CORS permitido: https://fleter-mu.vercel.app + localhost
- Branches: main (estable, deploy automatico) / develop (trabajo diario)

## Comandos utiles
npm run dev
redis-cli ping
npx prisma studio
node scripts/simular-gps.js
node scripts/test-fase4.js

## Historial de bugs corregidos
- id_vehiculo requerido vs opcional en viaje:aceptar → RESUELTO
- Verificacion de propiedad de vehiculo para vehiculos de empresa → RESUELTO
- Cliente no recibia viaje:conductor_asignado → RESUELTO (room personal usuario:{id})
- Todos los conductores veian "viaje aceptado" → RESUELTO (viaje:no_disponible solo al room)
- condiciones_req no incluidas en eventos WebSocket → RESUELTO
- Conductores que conectan tarde no recibian viajes disponibles → RESUELTO
- Clientes que conectan tarde no se unian a su room activo → RESUELTO

## Bug pendiente conocido
Timer de cancelacion de 10 min se activa para viajes programados aunque sean para el dia siguiente.
Fix: no iniciar el timer si fecha_programada > ahora + 2 horas. Se corrige en Fase 8.

## Proxima fase — Fase 5: Confirmacion y cierre
- QR unico por parada con firma digital del servidor
- POST /viajes/:id/confirmar-parada (verifica QR + posicion GPS)
- Calculo de costo real con datos GPS reales de Redis
- POST /viajes/:id/calificacion
- Generacion de remito PDF + Cloudflare R2 para almacenarlos
- Emit viaje:finalizado al room
- Persistir acumulado GPS en DB, limpiar Redis