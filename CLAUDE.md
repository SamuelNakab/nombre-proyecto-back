# Fleter — Backend

## Descripcion del proyecto
Plataforma de fletes para PyMEs argentinas. El cliente crea un viaje, el
sistema lo publica a conductores elegibles via WebSocket. Fee porcentual.
MVP: CABA + GBA.

## Estado actual
- Fases 0-5 COMPLETAS (registro, viajes, matching atomico, GPS/tracking,
  ETA, recalculo de ruta, confirmacion de paradas, cierre, remito PDF,
  calificaciones, vehiculos)
- Boton "Iniciar viaje" (inicio manual + puntualidad) COMPLETO, en produccion
- CI/CD + deploy Railway por environment COMPLETO
- Cancelacion por conductor, cliente y admin COMPLETO
- Panel de administracion COMPLETO
- Estructura jerarquica (empresas de logistica) COMPLETA
- Deteccion de zona por poligono COMPLETA
- Duraciones (estimada / real) y guard atomico en asignar COMPLETOS
- Confirmacion de paradas por proximidad (reemplazo del QR) COMPLETA
- Timeout de reservas por temporizador (se saco el poller que mantenia
  despierta la DB de Neon) COMPLETO

## Stack
- Node.js 22, ES Modules (NUNCA require()). Async/await siempre.
- Express, PostgreSQL en Neon (Prisma 6), Firebase Admin SDK,
  Socket.io v4, Redis (ioredis), Turf.js, Zod, pdfkit,
  @aws-sdk/client-s3 (R2), Google Maps Directions API, Vitest.

## Reglas de codigo
- ES Modules siempre. Named exports. kebab-case en archivos.
- Zod en todos los endpoints REST. Errores como { error: "mensaje" }.
- Variables en .env con default en codigo si no estan.
- PrismaClient unico en src/config/prisma.js.

## Reglas de migraciones Prisma
- Hay drift. Usar npx prisma db push. NUNCA migrate reset/dev sin
  autorizacion explicita de Samuel.
- La DB de Neon esta COMPARTIDA entre staging y produccion: un db push
  local toca el schema de produccion en ese mismo instante. Solo cambios
  ADITIVOS (tablas nuevas, columnas nullable) son seguros. NUNCA dropear
  ni renombrar columnas sin autorizacion explicita.
- El reemplazo del QR por proximidad NO tuvo cambios de schema.

## Maquina de estados — src/services/estado-viaje.service.js
TRANSICIONES como estructura de datos + validarTransicion(actual, destino),
que tira error si la transicion no esta permitida. La usan:
- El PATCH /api/viajes/:id/estado (antes permitia retrocesos invalidos).
- Todos los endpoints de la estructura jerarquica que cambian estado.
PENDIENTE: matching.service, cierre.service y cancelacion.service todavia
setean un estado fijo directo, sin validarTransicion. Se migran despues.

Transiciones validas:
| Desde                  | Hacia                    | Quien / trigger                          |
|------------------------|--------------------------|------------------------------------------|
| BUSCANDO_CONDUCTOR     | CONDUCTOR_ASIGNADO       | Conductor independiente acepta (atomico) |
| BUSCANDO_CONDUCTOR     | RESERVADO_POR_EMPRESA    | Gerente reserva (atomico)                |
| BUSCANDO_CONDUCTOR     | CANCELADO                | Cliente / admin                          |
| RESERVADO_POR_EMPRESA  | CONDUCTOR_ASIGNADO       | Gerente asigna conductor + vehiculo      |
| RESERVADO_POR_EMPRESA  | BUSCANDO_CONDUCTOR       | Timeout, gerente suelta, o desafiliacion |
| RESERVADO_POR_EMPRESA  | CANCELADO                | Cliente / admin                          |
| CONDUCTOR_ASIGNADO     | EN_CAMINO_A_ORIGEN       | Iniciar viaje (conductor o gerente)      |
| CONDUCTOR_ASIGNADO     | BUSCANDO_CONDUCTOR       | Cancela conductor INDEPENDIENTE          |
| CONDUCTOR_ASIGNADO     | RESERVADO_POR_EMPRESA    | Cancela conductor de EMPRESA             |
| CONDUCTOR_ASIGNADO     | CANCELADO                | Cliente / admin                          |
| EN_CAMINO_A_ORIGEN     | CARGANDO                 | Manual, PATCH /estado                    |
| CARGANDO               | EN_RUTA                  | Manual, PATCH /estado                    |
| EN_RUTA                | DESCARGANDO              | Manual, PATCH /estado                    |
| DESCARGANDO            | FINALIZADO               | Confirmacion de la ULTIMA parada         |
| cualquiera (no final)  | CANCELADO                | Admin                                    |

