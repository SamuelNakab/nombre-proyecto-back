# Fleter — Backend

## Descripcion del proyecto
Plataforma marketplace de fletes para PyMEs argentinas.
Similar a Uber pero para fletes. El cliente solicita un viaje,
el sistema lo publica a conductores elegibles via WebSocket,
el primero en aceptar queda asignado.

## Estado actual del proyecto
- Base de datos: schema.prisma completo, migración inicial aplicada en Neon
- Scaffold: estructura de carpetas creada
- Config: prisma.js, firebase.js, redis.js, storage.js creados
- Middleware: auth.middleware.js creado (verificarToken, requireRol)
- app.js: servidor base con health check funcionando
- Pendiente: endpoints de Fase 1 (registro, login) y documentación de la API

## Stack
- Node.js con ES Modules (import/export — NUNCA require)
- Express
- PostgreSQL en Neon (serverless)
- Prisma v5 como ORM
- Firebase Admin SDK para autenticacion
- Socket.io para WebSockets (GPS, matching, alertas)
- Redis para coordenadas GPS activas y rooms de viajes
- Zod para validacion de inputs en endpoints
- BullMQ para colas de notificaciones push
- MercadoPago Marketplace para pagos

## Reglas de codigo
- ES Modules siempre. Si escribis require() es un error.
- Async/await siempre. Nada de .then() encadenados.
- Validar todos los inputs con Zod en los endpoints.
- Respuestas de error siempre con formato: { error: "mensaje" }
- Variables de entorno: todas en .env, nunca hardcodeadas.
- Nombres de archivos: kebab-case
- Named exports en controllers y services, no default exports.
- Nunca modificar la DB directamente. Todo via schema.prisma + migrate.

## Estructura de carpetas
src/
├── config/
│   ├── firebase.js       # firebase-admin inicializado
│   ├── prisma.js         # instancia unica de PrismaClient
│   ├── redis.js          # cliente de Redis
│   └── storage.js        # cliente de Cloudflare R2
├── routes/
│   └── auth.routes.js    # pendiente
├── controllers/
│   └── auth.controller.js  # pendiente
├── services/
│   ├── costo.service.js
│   ├── desvio.service.js
│   ├── eta.service.js
│   ├── parada.service.js
│   └── notifications.service.js
├── middlewares/
│   └── auth.middleware.js  # verificarToken + requireRol — listo
├── sockets/
│   ├── index.js
│   ├── gps.socket.js
│   └── matching.socket.js
├── jobs/
│   └── notificaciones.job.js
└── app.js                  # servidor base listo, health check en GET /health

prisma/
├── schema.prisma           # completo y migrado
└── migrations/             # migracion init aplicada

## Modelos de la base de datos (resumen)
Usuario        → firebase_uid UNIQUE, email, dni, rol (CLIENTE|CONDUCTOR|GERENTE|ADMIN)
Cliente        → extiende Usuario 1:1, tiene viajes y calificaciones
Conductor      → extiende Usuario 1:1, tiene licencia y calificacion_promedio
Empresa        → tiene un gerente (Usuario), conductores y vehiculos
ConductorEmpresa → tabla N:N entre Conductor y Empresa
MetodoPago     → mp_token de MercadoPago, NUNCA datos reales de tarjeta
Vehiculo       → pertenece a Empresa, tiene condiciones
ConductorVehiculo → tabla N:N entre Conductor y Vehiculo
CondicionVehiculo → capacidades del vehiculo (FRAGIL, REFRIGERADO, etc.)
CondicionRequerida → lo que necesita un viaje (se cruza con CondicionVehiculo)
Viaje          → id_conductor/id_vehiculo/id_empresa son nullable al crear
Parada         → qr_token UNIQUE GLOBAL con @default(cuid())
Transaccion    → mp_idempotency_key UNIQUE para evitar cobros duplicados
Calificacion   → UNIQUE por viaje

## Autenticacion
- Firebase Auth maneja todas las credenciales
- NO hay contrasena en la DB — firebase_uid es el puente
- Flujo registro: crear en Firebase → obtener uid → crear en DB con ese uid
- Flujo login: Firebase autentica → JWT → backend verifica con verifyIdToken
- Si Firebase tiene exito pero la DB falla: hacer rollback borrando el usuario de Firebase
- verificarToken: verifica JWT, busca usuario por firebase_uid, adjunta req.usuario
- requireRol('CLIENTE', 'ADMIN'): verifica que req.usuario.rol este en la lista

## Variables de entorno
Todas las variables están en .env (no se pushea a Git).
El template con los nombres está en .env.example.
Para desarrollo: copiar .env.example a .env y completar los valores.
Ver .env.example para la lista completa de variables requeridas.

## Endpoints existentes
GET /health → { status: 'ok', timestamp: Date }

## Endpoints pendientes — Fase 1
POST /api/auth/registro-cliente
POST /api/auth/registro-conductor
POST /api/auth/registro-gerente
POST /api/auth/login
GET  /api/auth/me
PUT  /api/auth/perfil

## Comandos importantes
npm run dev                                    → iniciar servidor con hot reload
npx prisma migrate dev --name descripcion      → nueva migracion
npx prisma studio                              → UI para ver la DB en localhost:5555
npx prisma generate                            → regenerar cliente de Prisma