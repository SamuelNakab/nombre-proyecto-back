# Reporte de stress tests — Fleter backend

Fecha: 2026-06-20T00:32:03.253Z

## Resumen

- 62 tests corridos
- 54 pasaron
- 5 bugs
- 3 huecos conocidos / comportamientos no definidos

## vehiculos

| # | Caso | Resultado |
|---|------|-----------|
| 1 | Tokens conductores A y B obtenidos | ✅ |
| 2 | POST con 5 condiciones → 201 | ❌ — status 409 |
| 3 | Respuesta incluye las 5 condiciones | ❌ — undefined condiciones |
| 4 | POST sin condiciones → 201 | ✅ — status 201 |
| 5 | Respuesta tiene condiciones=[] | ✅ |
| 6 | Patente repetida rechazada con 409 | ✅ — status 409 — La patente ya esta registrada |
| 7 | PUT vehiculo ajeno rechazado con 403 | ❌ — status 500 |
| 8 | DELETE inexistente → 404 | ✅ — status 404 |
| 9 | DELETE vehiculo en viaje activo → 400 | ❌ — status 500 —  |
| 10 | Agregar FRAGIL ya existente → 409 | ✅ — status 409 |
| 11 | Agregar INVENTADA → 400 | ✅ — status 400 |
| 12 | Anio 1980 → 400 | ✅ — status 400 |
| 13 | Anio 2050 → 400 | ✅ — status 400 |

## gps

| # | Caso | Resultado |
|---|------|-----------|
| 1 | Tokens y vehiculos listos | ✅ |
| 2 | Primer ping → estado EN_CAMINO_A_ORIGEN | ✅ — EN_CAMINO_A_ORIGEN |
| 3 | Cliente recibe mapa:actualizar | ✅ — 1 eventos |
| 4 | Servidor sigue respondiendo tras lat=200/lng=500 | ✅ |
| 5 | No guarda coordenada invalida en Redis | ✅ — ultima=-34.6037,-58.3816 |
| 6 | Conductor recibe error 'Coordenadas fuera de rango' | ✅ — error recibido: "Coordenadas fuera de rango" |
| 7 | lat=90 / lng=180 (limite) se acepta y guarda en Redis | ✅ — ultima=90,180 |
| 8 | lat=-90 / lng=-180 (limite) se acepta y guarda en Redis | ✅ — ultima=-90,-180 |
| 9 | lat=90.0001 se rechaza (Redis no guarda la coord invalida) | ✅ — ultima sigue en -90,-180 |
| 10 | lng=180.0001 se rechaza (Redis no guarda la coord invalida) | ✅ — ultima sigue en -90,-180 |
| 11 | Acumulado tras [valido, invalido, valido] es la distancia real (no contaminado) | ✅ — distancia_km=2.141 (esperado ~2.4, no miles) |
| 12 | Ultima coord guardada es el ping valido (PARADA_B), no la invalida | ✅ — ultima=-34.5895,-58.3974 |
| 13 | Acumulado existe tras burst de 10 pings | ✅ — dist=0.1296km, t=0.004370h |
| 14 | Acumulado no tiene NaN ni Infinity | ✅ — valores numericos finitos |
| 15 | Conductor no asignado: NO se emite mapa:actualizar | ✅ — mapa antes=15, despues=15 |
| 16 | Conductor no asignado: su coordenada NO se guarda en Redis | ✅ — ultima sigue en -34.6028,-58.3807 |
| 17 | Conductor no asignado recibe error 'No autorizado para este viaje' | ✅ — error recibido: "No autorizado para este viaje" |
| 18 | Conductor asignado (A) SI puede mandar pings (sin regresion) | ✅ — mapa +1, ultima=-34.6028,-58.3807 |
| 19 | PATCH a FINALIZADO (no permitido manualmente) → 400 con error claro | ✅ — status 400 — Invalid option: expected one of "CARGANDO"\|"DESCARGANDO"\|"EN_RUTA" |
| 20 | Backend bloquea retroceso EN_RUTA → CARGANDO | ❌ — Acepto el retroceso de estado (BUG potencial) |
| 21 | alerta:desvio emitida tras pings lejanos | ✅ — evento recibido |
| 22 | alerta:parada emitida tras muchos pings detenidos | ✅ — evento recibido |

## cierre

| # | Caso | Resultado |
|---|------|-----------|
| 1 | Tokens y vehiculo listos | ✅ |
| 2 | Confirmar parada legal → 200 | ✅ — status 200 |
| 3 | confirmada=true | ✅ |
| 4 | QR de OTRO viaje → 400 | ✅ — status 400 |
| 5 | Firma manipulada → 400 | ✅ — status 400 |
| 6 | GPS lejos → 400 | ✅ — status 400 — Estas a 15462m de la parada. Debes estar a menos de 200m |
| 7 | 1ra confirmacion → 200 | ✅ — status 200 |
| 8 | 2da confirmacion misma parada → rechazada (400) | ✅ — status 400 |
| 9 | Calificar viaje en EN_RUTA → 400 | ✅ — status 400 — Solo se puede calificar un viaje finalizado |
| 10 | 1ra calificacion → 201 | ✅ — status 201 |
| 11 | 2da calificacion → 409 | ✅ — status 409 |
| 12 | puntuacion 0 → 400 | ✅ — status 400 |
| 13 | puntuacion 6 → 400 | ✅ — status 400 |
| 14 | puntuacion -1 → 400 | ✅ — status 400 |
| 15 | puntuacion decimal (2.5) → 400 | ✅ — status 400 |
| 16 | Remito /106.pdf HEAD → 200 | ✅ — HTTP 200 |
| 17 | Todas las keys gps:{id_viaje}:* eliminadas | ✅ |

## concurrencia

| # | Caso | Resultado |
|---|------|-----------|
| 1 | Tokens y vehiculos listos | ✅ |
| 2 | Creados 2 viajes (109, 110) | ✅ |
| 3 | Comportamiento observado: viaje 109 → conductor 4, viaje 110 → conductor 4 | ✅ — eventos al conductor: [109,110] |
| 4 | HUECO CONOCIDO: el mismo conductor quedo asignado a 2 viajes | ⚠️ — el backend no valida que un conductor no acepte viajes solapados (esperado en MVP) |
| 5 | Race condition resuelta: exactamente un ganador en TODAS las iteraciones (10/10) | ✅ — 10/10 corridas correctas |
| 6 | Cliente recibe mapa:actualizar de ambos viajes (v121: 5, v122: 5) | ✅ |
| 7 | HUECO: mapa:actualizar no incluye id_viaje | ⚠️ — cliente con N viajes simultaneos no puede distinguir GPS de cada uno |
| 8 | Servidor procesa 234 pings en 12602ms y atiende REST (latencia prom 453ms, max 670ms) | ✅ — prom 453ms, max 670ms |
| 9 | POST con fecha pasada → 400 | ✅ — status 400 |
| 10 | Tras reconectar, el conductor recibe mapa:actualizar del room (rejoin) | ⚠️ — 0 eventos |