## Confirmacion de paradas (sin QR)

El QR fue REEMPLAZADO por confirmacion por proximidad. Ya no existe el
endpoint de qr-paradas ni la firma/validacion de tokens.

Flujo: el conductor llega a la parada, toca el boton de confirmar en su
app, y el backend valida que su posicion este dentro de
RADIO_CONFIRMACION_METROS de esa parada.

- POST /api/viajes/:id/confirmar-parada
  Rol CONDUCTOR (solo el asignado al viaje).
  Body: { id_parada, lat, lng }. El id_parada sale de las paradas que ya
  devuelve GET /api/viajes/:id — no hay endpoint aparte para listarlas.
  Validaciones, en este orden:
  * el viaje existe -> 404
  * el conductor autenticado es el asignado -> 403
  * la parada pertenece a ese viaje -> 400
  * la parada no esta confirmada todavia (fecha_entrega null) -> 400
  * el viaje esta en EN_RUTA o DESCARGANDO -> 400
  * distancia((lat,lng), parada) <= RADIO_CONFIRMACION_METROS -> si no,
    400 con un mensaje que dice a cuantos metros esta y cual es el maximo
  Setea Parada.fecha_entrega (y estado ENTREGADO). Si es la ULTIMA parada
  sin confirmar, dispara el cierre del viaje igual que antes:
  DESCARGANDO -> FINALIZADO, precio_real, remito PDF, evento
  viaje:finalizado. Si quedan pendientes, solo recalcula el ETA.

- El ORDEN de las validaciones es contrato, no detalle: define que error
  ve el conductor cuando falla mas de una condicion. Esta documentado
  igual en API.md. El codigo viejo validaba el estado ANTES de la parada.

- "Ya confirmada" se chequea por fecha_entrega (no por estado ENTREGADO).
  Los dos se escriben juntos en el mismo update, asi que da igual, pero
  fecha_entrega es el campo que define el cierre. El conteo de paradas
  pendientes que dispara el cierre sigue yendo por estado.

- CAMBIO DE CONTRATO: una parada que no es de ese viaje devuelve 400
  ("La parada no pertenece a este viaje"), no 404. El viaje de la URL si
  existe; lo que esta mal es la combinacion. Mismo 400 exista o no la
  parada, para no filtrar ids de paradas de viajes ajenos.

- El orden de confirmacion ENTRE PARADAS no se valida: una parada se
  puede confirmar antes que otra de orden menor. Es el comportamiento que
  ya existia con el QR. De ahi que duracion_real use max(fecha_entrega).

- La distancia se calcula con la MISMA funcion que ya usaba el codigo
  (turf.distance en metros), no se escribio una nueva.

- Antes de este cambio el radio estaba FIJO en 200m; ahora es variable de
  entorno y el default bajo a 50m. Se bajo porque con el QR la proximidad
  era un control secundario (el token firmado ya probaba la presencia) y
  ahora es el UNICO control. Queda configurable porque 50m es agresivo
  para GPS urbano entre edificios altos.

- La columna qr_token queda en el schema pero SIN USO: la DB de Neon esta
  compartida con produccion y dropear columnas ahi es destructivo. Se
  dropea cuando se separen las DBs por environment. Sigue apareciendo en
  las respuestas que serializan la fila cruda de la parada; API.md avisa
  que se ignore.

## Estructura jerarquica

### Actores
- CLIENTE: sin cambios, crea viajes.
- Conductor INDEPENDIENTE: sin empresa, ve/acepta/coordina viajes con sus
  propios vehiculos.
- Conductor AFILIADO: pertenece a 1 o N empresas. CONSERVA su menu personal
  (sigue viendo y aceptando viajes propios con sus propios vehiculos), y
  ADEMAS recibe asignaciones de sus gerentes en una pestaña aparte.
