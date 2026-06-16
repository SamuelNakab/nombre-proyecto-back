# Reporte de stress tests — Fleter backend

Fecha: 2026-06-16
Entorno: localhost:3000, Redis publico Railway (acela.proxy.rlwy.net:10233),
DB Neon, Maps real, R2 real. `NODE_TLS_REJECT_UNAUTHORIZED=0` activo por
certificado corporativo en el medio (no afecta los tests, sí afectaría
producción si quedara así).

> **Nota de pre-vuelo:** este informe se pudo correr después de:
> 1. `node_modules` estaba corrupto (rmdir EPERM). Se borró y reinstaló.
> 2. `REDIS_URL` apuntaba al hostname interno de Railway (`redis.railway.internal`),
>    no resoluble desde local. Se reemplazó por el public endpoint para esta sesión.
> 3. Faltaban `QR_SECRET` y las 5 vars `R2_*` en `.env` (las agregó el usuario).
> 4. Faltan todavía `ETA_RECALCULO_SEGUNDOS`, `ETA_EMISION_SEGUNDOS`,
>    `RUTA_RECALCULO_COOLDOWN_SEGUNDOS`, `TARIFA_*` — el código usa defaults
>    hardcodeados, está OK para correr tests pero conviene completarlo.

---

## 1. Resumen ejecutivo

| Suite                         | Total | ✅ | ❌ bugs | ⚠️ huecos |
|-------------------------------|------:|---:|-------:|---------:|
| `test-fase5.js` (re-corrida)  |    36 | 36 |      0 |        0 |
| `test-eta-recalculo.js` (re-corrida) | 18 | 14 |  4* |        0 |
| `test-ruta-front.js` (re-corrida) | 16 | 14 |  2* |        0 |
| `stress/test-vehiculos-exhaustivo.js` | 13 | 13 | 0 |    0 |
| `stress/test-gps-exhaustivo.js` | 12 | 8 |   3 |        1 |
| `stress/test-cierre-exhaustivo.js` | 17 | 17 | 0 |        0 |
| `stress/test-concurrencia.js` | 11 |  7 |   1 |        3 |
| **TOTAL**                     |  **123** | **109** | **6** (1 crítico) | **4** |

\* Los 6 fallos de los tests de ETA/ruta-front son todos del **mismo hallazgo**:
el segundo ping desviado consecutivo no dispara `ruta:recalculada` con
fiabilidad. Ver bug #B-002.

---

## 2. Cobertura por área

### 2.1 Veh­ículos (13/13 ✅)

| # | Caso | Resultado |
|--:|------|-----------|
| 1 | Crear vehículo con las 5 condiciones | ✅ |
| 2 | Crear vehículo con condiciones vacías | ✅ |
| 3 | Patente duplicada → 409 | ✅ |
| 4 | PUT vehículo ajeno → 403 | ✅ |
| 5 | DELETE inexistente → 404 | ✅ |
| 6 | DELETE en viaje activo → 400 | ✅ |
| 7 | Condición duplicada → 409 | ✅ |
| 8 | Condición inválida → 400 | ✅ |
| 9 | `anio=1980` → 400 | ✅ |
| 10 | `anio=2050` → 400 | ✅ |

Sin hallazgos. Cobertura completa de los 9 escenarios pedidos.

### 2.2 GPS / Fase 4 (8/12)

| # | Caso | Resultado |
|--:|------|-----------|
| 1 | Ping válido → `mapa:actualizar` + estado a `EN_CAMINO_A_ORIGEN` | ✅ |
| 2 | `lat=200, lng=500` no crashea el servidor | ✅ |
| 3 | `lat=200, lng=500` no se guarda en Redis | ❌ **B-001** |
| 4 | 10 pings en 1 s — acumulado existe y no es NaN/Infinity | ✅ (pero ver consecuencia de B-001) |
| 5 | Ping de conductor NO asignado se rechaza | ❌ **B-003** |
| 6 | `CARGANDO → FINALIZADO` directo → 400 | ✅ |
| 7 | Bloqueo de `EN_RUTA → CARGANDO` (retroceso) | ❌ **B-004** |
| 8 | `alerta:desvio` tras pings en Patagonia | ✅ |
| 9 | `alerta:parada` tras 25 pings detenidos | ⚠️ **O-001** (no se emitió — inconcluso) |

### 2.3 Cierre / Fase 5 (17/17 ✅)

