# Fleter — Backend

## Descripcion del proyecto
Plataforma de fletes para PyMEs argentinas.
El cliente crea un viaje, el sistema lo publica a conductores elegibles via
WebSocket, el primero en aceptar queda asignado. Fee porcentual por viaje.
MVP: CABA + Gran Buenos Aires.

## Estado actual del proyecto
- Fases 0-5 COMPLETAS
- Gestion de vehiculos, campo descripcion, ETA + recalculo de ruta, ruta_planeada al front COMPLETO
- Pipeline CI/CD + deploy a Railway por environment COMPLETO
- Cancelacion de viaje por conductor COMPLETO
- **En curso: cancelacion de viaje por parte del cliente**

## Stack
- Node.js 22 con ES Modules (import/export — NUNCA require)
- Express
- PostgreSQL en Neon — Prisma 6
- Firebase Admin SDK
- Socket.io v4
- Redis con ioredis
- Turf.js, Zod
- pdfkit, @aws-sdk/client-s3 (Cloudflare R2)
- Google Maps Directions API

## Reglas de codigo
- ES Modules siempre. NUNCA require().
- Modulos CommonJS: import pkg from 'modulo'; const { X } = pkg;
- Async/await siempre.
- Validar con Zod en endpoints REST.
- Errores como { error: "mensaje" }
- Variables en .env, nunca hardcodeadas.
- kebab-case en archivos.
- Named exports en controllers/services.
- Instancia unica de PrismaClient en src/config/prisma.js

## Reglas de migraciones Prisma
- Hay drift en el historial. Usar npx prisma db push para cambios de schema.
- No usar prisma migrate reset sin autorizacion explicita de Samuel.

## Estados del viaje

| Transicion                              | Trigger                                        |
|-----------------------------------------|------------------------------------------------|
| BUSCANDO_CONDUCTOR → CONDUCTOR_ASIGNADO | Conductor acepta                               |
| BUSCANDO_CONDUCTOR → CANCELADO          | **NUEVO: cliente cancela (esta tarea)**        |
| CONDUCTOR_ASIGNADO → BUSCANDO_CONDUCTOR | Conductor cancela (ya implementado)            |
| CONDUCTOR_ASIGNADO → CANCELADO          | **NUEVO: cliente cancela (esta tarea)**        |
| CONDUCTOR_ASIGNADO → EN_CAMINO_A_ORIGEN | Automatico, primer ping GPS                    |
| EN_CAMINO_A_ORIGEN → CARGANDO           | Manual via PATCH /viajes/:id/estado            |
| CARGANDO → EN_RUTA                      | Manual via PATCH /viajes/:id/estado            |
| EN_RUTA → DESCARGANDO                   | Manual via PATCH /viajes/:id/estado            |
| DESCARGANDO → FINALIZADO                | QR de ultima parada confirmado                 |

CANCELADO es un estado terminal — no hay transiciones desde CANCELADO a nada.

## Cancelacion de viaje por cliente (esta tarea)
- Solo en estados BUSCANDO_CONDUCTOR o CONDUCTOR_ASIGNADO. Cualquier otro
  estado (EN_CAMINO_A_ORIGEN, CARGANDO, EN_RUTA, DESCARGANDO, FINALIZADO,
  CANCELADO): 400 con error claro.
- El viaje pasa a estado CANCELADO. Se guarda id_conductor e id_vehiculo
  tal como estaban al momento de cancelar (para historial). No se limpian
  esos campos — el viaje CANCELADO retiene la informacion de con quien
  estaba asociado, si estaba.
- Si el estado era CONDUCTOR_ASIGNADO al momento de cancelar:
  * Detener el emisor de ETA (detenerEmisorEta).
  * Limpiar TODAS las keys gps:{id_viaje}:* en Redis (limpiarGPS).
- Si el estado era BUSCANDO_CONDUCTOR:
  * No hay Redis ni ETA que limpiar (ruta_planeada esta en Redis pero
    limpiarGPS es idempotente y no falla si no encuentra keys, asi que
    llamarla igual es seguro).
- No se envia notificacion WebSocket a nadie por ahora (queda pendiente:
  eventualmente notificar al conductor asignado si lo habia).

## Cancelacion de viaje por conductor (ya implementado)
- Solo en estado CONDUCTOR_ASIGNADO.
- El viaje vuelve a BUSCANDO_CONDUCTOR con id_conductor y id_vehiculo en null.
- Se detiene el emisor de ETA y se limpia Redis.
- El viaje se republica emitiendo viaje:disponible a los conductores elegibles.
- El conductor que cancelo sigue siendo elegible.

## Refactor esperado (esta tarea)
La logica de "poner CANCELADO/limpiar Redis/detener ETA" se comparte entre
cancelar-conductor y cancelar-cliente. Extraer esa parte a un helper reusable
(por ejemplo en src/services/cancelacion.service.js con una funcion tipo
limpiarViajeActivo(id_viaje) que detiene ETA y limpia Redis, para reusar
desde ambos endpoints). Refactorizar cancelar-conductor para que use el
helper — no debe cambiar su comportamiento externo, sus tests actuales deben
seguir pasando.

## WebSockets — Rooms y eventos
- Room por viaje: viaje:{id_viaje}
- Room personal por usuario: usuario:{id_usuario}

Eventos relevantes al modelo actual: viaje:disponible, viaje:conductor_asignado,
viaje:no_disponible, viaje:ya_asignado, mapa:actualizar, eta:actualizar,
ruta:recalculada, viaje:finalizado, alerta:desvio, alerta:parada.

## Redis — Keys de GPS
gps:{id_viaje}:ultima
gps:{id_viaje}:historial
gps:{id_viaje}:ruta
gps:{id_viaje}:acumulado
gps:{id_viaje}:pings_detenido
gps:{id_viaje}:eta
gps:{id_viaje}:ultimo_recalculo
gps:{id_viaje}:pings_desviado

limpiarGPS (en gps.service.js) borra TODAS las keys gps:{id_viaje}:* de una vez.

## Deploy
- Backend: Railway (production: branch main, staging: branch develop)
- DB: Neon separada por environment
- Redis: Railway separado por environment
- Firebase compartido

## Comandos
npm run dev
npm run lint
npm run test
node scripts/test-fase5.js
node scripts/test-cancelacion-conductor.js
node scripts/test-cancelacion-cliente.js