# Fleter — Backend

## Descripcion del proyecto
Plataforma de fletes para PyMEs argentinas.
El cliente crea un viaje, el sistema lo publica a conductores
elegibles via WebSocket, el primero en aceptar queda asignado.
Fee porcentual por viaje. MVP: CABA + Gran Buenos Aires.

## Estado actual del proyecto
- Fases 0-5 COMPLETAS (registro, viajes, matching, GPS en vivo, QR, cierre, remito PDF, calificaciones)
- Gestion de vehiculos para conductores COMPLETO
- Campo descripcion opcional en viajes COMPLETO
- **En curso: pulido — ETA en tiempo real + recalculo de ruta por desvio**

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
- pdfkit para generacion de PDFs
- @aws-sdk/client-s3 para Cloudflare R2
- Google Maps Directions API (rutas y ETA con trafico)

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

## Reglas de migraciones Prisma
- Hay drift en el historial de migraciones (cambios aplicados con db push).
  Usar npx prisma db push para cambios de schema hasta que se limpie el historial.
- Nunca usar prisma migrate reset sin autorizacion explicita de Samuel.

## Estructura de carpetas
src/
├── config/
│   ├── firebase.js
│   ├── prisma.js
│   ├── redis.js
│   └── storage.js
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
│   ├── eta.service.js      → se reescribe en esta sesion
│   ├── cierre.service.js
│   └── remito.service.js
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
├── test-fase4.js
└── test-fase5.js
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
| viaje:finalizado              | servidor → room      | Room viaje:{id_viaje}                       |
| eta:actualizar                | servidor → room      | Room viaje:{id_viaje} (cada 30s) — NUEVO    |
| ruta:recalculada              | servidor → room      | Room viaje:{id_viaje} (al recalcular) — NUEVO|

## Estados del viaje

| Transicion                              | Trigger                                        |
|-----------------------------------------|------------------------------------------------|
| BUSCANDO_CONDUCTOR → CONDUCTOR_ASIGNADO | Conductor acepta (matching atomico)            |
| CONDUCTOR_ASIGNADO → EN_CAMINO_A_ORIGEN | Automatico, primer ping GPS                    |
| EN_CAMINO_A_ORIGEN → CARGANDO          | Manual, conductor via PATCH /viajes/:id/estado |
| CARGANDO → EN_RUTA                     | Manual, conductor via PATCH /viajes/:id/estado |
| EN_RUTA → DESCARGANDO                  | Manual, conductor via PATCH /viajes/:id/estado |
| DESCARGANDO → FINALIZADO               | QR de ultima parada confirmado                 |

## Elegibilidad de conductores
Un conductor es elegible para un viaje si y solo si:
1. Tiene AL MENOS UN vehiculo (propio o via conductor_vehiculo), Y
2. Al menos uno de esos vehiculos cumple TODAS las condiciones requeridas
   del viaje (si no hay condiciones, basta con tener un vehiculo).
La logica vive exclusivamente en elegibilidad.service.js — no duplicar.

## ETA — Diseño (esta sesion)
- Fuente de verdad: Google Maps Directions API con trafico, desde la posicion
  actual del conductor hasta la proxima parada PENDIENTE.
- Recalculo con API: cada 6 minutos (360s), O cuando se recalcula la ruta por
  desvio, O cuando se confirma una parada (cambia la proxima parada).
- Entre recalculos: countdown local. Cada 30s se emite eta:actualizar con el
  ultimo ETA de la API menos el tiempo transcurrido desde ese calculo.
- El countdown nunca baja de 0. Si llega a 0 antes del proximo recalculo
  programado, se fuerza un recalculo inmediato con la API.
- Estado del ETA en Redis: gps:{id_viaje}:eta →
  { segundos_eta_api, timestamp_calculo, proxima_parada_id } — expire 24h

## Recalculo de ruta por desvio — Diseño (esta sesion)
- Cuando desvio.service detecta desvio (>300m de la ruta) en 2 pings
  consecutivos, llamar a Google Maps Directions API desde la posicion actual
  del conductor hasta la proxima parada PENDIENTE (incluyendo las paradas
  restantes como waypoints si hay mas de una).