- GERENTE: responsable de una empresa. Ve viajes disponibles, los reserva,
  asigna conductor + vehiculo de su flota, registra vehiculos de la empresa,
  aprueba y desafilia conductores, ve el tracking de los viajes de su empresa.

### Modelos
- Empresa: nombre, cuit, codigo_afiliacion (unico), id_gerente, activa.
- ConductorEmpresa (N-a-N): id_conductor, id_empresa, estado
  (PENDIENTE | ACTIVO), fecha_alta, fecha_baja.
- Vehiculo: dueño explicito — id_conductor (nullable) O id_empresa (nullable),
  exactamente uno de los dos.
- Viaje: id_empresa (nullable), fecha_reserva (nullable), iniciado_por
  (nullable: "CONDUCTOR" | "GERENTE"), duracion_estimada_horas (Float?).

### Afiliacion
- El conductor ingresa el codigo_afiliacion de la empresa → se crea
  ConductorEmpresa en PENDIENTE.
- El gerente aprueba → ACTIVO.
- Cualquiera de los dos corta el vinculo. Reglas de desafiliacion:
  * Si el conductor tiene un viaje EN CURSO de esa empresa
    (EN_CAMINO_A_ORIGEN..DESCARGANDO) → NO se permite desafiliar, error claro.
  * Si tiene viajes ASIGNADOS sin iniciar (CONDUCTOR_ASIGNADO) de esa
    empresa → esos viajes vuelven a RESERVADO_POR_EMPRESA.

### Reserva y asignacion
- Los viajes disponibles se publican a conductores independientes elegibles
  Y a gerentes cuya empresa tenga al menos un vehiculo de flota que cumpla
  las condiciones del viaje.
- El gerente reserva (atomico, mismo patron que el aceptar) →
  RESERVADO_POR_EMPRESA. El viaje sale del pool para el resto.
- El gerente asigna cualquier conductor ACTIVO de su empresa + cualquier
  vehiculo de la flota que cumpla las condiciones → CONDUCTOR_ASIGNADO.
- Puede reasignar conductor/vehiculo mientras el viaje no arranco.
- GUARD ATOMICO: los TRES endpoints que escriben el viaje (reservar, asignar,
  reasignar) usan updateMany con el estado esperado en el WHERE, nunca un
  update plano sobre la lectura previa. count === 0 → 409.
  * reservar:  where { id_viaje, estado: 'BUSCANDO_CONDUCTOR' }
  * asignar:   where { id_viaje, estado: 'RESERVADO_POR_EMPRESA' }
  * reasignar: where { id_viaje, estado: 'CONDUCTOR_ASIGNADO', fecha_inicio: null }
  asignar era un update plano: dos POST /asignar concurrentes sobre el mismo
  viaje reservado devolvian los DOS 200, el ultimo par (conductor, vehiculo)
  pisaba al primero y los DOS conductores recibian viaje:asignado — uno para un
  viaje que no era suyo. En reasignar lo que cierra el WHERE es la carrera
  contra POST /:id/iniciar (reasignar un viaje que acaba de arrancar); dos
  reasignaciones concurrentes del mismo gerente siguen siendo last-write-wins,
  que es correcto porque las dos son legitimas.
  Cubierto por scripts/test-concurrencia-jerarquia.js (CASO C), verificado
  revirtiendo el guard: sin el, CASO C se pone en rojo con ganadores=2.
- Si tarda mas de RESERVA_TIMEOUT_MINUTOS sin asignar → se cancela la
  reserva automaticamente y vuelve a BUSCANDO_CONDUCTOR. Tambien puede
  soltarlo el gerente a mano (cancelar-reserva). Ver "Timeout de reservas".
- IMPORTANTE: cancelar-reserva y el timeout NO alcanzan con emitir al
  room viejo: republican el viaje DE CERO — re-corren la elegibilidad de
  conductores independientes + obtenerGerentesElegibles y suman a esa gente al
  room, reusando publicarViajeAConductoresElegibles (la MISMA funcion que la
  cancelacion de un conductor independiente). Asi, alguien que se conecto
  DESPUES de la reserva original tambien recibe viaje:disponible.

### Timeout de reservas — un timer por reserva (NO hay poller)