| # | Caso | Resultado |
|--:|------|-----------|
| 1 | QR firmado correcto + GPS cercano → 200 | ✅ |
| 2 | QR de otro viaje → 400 | ✅ |
| 3 | Firma HMAC manipulada → 400 | ✅ |
| 4 | GPS lejos (>200m) → 400 con mensaje claro | ✅ |
| 5 | Re-confirmar misma parada → 400 | ✅ |
| 6 | Calificar viaje en `EN_RUTA` → 400 | ✅ |
| 7 | Calificar dos veces → 409 | ✅ |
| 8 | Puntaje 0 / 6 / −1 / 2.5 → 400 todos | ✅ |
| 9 | Remito PDF accesible (HEAD 200) | ✅ |
| 10 | Redis limpiado (8 keys `gps:*`) | ✅ |

Sin hallazgos. Cobertura completa.

### 2.4 Concurrencia y casos extremos (7/11)

| # | Caso | Resultado |
|--:|------|-----------|
| 1 | Un conductor acepta 2 viajes simultáneos | ⚠️ **H-001** (esperado, queda en ambos) |
| 2 | Dos conductores aceptan el mismo viaje | ❌ **B-005 CRÍTICO** |
| 3 | Cliente recibe `mapa:actualizar` de N viajes | ✅ (recibe), ⚠️ **H-002** (sin `id_viaje`) |
| 4 | Performance: 272 pings + REST en paralelo | ✅ (lat. prom 658ms / max 1254ms) |
| 5 | Viaje con `fecha_programada` pasada | ✅ Zod rechaza con 400 (no es un hueco — está cubierto) |
| 6 | Reconexión de socket conductor con viaje activo | ⚠️ **H-003** |

---

## 3. Hallazgos clasificados

### a. BUGS REALES — comportamiento esperado que falla

#### **B-005 [CRÍTICO]** Race condition en `viaje:aceptar` — ambos conductores reciben `conductor_asignado`

**Cómo reproducir:**
1. Crear 1 viaje en `BUSCANDO_CONDUCTOR`.
2. Dos conductores elegibles emiten `viaje:aceptar` con el mismo `id_viaje` casi simultáneamente.
3. **Observado:** ambos reciben `viaje:conductor_asignado`. La DB queda con UN conductor (el último que ejecutó UPDATE), pero el otro conductor cree que ganó.

