# Contrato — extracto de lo que toca "finalizar viaje"

Copia textual de `context/api-contracts/context.md` del repo del dashboard (26-10-2026), **corregida por
el backend el 27-10-2026** con lo que reportó `HALLAZGOS.md` (radio, eventos de la última salida, payload
de `viaje:estado_cambiado`), el pedido del front del 20-10-2026 (motivo, descripción, sin condiciones) y
la Tarea 5 (cierre sin "Salir"). El contrato completo es `API.md` en la raíz del backend.

Si algo de acá no coincide con lo que hace el backend, la discrepancia se reporta; no se "arregla" el test
para que pase. **Regla del backend: cualquier cambio en el ciclo del viaje interno actualiza este archivo
y `sim-finalizar-viaje.mjs` en el mismo PR.**

### Pedido del front 20-10-2026 (viajes de PyME)

1. **`motivo` obligatorio** al crear un viaje (`POST /api/organizaciones/:id/viajes`) y una serie: texto
   libre, se guarda sin espacios en los bordes, **1 a 120** caracteres.
2. **`descripcion` obligatoria** con la misma regla, **1 a 500** caracteres.
3. **Sin condiciones especiales**: `condiciones_requeridas` ya no se pide, no se valida (crear, confirmar,
   reasignar, editar, series) y **no se devuelve** en los viajes y series de la PyME ni en los del chofer
   (REST y sockets). Si un cliente viejo la manda, se ignora sin error. Un viaje viejo con condiciones
   guardadas se confirma con cualquier vehículo propio. (Las condiciones del **vehículo** siguen existiendo
   en `/api/conductores/mis-vehiculos`: son del marketplace.)
4. **Editar** (`PUT`): `motivo` y `descripcion` son opcionales en el body, pero el viaje tiene que
   **quedar** con los dos. Un viaje viejo sin motivo se lee, se cancela y **se reasigna**, pero no se
   edita sin mandarlo. `null` o vacío → 400.
5. `motivo` vuelve en el detalle y la lista de la PyME, el detalle y la lista del chofer, y en
   `viaje:asignado` / `viaje:editado` / `serie:asignada`.

```json
POST /api/organizaciones/:id/viajes
{
  "id_conductor": 12,
  "fecha_programada": "2026-11-03T13:00:00.000Z",
  "paradas": [{ "lat": -34.6083, "lng": -58.3712, "direccion": "Plaza de Mayo, CABA" }, { "id_lugar": 4 }],
  "motivo": "Reposición sucursal Pilar",
  "descripcion": "Portón azul, tocar timbre"
}
```

| Status | Body | Causa |
|---|---|---|
| 400 | `{ "error": "motivo es requerido" }` | Falta `motivo` |
| 400 | `{ "error": "motivo no puede estar vacio" }` | Vacío o solo espacios |
| 400 | `{ "error": "motivo puede tener como máximo 120 caracteres" }` | Más de 120 |
| 400 | `{ "error": "descripcion es requerida" }` / `"descripcion no puede estar vacia"` / `"descripcion puede tener como máximo 500 caracteres"` | Ídem descripción |
| 400 | `{ "error": "El viaje no tiene motivo: completalo para poder editarlo" }` (o `descripcion`, o `motivo ni descripcion: completalos…`) | `PUT` de un viaje viejo sin mandar lo que le falta |

### Cambio de contrato para mobile (viajes de PyME)

Para medir la llegada y la salida de **cada** parada, el ciclo en curso cambió:

