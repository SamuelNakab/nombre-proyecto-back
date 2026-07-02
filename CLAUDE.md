# Fleter — Backend

## Descripcion del proyecto
Plataforma de fletes para PyMEs argentinas.
El cliente crea un viaje, el sistema lo publica a conductores elegibles via
WebSocket, el primero en aceptar queda asignado. Fee porcentual por viaje.
MVP: CABA + Gran Buenos Aires.

## Estado actual del proyecto
- Fases 0-5 COMPLETAS (registro, viajes, matching, GPS, QR, cierre, remito, calificaciones)
- Gestion de vehiculos de conductores COMPLETO
- Campo descripcion opcional COMPLETO
- ETA en tiempo real + recalculo de ruta + ruta_planeada al front COMPLETO
- Pipeline CI/CD + deploy a Railway por environment COMPLETO
- **En curso: cancelacion de viaje por parte del conductor**

## Stack
- Node.js 22 con ES Modules (import/export — NUNCA require)
- Express
- PostgreSQL en Neon — Prisma 6
- Firebase Admin SDK para autenticacion
- Socket.io v4
- Redis con ioredis
- Turf.js para algoritmos geograficos
- Zod para validacion de inputs
- pdfkit y @aws-sdk/client-s3 (Cloudflare R2)
- Google Maps Directions API

## Reglas de codigo
- ES Modules siempre. NUNCA require().
- Modulos CommonJS: import pkg from 'modulo'; const { X } = pkg;
- Async/await siempre.
- Validar inputs con Zod en todos los endpoints REST.
- Respuestas de error siempre como: { error: "mensaje" }
- Variables de entorno: todas en .env, nunca hardcodeadas.
- Nombres de archivos: kebab-case.
- Named exports en controllers y services.
- Instancia unica de PrismaClient en src/config/prisma.js

## Reglas de migraciones Prisma
- Hay drift en el historial. Usar npx prisma db push para cambios de schema.
- Nunca usar prisma migrate reset sin autorizacion explicita de Samuel.

## WebSockets — Rooms y eventos
- Room por viaje: viaje:{id_viaje}
- Room personal por usuario: usuario:{id_usuario}

Eventos existentes relevantes para esta tarea:
| Evento                   | Direccion            | Destinatario                          |
|--------------------------|----------------------|---------------------------------------|
| viaje:disponible         | servidor → conductor | Cada conductor elegible (socket directo)|
| viaje:conductor_asignado | servidor → conductor | Socket directo al ganador             |
| viaje:conductor_asignado | servidor → cliente   | Room personal usuario:{id_cliente}    |
| viaje:no_disponible      | servidor → room      | Room viaje:{id_viaje}                 |
| mapa:actualizar          | servidor → room      | Room viaje:{id_viaje}                 |
| eta:actualizar           | servidor → room      | Room viaje:{id_viaje}                 |
| ruta:recalculada         | servidor → room      | Room viaje:{id_viaje}                 |
| viaje:finalizado         | servidor → room      | Room viaje:{id_viaje}                 |

## Estados del viaje (lineal, sin retroceso salvo cancelacion del conductor)

| Transicion                              | Trigger                                        |
|-----------------------------------------|------------------------------------------------|
| BUSCANDO_CONDUCTOR → CONDUCTOR_ASIGNADO | Conductor acepta (matching atomico)            |
| CONDUCTOR_ASIGNADO → BUSCANDO_CONDUCTOR | **NUEVO: conductor cancela (esta tarea)**      |
| CONDUCTOR_ASIGNADO → EN_CAMINO_A_ORIGEN | Automatico, primer ping GPS                    |
| EN_CAMINO_A_ORIGEN → CARGANDO          | Manual via PATCH /viajes/:id/estado            |
| CARGANDO → EN_RUTA                     | Manual via PATCH /viajes/:id/estado            |
| EN_RUTA → DESCARGANDO                  | Manual via PATCH /viajes/:id/estado            |
| DESCARGANDO → FINALIZADO               | QR de ultima parada confirmado                 |

## Cancelacion de viaje por conductor (esta tarea)
- Solo en estado CONDUCTOR_ASIGNADO. Cualquier otro estado: 400.
- El viaje mantiene su id_viaje. Vuelve a BUSCANDO_CONDUCTOR, con id_conductor
  y id_vehiculo en null.
- Se detiene el emisor de ETA del viaje.
- Se limpian TODAS las keys gps:{id_viaje}:* en Redis (igual que al finalizar).
- Se vuelve a publicar a los conductores elegibles emitiendo viaje:disponible,
  reutilizando el flujo existente de creacion (incluido el recalculo de
  ruta_planeada con Google Maps Directions API cuando el siguiente conductor
  acepte y se haga el primer ping).
- El conductor que cancelo SIGUE siendo elegible: puede recibir viaje:disponible
  de este mismo viaje y volver a aceptarlo (no hay penalizacion ni limite por
  ahora — esa logica queda pendiente).
- El cliente NO recibe una notificacion especifica de la cancelacion. Solo va a
  ver que el viaje volvio a estado BUSCANDO_CONDUCTOR (y, eventualmente, recibira
  un nuevo viaje:conductor_asignado cuando otro conductor acepte).

## Elegibilidad de conductores
Un conductor es elegible si y solo si:
1. Tiene AL MENOS UN vehiculo registrado, Y
2. Al menos uno cumple TODAS las condiciones requeridas del viaje (si no
   hay condiciones, basta con tener al menos un vehiculo).
La logica vive exclusivamente en elegibilidad.service.js.

## Redis — Keys de GPS
gps:{id_viaje}:ultima
gps:{id_viaje}:historial
gps:{id_viaje}:ruta
gps:{id_viaje}:acumulado
gps:{id_viaje}:pings_detenido
gps:{id_viaje}:eta
gps:{id_viaje}:ultimo_recalculo
gps:{id_viaje}:pings_desviado

Al finalizar el viaje O al cancelar (esta tarea): limpiar TODAS las keys
gps:{id_viaje}:* con limpiarGPS (en gps.service.js).

## Variables de entorno
DATABASE_URL, FIREBASE_*, REDIS_URL, GOOGLE_MAPS_API_KEY, R2_*, QR_SECRET,
NODE_ENV, TARIFA_*, DESVIO_UMBRAL_METROS, PARADA_*, ETA_*, RUTA_*.

## Deploy
- Backend: Railway (production: branch main, staging: branch develop)
- DB: Neon (separada por environment)
- Redis: Railway (separado por environment)
- Firebase: compartido entre environments

## Comandos
npm run dev
npm run lint
npm run test
npm run test:e2e
node scripts/test-fase5.js
node scripts/test-eta-recalculo.js
node scripts/test-ruta-front.js