Antes era un setInterval en reserva.service que cada RESERVA_CHECK_INTERVAL_MS
(default 60s) pegaba un SELECT a la DB buscando reservas vencidas. Corria
SIEMPRE, hubiera o no reservas: ~1440 queries por dia por instancia, que
mantenian despierta la base de Neon 24/7 y se comieron la cuota de CU-horas.
Era el UNICO poller permanente del backend (el emisor de ETA arranca con los
pings GPS y se corta al cerrar el viaje o por su watchdog de inactividad).

Ahora cada reserva programa su propio setTimeout. Cero reservas, cero timers,
cero queries. Verificado con prisma:query: 1 sola query en 40s de server idle.

- programarTimeoutReserva(io, id_viaje, msRestantes?) / cancelarTimeoutReserva
  (id_viaje), sobre un Map id_viaje → Timeout en reserva.service.js. Mismo
  patron que tenia el MATCHING_TIMEOUT que se saco.
- Se PROGRAMA timer en los TRES caminos que ENTRAN a RESERVADO_POR_EMPRESA, no
  solo al reservar:
  * POST /api/viajes/:id/reservar
  * POST /api/viajes/:id/cancelar-conductor de un viaje de EMPRESA (reinicia
    fecha_reserva y el viaje vuelve a la empresa)
  * ejecutarDesafiliacion (los CONDUCTOR_ASIGNADO vuelven a RESERVADO)
  Los dos ultimos con el poller salian gratis; sin programarlos a mano esos
  viajes se quedarian reservados para siempre.
- Se CANCELA el timer en TODOS los caminos que SACAN el viaje de
  RESERVADO_POR_EMPRESA: asignar, cancelar-reserva (dentro de liberarReserva),
  cancelacion por admin, y cancelacion por cliente (defensivo: hoy
  ESTADOS_CANCELABLES no incluye RESERVADO_POR_EMPRESA, ver PENDIENTE abajo).
  reasignar NO cancela nada: va de CONDUCTOR_ASIGNADO a CONDUCTOR_ASIGNADO y el
  timer ya lo habia matado el asignar.
- Un timer que dispara DE MAS es INOFENSIVO: liberarReserva escribe con
  updateMany condicionado (where { id_viaje, estado: 'RESERVADO_POR_EMPRESA' })
  y devuelve si libero de verdad. Si el viaje ya salio de ese estado, matchea 0
  filas, no toca nada y no republica. Ese guard es nuevo: antes era un update
  plano sobre la lectura del poller (TOCTOU).
- Efecto colateral del guard: cancelar-reserva puede devolver 409 si pierde una
  carrera contra una asignacion concurrente. Antes devolvia 200 y pisaba un
  viaje ya asignado, devolviendolo al mercado con conductor y todo.
- La liberacion sigue republicando DE CERO con
  publicarViajeAConductoresElegibles, igual que antes.

### Barrido de arranque
Los timers viven en MEMORIA, asi que un reinicio los pierde. Al levantar,
app.js corre barridoInicialReservas: UNA sola consulta (no un poller) que busca
los RESERVADO_POR_EMPRESA y, por cada uno:
- ya vencido (mientras el proceso estaba caido) → lo libera ahora;
- todavia vigente → le programa el timer por el tiempo RESTANTE, contado desde
  su fecha_reserva y no desde el arranque (si no, cada deploy le regalaria el
  timeout completo de nuevo).
Loguea cuantas encontro, cuantas libero y cuantas reprogramo. La liberacion es
SECUENCIAL a proposito: cada una emite sockets y re-corre elegibilidad, y no
queremos una tormenta de queries justo en el arranque.

### LIMITACION CONOCIDA — un solo proceso
El Map de timers vive en la memoria de UNA instancia: solo conoce las reservas
que ella misma atendio. Con mas de una instancia, una reserva atendida por A no
tiene timer en B, y si A se cae nadie la libera hasta el proximo arranque de A.
Hoy no importa porque se corre una sola instancia. El dia que se escale hay que
mover esto a una cola persistente — BullMQ sobre el Redis que ya usamos — en
vez de setTimeout en memoria. El barrido de arranque cubre el reinicio, NO el
multi-instancia.

