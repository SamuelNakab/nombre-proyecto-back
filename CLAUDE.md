# Fleter — Backend

## Descripcion del proyecto
Plataforma de fletes para PyMEs argentinas. El cliente crea un viaje, el
sistema lo publica a conductores elegibles via WebSocket, el primero en
aceptar queda asignado. Fee porcentual. MVP: CABA + GBA.

## Estado actual del proyecto
- Fases 0-5 COMPLETAS
- Vehiculos, descripcion, ETA/recalculo/ruta_planeada COMPLETO
- CI/CD + deploy Railway por environment COMPLETO
- Cancelacion por conductor, por cliente y por admin COMPLETO
- Panel de administracion (endpoints + front separado) COMPLETO
- **En curso: boton "Iniciar viaje" (inicio manual, fin del inicio
  automatico por GPS)**

## Stack
- Node.js 22 con ES Modules (NUNCA require())
- Express, PostgreSQL en Neon (Prisma 6), Firebase Admin SDK,
  Socket.io v4, Redis (ioredis), Turf.js, Zod, pdfkit,
  @aws-sdk/client-s3 (R2), Google Maps Directions API

## Reglas de codigo
- ES Modules siempre. Async/await siempre.
- Zod en todos los endpoints REST. Errores como { error: "mensaje" }.
- Variables en .env. kebab-case en archivos. Named exports.
- PrismaClient unico en src/config/prisma.js.

## Reglas de migraciones Prisma
- Hay drift. Usar npx prisma db push. Nunca migrate reset sin
  autorizacion explicita de Samuel.

## Inicio manual de viaje (esta tarea)

### Regla central
El inicio automatico por primer ping GPS SE ELIMINA. La unica forma de
iniciar un viaje es POST /api/viajes/:id/iniciar (rol CONDUCTOR, solo el
asignado, solo en CONDUCTOR_ASIGNADO).

### Ventana de tiempo
- Se puede iniciar desde VENTANA_INICIO_MINUTOS (default 30) antes de
  fecha_programada.
- SIN limite superior: el conductor puede iniciar aunque haya pasado la
  hora, siempre.
- Demasiado temprano → 400 "El viaje solo puede iniciarse a partir de
  las <HH:MM>" (hora local America/Argentina/Buenos_Aires).

### Puntualidad (campos nuevos en Viaje)
- fecha_inicio DateTime? — timestamp del boton.
- puntualidad_inicio String? — calculado contra fecha_programada:
  * retraso <= PUNTUALIDAD_TARDE_MINUTOS (30) → "A_TIEMPO"
    (iniciar antes de hora tambien es A_TIEMPO)
  * hasta PUNTUALIDAD_MUY_TARDE_MINUTOS (120) → "TARDE"
  * mas → "MUY_TARDE"

### GPS
- Pings de viajes en CONDUCTOR_ASIGNADO o BUSCANDO_CONDUCTOR se rechazan:
  socket.emit('error', { error: "El viaje no fue iniciado" }), sin ningun
  efecto secundario (no Redis, no eventos).
- Pings de EN_CAMINO_A_ORIGEN en adelante: igual que siempre.
- El flujo correcto del mobile: boton → 200 → recien ahi arrancar GPS.

### Evento nuevo
viaje:iniciado → room personal usuario:{id_cliente}
payload: { id_viaje, fecha_inicio, puntualidad_inicio }

## Estados del viaje (actualizado)

| Transicion                              | Trigger                                     |
|-----------------------------------------|---------------------------------------------|
| BUSCANDO_CONDUCTOR → CONDUCTOR_ASIGNADO | Conductor acepta (matching atomico)         |
| BUSCANDO_CONDUCTOR → CANCELADO          | Cliente cancela                             |
| CONDUCTOR_ASIGNADO → BUSCANDO_CONDUCTOR | Conductor cancela (se republica)            |
| CONDUCTOR_ASIGNADO → CANCELADO          | Cliente cancela                             |
| CONDUCTOR_ASIGNADO → EN_CAMINO_A_ORIGEN | **POST /api/viajes/:id/iniciar (NUEVO)**    |
| EN_CAMINO_A_ORIGEN → CARGANDO           | Manual, PATCH /viajes/:id/estado            |
| CARGANDO → EN_RUTA                      | Manual, PATCH /viajes/:id/estado            |
| EN_RUTA → DESCARGANDO                   | Manual, PATCH /viajes/:id/estado            |
| DESCARGANDO → FINALIZADO                | QR de ultima parada confirmado              |
| cualquiera (no FINALIZADO/CANCELADO) → CANCELADO | Admin cancela                      |

