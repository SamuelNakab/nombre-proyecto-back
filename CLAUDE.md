# Fleter — Backend

## Descripcion del proyecto
Plataforma de fletes para PyMEs argentinas.
El cliente crea un viaje, el sistema lo publica a conductores
elegibles via WebSocket, el primero en aceptar queda asignado.
Fee porcentual por viaje. MVP: CABA + Gran Buenos Aires.

## Estado actual del proyecto
- Fases 0-5 COMPLETAS (registro, viajes, matching, GPS, QR, cierre, remito, calificaciones)
- Gestion de vehiculos de conductores COMPLETO
- Campo descripcion opcional en viajes COMPLETO
- ETA en tiempo real + recalculo de ruta por desvio + ruta_planeada al front COMPLETO
- **En curso: resolucion de bugs detectados en stress tests (B-005, B-001, B-003, B-002)**

## Bugs en resolucion (esta tanda)
Detectados por la bateria de stress tests (scripts/stress/). Se resuelven en
este orden, uno por sesion, cada uno con verificacion automatica:

1. B-005 [CRITICO] — Race condition en viaje:aceptar. Dos conductores que
   aceptan el mismo viaje casi simultaneamente reciben AMBOS
   viaje:conductor_asignado. La transaccion hace findUnique + update sin lock
   de fila, entonces ambas transacciones pasan la validacion. El perdedor
   ademas NO recibe viaje:ya_asignado.
   Archivo sospechoso: src/sockets/matching.socket.js (~122-141).

2. B-001 — Coordenadas GPS fuera de rango (lat=200, lng=500) se guardan en
   Redis. La validacion solo chequea typeof === 'number', no el rango valido.
   Contamina el acumulado de distancia (en el test salto a 4856 km).
   Archivo sospechoso: src/sockets/gps.socket.js (~23-29).
   Resolver esto tambien cierra B-006 (consecuencia directa).

3. B-003 [SEGURIDAD] — Cualquier conductor autenticado puede mandar
   conductor:ubicacion para un viaje que NO es suyo. El handler valida rol
   CONDUCTOR pero no que sea el conductor asignado a ese viaje.
   Archivo sospechoso: src/sockets/gps.socket.js (~14-40).

4. B-002 — ruta:recalculada por desvio no se dispara confiablemente al 2do
   ping desviado consecutivo. Sospecha: el contador gps:{id}:pings_desviado
   en Redis queda contaminado de corridas anteriores o un ping intermedio lo
   resetea. REQUIERE diagnostico con logging antes de aplicar fix.
   Archivo sospechoso: src/services/desvio.service.js (~31-32).

NO se tocan en esta tanda (quedan para mas adelante):
- B-004 (retroceso de estado EN_RUTA → CARGANDO) — espera refactor de
  maquina de estados.
- H-001 (conductor acepta viajes solapados) — espera estructura jerarquica.
- H-002 (mapa:actualizar sin id_viaje) — espera diseño multi-viaje activo.
- H-003 (conductor no se re-une al room tras reconexion) — pendiente.

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
- Hay drift en el historial de migraciones. Usar npx prisma db push para
  cambios de schema hasta que se limpie el historial.
- Nunca usar prisma migrate reset sin autorizacion explicita de Samuel.

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
| eta:actualizar                | servidor → room      | Room viaje:{id_viaje} (cada 30s)            |
| ruta:recalculada              | servidor → room      | Room viaje:{id_viaje} (al recalcular)       |

## Estados del viaje (transiciones validas, lineales)

| Transicion                              | Trigger                                        |
|-----------------------------------------|------------------------------------------------|
| BUSCANDO_CONDUCTOR → CONDUCTOR_ASIGNADO | Conductor acepta (matching atomico)            |
| CONDUCTOR_ASIGNADO → EN_CAMINO_A_ORIGEN | Automatico, primer ping GPS                    |
| EN_CAMINO_A_ORIGEN → CARGANDO          | Manual, conductor via PATCH /viajes/:id/estado |
| CARGANDO → EN_RUTA                     | Manual, conductor via PATCH /viajes/:id/estado |
| EN_RUTA → DESCARGANDO                  | Manual, conductor via PATCH /viajes/:id/estado |
| DESCARGANDO → FINALIZADO               | QR de ultima parada confirmado                 |