### PENDIENTE (aparte, no es de este cambio)
CLAUDE.md y API.md dicen "RESERVADO_POR_EMPRESA → CANCELADO: Cliente / admin",
pero ESTADOS_CANCELABLES en cancelarViajeCliente es solo
['BUSCANDO_CONDUCTOR', 'CONDUCTOR_ASIGNADO']: el cliente NO puede cancelar un
viaje reservado, le da 400. El admin si. Bug real de contrato vs codigo.

### Visibilidad del gerente
- Ademas del push por socket (viaje:disponible), el gerente descubre viajes
  disponibles por REST via GET /api/empresas/:id/viajes-disponibles: los
  BUSCANDO_CONDUCTOR con fecha futura que la flota de esa empresa puede
  cumplir. Sirve para el que se conecta tarde o recarga la pantalla. El
  filtro de condiciones REUSA conductorEsElegible (el mismo helper de
  elegibilidad.service.js que usa listarViajesDisponibles), pasando la flota
  por el slot de "vehiculos propios" — no se reimplementa el matching, asi
  el pull y el push no se pueden desincronizar.
- GET /api/empresas/:id/viajes incluye condiciones_req de cada viaje y las
  condiciones del vehiculo asignado (para filtrar la flota en el front).
- GET /api/viajes/:id lo puede leer tambien el gerente de la empresa dueña
  del viaje (viaje.id_empresa → empresa.id_gerente), ademas del cliente
  dueño y el conductor asignado. Cualquier otro → 403.

### Helper de acceso compartido — src/services/acceso-viaje.service.js
La regla de lectura de un viaje vive en UN solo lugar y la usan los TRES
endpoints que devuelven datos del viaje. Antes estaba inline en obtenerViaje y
los otros dos se habian quedado en CLIENTE/CONDUCTOR (el gerente no veia ni el
costo ni el remito de un viaje de su propia empresa).

- puedeVerViaje(viaje, usuario) → bool. Pasa el cliente dueño, el conductor
  asignado, o el gerente de la empresa dueña. La usan:
  * GET /api/viajes/:id
  * GET /api/viajes/:id/costo-acumulado
  * GET /api/viajes/:id/remito
- INCLUDE_ACCESO_VIAJE: el include de Prisma con las relaciones que el helper
  necesita (cliente, conductor, empresa). Los callers que no necesitan el objeto
  completo (costo-acumulado, remito) lo spreadean tal cual. puedeVerViaje TIRA
  error si alguna de las tres viene undefined: sin ese guard, olvidarse un
  include no rompe — devuelve un 403 silencioso al gerente, justo el bug que el
  helper viene a evitar.
- puedeVerViajeDisponible(viaje, usuario) → Promise<bool>. Regla ADICIONAL y
  EXCLUSIVA del detalle: un viaje en BUSCANDO_CONDUCTOR todavia tiene
  id_empresa null, asi que ningun gerente pasa por puedeVerViaje; este permite
  leerlo al gerente cuya flota cumple las condiciones_req, para que pueda
  decidir si lo reserva. REUSA obtenerGerentesElegibles (elegibilidad.service),
  el MISMO helper que decide a que gerentes les llega el push viaje:disponible
  — si te llego el push, podes abrir el detalle; push y detalle no se pueden
  desincronizar. NO se reimplementa el matching de condiciones.
  NO aplica a costo-acumulado ni remito (un viaje sin conductor no tiene ni
  costo acumulado ni remito).

Ninguna de las tres rutas tiene requireRol: la validacion real es el helper.

### Ejecucion
- El conductor asignado NO confirma la asignacion (por ahora): la ve en su
  pestaña "asignados" y puede iniciarla.
- "Iniciar viaje" lo puede apretar el conductor O el gerente. Guardar
  iniciado_por. El GPS SIEMPRE viene del celular del conductor.
- De CONDUCTOR_ASIGNADO en adelante, el flujo es identico para viajes de
  empresa y de conductor independiente.

### Calificacion
- Se califica al conductor.
- La calificacion de una empresa es el promedio de las de sus conductores
  ACTIVOS. Calcular en el read (GET empresa), no denormalizar.
- SOLO se promedian los conductores ACTIVOS que YA tienen al menos una
  calificacion propia. Los que no tienen NO cuentan (no se los toma como 0).
  Si ninguno tiene, calificacion_promedio de la empresa = null. Como
  Conductor.calificacion_promedio es Float @default(0) (nunca null), "tiene
  calificaciones" se detecta contando sus filas Calificacion (_count).

