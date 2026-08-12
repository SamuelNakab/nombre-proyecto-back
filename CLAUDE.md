# Fleter — Backend

## Descripcion del proyecto
Plataforma de fletes para PyMEs argentinas. El cliente crea un viaje, el
sistema lo publica a conductores elegibles via WebSocket. Fee porcentual.
MVP: CABA + GBA.

## Estado actual
- Fases 0-5 COMPLETAS (registro, viajes, matching atomico, GPS/tracking,
  ETA, recalculo de ruta, QR de paradas, cierre, remito PDF, calificaciones,
  vehiculos)
- Boton "Iniciar viaje" (inicio manual + puntualidad) COMPLETO, en produccion
- CI/CD + deploy Railway por environment COMPLETO
- Cancelacion por conductor, cliente y admin COMPLETO
- Panel de administracion COMPLETO
- **En curso: estructura jerarquica (empresas de logistica)**

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
- Los cambios de esta tarea son ADITIVOS (tablas nuevas + columnas
  nullable): db push es seguro, no borra datos.

## Maquina de estados (NUEVO — usar en esta tarea)
Crear src/services/estado-viaje.service.js con las transiciones validas
como estructura de datos y una funcion validarTransicion(actual, destino)
que tira error si no esta permitida. USARLA en:
- El PATCH /api/viajes/:id/estado existente (hoy permite retrocesos invalidos).
- TODOS los endpoints nuevos de esta tarea que cambien el estado del viaje.
NO refactorizar todavia matching.service, cierre.service ni
cancelacion.service (setean un estado fijo, se migran despues).

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
| DESCARGANDO            | FINALIZADO               | QR ultima parada                         |
| cualquiera (no final)  | CANCELADO                | Admin                                    |

## Estructura jerarquica (esta tarea)

### Actores
- CLIENTE: sin cambios, crea viajes.
- Conductor INDEPENDIENTE: sin empresa, ve/acepta/coordina viajes con sus
  propios vehiculos. Igual que hoy, NO se toca.
- Conductor AFILIADO: pertenece a 1 o N empresas. CONSERVA su menu personal
  (sigue viendo y aceptando viajes propios con sus propios vehiculos), y
  ADEMAS recibe asignaciones de sus gerentes en una pestaña aparte.
- GERENTE: responsable de una empresa. Ve viajes disponibles, los reserva,
  asigna conductor + vehiculo de su flota, registra vehiculos de la empresa,
  aprueba y desafilia conductores, ve el tracking de los viajes de su empresa.

### Modelos nuevos
- Empresa: nombre, cuit, codigo_afiliacion (unico), id_gerente, activa.
- ConductorEmpresa (N-a-N): id_conductor, id_empresa, estado
  (PENDIENTE | ACTIVO), fecha_alta, fecha_baja.

### Cambios en modelos existentes
- Vehiculo: dueño explicito — id_conductor (nullable) O id_empresa (nullable),
  exactamente uno de los dos. Los vehiculos de hoy son de conductor.
- Viaje: id_empresa (nullable), fecha_reserva (nullable), iniciado_por
  (nullable: "CONDUCTOR" | "GERENTE").

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
- El gerente reserva (atomico, mismo patron que el aceptar de hoy) →
  RESERVADO_POR_EMPRESA. El viaje sale del pool para el resto.
- El gerente asigna cualquier conductor ACTIVO de su empresa + cualquier
  vehiculo de la flota que cumpla las condiciones → CONDUCTOR_ASIGNADO.
- Puede reasignar conductor/vehiculo mientras el viaje no arranco.
- Si tarda mas de RESERVA_TIMEOUT_MINUTOS sin asignar → se cancela la
  reserva automaticamente y vuelve a BUSCANDO_CONDUCTOR. Tambien puede
  soltarlo el gerente a mano (cancelar-reserva).
- IMPORTANTE: cancelar-reserva y el job de timeout NO alcanzan con emitir al
  room viejo: republican el viaje DE CERO — re-corren la elegibilidad de
  conductores independientes + obtenerGerentesElegibles y suman a esa gente al
  room, reusando publicarViajeAConductoresElegibles (la MISMA funcion que la
  cancelacion de un conductor independiente). Asi, alguien que se conecto
  DESPUES de la reserva original tambien recibe viaje:disponible.

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
- De CONDUCTOR_ASIGNADO en adelante, el flujo es identico al de hoy.

### Calificacion
- Se califica al conductor, como hoy.
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

## Eventos WebSocket nuevos
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

## Variables de entorno de esta tarea
RESERVA_TIMEOUT_MINUTOS=10   (nueva, con default en codigo si no esta en .env)

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
node scripts/test-visibilidad-gerente.js   (nuevo, visibilidad del gerente)
node scripts/test-zona.js                  (nuevo, deteccion de zona)
node scripts/test-acceso-gerente.js        (nuevo, acceso del gerente a
                                            detalle / costo-acumulado / remito)