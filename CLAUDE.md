# Fleter — Backend

## Descripcion del proyecto
Plataforma de fletes para PyMEs argentinas.
El cliente crea un viaje, el sistema lo publica a conductores
elegibles via WebSocket, el primero en aceptar queda asignado.
Fee porcentual por viaje. MVP: CABA + Gran Buenos Aires.

## Estado actual del proyecto
- Fases 0-4 COMPLETAS
- Registro y gestion de vehiculos para conductores (extra) COMPLETO
- Bugs de matching corregidos
- **En curso: Fase 5 — Confirmacion y cierre (QR, costo real, remito PDF)**

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
- pdfkit para generacion de PDFs (Fase 5)
- @aws-sdk/client-s3 para Cloudflare R2 (Fase 5)

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
│   └── storage.js        → cliente Cloudflare R2 (se crea en Fase 5)
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
│   ├── eta.service.js
│   ├── cierre.service.js  → se crea en Fase 5
│   └── remito.service.js  → se crea en Fase 5
├── middlewares/
│   └── auth.middleware.js
├── sockets/
│   ├── index.js
│   ├── auth.socket.js
│   ├── matching.socket.js
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
- El backend NUNCA guarda contrasenas.
- Cada usuario tiene firebase_uid VARCHAR UNIQUE NOT NULL en usuarios.
- Registro: admin.auth().createUser() → uid → crear en DB.
  Si falla DB: rollback con admin.auth().deleteUser(uid).
- Login: cliente autentica con Firebase → JWT → Bearer en cada request
  → backend verifica con admin.auth().verifyIdToken(token).
- Testing:
  POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<KEY>
  Body: { "email": "...", "password": "...", "returnSecureToken": true }
  Usar el campo idToken como Bearer token.

## WebSockets — Rooms
- Room por viaje: viaje:{id_viaje}
- Room personal por usuario: usuario:{id_usuario} (se une al conectarse en sockets/index.js)

## WebSockets — Tabla de eventos

| Evento                        | Direccion            | Destinatario                                |
|-------------------------------|----------------------|---------------------------------------------|
| viaje:disponible              | servidor → conductor | Socket directo a cada conductor elegible    |
| viaje:aceptar                 | conductor → servidor | —                                           |
| viaje:conductor_asignado      | servidor → conductor | Socket directo al conductor ganador         |
| viaje:conductor_asignado      | servidor → cliente   | Room personal usuario:{id_usuario_cliente}  |
| viaje:ya_asignado             | servidor → conductor | Socket directo al conductor que llego tarde |
| viaje:no_disponible           | servidor → room      | Room viaje:{id_viaje}                       |
| viaje:cancelado_sin_conductor | servidor → cliente   | Room personal usuario:{id_usuario_cliente}  |
| conductor:ubicacion           | conductor → servidor | —                                           |
| mapa:actualizar               | servidor → room      | Room viaje:{id_viaje}                       |
| costo:actualizar              | servidor → room      | Room viaje:{id_viaje} (~cada 60s)           |
| alerta:desvio                 | servidor → room      | Room viaje:{id_viaje}                       |
| alerta:parada                 | servidor → room      | Room viaje:{id_viaje}                       |
| viaje:estado_cambiado         | servidor → room      | Room viaje:{id_viaje}                       |
| viaje:finalizado              | servidor → room      | Room viaje:{id_viaje} (Fase 5)              |

## Estados del viaje

| Transicion                              | Trigger                                        |
|-----------------------------------------|------------------------------------------------|
| BUSCANDO_CONDUCTOR → CONDUCTOR_ASIGNADO | Conductor acepta (matching atomico)            |
| CONDUCTOR_ASIGNADO → EN_CAMINO_A_ORIGEN | Automatico, primer ping GPS                    |
| EN_CAMINO_A_ORIGEN → CARGANDO          | Manual, conductor via PATCH /viajes/:id/estado |
| CARGANDO → EN_RUTA                     | Manual, conductor via PATCH /viajes/:id/estado |
| EN_RUTA → DESCARGANDO                  | Manual, conductor via PATCH /viajes/:id/estado |
| DESCARGANDO → FINALIZADO               | QR de ultima parada confirmado (Fase 5)        |

## QR — Logica de firma (Fase 5)
- Cada parada tiene qr_token (cuid) generado al crear el viaje.
- El backend firma { id_parada, id_viaje, orden } con HMAC-SHA256 usando QR_SECRET.
- El token firmado es lo que se muestra como QR al cliente y lo que escanea el conductor.
- Al confirmar: verificar firma + conductor a menos de 200 metros de la parada (Turf.js).

## Cloudflare R2 (Fase 5)
- Bucket: fleter-remitos
- Endpoint: https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com
- Region: 'auto'
- Key de cada remito: remitos/{id_viaje}.pdf
- URL publica: {R2_PUBLIC_URL}/remitos/{id_viaje}.pdf

## Redis — Keys de GPS
gps:{id_viaje}:ultima         → { lat, lng, timestamp } — expire 2h
gps:{id_viaje}:historial      → lista ultimas 20 coordenadas (LPUSH + LTRIM)
gps:{id_viaje}:ruta           → array [[lng,lat],...] — expire 24h
gps:{id_viaje}:acumulado      → { tiempo_horas, distancia_km, ultima_lat,
                                   ultima_lng, ultima_actualizacion } — expire 24h
gps:{id_viaje}:pings_detenido → contador pings lentos (INCR)

Al finalizar: persistir tiempo_horas y distancia_km en DB, DEL todas las keys.

## Variables de entorno
DATABASE_URL=
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
REDIS_URL=
GOOGLE_MAPS_API_KEY=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=fleter-remitos
R2_PUBLIC_URL=
QR_SECRET=
MERCADOPAGO_ACCESS_TOKEN=   (Fase 6)
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
- Backend: Railway. Script: prisma generate && node src/app.js
- DB: Neon (PostgreSQL serverless)
- Web: Vercel — https://fleter-mu.vercel.app
- CORS: https://fleter-mu.vercel.app + localhost
- Branches: main (estable, deploy auto) / develop (trabajo diario)

## Comandos
npm run dev
redis-cli ping
npx prisma studio
node scripts/simular-gps.js
node scripts/test-fase4.js

## Historial de bugs corregidos
- id_vehiculo requerido vs opcional en viaje:aceptar → RESUELTO
- Verificacion propiedad vehiculo para vehiculos de empresa → RESUELTO
- Cliente no recibia viaje:conductor_asignado → RESUELTO
- Todos los conductores veian viaje aceptado → RESUELTO
- condiciones_req no incluidas en eventos WebSocket → RESUELTO
- Conductores que conectan tarde no recibian viajes → RESUELTO
- Clientes que conectan tarde no se unian a su room → RESUELTO

## Bug pendiente
Timer de cancelacion se activa para viajes programados aunque sean para el dia siguiente.
Fix: no iniciar timer si fecha_programada > ahora + 2 horas. Se corrige en Fase 8.