### Tracking del gerente
- Al gerente se lo suma al room viaje:{id} de los viajes de su empresa,
  para que reciba mapa:actualizar / eta:actualizar como el cliente.

## Duraciones y unidades — src/services/duracion.service.js

Regla sin excepciones, para no mezclar unidades en una misma respuesta:
- En la BASE y en el calculo de precio, el tiempo va en HORAS (float):
  Viaje.duracion_estimada_horas, desglose.tiempo_horas, tiempo_capital.
- En la API, toda duracion se expone en MINUTOS (entero redondeado):
  duracion_estimada y duracion_real.
- Nomenclatura: `duracion_*` sin sufijo = minutos enteros. `tiempo_*` y
  `*_horas` = horas float.

- duracion_estimada_horas: columna en Viaje (Float?, aditiva y nullable).
  Se llena en crearViaje con resultado.desglose.tiempo_horas — el MISMO
  tiempo que se acaba de usar para estimar el precio, asi que
  duracion_estimada y precio_estimado no se pueden desincronizar. Antes ese
  valor se calculaba y se descartaba: salia una sola vez en la respuesta de
  creacion y no habia forma de recuperarlo (en PROVINCIA tarifa_hora es null y
  en MIXTO el precio mezcla los dos ejes, asi que NO es derivable del precio).
- duracion_real: NO hay columna, se calcula en el read con
  calcularDuracionRealMinutos(viaje) = max(paradas.fecha_entrega) − fecha_inicio.
  Se usa max() y NO la parada de mayor `orden`: nada garantiza que las paradas
  se confirmen en orden (no se valida el orden de confirmacion). null si el
  viaje no esta FINALIZADO o no tiene fecha_inicio.
- Lo consumen: GET /api/viajes/mis-viajes (duracion_real) y GET /api/viajes/:id
  (duracion_estimada). El detalle ademas incluye el vehiculo asignado (null
  mientras no hay conductor).
- Excepcion documentada: GET /api/empresas/:id/viajes devuelve
  duracion_estimada_horas en HORAS, porque ese endpoint serializa la fila cruda
  del viaje. El nombre lleva la unidad; la regla de minutos aplica a los campos
  derivados.

## Deteccion de zona (CABA / PROVINCIA / MIXTO)

La zona de un viaje la calcula SIEMPRE el servidor. El campo `zona` del body de
POST /api/viajes y POST /api/viajes/estimar-costo se acepta por compatibilidad
con el front (que la sigue mandando) pero su valor se IGNORA.

### Poligono de CABA
- Archivo: src/data/limite-caba.geojson (Feature GeoJSON, MultiPolygon, 1024
  vertices, ~82 KB). NO editar a mano: regenerar desde la fuente.
- Fuente: IGN (Instituto Geografico Nacional), via el Servicio de Normalizacion
  de Datos Geograficos de Argentina (georef-ar), dataset de provincias
  v12.1.0 (2023-11-27), provincia id "02".
  URL: https://infra.datos.gob.ar/georef/provincias.ndjson
  (dataset en datos.gob.ar: jgm-servicio-normalizacion-datos-geograficos)
- Se eligio el IGN porque data.buenosaires.gob.ar estaba caido (503) al
  momento de implementarlo. El dataset del GCBA ("Perimetro") es equivalente.
- Validado contra 20 puntos conocidos (10 dentro: Obelisco, Plaza de Mayo,
  Caballito, Lugano, Nunez, Puerto Madero, Mataderos, Retiro, Liniers, Villa
  Riachuelo; 10 fuera: La Plata, Avellaneda, San Isidro, Lanus, Ezeiza,
  Ciudadela, Olivos, Tigre, San Justo, y un punto en el Rio de la Plata).
  Los cruces de borde caen donde corresponde: Av. Gral Paz a la altura de
  Liniers en lng ~-58.530, y el Riachuelo en Barracas en lat ~-34.658.

### src/services/zona.service.js
- clasificarParada(lat, lng) -> boolean. turf.booleanPointInPolygon contra el
  poligono. Un punto sobre el borde cuenta como dentro.
