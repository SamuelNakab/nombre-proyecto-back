# Hallazgos — corrida contra staging del 26-10-2026

Backend: `https://nombre-proyecto-back-staging.up.railway.app` (`/health` → `capacidades: ["viaje-interno"]`).
Corridas: viajes **2698** a **2702** (PyMEs 305 a 309). El script pasó todos sus chequeos y la colección
de Postman, 53 de 53 aserciones. En la 2701 falló un chequeo por tiempo: el `error` del ping GPS tardó más
de 1 s en llegar por socket. El script ahora lo espera hasta 5 s (2702 pasó entera).

## Lo que funciona como dice el contrato

- Confirmar la **última** parada → `200 { estado: "DESCARGANDO", viaje_finalizado: false }`. La PyME
  también lo ve en `DESCARGANDO`.
- `salir` de la última → `200 { estado: "FINALIZADO", viaje_finalizado: true, precio_real, remito_url,
  estimado, real }`. `real.distancia_km` sale del GPS simulado.
- `salir` otra vez → `400 "No se puede salir de una parada en un viaje en estado FINALIZADO"`.
- Confirmar la última otra vez → `400 "La parada ya fue confirmada"`.
- Mensajes de error textuales iguales al contrato: "toca \"Salir\"", "No estas en ninguna parada",
  "Primero tenes que confirmar la parada 2", "Estas a 1112m de la parada…".
- El detalle de la PyME queda `FINALIZADO`, las 3 paradas tienen `llegada_real` y `salida_real`, y el remito
  está disponible.
- Socket: ping antes de iniciar → `error { error: "El viaje no fue iniciado" }`; ping después de
  finalizar → ignorado sin error; la PyME recibe `viaje:finalizado` **una sola vez**, con `estimado`, `real`
  y `paradas`.

## Diferencias con el contrato (a decidir: ¿se corrige el backend o el contrato?)

1. **Radio de confirmación: 200 m, no 50 m.** El contrato dice `RADIO_CONFIRMACION_METROS` default 50;
   staging responde "Debes estar a menos de 200m" (en `iniciar` y en `confirmar-parada`). Probablemente
   la variable está seteada en 200 en Railway. Si es a propósito, conviene anotarlo en el contrato.
2. **`salir` de la última no emite `viaje:estado_cambiado`.** El contrato de `salir` dice "Emite
   `viaje:estado_cambiado` (con `id_parada`) a la PyME" sin distinguir. En la práctica la última salida
   solo emite `viaje:finalizado`. Secuencia real de `estado_cambiado`:
   `CONFIRMADO→CARGANDO · CARGANDO→EN_RUTA · EN_RUTA→DESCARGANDO · DESCARGANDO→EN_RUTA · EN_RUTA→DESCARGANDO`.
   El front escucha los dos eventos, así que no rompe nada; es para que el contrato diga lo que pasa.
3. **Payload de `viaje:estado_cambiado`:** trae `estado_anterior` y `estado_nuevo` (más `id_parada`), no
   `estado`. Coincide con la sección vieja del contrato; lo anoto porque la sección del viaje interno no
   muestra el payload.

## Ruido esperable (no son bugs)

Con el GPS en línea recta entre paradas, la PyME recibe `alerta:desvio` y `ruta:recalculada`: la recta no
sigue la ruta de Google. Lo mismo `alerta:parada` si se queda quieto. Es efecto de la simulación.

## Resolución (backend, 27-10-2026)

Las tres diferencias se resolvieron **en el contrato** (el backend hace lo correcto) y el simulador ahora
las verifica:

1. **Radio**: `RADIO_CONFIRMACION_METROS=200` está seteado en Railway (staging y production) a propósito;
   el 50 es solo el default de código. El contrato lo dice y los ejemplos de error usan 200.
2. **Última salida**: `salir` de la última emite solo `viaje:finalizado` (no `viaje:estado_cambiado`). El
   contrato lo dice y el simulador chequea la secuencia exacta de `estado_cambiado`.
3. **Payload de `viaje:estado_cambiado`**: `{ id_viaje, estado_anterior, estado_nuevo, id_parada }`,
   documentado en el contrato.

Además el simulador se movió al backend (`e2e/sim/`), corre en CI después del deploy a staging, y suma
los casos del pedido del front del 20-10-2026 (motivo y descripción obligatorios, sin condiciones) y de la
Tarea 5 (finalizar antes de la hora prevista → 409, segundo viaje en curso → 409, `cerrado_por: CHOFER`).