- Reemplazar gps:{id_viaje}:ruta en Redis con la nueva ruta.
- Emitir ruta:recalculada al room con la nueva ruta completa.
- Forzar recalculo de ETA inmediato (la ruta cambio).
- Cooldown: no recalcular ruta mas de una vez cada 2 minutos por viaje.
  Guardar timestamp del ultimo recalculo en Redis:
  gps:{id_viaje}:ultimo_recalculo — expire 24h
- Tras recalcular, la deteccion de desvios usa la NUEVA ruta.

## Cloudflare R2
- Bucket: fleter-remitos
- Endpoint: https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com
- Region: 'auto'
- Key de cada remito: remitos/{id_viaje}.pdf
- URL publica: {R2_PUBLIC_URL}/remitos/{id_viaje}.pdf

## Redis — Keys de GPS
gps:{id_viaje}:ultima           → { lat, lng, timestamp } — expire 2h
gps:{id_viaje}:historial        → lista ultimas 20 coordenadas (LPUSH + LTRIM)
gps:{id_viaje}:ruta             → array [[lng,lat],...] — expire 24h
gps:{id_viaje}:acumulado        → { tiempo_horas, distancia_km, ultima_lat,
                                     ultima_lng, ultima_actualizacion } — expire 24h
gps:{id_viaje}:pings_detenido   → contador pings lentos (INCR)
gps:{id_viaje}:eta              → { segundos_eta_api, timestamp_calculo,
                                     proxima_parada_id } — expire 24h — NUEVO
gps:{id_viaje}:ultimo_recalculo → timestamp — expire 24h — NUEVO

Al finalizar el viaje: persistir totales en DB, DEL todas las keys gps:{id_viaje}:*

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
PORT=                       (Railway lo inyecta automaticamente)
NODE_ENV=development
ETA_RECALCULO_SEGUNDOS=360
ETA_EMISION_SEGUNDOS=30
RUTA_RECALCULO_COOLDOWN_SEGUNDOS=120
DESVIO_UMBRAL_METROS=300
PARADA_SOSPECHOSA_MINUTOS=5
PARADA_SOSPECHOSA_VELOCIDAD_KMH=3
TARIFA_BASE_HORA_CABA=3500
TARIFA_PICO_HORA_CABA=5000
TARIFA_BASE_KM_PROVINCIA=150
TARIFA_PICO_KM_PROVINCIA=200
MATCHING_TIMEOUT_MINUTOS=10 (sin efecto — pendiente eliminar en pulido)

## Deploy
- Backend: Railway. Script: prisma generate && node src/app.js
- DB: Neon (PostgreSQL serverless) — compartida entre prod y staging por ahora
- Redis: Railway (servicio en el mismo proyecto, por environment)
- Environments Railway: production (branch main) y staging (branch develop)
- Web: Vercel — https://fleter-mu.vercel.app
- CORS: abierto — restringir en pulido
- Branches: main (estable, deploy auto) / develop (trabajo diario)

## Comandos
npm run dev
redis-cli ping
npx prisma studio
node scripts/simular-gps.js
node scripts/test-fase4.js
node scripts/test-fase5.js

## Historial de bugs y fixes
- id_vehiculo requerido vs opcional en viaje:aceptar → RESUELTO
- Verificacion propiedad vehiculo para vehiculos de empresa → RESUELTO
- Cliente no recibia viaje:conductor_asignado → RESUELTO
- Todos los conductores veian viaje aceptado → RESUELTO
- condiciones_req no incluidas en eventos WebSocket → RESUELTO
- Conductores que conectan tarde no recibian viajes → RESUELTO
- Clientes que conectan tarde no se unian a su room → RESUELTO
- Redis con REDIS_URL apuntando a localhost en Railway → RESUELTO
- Puerto 3000 vs 8080 en Railway → RESUELTO (Railway inyecta PORT)
- Elegibilidad: conductor sin vehiculos veia viajes sin requisitos → RESUELTO
- Columna vehiculos.id_conductor faltante tras migrate reset (drift) → RESUELTO con db push

## Pendientes (fase de pulido)
- Eliminar timer de cancelacion y MATCHING_TIMEOUT_MINUTOS
- CORS abierto — restringir a dominios conocidos
- Calculo zona MIXTO — usar poligono CABA para separar tiempo/distancia
- ~~Devolver ruta_planeada en GET /api/viajes/:id~~ HECHO — la ruta se calcula al crear el viaje y se devuelve en POST /api/viajes, GET /api/viajes/:id y el evento viaje:conductor_asignado
- Limpiar drift del historial de migraciones Prisma