- contarParadasPorZona(paradas) -> { en_caba, fuera_caba, total, fraccion_caba }
- clasificarZona(paradas) -> 'CABA' (todas dentro) | 'PROVINCIA' (todas fuera)
  | 'MIXTO' (mezcla). Unica fuente de verdad de la zona.
- repartirPorZona({ zona, paradas, tiempo_horas, distancia_km })
  -> { tiempo_capital, distancia_provincia, fraccion_caba }.
  Unica definicion del reparto facturable. La usan costo.service (estimacion),
  cierre.service (cierre) y viajes.controller (precio acumulado en vivo), para
  que los tres no se puedan desincronizar.
- Las funciones aceptan paradas como { lat, lng } (body) o
  { latitud, longitud } (base), asi el caller no tiene que mapear.

### Reparto de MIXTO
  fraccion_caba = paradas_en_caba / total_paradas
  tiempo_capital      = tiempo_total    * fraccion_caba
  distancia_provincia = distancia_total * (1 - fraccion_caba)
CABA y PROVINCIA puros no cambiaron (tiempo total / distancia total).
Antes, MIXTO cobraba el tiempo total Y la distancia total: doble cobro.

### PENDIENTE
El reparto de MIXTO es una APROXIMACION POR CANTIDAD DE PARADAS, no por
recorrido real. Prorratear por tramo GPS real (clasificando cada punto del
recorrido con clasificarParada y acumulando por tramo) queda para mas adelante.

## Eventos WebSocket
| Evento          | Destinatario                                   |
|-----------------|------------------------------------------------|
| viaje:reservado | Room viaje:{id} (sacar del pool a los demas)   |
| viaje:asignado  | Room personal del conductor (usuario:{id})     |
| viaje:reserva_cancelada | Room viaje:{id} (vuelve al mercado)    |
| viaje:requiere_reasignacion | Room personal del gerente (usuario:{id_gerente}) |

Nota: viaje:asignado le puede llegar al mismo conductor desde varias
empresas donde trabaje — no asumir una sola empresa por conductor.

viaje:requiere_reasignacion avisa al gerente que un viaje YA asignado volvio
a RESERVADO_POR_EMPRESA y necesita reasignarse. Es distinto de
viaje:reserva_cancelada (ese es "vuelve al mercado abierto"). Payload
{ id_viaje, id_empresa, motivo }. Se emite en dos casos:
- Desafiliacion de un conductor con viajes CONDUCTOR_ASIGNADO de esa empresa
  (motivo: "conductor_desafiliado").
- Cancelacion del conductor de un viaje de empresa (motivo: "conductor_cancelo").

## Variables de entorno
RESERVA_TIMEOUT_MINUTOS=10        (default en codigo si no esta en .env;
                                   acepta FRACCIONARIOS: se lee con parseFloat
                                   + guarda, no parseInt. Los tests usan 0.1
                                   (= 6 segundos). Con parseInt, '0.1' daba 0,
                                   falsy, y caia al default 10 en silencio)
RESERVA_BARRIDO_ARRANQUE=1        (SOLO para tests: =0 desactiva el barrido de
                                   arranque. La DB de Neon esta COMPARTIDA con
                                   produccion, asi que un server efimero con
                                   RESERVA_TIMEOUT_MINUTOS chico barreria al
                                   levantar toda reserva de mas de unos
                                   segundos, incluidas las reales. En
                                   produccion NO se setea nunca)
RADIO_CONFIRMACION_METROS=50      (default en codigo si no esta en .env;
                                   antes el radio estaba fijo en 200)
ANTICIPACION_MINIMA_MINUTOS=60    (default en codigo si no esta en .env;
                                   antes estaba hardcodeado en 1 hora dentro
                                   del .refine de fecha_programada)

ANTICIPACION_MINIMA_MINUTOS es el minimo de anticipacion de fecha_programada en
POST /api/viajes. Se baja en staging/local (o se pone en 0) para crear un viaje
y debuggearlo sin esperar una hora. Detalles:
- El piso "la fecha tiene que ser FUTURA" NO depende de la variable: con 0 el
  minimo queda en `ahora` y la comparacion estricta rechaza igual el pasado.
  Por eso anticipacionMinimaMinutos() nunca devuelve un negativo (un negativo
  correria el minimo hacia atras y dejaria pasar fechas pasadas); un valor
  basura o negativo cae al default 60.
