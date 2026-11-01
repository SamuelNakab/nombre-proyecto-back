# AGENTS.md — Simulador del front (Fleter)

Instrucciones para un agente de código que trabaja en el **backend de Fleter**. Este paquete lo armó el
equipo del dashboard web para probar el ciclo del viaje de PyME **sin front**: crea sus propias cuentas,
saca el token de Firebase por REST y simula la ubicación del chofer. Vive en `e2e/sim/` y corre en CI
(job `e2e-staging`, paso "Simulador del front") después del deploy a staging.

## Qué hay

| Archivo | Para qué |
|---|---|
| `sim-finalizar-viaje.mjs` | Recorrido completo en Node, con GPS por socket.io y escucha de eventos de la PyME y del chofer. **La prueba principal.** |
| `postman/fleter-finalizar-viaje.postman_collection.json` | El mismo recorrido por REST (sin GPS), con tests en cada request. |
| `CONTRATO-FINALIZAR.md` | Extracto del contrato de la API: lo que se verifica. |
| `HALLAZGOS.md` | La corrida del front contra staging (26-10-2026) y cómo se resolvió cada diferencia. |
| `README.md` | Lo mismo que este archivo, para una persona. |

## Qué verifica

```
ASIGNADO ─confirmar→ CONFIRMADO ─iniciar (parada 1)→ CARGANDO ─salir→ EN_RUTA ─confirmar 2→ DESCARGANDO
  ─salir→ EN_RUTA ─confirmar 3 (última)→ DESCARGANDO ─salir→ FINALIZADO (cerrado_por CHOFER)
```

Más: `motivo` / `descripcion` obligatorios (400), condiciones de un cliente viejo ignoradas, `motivo` en
la PyME, en el chofer y en `viaje:asignado`; iniciar / confirmar lejos (400 con la distancia), confirmar sin
salir (400), salir en `EN_RUTA` (400), saltear una parada (400), segundo viaje en curso (409), la PyME
finalizando antes de la hora prevista (409) y después de cerrado (409), `PATCH /api/viajes/:id/estado` en
viaje de PyME (400), la secuencia exacta de `viaje:estado_cambiado`, ping GPS antes de iniciar (evento
`error`) y después de finalizar (se ignora).

## Cómo correrlo

```bash
node e2e/sim/sim-finalizar-viaje.mjs                                   # contra staging, desde la raíz
FLETER_API=http://localhost:3000 node e2e/sim/sim-finalizar-viaje.mjs  # contra el backend local
```

- Key de Firebase: `FIREBASE_WEB_API_KEY` (o `FIREBASE_API_KEY`) del entorno, de `e2e/sim/.env` o del
  `.env` de la raíz del repo. **Nunca** se commitea.
- Tarda **1–2 minutos**: el viaje se crea con la anticipación mínima (60 min) y la ventana de inicio abre
  60 min antes, así que reintenta `iniciar` cada 10 s hasta que abre.
- Contra un backend local, Firebase tiene que ser el mismo proyecto.
- Sale con `0` si todo pasa y `1` si falla algo. Cada request se imprime con status y body recortado.

## Efectos secundarios

Cada corrida **crea datos reales**: 2 usuarios (`sim+pyme-<n>@fleter.test`, `sim+chofer-<n>@fleter.test`,
contraseña `Sim-<n>`), una PyME, un vehículo, un viaje FINALIZADO con remito en R2 y uno CANCELADO. Staging
comparte la base con production: al final se cancela todo viaje que haya quedado vivo. Lo demás se cuenta
y se borra con `node scripts/restos.js --solo sim [--borrar]` (categoría `sim`).

## Reglas para el agente

1. **El contrato es la fuente de verdad** (`CONTRATO-FINALIZAR.md`). Si un chequeo falla, primero
   decidí si el bug está en el backend o en el contrato, y decilo. **No cambies el test para que pase**
   sin explicar por qué el comportamiento nuevo es el correcto.
2. **Cualquier cambio en el ciclo del viaje interno actualiza este simulador y el contrato en el mismo
   PR** (regla del backend, en `CLAUDE.md`), y se avisa al front y al mobile: dependen de los mensajes de
   error y de los campos (`estado`, `viaje_finalizado`, `estado_nuevo`, `id_parada`, `cerrado_por`).
3. Coordenadas: Plaza de Mayo → Obelisco → Recoleta. "Cerca" = +0,00018 de latitud (~20 m), "lejos" =
   +0,01 (~1,1 km). `RADIO_CONFIRMACION_METROS` vale 200 en staging y production (50 de default); si
   alguna vez baja de ~25 m, "cerca" deja de pasar: acercalo.
4. No registres un chofer **sin licencia** mientras production no tenga el Paso A de la licencia: el
   Prisma viejo tira al leer esa fila (la base es compartida).
5. Para agregar un caso: un `api(...)` + `check(...)` en el paso que corresponda; si crea un viaje,
   sumalo a `estado.viajes` para que se cancele si algo falla. En la colección, un request nuevo con su
   test en `1. Recorrido` (el orden importa).

## Ideas de lo que se puede sumar después

- Cancelar en curso desde la PyME en medio del recorrido (`409` de carrera en `salir`).
- Dos `salir` simultáneos sobre la última parada: uno `200`, el otro `409`.
- Un viaje de 2 paradas y uno de `MAX_PARADAS_POR_VIAJE`; una parada `{ "id_lugar": ... }` (Paso 4).
- Salida detectada por GPS (alejarse > 500 m durante 4 min) y el finalizar de la PyME habilitado por `GPS`.