**Sospecha técnica:** la "transacción atómica" en
[src/sockets/matching.socket.js:122-141](src/sockets/matching.socket.js#L122-L141)
hace `findUnique` y luego `update` dentro de `$transaction`, pero el `findUnique`
no toma lock (no hay `FOR UPDATE`). Las dos transacciones leen el viaje
`BUSCANDO_CONDUCTOR`, las dos ejecutan `update` y ninguna setea
`yaAsignado=true`. Ambos branches emiten el evento.

**Fix sugerido (no aplicado, sólo orientativo):**
```js
const updated = await tx.viaje.updateMany({
  where: { id_viaje, estado: 'BUSCANDO_CONDUCTOR' },
  data: { estado: 'CONDUCTOR_ASIGNADO', id_conductor, id_vehiculo },
});
if (updated.count === 0) { yaAsignado = true; return; }
```
`updateMany` con WHERE compuesto sí es atómico en PostgreSQL (UPDATE con WHERE
es atomic-by-row), y `count` te dice si vos fuiste el ganador.

**Impacto:** en producción, dos conductores van al mismo origen, el cliente recibe el evento `conductor_asignado` con datos del último, el primero sigue creyendo que tiene el viaje. Crítico porque también deja al "perdedor" sin `viaje:ya_asignado`, así que no se entera de que perdió.

---

#### **B-001** Coordenadas GPS fuera de rango se guardan en Redis

**Cómo reproducir:**
1. Conductor con viaje aceptado emite `conductor:ubicacion` con `lat=200, lng=500`.
2. `gps:{id_viaje}:ultima` en Redis contiene exactamente `{"lat":200,"lng":500,"timestamp":...}`.

**Sospecha técnica:** la validación en
[src/sockets/gps.socket.js:23-29](src/sockets/gps.socket.js#L23-L29) sólo
chequea `typeof === 'number'`, no el rango `-90..90` / `-180..180`. Cualquier
número pasa.

**Impacto:** el siguiente ping legítimo calcula distancia desde lat=200 hasta
una coord real → en el test, el acumulado saltó a **4856 km** después del
burst. Esto contamina el cálculo de precio (`tarifa_km * distancia_km`) y la
detección de desvío.

**Fix sugerido:** validar rangos antes del `if (typeof lat !== 'number')`:
```js
if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
  socket.emit('error', { error: 'Coordenadas fuera de rango' });
  return;
}
```

---

#### **B-002** `ruta:recalculada` por desvío no se dispara confiablemente al 2º ping consecutivo

**Cómo reproducir:** correr `node scripts/test-eta-recalculo.js` o
`node scripts/test-ruta-front.js`. El test envía 2 pings desviados
consecutivos y espera `ruta:recalculada`. En múltiples corridas:
- `test-eta-recalculo.js`: 0 recálculos en el momento esperado, luego 1
  tardío durante la ventana de "cooldown".
- `test-ruta-front.js`: 0 recálculos.

**Sospecha técnica:** en
[src/services/desvio.service.js:31-32](src/services/desvio.service.js#L31-L32)
se hace `INCR gps:{id}:pings_desviado` y luego `expire`. Si la key llega de una
corrida anterior (no se borró), o si llega un ping intermedio que pasa por
`!desvio.desviado` y la borra, el contador se resetea sin avisar. Las paradas
intermedias entre pings, o el ruido de la API de Maps al calcular el
`nearestPointOnLine`, pueden estar resetando.

**Impacto:** los desvíos se siguen detectando (`alerta:desvio` sí llega), pero
la ruta no se recalcula → el front sigue mostrando la ruta vieja y el ETA se
recalcula contra una ruta incorrecta. Funcionalidad clave de la sesión actual
de "pulido" no funciona end-to-end.

**Para investigar:** correr el server con logging extra dentro de
`manejarDesvio` y revisar el valor de `consecutivos` en cada ping.

---

#### **B-003** Cualquier conductor puede mandar pings GPS para un viaje ajeno

**Cómo reproducir:**
1. Conductor A acepta viaje X.
2. Conductor B (autenticado) emite `conductor:ubicacion` con `id_viaje: X`.
3. El servidor procesa el ping, actualiza Redis y emite `mapa:actualizar` al
   room del viaje.

**Sospecha técnica:** [src/sockets/gps.socket.js:14-40](src/sockets/gps.socket.js#L14-L40)
sólo verifica que `socket.data.usuario.rol === 'CONDUCTOR'`, no que el
`id_usuario` del socket coincida con el `id_conductor` asignado al viaje.

**Impacto:** un conductor malicioso autenticado puede inyectar GPS arbitrario en
cualquier viaje activo de otro conductor, falsificando posición, contaminando
distancia/precio y disparando alertas falsas. Es un agujero de seguridad real,
no solo un hueco de feature.

**Fix sugerido:** agregar al inicio del handler:
```js
const viaje = await prisma.viaje.findUnique({ where: { id_viaje } });
const conductor = await prisma.conductor.findUnique({
  where: { id_usuario: socket.data.usuario.id_usuario }
});
if (!viaje || viaje.id_conductor !== conductor?.id_conductor) return;
```

---

#### **B-004** Backend permite el retroceso de estado `EN_RUTA → CARGANDO`

**Cómo reproducir:**
1. Viaje en estado `EN_RUTA`.
2. Conductor: `PATCH /api/viajes/:id/estado { estado: 'CARGANDO' }` → 200.

**Sospecha técnica:** [src/controllers/viajes.controller.js:250-282](src/controllers/viajes.controller.js#L250-L282).
El Zod schema acepta los tres valores `'CARGANDO' | 'DESCARGANDO' | 'EN_RUTA'` y
no valida la transición. La tabla de transiciones de CLAUDE.md indica que
`CARGANDO → EN_RUTA → DESCARGANDO` es lineal — no debería poder volver atrás.

**Impacto:** el conductor podría manipular el estado para evitar la confirmación
final por QR. Probablemente no exploit grave (el QR igual se necesita para
finalizar), pero rompe la consistencia del modelo.

**Severidad:** baja-media. Puede esperar a refactor de máquina de estados.

---

#### **B-006** El handler GPS levanta el `iniciarEmisorEta` y procesa rutas incluso después de un ping inválido

Subconsecuencia de B-001: después de un ping `lat=200/lng=500`, el siguiente
ping legítimo entra al cálculo con una `ultima` corrupta y los servicios de
ETA / desvío reciben distancias absurdas. Se resuelve solo si se aplica B-001.
No lo cuento aparte en el total, sólo lo dejo asentado para no perderlo.

### b. HUECOS CONOCIDOS (features pendientes, no son bugs)

#### **H-001** Un conductor puede aceptar viajes solapados

Confirmado: el mismo conductor `id=4` quedó asignado en DB a los viajes 35 y 36
al emitir `viaje:aceptar` para ambos casi simultáneamente. **Esperado**: CLAUDE.md
y el brief lo marcan como pendiente de la estructura jerárquica futura.

#### **H-002** `mapa:actualizar` no incluye `id_viaje`

El cliente recibió `mapa:actualizar` de los 2 viajes simultáneos
(5 eventos cada uno), pero el payload no incluye `id_viaje` —
[src/sockets/gps.socket.js:62-67](src/sockets/gps.socket.js#L62-L67). El front
no puede distinguir cuál ping corresponde a qué viaje si el cliente tiene
varios activos. Fácil de arreglar (1 línea), pero no es un bug del flujo
actual MVP de 1 viaje a la vez.

#### **H-003** El conductor no se re-une a `viaje:{id}` tras reconectar

Tras desconexión + reconexión de socket, el conductor con viaje activo no
recibió `mapa:actualizar` aunque siga enviando pings — el ping en sí se
procesa, pero el `io.to(room).emit` no le llega porque ya no está suscripto al
room. Solo el room personal `usuario:{id_usuario}` se re-une automáticamente.
Falta lógica para que al conectar/reconectar el conductor se re-suscriba a los
viajes activos donde es `id_conductor`. Marcado como hueco porque CLAUDE.md no
documenta este caso.

### c. OBSERVACIONES (no bugs, no huecos)

#### **O-001** `alerta:parada` no se emitió en el test

Mandé 25 pings consecutivos casi en la misma coordenada y no recibí
`alerta:parada` en el cliente. El cálculo en
[src/services/parada.service.js:11-25](src/services/parada.service.js#L11-L25)
es `contador * 15s` (asume un ping cada 15s real), pero el test los manda en
~120ms cada uno. Con 25 pings, deberían acumular `25 * 15s / 60 = 6.25 min`,
mayor al umbral de 5 min. No descarto un bug, pero también puede ser que el
campo `velocidad_kmh` calculado en el burst entre coords casi-iguales con
timestamps casi-iguales produzca NaN/Infinity y rompa la rama. Inconcluso —
necesita un test con timestamps más realistas o instrumentación temporal.

#### **O-002** `NODE_TLS_REJECT_UNAUTHORIZED=0` requerido en este entorno

El entorno local tiene un certificado corporativo en el medio que rompe
- `prisma generate` (descarga de query engine)
- el upload a R2 desde el servidor (TLS hacia `*.r2.cloudflarestorage.com`)
- los fetches a la API de Maps desde el servidor en algunos casos

No es un bug del backend pero **importante**: si llegara a producción con esa
env var seteada, sería un riesgo de seguridad serio.

#### **O-003** Performance OK bajo carga

272 pings GPS en ~14s, mientras un endpoint REST (`GET /mis-viajes`) responde
con latencia promedio de **658 ms** y máxima de **1254 ms**. Aceptable para MVP
pero **alto para una API de listado simple** — sospecho que la combinación de
`fetchSockets()` recurrente más Redis remoto (Railway, no local) más Neon
(serverless, cold-cache en queries esporádicas) es la causa. No es bug;
queda como nota para optimización.

---

## 4. Archivos creados / modificados

- `scripts/stress/_helpers.js` — helpers reutilizables (auth, api, socket)
- `scripts/stress/test-vehiculos-exhaustivo.js` — Parte 2A
- `scripts/stress/test-gps-exhaustivo.js` — Parte 2B
- `scripts/stress/test-cierre-exhaustivo.js` — Parte 2C
- `scripts/stress/test-concurrencia.js` — Parte 3
- `scripts/stress/run-all.js` — runner que corre los 4 y produce reporte tabular
- `scripts/stress/REPORTE.md` — este archivo

No se modificó ningún archivo de `src/`, ni `prisma/`, ni endpoints.

## 5. Cómo re-correr los tests

Requisito: el servidor debe estar levantado en `localhost:3000` con conexión
a Redis funcional. En este entorno se levantó con:

```powershell
$env:REDIS_URL="redis://default:***@acela.proxy.rlwy.net:10233"
$env:NODE_TLS_REJECT_UNAUTHORIZED="0"
node src/app.js
```

Y los tests:

```powershell
$env:REDIS_URL="redis://default:***@acela.proxy.rlwy.net:10233"
$env:NODE_TLS_REJECT_UNAUTHORIZED="0"
node scripts/stress/run-all.js
```

## 6. Prioridad sugerida de fixes

1. **B-005 (crítico)** — race condition de matching. Esto va a producción y la
   gente se va a quejar.
2. **B-003** — autorización en `conductor:ubicacion`. Es un agujero de seguridad.
3. **B-002** — `ruta:recalculada` poco confiable. Es la feature en curso de
   "pulido" — ya estás en el contexto.
4. **B-001** — validación de rango GPS. Trivial de arreglar, evita corrupción
   del acumulado.
5. **B-004** y **H-2** — pueden esperar al refactor de máquina de estados y al
   diseño de "multi-viaje activo" respectivamente.