- El mensaje de error lleva el valor configurado, no un 60 fijo:
  "fecha_programada debe ser una fecha ISO futura (al menos X minutos desde
  ahora)". Es contrato: esta documentado igual en API.md.
- La variable se lee en CADA request, no se cachea en el modulo.
- NO aplica a POST /api/viajes/estimar-costo: ahi fecha_programada es opcional,
  solo define si es hora pico, y acepta cualquier fecha (incluso pasada).

QR_SECRET se SACO de .env.example. Puede seguir en el .env local de cada
uno, pero ya no lo lee nadie: se elimino junto con firmarQR/verificarQR.

MATCHING_TIMEOUT eliminado POR COMPLETO — no queda ningun rastro:
- La env var MATCHING_TIMEOUT_MINUTOS se saco de .env.example y del codigo.
- Se elimino todo el mecanismo en matching.service (el setTimeout, el Map de
  timers, cancelarPorTimeout y cancelarTimer) y su llamada en matching.socket.
- Consecuencia: un viaje en BUSCANDO_CONDUCTOR ya NO se auto-cancela por
  timeout. Queda disponible hasta que un conductor lo acepte, un gerente lo
  reserve, o el cliente/admin lo cancele. El evento viaje:cancelado_sin_conductor
  ya no se emite.

## Deploy
- Railway: production (main) / staging (develop).
- DB Neon COMPARTIDA entre ambos. Redis separado por environment.

## Comandos
npm run dev / npm run lint / npm run test
node scripts/test-fase5.js
node scripts/test-cancelacion-conductor.js
node scripts/test-cancelacion-cliente.js
node scripts/test-admin.js
node scripts/test-iniciar-viaje.js
node scripts/test-jerarquia.js
node scripts/test-visibilidad-gerente.js   (visibilidad del gerente)
node scripts/test-zona.js                  (deteccion de zona)
node scripts/test-acceso-gerente.js        (acceso del gerente a detalle /
                                            costo-acumulado / remito)
node scripts/test-campos-duracion.js       (duracion_real / duracion_estimada /
                                            vehiculo en el detalle /
                                            tiempo_capital y distancia_provincia
                                            en las 3 zonas)
node scripts/test-concurrencia-jerarquia.js (reserva y asignacion atomicas;
                                            CASO C = doble asignacion)
node scripts/test-confirmar-parada.js      (confirmacion por proximidad: radio,
                                            parada ajena, conductor ajeno,
                                            cierre del viaje, qr-paradas 404)
node scripts/test-anticipacion.js          (ANTICIPACION_MINIMA_MINUTOS: valores
                                            60 / 5 / 0, el piso de fecha futura
                                            y el mensaje de error. NO usa el
                                            server de :3000 — levanta uno propio
                                            por valor, en puertos 3101-3103)
node scripts/stress/test-cierre-exhaustivo.js (cierre + calificacion + remito +
                                            limpieza de Redis. CORRERLO: quedo
                                            roto meses por no correrse — sin
                                            dotenv para Redis y sin POST
                                            /:id/iniciar tras el boton nuevo)
node scripts/test-timeout-reserva.js       (timers de reserva: vence y republica,
                                            asignar antes del timeout, cancelar
                                            -reserva a mano, y el barrido de
                                            arranque. NO usa el server de :3000
                                            para los casos de timer — levanta
                                            uno propio por caso en 3201-3204 con
                                            RESERVA_TIMEOUT_MINUTOS=0.1)

scripts/_server-efimero.js es el helper compartido que levanta src/app.js en un
puerto propio con el env que se le pida. Lo usan el CASO 8 de test-jerarquia
(puerto 3210) y test-timeout-reserva. test-anticipacion tiene su propia copia
inline, anterior a la extraccion. OJO: no hay adapter de Redis en socket.io, o
sea que un socket conectado a :3000 NO recibe los eventos que emite un server
efimero — los tests que verifican eventos conectan sus sockets al puerto efimero.

Nota de entorno: si el repo esta en una carpeta sincronizada por OneDrive,
node --watch (npm run dev) se reinicia solo cuando OneDrive toca node_modules y
corta requests en vuelo. Sintoma tipico: "fetch failed" a mitad de un script.