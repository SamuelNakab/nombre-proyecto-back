# Simulador del front — viaje de PyME de punta a punta

Test de **caja negra** del ciclo del viaje de PyME contra un backend desplegado, simulando la ubicación
del chofer. Lo armó el equipo del dashboard web; vive en el backend (`e2e/sim/`) y corre en CI después del
deploy a staging. Crea sus propias cuentas (`sim+...@fleter.test`): no hace falta token ni loguearse en
ninguna app.

Lo que verifica (el contrato está en `CONTRATO-FINALIZAR.md`):
- **Paso 3**: confirmar la última parada deja el viaje en `DESCARGANDO`; recién
  `POST /api/choferes/viajes/:id/salir` de la última lo pasa a `FINALIZADO` (con `precio_real`,
  `remito_url`, `estimado` y `real`).
- **Pedido del front 20-10-2026**: `motivo` y `descripcion` obligatorios (400 si faltan), sin
  condiciones (las de un cliente viejo se ignoran), `motivo` en las lecturas de la PyME y del chofer.
- **Tarea 5**: la PyME no puede finalizar antes de la hora prevista (409), el chofer no puede iniciar un
  segundo viaje en curso (409), `viaje:finalizado` con `cerrado_por: "CHOFER"`.

## 1. Script con GPS por socket (la prueba principal)

Desde la raíz del repo (usa el `socket.io-client` del backend y la `FIREBASE_WEB_API_KEY` del `.env` de
la raíz):

```bash
node e2e/sim/sim-finalizar-viaje.mjs                                   # contra staging
FLETER_API=http://localhost:3000 node e2e/sim/sim-finalizar-viaje.mjs  # contra el backend local
```

Suelto (como en CI): `cd e2e/sim && npm ci --omit=dev && npm run sim`, con `FIREBASE_WEB_API_KEY` en el
entorno o en `e2e/sim/.env` (ver `.env.example`; la key **no** se commitea).

## 2. Postman

1. Postman → **Import** → `postman/fleter-finalizar-viaje.postman_collection.json`.
2. En la colección → pestaña **Variables** → `firebase_api_key` = la Web API key de Firebase
   (`FIREBASE_WEB_API_KEY`). `base_url` apunta a staging.
3. Clic derecho en la colección → **Run collection** → Run. Corre en orden `0. Armado` y `1. Recorrido`.

La colección no puede emitir `conductor:ubicacion` por socket.io: el GPS y los eventos solo están en el
script. Por terminal: `cd e2e/sim && npm install && npm run postman` (con `FIREBASE_WEB_API_KEY` exportada).

## Datos que deja

Cada corrida crea datos reales (2 usuarios, una PyME, un vehículo, un viaje FINALIZADO con remito y uno
CANCELADO). La base de staging es la de production: los viajes que queden vivos si algo falla se cancelan
al final, y el resto se cuenta y se borra desde la raíz del repo con
`node scripts/restos.js --solo sim` (y `--borrar`).

Para un agente de código: `AGENTS.md`. Resultado de la corrida del front: `HALLAZGOS.md`.