La maquina de estados es LINEAL — no se permite retroceso. (La validacion de
retroceso es B-004, pendiente — no se implementa en esta tanda.)

## Elegibilidad de conductores
Un conductor es elegible para un viaje si y solo si:
1. Tiene AL MENOS UN vehiculo (propio o via conductor_vehiculo), Y
2. Al menos uno de esos vehiculos cumple TODAS las condiciones requeridas
   del viaje (si no hay condiciones, basta con tener un vehiculo).
La logica vive exclusivamente en elegibilidad.service.js — no duplicar.

## Logica de viaje:aceptar (matching.socket.js)
1. Validar id_viaje del payload.
2. id_vehiculo opcional: si no viene, auto-seleccionar el primer vehiculo
   elegible del conductor. Si no tiene ninguno: emitir error.
3. La asignacion debe ser ATOMICA: solo un conductor puede ganar un viaje.
   El ganador recibe viaje:conductor_asignado, el cliente tambien (a su room
   personal), el resto del room recibe viaje:no_disponible, y cualquier
   conductor que intento y perdio recibe viaje:ya_asignado.

## GPS / conductor:ubicacion (gps.socket.js)
- Solo el conductor ASIGNADO al viaje puede mandar pings para ese viaje.
- Las coordenadas deben estar en rango: lat -90..90, lng -180..180.
- Primer ping cambia el estado a EN_CAMINO_A_ORIGEN automaticamente.
- Cada ping actualiza Redis y emite mapa:actualizar al room.

## Recalculo de ruta por desvio (desvio.service.js)
- Al 2do ping consecutivo desviado (>DESVIO_UMBRAL_METROS de la ruta),
  con cooldown de RUTA_RECALCULO_COOLDOWN_SEGUNDOS (120s), recalcular ruta
  con Google Maps desde la posicion actual y emitir ruta:recalculada.
- Contador de pings consecutivos en Redis: gps:{id_viaje}:pings_desviado
  (INCR al desviarse, resetear a 0 al volver a la ruta).

## Redis — Keys de GPS
gps:{id_viaje}:ultima           → { lat, lng, timestamp } — expire 2h
gps:{id_viaje}:historial        → lista ultimas 20 coordenadas (LPUSH + LTRIM)
gps:{id_viaje}:ruta             → array [[lng,lat],...] — expire 24h
gps:{id_viaje}:acumulado        → { tiempo_horas, distancia_km, ... } — expire 24h
gps:{id_viaje}:pings_detenido   → contador pings lentos (INCR)
gps:{id_viaje}:eta              → { segundos_eta_api, timestamp_calculo, proxima_parada_id }
gps:{id_viaje}:ultimo_recalculo → timestamp — expire 24h
gps:{id_viaje}:pings_desviado   → contador pings consecutivos desviados

Al finalizar el viaje: limpiarGPS borra TODAS las keys gps:{id_viaje}:*

## Deploy
- Backend: Railway. Script: prisma generate && node src/app.js
- DB: Neon (PostgreSQL serverless) — compartida prod/staging por ahora
- Redis: Railway (servicio por environment)
- Environments: production (branch main) / staging (branch develop)
- Web: Vercel — https://fleter-mu.vercel.app
- CORS: abierto — restringir en pulido
- Branches: main (estable) / develop (trabajo diario)

## Comandos
npm run dev
redis-cli ping
npx prisma studio
node scripts/test-fase5.js
node scripts/test-eta-recalculo.js
node scripts/test-ruta-front.js
node scripts/stress/run-all.js

## Pendientes (fase de pulido / futuro)
- Eliminar timer de cancelacion y MATCHING_TIMEOUT_MINUTOS
- CORS abierto — restringir a dominios conocidos
- Calculo zona MIXTO — usar poligono CABA para separar tiempo/distancia
- Limpiar drift del historial de migraciones Prisma
- B-004: validar retroceso de estados (refactor maquina de estados)
- H-001/H-002/H-003: derivan de la estructura jerarquica (siguiente gran paso)