1. **Botón "Salir" en cada parada:** [`POST /api/choferes/viajes/:id/salir`](#post-apichoferesviajesidsalir)
   (sin body). Iniciar = llegaste a la parada 1; "Salir" = te vas de la parada en la que estás.
2. **Confirmar parada** = llegaste a la **siguiente** parada (solo en `EN_RUTA`, en orden). Pasa a
   `DESCARGANDO`, que ahora significa "en una parada" (carga o descarga).
3. **Confirmar la última ya NO finaliza el viaje**: lo finaliza "Salir" de la última.
4. **`PATCH /api/viajes/:id/estado` ya no aplica** a viajes de PyME: responde `400`.

```
iniciar (parada 1) → CARGANDO ─salir→ EN_RUTA ─confirmar parada 2→ DESCARGANDO ─salir→ EN_RUTA ─ … ─confirmar última→ DESCARGANDO ─salir→ FINALIZADO
```

Los viajes del marketplace (legacy) no cambian.

**Paso 4 (lugares y series), también para mobile:**

5. Las paradas que recibe el chofer (REST y sockets) **no** traen `id_lugar` ni `lugar`: solo
   dirección y coordenadas. Nada cambia en cómo se muestran.
6. Una [serie](#series-de-viajes) genera muchos viajes de una vez y el chofer recibe **un solo**
   evento [`serie:asignada`](#websocket--serieasignada-y-seriecancelada) con todos (no un
   `viaje:asignado` por cada uno). Los viajes de una serie se listan, confirman y rechazan **uno por
   uno** como cualquier otro, y traen `id_serie` (null en un viaje suelto).

---

## Viaje interno — la PyME asigna, el chofer confirma (Paso 2)

Ciclo nuevo del viaje: una **PyME** crea el viaje y lo asigna **directo** a un chofer vinculado; el
chofer lo **confirma** (eligiendo con qué vehículo) o lo **rechaza**, lo **inicia en el origen** y lo
ejecuta. Reemplaza al marketplace, que queda dormido (ver [Flags](#flags--lo-que-queda-dormido)).

**Estados del ciclo:**

```
ASIGNADO ──confirmar──▶ CONFIRMADO ──iniciar──▶ CARGANDO ──salir──▶ EN_RUTA ◀──salir── DESCARGANDO ──salir (última)──▶ FINALIZADO
                                                                       └──confirmar parada──▶┘
   │  ▲                     │  │
   │  └──reasignar/editar───┘  │
   ├──rechazar──▶ RECHAZADO    │
   ├──────────────────────────┴──▶ VENCIDO   (la ventana de inicio cerró)
   └── cancelar ──▶ CANCELADO   (desde cualquier estado no final; el chofer solo antes de iniciar)
```

Finales: `RECHAZADO`, `VENCIDO`, `CANCELADO`, `FINALIZADO`. No existe `EN_CAMINO_A_ORIGEN`: el chofer
inicia el viaje **estando en el origen** y pasa directo a `CARGANDO`. Desde el Paso 3 el viaje en curso
se recorre **parada por parada** (ver [Cambio de contrato para mobile](#cambio-de-contrato-para-mobile))
y `PATCH /api/viajes/:id/estado` no aplica a estos viajes.

| Desde | Hacia | Quién | Cómo |
|---|---|---|---|
| — | `ASIGNADO` | PyME | [`POST /api/organizaciones/:id/viajes`](#post-apiorganizacionesidviajes) |
| `ASIGNADO` | `CONFIRMADO` | Chofer | [`POST /api/choferes/viajes/:id/confirmar`](#post-apichoferesviajesidconfirmar) |
| `ASIGNADO` | `RECHAZADO` | Chofer | [`POST /api/choferes/viajes/:id/rechazar`](#post-apichoferesviajesidrechazar) |
| `ASIGNADO` / `CONFIRMADO` | `ASIGNADO` | PyME | reasignar o editar (si estaba `CONFIRMADO`, hay que reconfirmar) |
| `CONFIRMADO` | `CARGANDO` | Chofer | [`POST /api/choferes/viajes/:id/iniciar`](#post-apichoferesviajesidiniciar) (única forma) |
| `CARGANDO` / `DESCARGANDO` | `EN_RUTA` | Chofer | salir de la parada actual ([`POST /api/choferes/viajes/:id/salir`](#post-apichoferesviajesidsalir)) |
| `EN_RUTA` | `DESCARGANDO` | Chofer | llegar a la **siguiente** parada ([`POST /api/viajes/:id/confirmar-parada`](#post-apiviajesidconfirmar-parada)) |
| `DESCARGANDO` | `FINALIZADO` | Chofer | salir de la **última** parada (`POST /api/choferes/viajes/:id/salir`) |
| `DESCARGANDO` | `FINALIZADO` | PyME | [`POST /api/organizaciones/:id/viajes/:idViaje/finalizar`](#post-apiorganizacionesidviajesidviajefinalizar-tarea-5) (Tarea 5): llegó a la última y pasó la hora prevista de fin, o el GPS detectó la salida |
| `CARGANDO` / `EN_RUTA` / `DESCARGANDO` | `FINALIZADO` | Sistema | cierre automático a fin del día (Tarea 5; si no llegó a la última, `incompleto`) |
| `ASIGNADO` / `CONFIRMADO` | `CANCELADO` | Chofer, PyME, admin | cancelar, o desvincular al chofer |
| `CARGANDO` / `EN_RUTA` / `DESCARGANDO` | `CANCELADO` | PyME, admin | el chofer **no** puede cancelar en curso |
| `ASIGNADO` / `CONFIRMADO` | `VENCIDO` | Sistema | la ventana de inicio cerró |

**Ventana de inicio.** El chofer puede iniciar entre `fecha_programada − VENTANA_INICIO_ANTES_MINUTOS`

---

### POST /api/choferes/viajes/:id/iniciar

El chofer inicia el viaje **en el origen**. `CONFIRMADO` → **`CARGANDO`** (directo, no hay
`EN_CAMINO_A_ORIGEN`). `fecha_inicio` y `fecha_llegada_origen` quedan en este instante; la
`puntualidad_inicio` se calcula en el read contra `fecha_programada`.

**Autenticación:** Requerida — rol `CONDUCTOR`, el chofer asignado.

**Body:** `{ "lat": -34.6037, "lng": -58.3816 }` — la posición actual del celular (la misma fuente que
`confirmar-parada`).

Valida las dos cosas y, si fallan, el `400` dice cuál (o las dos):
- estar dentro de la **ventana de inicio**;
- estar a ≤ `RADIO_CONFIRMACION_METROS` (**200 m en staging y production**; 50 m es el default de código) de la **primera parada** (el origen).

**Respuesta exitosa — 200** (real):
```json
{
  "mensaje": "Viaje iniciado",
  "id_viaje": 883,
  "estado": "CARGANDO",
  "fecha_inicio": "2026-10-09T21:36:15.690Z",
  "fecha_llegada_origen": "2026-10-09T21:36:15.690Z",
  "id_parada": 1787,
  "llegada_real": "2026-10-09T21:36:15.690Z"
}
```
Iniciar es también la **llegada a la parada 1** (`llegada_real`; queda confirmada). Recién después de
este `200` el mobile tiene que arrancar el GPS (`conductor:ubicacion`). Los pings de un viaje `ASIGNADO`
o `CONFIRMADO` se rechazan con `error { "error": "El viaje no fue iniciado" }`. Después se recorre parada
por parada con [`salir`](#post-apichoferesviajesidsalir) y
[`confirmar-parada`](#post-apiviajesidconfirmar-parada).

**Errores posibles** (reales):
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{"error": "No podes iniciar el viaje: el viaje solo puede iniciarse a partir de las 01:02"}` | Antes de la ventana |
| 400 | `{"error": "No podes iniciar el viaje: estas a 1112m del origen y debes estar a menos de 200m"}` | Lejos del origen |
| 400 | `{"error": "No podes iniciar el viaje: el viaje solo puede iniciarse a partir de las 01:02; estas a 1112m del origen y debes estar a menos de 200m"}` | Las dos cosas |
| 400 | `{"error": "La ventana para iniciar el viaje cerro a las 22:53; el viaje vencio"}` | La ventana cerró (el viaje queda `VENCIDO`) |
| 400 | `{ "error": "Tenes que confirmar el viaje (elegir el vehiculo) antes de iniciarlo" }` | Sigue `ASIGNADO` |
| 404 | `{ "error": "Viaje no encontrado" }` | No es su viaje |
| 409 | `{ "error": "Ya tenes un viaje en curso (#2701): terminalo antes de iniciar otro" }` | **Tarea 5:** el chofer ya tiene otro viaje en `CARGANDO` / `EN_RUTA` / `DESCARGANDO` (de cualquier PyME). Se chequea **antes** que la ventana y la distancia |
| 409 | `{ "error": "El viaje cambio de estado mientras se procesaba tu pedido: volve a cargarlo" }` | Carrera (lo cancelaron o lo desvincularon en ese instante) |

Emite `viaje:iniciado` y `viaje:estado_cambiado` (`CONFIRMADO → CARGANDO`) a la PyME.

---

### POST /api/choferes/viajes/:id/salir

El chofer **sale de la parada en la que está** (Paso 3). Sin body. Guarda `salida_real` y el peón real
de esa parada.

- Desde `CARGANDO` (parada 1) o `DESCARGANDO` (cualquier otra) → **`EN_RUTA`** si quedan paradas.
- Desde la **última** parada → **`FINALIZADO`**: el cierre de siempre (precio real, remito, distancia
  real) más los tiempos reales. Emite `viaje:finalizado`.
- No valida proximidad: salir es irse.

**Autenticación:** Requerida — rol `CONDUCTOR`, el chofer asignado.

**Respuesta exitosa — 200** (real, quedan paradas):
```json
{
  "mensaje": "Saliste de la parada",
  "id_viaje": 883,
  "id_parada": 1787,
  "estado": "EN_RUTA",
  "salida_real": "2026-10-09T21:36:19.192Z",
  "viaje_finalizado": false
}
```
**Respuesta exitosa — 200** (real, era la última):
```json
{
  "mensaje": "Viaje finalizado",
  "id_viaje": 883,
  "id_parada": 1788,
  "estado": "FINALIZADO",
  "salida_real": "2026-10-09T21:36:23.652Z",
  "viaje_finalizado": true,
  "precio_real": 6.013888888888889,
  "remito_url": "https://pub-259e35cb295345b4b029cc3b28a349e8.r2.dev/remitos/883.pdf",
  "estimado": {
    "manejo_horas": 0.2297222222222222,
    "peon_horas": 1,
    "total_horas": 1.2297222222222222,
    "distancia_km": 4.322
  },
  "real": {
    "manejo_horas": 0.0009533333333333334,
    "peon_horas": 0.001258333333333333,
    "total_horas": 0.0022116666666666665,
    "distancia_km": 2.141186210529206
  }
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "No estas en ninguna parada: confirma la llegada a la siguiente antes de salir" }` | El viaje está `EN_RUTA` |
| 400 | `{ "error": "No se puede salir de una parada en un viaje en estado CONFIRMADO" }` | No está en curso |
| 404 | `{ "error": "Viaje no encontrado" }` | No es su viaje |
| 409 | `{ "error": "El viaje ya fue cerrado por la empresa" }` / `"El viaje ya fue cerrado automaticamente"` | **Tarea 5:** lo cerró la PyME o el cierre automático |
| 409 | `{ "error": "El viaje cambio de estado mientras se procesaba tu pedido: volve a cargarlo" }` | Carrera (doble "salir", o lo cancelaron en ese instante) |

**Eventos:** si quedan paradas, `viaje:estado_cambiado` (`CARGANDO`/`DESCARGANDO` → `EN_RUTA`, con
`id_parada`) a la PyME. **Salir de la última NO emite `viaje:estado_cambiado`: emite solo
`viaje:finalizado`** (a la PyME, a la sala del viaje y al chofer). La respuesta de la última trae además
`origen_salida` (`CHOFER`, o `GPS` si el GPS ya había detectado la salida antes del toque).

Secuencia completa de `viaje:estado_cambiado` en un viaje de 3 paradas:
`CONFIRMADO→CARGANDO · CARGANDO→EN_RUTA · EN_RUTA→DESCARGANDO · DESCARGANDO→EN_RUTA · EN_RUTA→DESCARGANDO`.

### WebSocket — `viaje:estado_cambiado` (viaje de PyME)

```json
{ "id_viaje": 883, "estado_anterior": "EN_RUTA", "estado_nuevo": "DESCARGANDO", "id_parada": 1788 }
```
Siempre con `estado_anterior`, `estado_nuevo` e `id_parada` (la parada a la que llegó o de la que salió).
No trae `estado`.

---

### POST /api/organizaciones/:id/viajes/:idViaje/finalizar (Tarea 5)

La PyME **finaliza a mano** un viaje cuyo chofer no tocó "Salir" en la última parada. Sin body. Cualquier
miembro, también con la PyME suspendida. Solo si el chofer **llegó a la última parada** y además pasó la
**hora prevista de fin** (`llegada_real` de la última + su peón estimado) o el GPS **detectó la salida** de
la última. El precio se corta en la salida detectada o en la hora prevista.

| Status | Body | Causa |
|---|---|---|
| 200 | `{ "estado": "FINALIZADO", "cerrado_por": "ORGANIZACION", "precio_real", "remito_url", "salida_real", "origen_salida", "peon_medido", "fecha_corte_precio", "estimado", "real" }` | OK |
| 400 | `{ "error": "No se puede finalizar un viaje en estado CONFIRMADO" }` | No está en curso |
| 409 | `{ "error": "El chofer todavia no llego a la ultima parada: no se puede finalizar el viaje" }` | No llegó a la última |
| 409 | `{ "error": "Todavia no se puede finalizar: el cierre manual se habilita a las 15:42 (hora prevista de fin) o cuando el GPS detecte la salida de la ultima parada" }` | Antes de la hora prevista y sin salida detectada |
| 409 | `{ "error": "El viaje ya fue cerrado por el chofer" }` (o `por la empresa`, `automaticamente`) | Ya está `FINALIZADO` |

Además: el viaje se **cierra solo** a fin del día (23:59:59 de Buenos Aires del día de inicio; si la hora
prevista cae después, la prevista + `CIERRE_EXTENSION_MINUTOS`), completo o incompleto.

**Bloque `cierre` en el detalle y las listas** (PyME y chofer):
```json
"cierre": {
  "cerrado_por": null,
  "incompleto": false,
  "cierre_manual_desde": "2026-10-27T18:42:00.000Z",
  "cierre_manual_habilitado": false,
  "motivo_habilitacion": null,
  "hora_prevista_fin": "2026-10-27T18:42:00.000Z",
  "salida_detectada": null,
  "cierre_automatico_en": "2026-10-28T02:59:59.000Z",
  "fecha_corte_precio": null
}
```
`cerrado_por`: `CHOFER` | `ORGANIZACION` | `AUTOMATICO` (null mientras está abierto).

**`viaje:finalizado`** (PyME + sala del viaje + chofer) suma `cerrado_por`, `incompleto`,
`paradas_no_visitadas` (ids) y `fecha_corte_precio` a lo de siempre (`precio_real`, `remito_url`,
`estimado`, `real`, `paradas`). En el flujo normal: `cerrado_por: "CHOFER"`, `incompleto: false`,
`paradas_no_visitadas: []`.

---


---

### POST /api/viajes/:id/confirmar-parada

> **Viajes de PyME (ciclo por parada, Paso 3):** confirmar es **llegar a la siguiente parada**. Solo en
> `EN_RUTA`, solo la siguiente en orden, y pasa a `DESCARGANDO` (guarda `llegada_real` y el manejo real
> del tramo). **Confirmar la última ya no finaliza:** lo hace [`salir`](#post-apichoferesviajesidsalir).
> La parada 1 queda confirmada al iniciar. Orden de validaciones: viaje `404` → chofer `403` → parada
> ajena `400` → ya confirmada `400` → estado `400` → **no es la siguiente `400`** → distancia `400`.
> Respuesta real:
> ```json
> {"confirmada": true, "viaje_finalizado": false, "id_viaje": 883, "id_parada": 1788, "estado": "DESCARGANDO", "llegada_real": "2026-10-09T21:36:22.624Z"}
> ```
> Errores nuevos (reales): `400 {"error": "Todavia estas en una parada: toca \"Salir\" antes de confirmar la siguiente"}` (está en una parada:
> primero "Salir") y `400 {"error": "Primero tenes que confirmar la parada 2"}` (salteó una).
> **Tarea 5:** si el viaje lo cerró la PyME o el cierre automático → `409 {"error": "El viaje ya fue cerrado por la empresa"}`
> (o `automaticamente`), después del `403` y antes de "parada ajena".
> Lo que sigue describe el ciclo del marketplace, sin cambios.

> **Compartido por los dos ciclos.** Un viaje de PyME confirma sus paradas acá, igual que uno del
> marketplace. Si al confirmar la última parada el viaje ya no está en `EN_RUTA`/`DESCARGANDO` (p. ej.
> la PyME lo canceló en ese instante), responde `409 { "error": "El viaje cambio de estado y no se
> pudo cerrar" }` y el viaje no se finaliza.


El conductor llega a una parada, toca "confirmar" en su app y el backend valida
que su posición GPS esté **dentro de `RADIO_CONFIRMACION_METROS` de esa parada**.
Si era la última parada pendiente, cierra el viaje automáticamente.

> **Cambio de contrato (reemplazo del QR).** Antes el conductor escaneaba un QR
> firmado que el cliente mostraba en pantalla. Ese flujo ya no existe: se eliminó
> `GET /api/viajes/:id/qr-paradas` y el campo `qr_firmado` del body. El
> `id_parada` ahora se toma de las paradas que ya devuelve
> [`GET /api/viajes/:id`](#get-apiviajesid).


**Rol requerido:** `CONDUCTOR` (debe ser el conductor asignado al viaje)


**Body:**
```json
{
  "id_parada": 1,
  "lat": -34.6037,
  "lng": -58.3816
}
```


- `id_parada`: entero positivo. Sale de `paradas[].id_parada` del detalle del viaje.
- `lat`, `lng`: coordenada GPS actual del conductor al momento de confirmar.


**Validaciones en orden.** El orden importa: define qué error ve el conductor
cuando falla más de una condición a la vez.

| # | Condición | Si falla |
|---|-----------|----------|
| 1 | El viaje existe | `404 Viaje no encontrado` |
| 2 | El conductor autenticado es el asignado al viaje | `403 No sos el conductor de este viaje` |
| 3 | La parada pertenece a ese viaje | `400 La parada no pertenece a este viaje` |
| 4 | La parada no está confirmada todavía (`fecha_entrega` en `null`) | `400 La parada ya fue confirmada` |
| 5 | El viaje está en `EN_RUTA` o `DESCARGANDO` | `400 El viaje debe estar en estado EN_RUTA o DESCARGANDO` |
| 6 | `distancia((lat,lng), parada) <= RADIO_CONFIRMACION_METROS` | `400 Estas a Xm de la parada. Debes estar a menos de Ym` |

La distancia se mide con `turf.distance` en metros, la misma función que usan el
tracking GPS y el detector de desvíos.

**El orden de confirmación entre paradas NO se valida:** se puede confirmar la
parada de `orden` 2 antes que la de `orden` 1. Es el comportamiento que ya existía
con el QR. Por eso `duracion_real` toma el **máximo** de las `fecha_entrega` y no
la parada de mayor `orden` — ver [`GET /api/viajes/mis-viajes`](#get-apiviajesmis-viajes).


**Respuesta exitosa — 200 (parada confirmada, quedan pendientes):**
```json
{
  "confirmada": true,
  "viaje_finalizado": false
}
```


**Respuesta exitosa — 200 (última parada → viaje cerrado):**
```json
{
  "confirmada": true,
  "viaje_finalizado": true,
  "precio_real": 1750.00,
  "remito_url": "https://pub.r2.example.com/remitos/42.pdf"
}
```


**Efectos secundarios al cerrar el viaje:**
- La parada queda en estado `ENTREGADO` con `fecha_entrega = now()`
- El viaje pasa a estado `FINALIZADO` con `precio_real` calculado
- Se genera el remito PDF y se sube a Cloudflare R2
- Se emite el evento WebSocket `viaje:finalizado` al room del viaje
- Se eliminan todas las keys GPS de Redis

Si quedan paradas pendientes no se cierra nada: solo se recalcula el ETA hacia la
próxima parada (evento `eta:actualizar`).


**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "La parada no pertenece a este viaje" }` | El `id_parada` es de otro viaje (o no existe) |
| 400 | `{ "error": "La parada ya fue confirmada" }` | La parada ya tiene `fecha_entrega` |
| 400 | `{ "error": "El viaje debe estar en estado EN_RUTA o DESCARGANDO" }` | Estado incorrecto |
| 400 | `{ "error": "Estas a Xm de la parada. Debes estar a menos de 200m" }` | Demasiado lejos de la parada (200 m en staging y production) |
| 400 | `{ "error": "<mensaje de Zod>" }` | Body inválido (falta `id_parada`, `lat`/`lng` no numéricos, etc.) |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CONDUCTOR |
| 403 | `{ "error": "No sos el conductor de este viaje" }` | Conductor diferente al asignado |
| 404 | `{ "error": "Viaje no encontrado" }` | No existe viaje con ese id |

`id_parada` de otro viaje devuelve **400, no 404**: el recurso de la URL (el viaje)
sí existe, y la parada puede existir perfectamente — lo que está mal es la
combinación. La respuesta es la misma exista o no la parada, para no filtrar qué
ids de parada existen en viajes ajenos.


<a id="radio-de-confirmacion"></a>
#### Radio de confirmación

`RADIO_CONFIRMACION_METROS` — variable de entorno. **En staging y production vale 200**
(seteada en Railway); el default de código, si no está, es 50. Vale para `iniciar` (distancia
al origen) y para `confirmar-parada`.

Es configurable sin redeploy porque 50 m es agresivo para GPS urbano entre
edificios altos. El "cerca" del simulador (~20 m) entra con cualquiera de los dos valores.


---



---

## WebSockets — GPS en tiempo real (Fase 4)

### Evento: conductor:ubicacion

**Dirección:** conductor → servidor  
**Quién lo emite:** el conductor durante el viaje activo  
**Cuándo:** cada ~15 segundos mientras el conductor está en movimiento

**Payload a emitir:**
```json
{
  "id_viaje": 42,
  "lat": -34.6037,
  "lng": -58.3816,
  "timestamp": 1746700000000
}
```

- `timestamp`: milisegundos desde epoch (`Date.now()`)

**Cómo emitirlo:**
```js
socket.emit('conductor:ubicacion', {
  id_viaje: 42,
  lat: -34.6037,
  lng: -58.3816,
  timestamp: Date.now()
});
```

**Validaciones del servidor (en orden):**
1. El usuario debe tener rol `CONDUCTOR`.
2. `id_viaje`, `lat`, `lng` y `timestamp` deben estar presentes y ser numéricos.
3. **Rango geográfico válido:** `lat` en `[-90, 90]` y `lng` en `[-180, 180]`. Un ping fuera
   de rango se descarta **antes** de tocar Redis o acumular distancia (no contamina el costo
   ni la posición guardada).
4. **Solo el conductor asignado al viaje puede enviar pings de ese viaje.** Un conductor
   autenticado distinto al asignado no puede falsificar posición/distancia ni disparar alertas
   en un viaje ajeno. Lo mismo aplica si el viaje no existe.
5. **El viaje tiene que estar iniciado.** Los pings solo se aceptan desde `EN_CAMINO_A_ORIGEN`
   en adelante (`EN_CAMINO_A_ORIGEN`, `CARGANDO`, `EN_RUTA`, `DESCARGANDO`). Un ping de un viaje
   en `CONDUCTOR_ASIGNADO` o `BUSCANDO_CONDUCTOR` se rechaza con el error
   `"El viaje no fue iniciado"` y **no tiene ningún efecto secundario**: no toca Redis
   (`ultima`/`acumulado`/`historial`), no emite `mapa:actualizar` y no arranca el emisor de ETA.

> El viaje se inicia con el botón **Iniciar viaje** (`POST /api/viajes/:id/iniciar`). El flujo
> correcto del mobile es: botón → `200` → recién ahí arrancar el GPS.

Si el viaje ya está `FINALIZADO` o `CANCELADO`, el ping se ignora silenciosamente (sin error).

**Errores (evento `error`):**

A diferencia del resto de los eventos de negocio, los errores de `conductor:ubicacion` se
emiten con la forma `{ "error": "..." }` (no `{ "mensaje": "..." }`):

| Payload del evento `error` | Causa |
|----------------------------|-------|
| `{ "error": "Solo conductores pueden enviar GPS" }` | El usuario no tiene rol `CONDUCTOR` |
| `{ "error": "Datos GPS invalidos" }` | Falta un campo o `lat`/`lng`/`timestamp` no es numérico |
| `{ "error": "Coordenadas fuera de rango" }` | `lat`/`lng` fuera del rango geográfico válido |
| `{ "error": "No autorizado para este viaje" }` | El conductor no es el asignado al viaje, o el viaje no existe |
| `{ "error": "El viaje no fue iniciado" }` | El viaje está en `CONDUCTOR_ASIGNADO` o `BUSCANDO_CONDUCTOR`: falta pulsar **Iniciar viaje** (`POST /api/viajes/:id/iniciar`). El ping se descarta sin efectos |
| `{ "error": "Error interno al procesar ubicacion" }` | Error inesperado del servidor |

**Efectos secundarios en el servidor** (solo con el viaje ya iniciado):
- Guarda coordenada en Redis (historial de últimas 20)
- Acumula distancia y tiempo
- Arranca (si no estaba activo) el emisor periódico de ETA del viaje, que emite `eta:actualizar` cada 30 s al room
- Emite `mapa:actualizar`, y cada ~60 s emite `costo:actualizar`
- Si el viaje está en `EN_RUTA`: verifica desvíos (y recalcula la ruta si corresponde) y paradas sospechosas

---


---

### WebSocket — eventos del viaje interno

**Salas.** Al conectarse, un `CLIENTE` entra a la sala `organizacion:{id}` de su PyME (y se suma o sale
solo al crear la PyME, canjear un código, irse o ser eliminado). El chofer recibe todo por su sala
personal. Todos los payloads traen `id_viaje` e `id_organizacion`.

| Evento | Quién lo recibe | Cuándo |
|---|---|---|
| `viaje:asignado` | PyME + chofer | Al crear, y al chofer nuevo al reasignar. Trae `motivo` y `descripcion`; **no** trae `condiciones_requeridas` |
| `viaje:desasignado` | PyME + chofer anterior | Al reasignar |
| `viaje:editado` | PyME + chofer | Al editar. `confirmacion_anulada: true` si estaba `CONFIRMADO` |
| `viaje:confirmado` | PyME | El chofer confirma |
| `viaje:rechazado` | PyME | El chofer rechaza |
| `viaje:iniciado`, `viaje:estado_cambiado`, `viaje:finalizado` | PyME (y `finalizado` también al chofer) | Iniciar, salir, confirmar parada, cierre. `estado_cambiado` trae `estado_anterior`, `estado_nuevo` e `id_parada` (la última salida no lo emite); `finalizado` trae `estimado`, `real`, `paradas`, `cerrado_por`, `incompleto`, `paradas_no_visitadas` y `fecha_corte_precio` |
| `viaje:cancelado` | PyME + chofer | Cualquier cancelación. `causa`: `CHOFER` / `ORGANIZACION` / `ADMIN` / `DESVINCULACION` |
| `viaje:vencido` | PyME + chofer | Pasó a `VENCIDO`. Trae `estado_anterior` |
| `mapa:actualizar`, `costo:actualizar`, `eta:actualizar`, `alerta:desvio`, `alerta:parada`, `ruta:recalculada` | PyME | Tracking en vivo de sus viajes en curso |
| `serie:asignada` (Paso 4) | PyME + chofer | Al crear una serie: **un** evento con todos sus viajes. Ver [Series](#websocket--serieasignada-y-seriecancelada) |
| `serie:cancelada` (Paso 4) | PyME | Al cancelar una serie (sus viajes no cambian) |
| `parada:salida_detectada` (Tarea 5) | PyME + chofer | El GPS detectó que el chofer se fue de una parada (una vez por parada) |
| `viaje:cierre_habilitado` (Tarea 5) | PyME | Se habilitó el cierre manual: `motivo` `TIEMPO` (pasó la hora prevista) o `GPS` (salida detectada) |