Ya NO existe la transicion automatica por primer ping GPS.

## Cancelaciones — resumen
- CONDUCTOR: solo CONDUCTOR_ASIGNADO (hasta el instante de iniciar) →
  vuelve a BUSCANDO_CONDUCTOR y se republica.
- CLIENTE: BUSCANDO_CONDUCTOR o CONDUCTOR_ASIGNADO → CANCELADO.
- ADMIN: cualquier estado salvo FINALIZADO/CANCELADO → CANCELADO.
Las tres usan limpiarViajeActivo (cancelacion.service.js): detiene ETA +
limpia Redis.

## WebSockets — eventos

| Evento                     | Destinatario                              |
|----------------------------|-------------------------------------------|
| viaje:disponible           | Conductores elegibles (socket directo)    |
| viaje:conductor_asignado   | Ganador + cliente (room personal)         |
| viaje:ya_asignado          | Conductor que llego tarde                 |
| viaje:no_disponible        | Room viaje:{id}                           |
| viaje:iniciado             | Cliente (room personal) — NUEVO           |
| conductor:ubicacion        | conductor → servidor                      |
| mapa:actualizar            | Room viaje:{id}                           |
| costo:actualizar           | Room viaje:{id} (~60s)                    |
| eta:actualizar             | Room viaje:{id} (30s)                     |
| ruta:recalculada           | Room viaje:{id}                           |
| alerta:desvio / alerta:parada | Room viaje:{id}                        |
| viaje:estado_cambiado      | Room viaje:{id}                           |
| viaje:finalizado           | Room viaje:{id}                           |
| viaje:cancelado_por_admin  | Room viaje:{id} + cliente                 |

## Redis — Keys de GPS
gps:{id_viaje}:ultima, :historial, :ruta, :acumulado, :pings_detenido,
:eta, :ultimo_recalculo, :pings_desviado
limpiarGPS borra todas. Se llama al finalizar y en toda cancelacion.

## Variables de entorno relevantes a esta tarea
VENTANA_INICIO_MINUTOS=30
PUNTUALIDAD_TARDE_MINUTOS=30
PUNTUALIDAD_MUY_TARDE_MINUTOS=120
(mas todas las existentes: DATABASE_URL, FIREBASE_*, REDIS_URL,
GOOGLE_MAPS_API_KEY, R2_*, QR_SECRET, TARIFA_*, FEE_PORCENTAJE, etc.)

## Deploy
- Railway: production (main) / staging (develop)
- DB Neon COMPARTIDA entre ambos. Redis separado por environment.
- Firebase compartido.

## Comandos
npm run dev / npm run lint / npm run test
node scripts/test-fase5.js
node scripts/test-cancelacion-conductor.js
node scripts/test-cancelacion-cliente.js
node scripts/test-admin.js
node scripts/test-iniciar-viaje.js (nuevo, esta tarea)
node scripts/consola-manual.js (herramienta de prueba manual, interactiva —
  requiere CLIENTE_EMAIL/PASSWORD, CONDUCTOR_EMAIL/PASSWORD,
  FIREBASE_WEB_API_KEY, API_URL en .env)

## Herramienta de prueba manual (consola-manual.js)

No depende de mobile ni de web. Loguea un cliente y un conductor de
prueba, conecta dos sockets, y expone un menu (crear / aceptar / iniciar
/ ping GPS / cambiar estado / confirmar parada / cancelar conductor /
cancelar cliente / ver estado) para probar el flujo completo de un viaje
a mano contra staging.

No corre en CI — es interactivo, uso manual, local. Vive en scripts/,
fuera de los globs de lint y test.

Requiere socket.io-client como devDependency (unica excepcion a "no
instalar dependencias" para archivos en scripts/).