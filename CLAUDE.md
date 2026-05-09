# Fleter — Backend

## Descripcion del proyecto
Plataforma marketplace de fletes para PyMEs argentinas.
Similar a Uber pero para fletes. El cliente solicita un viaje,
el sistema lo publica a conductores elegibles via WebSocket,
el primero en aceptar queda asignado.

## Estado actual del proyecto
Fase 1 COMPLETA y desplegada en Railway.
Fase 2 EN DESARROLLO en branch develop.

## RESTRICCION ACTIVA DE DESARROLLO
GOOGLE_MAPS_API_KEY no esta disponible todavia.
Todo el codigo que use Google Maps debe funcionar de la siguiente manera:
- Si GOOGLE_MAPS_API_KEY existe en el .env: usar la API real de Google
- Si GOOGLE_MAPS_API_KEY no existe o esta vacia: usar valores mock hardcodeados
  y loggear un warning en consola: "GOOGLE_MAPS_API_KEY no configurada, usando valores mock"
- Los valores mock son: distancia_km = 10, tiempo_horas = 0.5
- Esta logica va SOLO en costo.service.js — el resto del codigo no sabe si es mock o real
- Cuando se agregue la key al .env, todo funciona automaticamente sin cambiar codigo

## Stack
- Node.js 22 con ES Modules (import/export — NUNCA require)
- Express
- PostgreSQL en Neon (serverless)
- Prisma 6 como ORM (version fija sin caret)
- Firebase Admin SDK para autenticacion
- Socket.io para WebSockets (proxima fase)
- Redis (proximas fases)
- Zod para validacion
- BullMQ para colas (proximas fases)
- Google Maps API Distance Matrix (requiere GOOGLE_MAPS_API_KEY en .env)

## Reglas de codigo
- ES Modules siempre. NUNCA require().
- Para modulos CommonJS usar:
    import pkg from 'nombre-modulo';
    const { NamedExport } = pkg;
- Async/await siempre.
- Validar todos los inputs con Zod.
- Respuestas de error: { error: "mensaje" }
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
│   └── elegibilidad.service.js
├── middlewares/
│   ├── auth.middleware.js
│   └── validate.middleware.js
├── sockets/
├── jobs/
└── app.js
prisma/
├── schema.prisma
└── migrations/

## Modelos relevantes para Fase 2
Viaje              → id_conductor/id_vehiculo/id_empresa son nullable al crear
Parada             → qr_token UNIQUE GLOBAL (cuid generado por Prisma)
CondicionRequerida → lo que necesita el viaje
CondicionVehiculo  → capacidades del vehiculo
Cliente            → quien crea el viaje
Conductor          → quien ve los viajes disponibles

## Logica del calculo de costo
- Zona CABA: costo = tiempo_horas_total * tarifa_hora
- Zona PROVINCIA: costo = distancia_km_total * tarifa_km
- Zona MIXTO: costo = (tiempo * tarifa_hora) + (distancia * tarifa_km)
- precio_estimado se calcula al crear el viaje
- precio_real se calcula al finalizar con datos GPS reales (Fase 4)

## Filtro de conductores elegibles
Un conductor es elegible si al menos uno de sus vehiculos cumple
TODAS las condiciones requeridas por el viaje.

## Variables de entorno
Todas en .env (no se pushea). Ver .env.example.
GOOGLE_MAPS_API_KEY → requerida para calculos reales, opcional para desarrollo
                      (el sistema usa mock si no esta presente)

## Endpoints existentes (Fase 1)
POST /api/auth/registro-cliente
POST /api/auth/registro-conductor
POST /api/auth/registro-gerente
POST /api/auth/login
GET  /api/auth/me
PUT  /api/auth/perfil
GET  /health

## Endpoints a implementar en Fase 2
POST /api/viajes/estimar-costo    (CLIENTE)
POST /api/viajes                  (CLIENTE)
GET  /api/viajes/disponibles      (CONDUCTOR)
GET  /api/viajes/mis-viajes       (CLIENTE)
GET  /api/viajes/:id              (autenticado)

## Comandos importantes
npm run dev                                → desarrollo local
npm run start                              → produccion
npx prisma migrate dev --name descripcion  → nueva migracion
npx prisma studio                          → UI para ver la DB