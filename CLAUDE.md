# Fleter — Backend

## Descripcion del proyecto
Sistema administrativo de fletes para PyMEs argentinas (antes: marketplace).
Una PyME registra y sigue sus viajes con choferes de confianza: asigna el viaje
a un chofer vinculado, el chofer confirma o rechaza y lo ejecuta, y la PyME lo
sigue en vivo. El marketplace viejo (el sistema publica el viaje a conductores
elegibles) queda DORMIDO detras de MARKETPLACE_HABILITADO. MVP: CABA + GBA.

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
- Viajes vencidos: flag `vencido` en el read + evento viaje:vencido COMPLETO
- Historial de estados del viaje, metricas por etapa (tiempo de peon),
  puntualidad medida en la LLEGADA al origen y guard atomico en iniciar COMPLETO
- PASO 1 del modelo nuevo — Identidad (PyMEs, miembros, invitaciones por
  codigo, vinculo PyME-chofer) COMPLETO. Solo agrega: el flujo de viajes,
  marketplace, gerente, empresas, afiliaciones y calificaciones NO cambio (se
  reemplaza en el Paso 2). Ver "Identidad — PyMEs, miembros, invitaciones y
  choferes".
- PASO 2 — Viaje interno (la PyME asigna a un chofer vinculado, el chofer
  confirma / rechaza / inicia en el origen; vencimiento, cancelacion,
  reasignacion, edicion; la desvinculacion cancela los viajes vivos; sala de
  socket por PyME) COMPLETO. Marketplace, gerente, empresas, afiliaciones y
  calificaciones DORMIDOS detras de flags (no se borro nada). Ver "Viaje
  interno (Paso 2)".
- PASO 3 — Google Maps por Routes API detras de una capa unica, duracion
  estimada = tramos con trafico + peon por parada, fin del mock (503 / 400),
  manejo y peon estimados y reales por viaje y por parada, distancia estimada
  y real, y CICLO POR PARADA del viaje interno (iniciar / confirmar llegada /
  salir) COMPLETO. El precio NO cambio. Ver "Google Maps, duracion y manejo /
  peon (Paso 3)".
- PASO 4 — LUGARES GUARDADOS de la PyME (snapshot en la parada, el chofer
  nunca ve el nombre), SERIES de viajes (todo o nada, hora argentina, un
  serie:asignada) y tope GLOBAL de paradas por viaje (MAX_PARADAS_POR_VIAJE)
  COMPLETO. Ver "Lugares guardados y series (Paso 4)".
- MANTENIMIENTO DE TESTS — key de Firebase fuera del codigo, limpieza
  compartida en TODAS las suites, restos.js, intermitentes arreglados, runner
  unico (npm run test:regresion), exploratorias a scripts/legacy/,
  .env.example completo y log de desconexion de socket con motivo COMPLETO. Ver
  "Regresion y limpieza de tests".
- TAREA 5 — CIERRE SIN "SALIR": deteccion de salida por GPS en cualquier parada,
  finalizar a mano por la PyME, cierre automatico a fin del dia (completo o
  incompleto), corte del precio separado de la formula, 409 sobre viajes
  cerrados, un solo viaje en curso por chofer y el emisor de ETA sin queries
  cuando no quedan paradas. Ver "Cierre sin Salir y deteccion de salida
  (Tarea 5)".
- PEDIDO DEL FRONT 20-10-2026 — condiciones especiales FUERA del ciclo interno
  (no se piden, no se validan, no se devuelven), MOTIVO del viaje (columna
  nueva) y DESCRIPCION obligatorios al crear (viaje y serie) y en el estado
  resultante de editar, licencia del chofer opcional en la base (Paso A; el
  registro la sigue exigiendo hasta LICENCIA_OPCIONAL=true) y el SIMULADOR DEL
  FRONT en e2e/sim (contrato corregido, casos de la Tarea 5, paso de CI,
  categoria `sim` de restos.js) COMPLETO. Ver "Pedido del front 20-10-2026".

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
- CUALQUIER cambio en el ciclo del viaje interno (endpoints, estados, mensajes
  de error, campos o eventos de crear / confirmar / iniciar / salir /
  confirmar-parada / finalizar / cancelar) actualiza en el MISMO PR el
  simulador del front (e2e/sim/sim-finalizar-viaje.mjs) y su contrato
  (e2e/sim/CONTRATO-FINALIZAR.md). El front y el mobile dependen de ese
  contrato; el simulador corre en CI contra staging.

## Reglas de migraciones Prisma
- Hay drift. Usar npx prisma db push. NUNCA migrate reset/dev sin
  autorizacion explicita de Samuel.
- La DB de Neon esta COMPARTIDA entre staging y produccion: un db push
  local toca el schema de produccion en ese mismo instante. Solo cambios
  ADITIVOS (tablas nuevas, columnas nullable) son seguros. NUNCA dropear
  ni renombrar columnas sin autorizacion explicita.
- El reemplazo del QR por proximidad NO tuvo cambios de schema.
- Paso 1 (identidad): 6 enums nuevos y 4 tablas nuevas (organizaciones,
  miembros_organizacion, invitaciones, vinculos_chofer), con FKs e indices SOLO
  sobre esas tablas. Las back-relations en Usuario y Conductor no generan DDL.
  Se reviso con `npx prisma migrate diff --from-schema-datasource
  prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`
  antes del db push (ojo: --from-url "$DATABASE_URL" no anda si la variable no
  esta exportada en el shell; --from-schema-datasource la lee del .env).
- Paso 2 (viaje interno): EstadoViaje suma ASIGNADO, CONFIRMADO, RECHAZADO y
  VENCIDO (ALTER TYPE ... ADD VALUE, los valores viejos quedan); enum nuevo
  CausaCancelacion; 6 columnas NULLABLE en viajes (id_organizacion, id_creador,
  metodo_cobro, fecha_confirmacion, fecha_rechazo, causa_cancelacion), 1 indice
  (id_organizacion, estado) y 2 FKs (ON DELETE SET NULL). Revisado con el mismo
  migrate diff: sin DROP ni ALTER destructivo. id_cliente sigue NOT NULL (ver
  "Viaje interno").
- Paso 3 (manejo / peon): 6 columnas NULLABLE en viajes (manejo_estimado_horas,
  peon_estimado_horas, distancia_estimada_km, manejo_real_horas,
  peon_real_horas, distancia_real_km) y 9 en paradas (llegada_estimada,
  salida_estimada, peon_estimado_horas, manejo_estimado_horas,
  distancia_estimada_km, llegada_real, salida_real, peon_real_horas,
  manejo_real_horas). Sin enums, indices ni FKs. Revisado con el mismo migrate
  diff: solo ADD COLUMN.
- Paso 4 (lugares / series): 2 enums NUEVOS (FrecuenciaSerie, EstadoSerie; no se
  toco ningun enum existente), 2 tablas nuevas (lugares, series_viaje) con sus
  indices y FKs RESTRICT, 1 columna NULLABLE en paradas (id_lugar) y 1 en viajes
  (id_serie), cada una con su FK ON DELETE SET NULL, y el indice
  viajes(id_serie). Revisado con el mismo migrate diff: sin DROP, sin ALTER
  COLUMN, sin ALTER TYPE. Las FKs nuevas sobre viajes / paradas se agregaron con
  todas las filas en NULL (validacion instantanea).
- Tarea 5 (cierre sin "Salir"): 2 enums NUEVOS (CierreViaje, OrigenSalida; no se
  toco ningun enum existente), 2 columnas NULLABLE en viajes (cerrado_por,
  fecha_corte_precio) y 3 en paradas (salida_detectada, origen_salida,
  no_visitada). Sin indices ni FKs. "No visitada" es una columna Boolean y NO un
  valor nuevo de EstadoParada, justamente por el OJO de abajo. Revisado con el
  mismo migrate diff: solo CREATE TYPE + ADD COLUMN.
- Pedido del front 20-10-2026: 1 columna NULLABLE en viajes (motivo) y 1 en
  series_viaje (motivo), y DROP NOT NULL en conductores.nro_licencia y
  conductores.licencia_vencimiento (relajante, metadata-only). Sin enums,
  indices ni FKs. Revisado con el mismo migrate diff: solo ADD COLUMN + ALTER
  COLUMN ... DROP NOT NULL. Las condiciones (condicion_requerida,
  series_viaje.condiciones, el enum TipoCondicion) NO se tocaron: quedan sin uso
  en el ciclo interno hasta separar las DBs.
- OJO con relajar un NOT NULL mientras la DB esta compartida: es compatible
  para ESCRIBIR, pero el Prisma VIEJO (production antes del merge a main) TIRA
  al LEER una fila con NULL en esa columna (p. ej. GET /api/admin/usuarios, que
  trae `conductor: true`). Por eso el codigo nuevo NO escribe NULL hasta que se
  prenda LICENCIA_OPCIONAL, y eso va recien con main desplegado. Antes del merge
  a main: `SELECT count(*) FROM conductores WHERE nro_licencia IS NULL OR
  licencia_vencimiento IS NULL` tiene que dar 0.
- OJO con agregar valores a un enum mientras la DB esta compartida: el Prisma
  de un deploy VIEJO no conoce los valores nuevos y TIRA al leer una fila que
  los tenga (p. ej. el panel admin de produccion antes de que main tenga el
  codigo). Achicar la ventana entre el merge a develop y el merge a main, y no
  dejar viajes con estados nuevos vivos en staging en el medio.

## Identidad — PyMEs, miembros, invitaciones y choferes (Paso 1)

Fleter se relanza como app de control y trazabilidad: una PyME registra y sigue
sus viajes con choferes de confianza. El Paso 1 es SOLO la capa de identidad.
Todavia no esta conectada a viajes: eso es el Paso 2.

### Cuentas
- `usuario.rol` ES el tipo de cuenta y no cambia despues del registro (PUT
  /api/auth/perfil no acepta rol). CLIENTE = usuario de PyME, CONDUCTOR = chofer,
  ADMIN. GERENTE queda como estaba. Quien es PyME y chofer a la vez usa DOS
  cuentas.
- Registro de CLIENTE: empresa y CUIT no son obligatorios (ya no lo eran:
  Cliente.cuit / nombre_empresa eran String? y el Zod los tenia .optional(); no
  hizo falta tocar columnas). Si llegan se guardan como campos LEGACY y nada
  nuevo los usa: la PyME es Organizacion.
- CLIENTE huerfano (sin membresia activa): en lo nuevo solo puede crear una PyME
  o canjear un codigo de MIEMBRO. Todo /api/organizaciones/:id/* pasa por
  requireMiembro -> 403 "No perteneces a esta PyME", exista o no la PyME.
- CONDUCTOR sin vinculos: solo canjea codigos de CHOFER (GET
  mis-organizaciones le devuelve []).
- NO existe endpoint para borrar la cuenta (ni en auth ni en admin), asi que no
  hubo que bloquearlo para el ultimo responsable. Si se crea, TIENE que negarse
  mientras el usuario sea el ultimo responsable activo de su PyME (reusar
  darDeBaja / la cuenta de responsables de organizacion.service.js).

### Modelos (prisma/schema.prisma)
- Organizacion: nombre, cuit (normalizado, 11 digitos), razon_social?,
  direccion?, estado TRIAL | ACTIVA | SUSPENDIDA (default TRIAL; las
  transiciones son del Paso 5, hoy solo existe el campo).
- MiembroOrganizacion: id_organizacion, id_usuario, rol RESPONSABLE | MIEMBRO
  (enum que va a crecer), activo, fecha_alta, fecha_baja, motivo_baja
  (SE_FUE | ELIMINADO), baja_por_id_usuario (sin FK).
- Invitacion: id_organizacion, tipo MIEMBRO | CHOFER, codigo_hash (@unique),
  creada_por, fecha_vencimiento, fecha_uso / usada_por, fecha_revocacion /
  revocada_por.
- VinculoChofer: id_organizacion, id_conductor, activo, fecha_alta, fecha_baja,
  desvinculado_por (CHOFER | ORGANIZACION) + desvinculado_por_id_usuario,
  metodo_cobro (enum con un unico valor, CALCULO_PLATAFORMA) + parametros_cobro
  (Json?, para metodos futuros), id_invitacion. Nadie puede cambiar el metodo de
  cobro todavia.
- Membresias y vinculos NO tienen unique (organizacion, usuario/conductor): irse
  y volver, o desvincularse y revincularse, crea una fila NUEVA. Cada paso queda
  en el historial.

### Invariantes y como se sostienen
Ninguna es un constraint (CUIT por pedido explicito; las otras no son de fila).
Se sostienen serializando las operaciones con locks dentro de una $transaction
interactiva (OPCIONES_TX: maxWait 10s, timeout 20s):

| Invariante                                   | Lock                                          | Operaciones                   |
|----------------------------------------------|-----------------------------------------------|-------------------------------|
| Una sola PyME activa por usuario (MAX_ORGANIZACIONES_POR_USUARIO, default 1) | SELECT ... FROM usuarios FOR UPDATE (fila del actor) | crear PyME, canjear           |
| Toda PyME tiene >= 1 RESPONSABLE activo      | SELECT ... FROM organizaciones FOR UPDATE      | cambiar rol, eliminar, irse   |
| CUIT unico entre PyMEs                       | pg_advisory_xact_lock(hashtext('org-cuit:'+cuit)) | crear, editar              |
| Un codigo se usa una sola vez                | updateMany condicionado a pendiente, en la MISMA tx que crea la membresia/vinculo | canjear |

- Los dos primeros locks nunca se toman en la misma transaccion: no hay orden
  que pueda hacer deadlock.
- Las operaciones sobre miembros RE-chequean adentro de la tx (ya con la PyME
  bloqueada) que el actor siga siendo RESPONSABLE activo (exigirResponsable): el
  middleware chequea antes del lock y otro responsable lo pudo haber degradado.
- Eliminar a OTRO responsable nunca choca con "ultimo responsable" (si el actor
  es responsable hay al menos dos). El 409 de eliminar solo es alcanzable cuando
  un responsable se elimina A SI MISMO (cuenta como SE_FUE). Dos responsables
  eliminandose mutuamente a la vez: gana uno, el otro recibe 403 (ya no es
  miembro cuando le toca el lock).
- Cada guard esta VERIFICADO revirtiendolo (protocolo de reversion con
  test-identidad.js): sin el lock de usuario, CASO 11 da 200,200 y el usuario
  termina en 2 PyMEs; sin el lock de la PyME, CASO 10 deja la PyME con 0
  responsables; sin el condicional del canje, CASO 9 da 200,200 con el mismo
  codigo.

### Permisos
- Solo RESPONSABLE: generar y revocar codigos de MIEMBRO, eliminar miembros,
  editar la PyME, cambiar roles (promover / degradar, incluido a si mismo).
- Cualquier miembro activo: ver la PyME, sus miembros activos y las
  invitaciones pendientes; generar y revocar codigos de CHOFER; listar choferes
  y desvincularlos; irse.
- Cualquier miembro se va solo, salvo el ultimo responsable (409).

### Invitaciones — src/services/invitacion.service.js
- Codigo de 10 caracteres con crypto.randomInt sobre el alfabeto sin ambiguos
  (sin 0/O ni 1/I/L; el mismo de codigo_afiliacion, replicado porque
  afiliacion.service no lo exporta y es del Paso 2). Se muestra XXXXX-XXXXX.
- En la base SOLO va HMAC-SHA256(codigo normalizado, INVITACION_SECRETO). El
  codigo en claro se devuelve UNA vez, en la respuesta de creacion. El listado
  de pendientes no trae ni codigo ni hash.
- Sin INVITACION_SECRETO el server arranca, loguea "[invitaciones]
  INVITACION_SECRETO no configurado" y los endpoints de invitaciones (crear,
  listar, revocar, canjear) responden 503. El secreto se lee en cada request.
- Vence a las INVITACION_VIGENCIA_HORAS (72), un solo uso, revocable (solo si
  esta pendiente; si no, 409).
- Canje: UN endpoint. CLIENTE -> solo MIEMBRO (queda MIEMBRO). CONDUCTOR -> solo
  CHOFER (queda vinculado). Ignora guiones, espacios y mayusculas.
- ERRORES, en este orden (es contrato, esta igual en API.md):
  1. 503 sin secreto.
  2. 429 rate limit (va ANTES del body: un intento con basura cuenta igual).
  3. 400 body invalido.
  4. Estado del usuario, EXPLICITO y antes de buscar el codigo: CLIENTE con PyME
     activa -> 409 "Ya perteneces a una PyME" (aun con un codigo inexistente).
  5. Cualquier falla del codigo -> 400 { "error": "Codigo invalido" }, IDENTICO
     byte a byte: no existe, vencido, usado, revocado, de otro tipo, formato
     basura, o perdio la carrera contra otro canje.
  - Matiz: "ya vinculado a ESA PyME" (CONDUCTOR) solo se puede saber con el
    codigo resuelto, porque es el codigo el que dice de que PyME es. Se chequea
    recien con un codigo VALIDO -> 409 "Ya estas vinculado a esta PyME", y el
    codigo NO se consume. No filtra nada: solo se entera quien tiene un codigo
    bueno.
- Rate limit (rate-limit-canje.service.js): INVITACION_INTENTOS_MAX (5) cada
  INVITACION_VENTANA_MINUTOS (15), por usuario Y por IP, contando cada intento.
  MULTI de SET NX EX + INCR (la clave nunca queda sin TTL; no depende de EXPIRE
  NX de Redis 7). IP = ultimo valor de X-Forwarded-For (el que agrega el proxy
  de Railway) o el socket; NO se activo `trust proxy` para no cambiar req.ip en
  toda la app. Si Redis no esta `ready` o no responde en 1s -> se deja pasar y
  se loguea "[invitaciones] rate limit sin Redis". Ese chequeo de status existe
  porque ioredis ENCOLA comandos mientras reconecta: sin el, con Redis caido el
  request quedaria colgado.

### Vinculo PyME-chofer — src/services/vinculo-chofer.service.js
- La PyME ve de sus choferes: nombre, apellido, telefono y sus vehiculos
  PROPIOS (patente, marca, modelo, anio, color, tipo, condiciones). NUNCA a que
  otras PyMEs esta vinculado, ni la flota de empresas de logistica donde trabaje
  (conductor_vehiculos: es de otra organizacion).
- El chofer ve el nombre de sus PyMEs (GET /api/choferes/mis-organizaciones y
  `organizaciones` en /me).
- desvincularChofer({ id_organizacion, id_conductor, actor, io }) es la UNICA
  funcion que corta un vinculo; la usan los dos endpoints (desde la PyME, origen
  ORGANIZACION; desde el chofer, origen CHOFER). updateMany condicionado a
  activo -> 0 filas = 404. Desde el Paso 2, en la MISMA transaccion cancela
  todos los viajes no finales de ese chofer con esa PyME (ver "Viaje interno —
  Desvinculacion"). Devuelve los ids cancelados (`viajes_cancelados`).

### Pendientes que siguen abiertos
- Usar metodo_cobro / parametros_cobro del vinculo en el calculo del precio
  (hoy el viaje solo COPIA metodo_cobro del vinculo; el precio es el calculo de
  siempre).
- Cuando se agregue un endpoint de borrar cuenta: bloquearlo para el ultimo
  responsable (ver "Cuentas").
- Transiciones de Organizacion.estado (TRIAL / ACTIVA / SUSPENDIDA): Paso 5.
  Hoy SUSPENDIDA ya bloquea crear / editar / reasignar viajes (403).
- Los campos legacy Cliente.cuit / nombre_empresa / direccion_principal se
  pueden dejar de pedir en el front; se limpian cuando se separen las DBs.

## Viaje interno (Paso 2)

La PyME asigna el viaje DIRECTO a un chofer vinculado, el chofer confirma
(eligiendo vehiculo) o rechaza, lo inicia EN el origen y lo ejecuta. Reemplaza
el ciclo del marketplace (que queda dormido, ver "Flags"). Un viaje es interno
si `id_organizacion != null` (cicloDe en estado-viaje.service).

Archivos: src/services/viaje-interno.service.js (acciones y transacciones),
src/controllers/viajes-internos.controller.js (Zod + HTTP),
src/services/ventana-inicio.js (ventana pura), src/services/viaje-validacion.js
(schemas compartidos con la ruta legacy: paradas, fecha con
ANTICIPACION_MINIMA_MINUTOS; las condiciones quedaron SOLO para la legacy, y
motivo / descripcion son del ciclo interno), src/sockets/salas.js, src/middlewares/flags.middleware.js.

### Modelo
- Viaje: id_organizacion, id_creador (el miembro que lo creo), metodo_cobro
  (COPIA del vinculo al crear y al reasignar), fecha_confirmacion,
  fecha_rechazo, causa_cancelacion (CHOFER | ORGANIZACION | ADMIN |
  DESVINCULACION). motivo_cancelacion sigue siendo el texto libre. Quien y cuando
  cancelo estan en el historial: no hay columnas para eso.
- id_cliente sigue NOT NULL (hacerlo nullable seria un ALTER, se evito): en un
  viaje interno apunta al Cliente del CREADOR, solo porque el schema lo exige.
  NINGUN permiso nuevo lo usa, y los viejos lo ignoran en viajes internos
  (puedeVerViaje solo aplica "cliente dueño" si id_organizacion es null).
- Se reusan id_conductor, id_vehiculo (null hasta confirmar), paradas, tarifas, precios, duracion_estimada_horas, fecha_inicio,
  fecha_llegada_origen e iniciado_por. condiciones_req NO: desde el pedido del
  front 20-10-2026 el ciclo interno no tiene condiciones (ver esa seccion).
- "Vehiculo propio activo" = Vehiculo.id_conductor = el chofer. No hay columna
  `activo`: el borrado es fisico y esta bloqueado con viajes no finales. La flota
  de empresas (conductor_vehiculos) NO cuenta.

### Ciclo — TRANSICIONES_INTERNO (estado -> destino -> quien)
| Desde       | Hacia       | Quien                        | Accion |
|-------------|-------------|------------------------------|--------|
| (crear)     | ASIGNADO    | PYME                         | POST /api/organizaciones/:id/viajes |
| ASIGNADO    | CONFIRMADO  | CHOFER                       | confirmar (elige vehiculo) |
| ASIGNADO    | RECHAZADO   | CHOFER                       | rechazar (final) |
| ASIGNADO    | ASIGNADO    | PYME                         | reasignar / editar — SIN fila de historial |
| CONFIRMADO  | CARGANDO    | CHOFER                       | iniciar = llega a la parada 1 (UNICO camino) |
| CONFIRMADO  | ASIGNADO    | PYME                         | reasignar / editar (hay que reconfirmar) |
| ASIGNADO / CONFIRMADO | CANCELADO | CHOFER, PYME, ADMIN, SISTEMA | cancelar / desvinculacion |
| ASIGNADO / CONFIRMADO | VENCIDO   | SISTEMA                | timer / barrido / chequeo perezoso |
| CARGANDO / DESCARGANDO | EN_RUTA | CHOFER                      | salir de la parada actual (quedan paradas) |
| EN_RUTA     | DESCARGANDO | CHOFER                       | confirmar-parada (llega a la SIGUIENTE) |
| DESCARGANDO | FINALIZADO  | CHOFER                       | salir de la ULTIMA parada |
| DESCARGANDO | FINALIZADO  | PYME                         | finalizar (Tarea 5): llego a la ultima y paso la hora prevista o hay salida detectada |
| CARGANDO / EN_RUTA / DESCARGANDO | FINALIZADO | SISTEMA        | cierre automatico de fin del dia (Tarea 5; desde CARGANDO / EN_RUTA = incompleto) |
| CARGANDO / EN_RUTA / DESCARGANDO | CANCELADO | PYME, ADMIN, SISTEMA | el chofer NO puede cancelar en curso |
Finales: RECHAZADO, VENCIDO, CANCELADO, FINALIZADO. No existe
EN_CAMINO_A_ORIGEN. Desde el Paso 3 (ciclo por parada) el CHOFER ya no puede pasar
EN_RUTA -> FINALIZADO (desde la Tarea 5 solo lo hace el SISTEMA, en el cierre
automatico incompleto), y PATCH /api/viajes/:id/estado NO aplica a viajes
internos (400): todo va por iniciar, confirmar-parada y salir. Ver "Ciclo por
parada" en el Paso 3.
Validada fila por fila en estado-viaje.service.test.js.

### Patron de escritura — TODA accion del ciclo
1. Lectura previa -> 400 descriptivos del caso secuencial.
2. $transaction (OPCIONES_TX): updateMany CONDICIONADO (estado esperado, y el
   chofer y la fecha cuando importan) PRIMERO; count === 0 -> 409. Ese update
   toma el lock de la fila: lo que otra tx pudo cambiar (el vinculo) se re-valida DESPUES en la misma tx, y si falla, rollback.
3. Fuera de la tx: historial, timers, Redis, eventos.
- El vinculo se bloquea (SELECT ... FOR UPDATE ... activo) en crear y reasignar;
  desvincular toma el mismo lock con su updateMany. Orden de locks siempre
  vinculo -> viaje: no hay deadlock.
- Un estado invalido en el caso secuencial da 400; la carrera real da 409.

GUARDS VERIFICADOS REVIRTIENDOLOS (protocolo de reversion, test-viaje-interno.js
CASO 17 con SUBCASOS=...): ver la tabla de resultados en el reporte del Paso 2.
| Guard | Caso que se pone en rojo sin el |
|-------|---------------------------------|
| confirmar: `estado: 'ASIGNADO'` en el WHERE | 17c (doble confirmar: 200,200 y 2 filas CONFIRMADO) |
| confirmar: `id_conductor` en el WHERE | 17d (reasignar vs confirmar: CONFIRMADO con el chofer nuevo y el vehiculo del viejo) |
| confirmar: `fecha_programada >= limite` + su chequeo perezoso | 17b (se confirma un viaje vencido) |
| vencer: `estado in [ASIGNADO, CONFIRMADO]` en el WHERE | 17b (dos filas VENCIDO) |
| iniciar: `estado: 'CONFIRMADO'` en el WHERE | 17e / 17f (un viaje cancelado vuelve a CARGANDO) |
| crear: lock + re-chequeo del vinculo en la tx | 17g (viaje vivo con un chofer desvinculado) |

### Crear — POST /api/organizaciones/:id/viajes (cualquier miembro)
Orden: PyME SUSPENDIDA -> 403; Zod (id_conductor, paradas, fecha con
ANTICIPACION_MINIMA_MINUTOS, motivo, descripcion; condiciones_requeridas se
descarta); vinculo ACTIVO -> si no 400; al menos un vehiculo propio -> si no
400; precio con
estimarCosto SIN cambios (fuera de la tx). Queda ASIGNADO sin vehiculo, ruta
planeada best-effort, timer de vencimiento, viaje:asignado al chofer y a la PyME.

### Chofer — /api/choferes/viajes
- GET (grupo asignados | confirmados | en_curso | historial, o estado=): sus
  viajes internos de TODAS sus PyMEs, cada uno con organizacion.nombre.
- confirmar { id_vehiculo }: cualquier vehiculo PROPIO -> CONFIRMADO (sin
  condiciones, aunque el viaje viejo las tenga guardadas).
- rechazar -> RECHAZADO. Las dos solo desde ASIGNADO.
- iniciar { lat, lng }: CONFIRMADO, dentro de la ventana Y a <=
  RADIO_CONFIRMACION_METROS de la parada de orden 1, con la MISMA distanciaMetros
  y la misma fuente de ubicacion (body) que confirmar-parada. El 400 dice cual
  falla, o las dos. Pasa DIRECTO a CARGANDO con fecha_inicio =
  fecha_llegada_origen = ahora (duracion_aproximacion_origen sale 0: ese tramo
  no existe). La puntualidad se sigue calculando en el read. Desde el Paso 3
  tambien es la LLEGADA a la parada 1 (llegada_real, fecha_entrega, ENTREGADO).
- cancelar: solo ASIGNADO o CONFIRMADO; en curso -> 400 "pedile a la PyME".
- Recorrer las paradas (Paso 3): POST /api/choferes/viajes/:id/salir y
  POST /api/viajes/:id/confirmar-parada. PATCH /api/viajes/:id/estado da 400 en
  un viaje interno. El GPS sigue por el socket conductor:ubicacion.

### PyME — /api/organizaciones/:id/viajes (requireMiembro)
- GET lista (grupo activos | en_curso | historial, o estado=) y GET detalle.
  Scoping SIEMPRE por id_organizacion, nunca por usuario. Viaje de otra PyME ->
  404 (no se filtran ids).
- PUT editar (paradas / fecha / motivo / descripcion, al menos uno): solo
  ASIGNADO o CONFIRMADO. El viaje tiene que QUEDAR con motivo y descripcion
  (un viaje viejo sin alguno -> 400 si no lo manda). Recalcula precio, zona y
  duracion si cambian paradas o fecha, y la ruta si cambian paradas.
  CONFIRMADO -> ASIGNADO con vehiculo null. Reprograma el timer.
- POST reasignar { id_conductor }: solo ASIGNADO o CONFIRMADO, mismas
  validaciones que crear, mismo chofer -> 400. Vuelve a ASIGNADO con vehiculo
  null y metodo_cobro del vinculo nuevo.
- POST cancelar { motivo? }: cualquier estado no final, incluido en curso.
  limpiarViajeActivo (ETA + GPS + Redis).
- GET costo-acumulado (mismo calculo, extraido a calcularCostoAcumulado en
  costo.service) y GET remito.
- SUSPENDIDA bloquea crear, editar y reasignar (403). Cancelar sigue permitido.
- Las rutas viejas por usuario (mis-viajes, mis-viajes-conductor, asignados,
  unirseARoomsCliente) filtran id_organizacion null. GET /api/viajes/:id de un
  viaje interno: solo el chofer asignado (el miembro va por la ruta de la PyME).
  Los viajes internos no se califican.

### Vencimiento — SIN pollers
Un viaje ASIGNADO o CONFIRMADO cuyo fin de ventana (fecha_programada +
VENTANA_INICIO_DESPUES_MINUTOS) ya paso pasa a VENCIDO (final). Tres
mecanismos, todos terminan en vencerViajeInterno (vencimiento.service), cuyo
updateMany condicionado (estado pre-inicio Y fecha vencida en el WHERE) hace
inofensivo dispararse de mas o dos a la vez:
1. Timer por viaje (programarVencimientoInterno), al crear, editar y reasignar.
   Comparte el Map de los avisos legacy: cancelarAvisoVencimiento corta los
   dos. Al disparar RELEE la fila y se re-arma si todavia no toca. Se cancela
   al rechazar, cancelar, iniciar, desvincular, cancelar del admin y cerrar.
2. Barrido de arranque (barridoInicialVencimientosInternos), UNA query. Vence
   los atrasados (secuencial) y arma el resto. Kill-switch
   VENCIMIENTO_BARRIDO_ARRANQUE=0 (solo tests): ESCRIBE en la DB compartida.
3. Chequeo PEREZOSO (vencerSiCorresponde) antes de toda accion y de toda
   lectura de la PyME o del chofer, scopeado a lo suyo. El panel admin NO lo
   usa (no escribe sobre viajes ajenos con la env de otro proceso).
Misma limitacion de un solo proceso que los demas timers.

### El flag `vencido` — UNIFICADO
esViajeVencido sirve a los dos ciclos (los estados no se pisan): VENCIDO -> true;
ASIGNADO / CONFIRMADO -> true si el fin de ventana paso (cubre el hueco hasta el
chequeo perezoso, p. ej. en el admin); legacy -> la regla de siempre, sin
cambios (el viaje legacy sigue sin cambiar de estado). Un solo campo para el front.

### Desvinculacion
desvincularChofer, en UNA transaccion: corta el vinculo (lock) -> SELECT ...
FOR UPDATE de los viajes no finales de ese chofer con ESA PyME -> CANCELADO con
causa DESVINCULACION, incluso uno en curso. Fuera de la tx: historial (origen
del actor), timers, limpiarViajeActivo y viaje:cancelado a la PyME y al chofer.
Los viajes del chofer con OTRAS PyMEs no se tocan. Desde el Paso 4, en la MISMA
tx (despues del vinculo, antes de los viajes) las series ACTIVAS de ese chofer
con ESA PyME pasan a BORRADA con UN UPDATE ... RETURNING (series_borradas son
exactamente las que cambio, aunque un cancelar serie se cruce); devuelve
{ viajes_cancelados, series_borradas }.

### Salas de socket
organizacion:{id} = miembros ACTIVOS. Al conectarse, un CLIENTE entra a las de
sus membresias; se sincroniza (sincronizarSalaOrganizacion) al crear la PyME,
canjear un codigo MIEMBRO, salir y ser eliminado. El chofer recibe lo suyo por
usuario:{id}. Ver "Eventos WebSocket".

### Carrera con un ping GPS en vuelo (arreglada en este paso)
Cancelar (o cerrar) un viaje mientras un ping todavia se procesaba dejaba keys
huerfanas en Redis (gps:{id}:acumulado, y gps:{id}:eta del calculo de ETA que
el ping dispara), y podia re-arrancar el emisor de ETA de un viaje cancelado.
Pasaba tambien en el legacy. Arreglo, sin queries extra por ping:
- limpiarViajeActivo y el cierre anotan CUANDO limpiaron (en memoria, 60 s),
  ANTES de limpiar. El handler de conductor:ubicacion anota cuando EMPEZO y,
  despues de escribir y al final, re-limpia solo si hubo una limpieza
  POSTERIOR a su inicio (relimpiarSiCerrado(id, inicioPing)).
- OJO: comparar contra el inicio del ping NO es decorativo. Una limpieza no
  siempre cierra el viaje: cancelar-conductor y liberarReserva lo devuelven al
  mercado y sigue vivo. La primera version usaba un simple "fue cerrado hace
  menos de 60 s" y rompia test-cancelacion-conductor PUNTO 4: el conductor que
  reaceptaba el viaje veia su primer ping re-limpiado (acumulado ausente).
- emitirEta, si al terminar de calcular el emisor ya fue detenido, borra la key
  de ETA y no emite.
Cubierto por CASO 8e de test-viaje-interno.js.

### Remito
bloqueSolicitante(viaje) (pura): en un viaje interno el encabezado es "PYME"
con nombre, CUIT (XX-XXXXXXXX-X) y razon social; el creador no aparece. Legacy
sin cambios.

### Admin
Lista y detalle con `organizacion` (y `creador` en el detalle); filtro y
estadisticas con los 4 estados nuevos. El cancelar del admin es ahora un
updateMany condicionado (409 si pierde una carrera); en un viaje interno setea
causa ADMIN y emite viaje:cancelado a la PyME y al chofer.

### Flags
- MARKETPLACE_HABILITADO (default false). Con false dan 404 `{ "error": "No
  encontrado" }` (el middleware va ANTES de verificarToken: 404 con o sin
  token): POST /api/viajes (crear viejo), GET /api/viajes/disponibles,
  POST /api/viajes/:id/{reservar,asignar,reasignar,cancelar-reserva}, todo
  /api/empresas, todo /api/afiliaciones y POST /api/auth/registro-gerente. El
  socket viaje:aceptar responde error "Funcion no disponible", publicarViaje no
  emite viaje:disponible, el conductor no se une al pool al conectarse y no
  corre barridoInicialReservas.
- CALIFICACIONES_HABILITADAS (default false): POST /api/viajes/:id/calificacion
  -> 404. Flag PROPIO: las calificaciones pueden volver sin el marketplace (una
  PyME calificando a sus choferes encaja en el modelo nuevo).
- Siguen SIN flag (sirven a viajes legacy vivos o son compartidas):
  estimar-costo, mis-viajes*, asignados, cancelar-cliente, cancelar-conductor,
  el iniciar legacy, PATCH /estado, confirmar-parada, costo-acumulado, remito y
  GET /:id.
- Con los dos en true todo lo viejo funciona igual que antes (regresion).
- GET /health devuelve `capacidades: ['viaje-interno']` (ver "CI").

### Decisiones de interpretacion (Paso 2)
D1 id_cliente NOT NULL = el creador (ancla). D2 vehiculo activo = propio y
existente. D3 dos tablas, un validarTransicion. D4 historial reusa ORIGENES
(chofer CONDUCTOR, PyME CLIENTE). D5 iniciar dice que falla; pasada la ventana
el viaje ya vencio; secuencial 400, carrera 409. D6 EN_RUTA -> FINALIZADO en la
tabla. D7 aproximacion al origen = 0. D8 SUSPENDIDA bloquea crear / editar /
reasignar. D9 flag propio de calificaciones. D10 el admin no hace chequeo
perezoso. D11 iniciar legacy con VENTANA_INICIO_ANTES_MINUTOS (el fallback a la
vieja VENTANA_INICIO_MINUTOS se saco en el mantenimiento de tests), sin limite
superior. D12 causa_cancelacion enum; quien / cuando en el historial.

### PENDIENTE (lo que quedo del Paso 2)
- HECHO en el Paso 3: Routes API, algoritmo de duracion y 503 en vez del mock.
- Usar metodo_cobro / parametros_cobro del vinculo en el precio.
- HECHO en la Tarea 5: un chofer no puede iniciar un viaje con otro en curso
  (409, con lock del chofer en la tx).
- Migrar matching / cancelacion legacy a validarTransicion + updateMany
  condicionado (cancelar-cliente y cancelar-conductor legacy siguen siendo
  update plano).
- Mover los timers (reservas, avisos, vencimientos) a una cola persistente el
  dia que haya mas de una instancia.

## Google Maps, duracion y manejo / peon (Paso 3)

### Capa unica — src/services/maps/
UNICO modulo que habla con Google: nadie mas hace fetch a routes.googleapis.com
ni a maps.googleapis.com (verificable con grep). index.js expone tres funciones:
| Funcion | Uso | routingPreference | FieldMask | SKU |
|---|---|---|---|---|
| calcularTramo({origen, destino, salida}) | crear / editar / estimar (algoritmo) | TRAFFIC_AWARE + departureTime | routes.duration, routes.distanceMeters, routes.polyline.encodedPolyline | Pro |
| calcularEta({origen, destino}) | emisor de ETA | TRAFFIC_AWARE, sin departureTime (= ahora) | routes.duration, routes.distanceMeters | Pro |
| calcularRuta(puntos) | desvio y fallback de ruta de gps.socket | TRAFFIC_UNAWARE + intermediates | routes.polyline.encodedPolyline | Essentials (Pro con > 10 intermedios) |
- comun.js (PURO, testeado sin red): ErrorMaps, conversiones ("123s" -> s,
  metros -> km), polilinea -> [lng, lat], concatenacion de tramos.
- routes.js / legacy.js: solo ARMAN el pedido y LEEN la respuesta. index.js pone
  el fetch, el timeout (AbortSignal.timeout(MAPS_TIMEOUT_MS), default 8000), el
  log por llamada ("[maps] routes tramo 200 312ms (PRO=12 ESSENTIALS=3)") y el
  contador por SKU (estadisticasMaps). NUNCA se loguea la URL (en legacy lleva
  la key) ni la key; test unitario que lo verifica.
- departureTime: Routes da 400 si es pasado ("Timestamp must be set to a future
  time"); si la salida es <= ahora + 60 s NO se manda (Google usa "ahora").
- MAPS_PROVIDER=legacy (Directions) es un ROLLBACK TEMPORAL: las tres
  operaciones en ~80 lineas reusando todo comun.js. Distance Matrix ya no se
  usa. Se borra cuando Routes lleve 1 a 2 semanas estable en produccion.
- Doc: computeRoutes (https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes),
  field mask obligatoria (.../routes/choose_fields), SKUs
  (.../routes/usage-and-billing): TRAFFIC_AWARE -> Pro; la polilinea no cambia
  el SKU.

### REGLA: nunca valores inventados
Si Google falla, la capa TIRA ErrorMaps (extiende ErrorNegocio):
- NO_DISPONIBLE -> 503 { error: 'No se pudo calcular la ruta. Probá de nuevo en
  unos minutos.' }: sin key, timeout, red, 401 / 403 / 429 / 5xx, o un 4xx de
  Google (un 400 de Google es un bug nuestro, no del usuario).
- SIN_RUTA -> 400: Google respondio y routes vino vacio. El algoritmo lo
  re-tira con "No hay una ruta en auto entre la parada N y la parada N+1".
Cada caller:
- crear interno, editar, estimar-costo y POST /api/viajes (dormido): el
  calculo va ANTES de cualquier tx -> el error sale por responderErrorNegocio y
  no se crea ni modifica nada.
- ETA (eta-emisor): saltea ESE ciclo, loguea "[eta-emisor] viaje X: ciclo
  salteado" y no emite. Ya no hay ETA por linea recta.
- Desvio: mantiene la ruta anterior, loguea y consume el cooldown igual (sin
  cooldown, durante una caida de Google se reintentaria en cada ping).
- Fallback de ruta en gps.socket: sigue sin ruta (como antes).
Se borraron el mock de costo.service (10 km / 0.5 h), obtenerRutaMock /
obtenerRutaOptima (ruta recta) y el fallback de linea recta del ETA.

### Algoritmo de duracion — src/services/estimacion.service.js
estimarRecorrido({ paradas, inicio, peonMinutos, calcularTramo }) es PURA (el
tramo se inyecta; tests sin red en estimacion.service.test.js):
- Arranca en fecha_programada (si falta o ya paso, "ahora").
- En CADA parada (origen, intermedias y destino) suma TIEMPO_PEON_MINUTOS (30)
  de PEON: salida = llegada + peon.
- Cada tramo es MANEJO, pedido con hora de salida = salida de la parada
  anterior (secuencial: cada llamada depende de la anterior).
- Ejemplo A -> B -> C a las 10:00: peon A 10:00-10:30; manejo A->B 40 min ->
  11:10; peon B hasta 11:40; manejo B->C 25 min -> 12:05; peon C hasta 12:35.
  Total 2 h 35 = manejo 1 h 05 + peon 1 h 30.
- Devuelve por parada llegada / salida estimadas, peon y el manejo / distancia
  del tramo que LLEGA (null en la 1); totales (distancia, manejo, peon, total,
  inicio y fin); y la polilinea concatenada de los tramos.
- Un error en un tramo se propaga: nunca se completa con valores inventados.
- costo.service.estimarCosto lo usa. EL PRECIO NO CAMBIO: tarifa.service y
  repartirPorZona reciben el MANEJO (ahora con trafico) y la distancia, como
  antes. desglose.tiempo_horas sigue siendo el manejo. La zona sale de las
  coordenadas de las paradas, no de la geometria.
- duracion_estimada_horas pasa a ser el TOTAL (manejo + peon).
- Ruta planeada: la polilinea concatenada de los MISMOS tramos (mismo SKU), se
  guarda con guardarRutaPlaneada (misma key gps:{id}:ruta, [lng, lat]). Ya no
  hay llamada aparte al crear / editar. calcularYGuardarRuta queda para el
  fallback de gps.socket.
- Llamadas a Google: crear / editar (si cambian paradas o fecha) / estimar =
  paradas - 1 (Pro). ETA ~ 1 Pro cada ETA_RECALCULO_SEGUNDOS (360) de viaje en
  curso + 1 por cada confirmacion / salida / desvio. Desvio = 1 Essentials.

### Ciclo por parada (viaje interno)
Cada parada tiene LLEGADA y SALIDA reales:
| Accion | Ruta | Estado | Escribe |
|---|---|---|---|
| iniciar | POST /api/choferes/viajes/:id/iniciar | CONFIRMADO -> CARGANDO | parada 1: llegada_real, fecha_entrega, ENTREGADO |
| salir | POST /api/choferes/viajes/:id/salir (sin body) | CARGANDO / DESCARGANDO -> EN_RUTA | parada abierta: salida_real, peon_real_horas; totales del viaje |
| confirmar-parada | POST /api/viajes/:id/confirmar-parada | EN_RUTA -> DESCARGANDO | la SIGUIENTE: llegada_real, manejo_real_horas del tramo, fecha_entrega, ENTREGADO |
| salir de la ULTIMA | POST /api/choferes/viajes/:id/salir | DESCARGANDO -> FINALIZADO | el cierre de siempre (precio real, remito, distancia real) + reales, en UNA tx |
- DESCARGANDO ahora significa "en una parada" (carga o descarga).
- Confirmar la ULTIMA ya NO finaliza; finaliza el "salir" de la ultima.
- Orden obligatorio. Contrato de confirmar-parada en un viaje interno (legacy
  sin cambios): 404 -> 403 -> parada ajena 400 -> ya confirmada 400 ->
  estado != EN_RUTA 400 ("Todavia estas en una parada: toca Salir...") -> no es
  la siguiente 400 ("Primero tenes que confirmar la parada N") -> distancia 400.
- salir NO valida proximidad (la salida es irse; con GPS malo no se podria
  salir). salir en EN_RUTA -> 400 "No estas en ninguna parada".
- Guards (patron de siempre, en tx): salir = viaje.updateMany con el estado
  leido + parada.updateMany { salida_real: null } de la abierta; confirmar =
  viaje.updateMany { estado: EN_RUTA, id_conductor } + parada.updateMany
  { llegada_real: null } + re-chequeo de que la anterior salio; cierre interno =
  updateMany { estado: DESCARGANDO } + salida de la ultima. Cualquiera en 0 ->
  409 y rollback. Cubiertos por CASO 17h (doble salir, de la 1 y de la ultima),
  17i (salir vs cancelar) y 17j (confirmar vs cancelar).
- La fila del historial se escribe con el MISMO instante que la llegada / salida
  (registrarCambioEstado acepta `fecha` opcional): contra Neon el insert llega
  ~1 s despues de la tx y si no, no coincidian.
- Eventos: viaje:estado_cambiado suma id_parada (aditivo) en iniciar, salir y
  confirmar; viaje:finalizado suma estimado, real y paradas. ETA inmediato al
  confirmar y al salir (best-effort).

### Manejo y peon REALES — tiempos-reales.js (puro) + medicion-real.service.js
- Interno: peon de una parada = salida_real - llegada_real; manejo de un tramo =
  llegada_real - salida_real de la anterior; totales = sumas. real total =
  llegada a la 1 -> salida de la ultima = MISMO intervalo que el estimado.
- Legacy (ciclo sin cambios): solo por viaje, desde el historial: CARGANDO +
  DESCARGANDO = peon, EN_RUTA = manejo; se guardan al cerrar.
- Se GUARDAN: en cada confirmar (manejo del tramo), en cada salir (peon de la
  parada + totales), al cerrar (en la tx del cierre) y, si se cancela EN CURSO
  (PyME, admin, desvinculacion), guardarMedicionParcial(id_viaje, fin) DESPUES
  del commit y ANTES de limpiarViajeActivo. La parada abierta se cierra en `fin`
  solo para el calculo (peon_real_horas si, salida_real queda null); si se
  cancela manejando, el tramo parcial suma al manejo del VIAJE. Nunca tira.
- distancia_real_km = el acumulado GPS de Redis, leido ANTES de limpiarGPS (al
  cerrar, o el parcial al cancelar en curso). null si no hubo pings.
- Metricas viejas en internos (calcularMetricasViaje elige por cicloDe):
  duracion_real = real total en minutos (llegada 1 -> salida ultima),
  duracion_carga = peon de la parada 1, duracion_descarga = peon de la ultima.
  Legacy identico. Por eso mis-viajes-conductor (select explicito) pide
  id_organizacion.

### Persistencia y API
- Horas en la base, minutos en la API (regla de duracion.service). Las columnas
  de parada llevan _horas; la API expone _min enteros.
- Estimado: se escribe al crear (interno y legacy) y se reescribe al editar
  (paradas nuevas -> createMany con estimados; solo fecha -> update de cada
  parada dentro de la tx, releyendolas con el lock). Reasignar no recalcula.
- bloqueTiempos(viaje) -> estimado { manejo_horas, peon_horas, total_horas,
  distancia_km } (null en viajes viejos) y real { ... } (null hasta FINALIZADO,
  o CANCELADO con algo medido). tiemposParada(p) -> peon_estimado_min,
  manejo_estimado_min, peon_real_min, manejo_real_min, diferencia_min
  (llegada_real - llegada_estimada). Canales: detalle y listas de la PyME y del
  chofer, admin (lista: bloque; detalle: bloque + paradas), respuesta de crear y
  viaje:finalizado. estimar-costo devuelve estimado (con inicio / fin) y tramos.

### PENDIENTES (Paso 4 o despues)
- HECHO en la Tarea 5: si el chofer no toca "Salir" en la ULTIMA parada, la PyME
  puede finalizar y el viaje se cierra solo a fin del dia.
- Borrar maps/legacy.js cuando Routes lleve 1 a 2 semanas estable.
- Tarifario con peon y manejo por separado (las columnas ya estan).
- Front mobile: boton Salir en cada parada (ver API.md "Cambio de contrato para
  mobile").

## Lugares guardados y series (Paso 4)

Archivos: src/services/lugar.service.js + controllers/lugares.controller.js;
src/services/serie.service.js + controllers/series.controller.js;
src/services/serie-fechas.js (PURO: fechas y zona horaria);
src/services/limite-concurrencia.js (PURO: ejecutarConLimite);
src/services/vista-parada.js (PURO: que ve cada uno de una parada). Rutas bajo
/api/organizaciones/:id/{lugares,series}, cualquier miembro activo
(requireMiembro). Recurso de otra PyME -> 404.

### Tope GLOBAL de paradas — MAX_PARADAS_POR_VIAJE (default 10)
Vive en schemaParadas (viaje-validacion.js), asi vale para TODO lo que lo usa:
crear y editar interno, estimar-costo, POST /api/viajes legacy y la plantilla de
las series. 400 "Un viaje puede tener como máximo N paradas". En EDITAR el schema
es .optional(): el tope solo aplica si llegan paradas (un viaje viejo que ya lo
supere no se rompe al cambiarle la fecha). Basura o < 2 -> 10. Peor caso de una
serie: 31 viajes x 9 tramos = 279 llamadas Pro.

### Lugares guardados
- Lugar: nombre, direccion, latitud, longitud (la API usa lat / lng), activo,
  id_creador, fecha_baja / baja_por_id_usuario. Crear, listar (solo activos),
  editar (parcial), borrar = SOFT (activo false). Un lugar borrado no se
  reactiva: se crea otro.
- NOMBRE UNICO entre los ACTIVOS de la PyME sin distinguir mayusculas (y con los
  espacios normalizados). NO es constraint: pg_advisory_xact_lock(hashtext(
  'lugar-nombre:' || org || ':' || lower(nombre))) + SELECT, en la tx, igual que
  el CUIT. La clave del lock usa lower() de POSTGRES (el mismo que compara), no
  toLowerCase de JS. Editar toma el lock por el nombre NUEVO. Editar / borrar:
  updateMany condicionado a activo (lectura previa 404; carrera 409).
- SUSPENDIDA -> 403 en crear y editar; borrar sigue permitido (es sacar algo).
- USO: en crear / editar viaje y en la plantilla de una serie, cada parada es
  { id_lugar } O { lat, lng, direccion? } (schemaParadasInternas; las dos cosas
  juntas -> 400). La ruta LEGACY y estimar-costo NO aceptan id_lugar.
  resolverParadas(id_organizacion, paradas): UNA query por los ids con
  { id_organizacion, activo: true }; si falta alguno -> 400 "El lugar N no existe
  o no esta activo", el MISMO para uno de otra PyME (no se filtran ids). Fuera de
  toda tx y sin lock: es una copia.

### REGLA DE SNAPSHOT
- La parada guarda una COPIA de direccion, latitud y longitud del lugar, mas
  Parada.id_lugar (FK SET NULL). Editar o borrar el lugar despues NO cambia
  viajes ni series existentes (snapshotParadas, pura, en viaje-validacion.js).
- El NOMBRE NO se copia a la parada (decision): la PyME ve el nombre ACTUAL por
  join (parada.lugar = { id_lugar, nombre, activo }, tambien de un lugar
  borrado); si el nombre no esta en la fila, ningun spread de la fila cruda se lo
  puede mostrar al chofer.
- EL CHOFER NUNCA VE EL NOMBRE NI id_lugar. Canales, uno por uno:
  * PyME (lista, detalle, crear, editar, reasignar): serializarViajePyme ->
    paradaVistaPyme. INCLUDE_VIAJE_INTERNO trae paradas.lugar.
  * Chofer (GET /api/choferes/viajes y /:id): serializarViajeChofer ->
    paradaVistaChofer (saca lugar e id_lugar). Si trae id_serie.
  * GET /api/viajes/:id (en un interno solo llega el chofer): paradaVistaChofer
    sobre el spread.
  * Sockets que van a la PyME Y al chofer en el MISMO emit (viaje:asignado,
    viaje:editado, serie:asignada): resumenViaje arma las paradas con campos
    EXPLICITOS y nunca el lugar. NINGUN socket lleva el nombre: la PyME lo ve por
    REST.
  * viaje:finalizado, tracking (mapa / eta / costo / alertas / ruta) y las
    respuestas de iniciar / salir / confirmar-parada: no llevan filas de parada
    con lugar. Remito PDF: solo p.direccion. Admin: fila cruda con id_lugar, sin
    nombre (el admin no es el chofer).
  * paradaVistaPyme TIRA si la parada viene de un lugar y el include no trajo la
    relacion (mismo idiom que esViajeVencido).
- test-lugares-series.js lo verifica por TODAS las vias (REST, sockets y el texto
  del remito descomprimido) y ademas con un chequeo global: ningun cuerpo REST ni
  evento que recibio el chofer contiene la marca de los nombres.

### Series de viajes — SerieViaje
- frecuencia DIARIA | DIAS_SEMANA (dias_semana, ISO 1 = lunes ... 7 = domingo) |
  SEMANAL (dia_semana) | MENSUAL (dia_mes 1..31); hora "HH:MM" LOCAL;
  fecha_desde / fecha_hasta @db.Date LOCALES; paradas = plantilla YA RESUELTA
  (snapshot, con id_lugar); motivo y descripcion (se copian a cada viaje);
  condiciones (SIN USO desde el pedido del front, queda []); estado ACTIVA |
  CANCELADA | BORRADA (+ fecha_baja, baja_por_id_usuario). Viaje.id_serie.
- ZONA HORARIA: America/Argentina/Buenos_Aires. "Todos los dias a las 9:00" =
  9:00 de Buenos Aires = 12:00Z. localAUtc calcula el offset con Intl en el
  instante (dos pasadas), sin dependencias: no asume que Argentina siga sin
  horario de verano (el unit test lo prueba con New York).
- VENTANA: [fecha_desde, fecha_hasta] INCLUSIVA, fecha_hasta por defecto
  desde + 30 y como maximo eso -> DIARIA da hasta 31 viajes
  (MAX_VIAJES_POR_SERIE = 31). fecha_desde entre hoy (local) y hoy + 90.
- Ocurrencias que no cumplen ANTICIPACION_MINIMA_MINUTOS (la MISMA comparacion
  que crear: fecha <= ahora + anticipacion) se SALTEAN con motivo PASADA o
  SIN_ANTICIPACION y vuelven en la respuesta (salteadas). Si no queda ninguna ->
  400 "La serie no genera ningun viaje en esa ventana" con salteadas en el
  cuerpo (ErrorNegocio acepta un extra que se suma al { error }).
- MENSUAL con dia 29-31 en un mes que no lo tiene -> se AJUSTA al ULTIMO dia
  del mes (31 de noviembre -> 30) y sale en "ajustadas" con FIN_DE_MES. "El 31
  de cada mes" en logistica es "a fin de mes"; saltear dejaria un hueco callado.

### TODO O NADA al crear una serie (crearSerie)
1. PyME operativa (SUSPENDIDA -> 403), Cliente del creador (ancla de
   id_cliente), ventana, validarChoferAsignable UNA vez, resolverParadas,
   generarOcurrencias.
2. TODAS las estimaciones (estimarCosto, cada una con SU fecha: trafico y hora
   pico propios) con ejecutarConLimite: SERIE_CONCURRENCIA_MAPS (4) a la vez y
   SERIE_TIMEOUT_MS (60000) en total. Ante el primer error no lanza mas, espera a
   las que estan en vuelo y tira: Google caido o timeout total -> 503,
   SIN_RUTA -> 400 (igual que crear). NO se escribio nada.
3. UNA transaccion: bloquearVinculoActivo (el MISMO lock que crear: serializa
   contra desvincular; vinculo cortado -> 400 y rollback) -> serieViaje.create ->
   viaje.createManyAndReturn (todos ASIGNADO, con precio, zona, tarifas,
   estimado, id_serie, motivo y descripcion) -> parada.createMany. ~4 queries, no un round-trip por viaje. Los ids se emparejan por
   fecha_programada (unica en la serie), NO por el orden del RETURNING.
4. Fuera de la tx: historial ASIGNADO en LOTE (registrarCambiosEstado, nunca
   tira), programarVencimientoInterno por viaje, ruta planeada en Redis SOLO de
   los que salen dentro de 24 h (la key tiene TTL de 24 h; el resto la recalcula
   el fallback de gps.socket en el primer ping) y UN serie:asignada al chofer y a
   la sala de la PyME (no N viaje:asignado). Log:
   "[series] serie X: N viajes, M llamadas Pro, estimacion Xms, tx Yms, total Zms".
- Medido (test-lugares-series, Neon desde Argentina): DIARIA de 30 viajes de 2
  paradas = 30 llamadas Pro, estimacion ~0.75-0.8 s (4 en paralelo), tx ~0.6 s,
  total ~3.1-3.6 s en el server.
- Cada viaje generado es un viaje interno normal: el chofer confirma / rechaza
  cada uno, y la PyME los edita / reasigna / cancela con las rutas del Paso 2.
  NADA se propaga a la serie ni a los otros viajes; id_serie queda aunque se
  reasigne.
- Cancelar serie: lectura previa (404 / 400 si no esta ACTIVA) + updateMany
  { estado: 'ACTIVA' } -> 409 si pierde la carrera. Los viajes NO se tocan.
  serie:cancelada solo a la PyME. Permitido con la PyME SUSPENDIDA.
- Desvincular: series ACTIVAS del chofer con ESA PyME -> BORRADA en la misma tx
  (ver "Desvinculacion"). Las CANCELADAS y las de otras PyMEs no se tocan.
- Detalle y lista corren el chequeo PEREZOSO de vencimiento antes de leer; la
  lista trae resumen_viajes { total, por_estado }.
- La serie NO se renueva sola. Propuesta (NO implementada, pendiente de
  aprobacion): POST /:id/series/:idSerie/repetir que EXTIENDE la misma serie
  (ventana nueva desde la ultima ocurrencia + 1 dia, fecha_hasta se actualiza,
  sin cambio de schema), misma plantilla snapshot, mismo todo o nada, solo si a
  la serie le quedan <= 7 dias.

GUARDS VERIFICADOS REVIRTIENDOLOS (test-lugares-series.js):
| Guard | Caso que se pone en rojo sin el |
|-------|---------------------------------|
| advisory lock del nombre del lugar | 21c (201,201,201 y 3 activos con el mismo nombre) |
| cancelar serie: estado 'ACTIVA' en el WHERE | 21b (200,200 en las 5 rondas) |
| crear serie: lock + re-chequeo del vinculo en la tx | 21a (serie ACTIVA y viajes vivos con el vinculo cortado) |
| desvincular: UPDATE ... RETURNING de las series ACTIVAS en la tx | 19c / 19f (la serie queda ACTIVA) |
| resolverParadas: activo: true en el WHERE | 7a / 7d / 7e (viaje, serie y edicion con un lugar borrado) |

### Decisiones de interpretacion (Paso 4)
D1 tope de paradas global por env (editar: solo si cambian las paradas). D2
columnas latitud / longitud, API lat / lng. D3 el nombre del lugar no se copia
(la PyME ve el actual por join). D4 el chofer tampoco ve id_lugar. D5 ningun
socket lleva el nombre. D6 borrar lugar permitido con SUSPENDIDA; borrado no se
reactiva. D7 dias ISO, ventana inclusiva (max 31), desde hasta hoy + 90. D8
MENSUAL 29-31 -> fin de mes. D9 SIN_RUTA 400, Google caido / timeout 503. D10
plantilla snapshot. D11 fecha_baja / baja_por en Lugar y SerieViaje. D12
serie:cancelada solo a la PyME; desvincular no emite evento de serie. D13
historial en lote. D14 ruta en Redis solo < 24 h. D15 estimar-costo sin
id_lugar.

### PENDIENTES (Paso 5 o despues)
- "Repetir serie" (propuesta arriba), si se aprueba.
- Rate limit / cupo de creacion de series por PyME: hoy un miembro puede crear
  series sin limite y cada una cuesta hasta 279 llamadas Pro.
- estimar-costo con { id_lugar } (hoy el front manda las coordenadas del lugar).
- Los 31 timers por serie suman al Map en memoria: misma limitacion de un solo
  proceso que el resto (cola persistente el dia que haya mas de una instancia).

## Cierre sin Salir y deteccion de salida (Tarea 5)

Antes, un viaje interno solo se cerraba con "Salir" en la ultima parada: si el
chofer no lo tocaba, quedaba DESCARGANDO para siempre, con el emisor de ETA vivo
y el precio creciendo con el GPS. Ahora hay tres caminos de cierre, todos por
cerrarViajeInterno (cierre.service), que gana UNO solo (updateMany con el estado
leido en el WHERE + chequeos de la parada abierta y de las no visitadas en la
MISMA tx; el que pierde recibe 409 "El viaje ya fue cerrado por ...").

Archivos: cierre-fechas.js (PURO: hora prevista de fin, fin del dia, momento del
cierre automatico, cierre manual desde), salida-deteccion.js (PURO: la regla de
deteccion) + salida-deteccion.service.js (Redis, la escritura y los eventos),
cierre-plan.js (PURO: que se escribe y el INSTANTE DE CORTE del precio),
mediciones-gps.js (PURO: mediciones hasta un instante), precio-real.js (PURO: la
FORMULA, unica, tambien la usa calcularCostoAcumulado), cierre-automatico.service.js
(timers, chequeo perezoso, barrido) y timers-cierre.js (el Map, aparte para que
limpiarViajeActivo lo corte sin import circular).

### Definiciones (cierre-fechas.js)
- Hora prevista de fin = llegada_real a la ULTIMA + peon_estimado_horas de esa
  parada (si es null, TIEMPO_PEON_MINUTOS).
- Fin del dia = 23:59:59 America/Argentina/Buenos_Aires del dia LOCAL de
  fecha_inicio (localAUtc de serie-fechas, ahora con segundo opcional).
- Cierre automatico = fin del dia; si ya llego a la ultima y la prevista cae
  DESPUES del fin del dia -> prevista + CIERRE_EXTENSION_MINUTOS.
- Cierre manual desde = min(prevista, salida_detectada de la ultima); motivo GPS
  si la detectada es <= la prevista, si no TIEMPO.

### Deteccion de salida (A)
- Enganche en gps.socket, despues de actualizarAcumulado y del primer
  relimpiarSiCerrado: solo viajes internos en CARGANDO / DESCARGANDO cuya parada
  abierta (llegada_real y sin salida_real) no tenga salida_detectada. Usa las
  paradas del findUnique que el handler ya hacia: CERO queries nuevas por ping.
- Estado intermedio en Redis gps:{id}:salida = { id_parada, fuera_desde,
  ultimo_ts } con TTL (segundos + 600). Solo cuentan pings con ts > llegada_real;
  ts del celular > 60 s en el futuro respecto del server -> ignorado (no se puede
  adelantar la deteccion); desordenados -> ignorados; adentro (<= metros) -> reset.
  Afuera durante >= SALIDA_DETECCION_SEGUNDOS -> detectada = fuera_desde (la hora
  del PRIMER ping afuera, hora del celular: falsificarla solo perjudica al chofer).
- UNICA escritura: parada.updateMany { salida_real: null, salida_detectada: null }
  (una vez por parada; si un Salir se adelanto, gana el Salir). El estado de Redis
  se borra DESPUES de esa escritura: si falla, el proximo ping re-detecta. Eventos:
  parada:salida_detectada (chofer + PyME) y, si es la ultima y la prevista no
  habia pasado, viaje:cierre_habilitado GPS. Nunca tira.
- NO cierra nada. Salir: elegirSalidaReal (cierre-plan) -> la detectada si es
  ANTERIOR al toque (origen GPS), si no el toque (CHOFER). La fila EN_RUTA del
  historial y el manejo del tramo siguiente usan esa salida_real.

### Finalizar de la PyME (B) — POST /api/organizaciones/:id/viajes/:idViaje/finalizar
Cualquier miembro, tambien con la PyME SUSPENDIDA. Orden: perezosos -> 404 ->
FINALIZADO 409 (dice quien) -> no en curso 400 -> no llego a la ultima 409 ->
cierre manual no habilitado 409 (dice la hora) -> carrera 409. La salida es la
detectada (GPS) o queda VACIA con el peon no medido.

### Cierre automatico (C) — sin pollers
- Timer AUTOMATICO por viaje, armado en iniciarViajeInterno y re-armado al llegar
  a la ULTIMA (confirmarParadaInterna). Al disparar relee y se re-arma si no toca.
- Timer HABILITADO (aviso viaje:cierre_habilitado TIEMPO a la PyME), armado al
  llegar a la ultima; si la prevista ya paso en ese momento (peon 0), avisa al
  toque (avisarSiYaPaso). El barrido de arranque no re-avisa.
- Chequeo perezoso cerrarSiCorresponde(where), junto con vencerSiCorresponde en
  ponerAlDia: listas y detalle de la PyME y del chofer, salir, confirmar-parada
  interno, iniciar ({ id_conductor }: un viaje de ayer colgado no bloquea el de
  hoy), finalizar y cancelar de la PyME. Filtro grueso en SQL
  (limiteInicioCandidatos: fecha_inicio antes del dia local de ahora + 1 s) y
  decision exacta en JS. El admin NO lo usa.
- Barrido de arranque (app.js): UNA query de los internos en curso; cierra los
  atrasados en secuencia y arma los timers del resto. Kill-switch
  CIERRE_BARRIDO_ARRANQUE=0 (escribe en la DB compartida);
  CIERRE_BARRIDO_ID_ORGANIZACION lo limita a una PyME (test).
- Llego a la ultima -> FINALIZADO completo; si no -> FINALIZADO incompleto, las
  paradas sin llegada con no_visitada true. Nunca un estado nuevo.

### Datos de los cierres sin Salir (D) y el corte del precio
- La parada abierta: salida_detectada si existe (origen GPS); si no, salida_real
  null y peon_real_horas null = "no medido": tiempos-reales no lo suma
  (paradas_peon_no_medido), real.peon_completo false, duracion_real /
  duracion_descarga null, peon_medido false en la parada (null mientras esta en
  ella).
- cerrado_por: CHOFER | ORGANIZACION | AUTOMATICO (solo internos).
- Instante de corte (instanteCorte dentro de planCierre), SEPARADO de la formula:
  | Cierre | Corte |
  |---|---|
  | CHOFER sin deteccion (flujo normal) | el toque -> mediciones = el acumulado completo (identico a antes) |
  | CHOFER con deteccion anterior | la detectada |
  | PyME / AUTO, llego a la ultima | la detectada; si no, la hora prevista de fin |
  | AUTO sin llegar, en una parada | su detectada; si no, su llegada + su peon estimado |
  | AUTO sin llegar, EN_RUTA | min(ultimo ping, salida anterior + manejo estimado del tramo), nunca antes de esa salida |
  Ninguno es posterior a ahora. EN_RUTA (propuesta, aprobada en el plan): el
  manejo existio pero sin llegada no se sabe cuando termino; "ultimo instante
  medido" (la salida anterior) le cobraria de menos un tramo real, "ultimo ping"
  le cobraria el viaje a casa; el estimado es la cota y el ultimo ping la recorta.
- Mediciones hasta T (el precio NO sigue creciendo con el GPS): gps:{id}:puntos,
  ZSET (score = ts del ping) con el acumulado, muestreado cada 30 s, TTL 24 h,
  escrito por gps.socket SOLO para internos (Redis, no DB). medicionesHasta: T >=
  ultimo ping -> el acumulado tal cual; si no, el ultimo punto <= T (tiempo
  exacto, distancia con error <= 30 s de manejo). distancia_real_km = la medida
  hasta el corte; fecha_corte_precio la guarda. Cerrado MANEJANDO (automatico
  incompleto en EN_RUTA): el tramo en curso hasta el corte suma al
  manejo_real_horas del viaje (fin = corte, igual que al cancelar en curso), asi
  el real cubre la misma ventana que el precio; con una parada abierta NO se pasa
  fin (cerraria su peon: inventado).
- Precio = precioDesdeMediciones(viaje, mediciones): la formula de siempre,
  extraida. Cambiar la formula no toca el cierre.
- OJO: prisma updateMany con `data: {}` NO ejecuta nada y devuelve count 0. El
  "la parada sigue abierta" del cierre sin salida es un count (bajo el lock de la
  fila del viaje que tomo el updateMany de arriba), no un updateMany vacio: con el
  updateMany vacio todo finalizar sin deteccion daba 409 (lo encontro el CASO 2).
- Limpieza: la del cierre de siempre + cancelarTimersCierre + las keys nuevas
  (limpiarGPS borra gps:{id}:salida y gps:{id}:puntos; _limpieza.js las cubre
  por el patron gps:{id}:*). limpiarViajeActivo (cancelaciones) tambien corta los
  timers de cierre.

### Otros (E)
- Salir / confirmar-parada sobre un viaje cerrado por la EMPRESA o el AUTOMATICO
  -> 409 "El viaje ya fue cerrado por la empresa" / "... automaticamente". En
  confirmar-parada va despues del 403 y antes de "parada ajena" (orden nuevo,
  documentado en API.md). Cerrado por el mismo chofer: los 400 de siempre. Los
  pings de un viaje cerrado se ignoran como siempre (ESTADOS_TERMINALES).
- Un chofer no inicia con otro viaje en ESTADOS_EN_CURSO (cualquier ciclo) ->
  409. Caso secuencial antes de la ventana / proximidad; en la tx, SELECT ...
  FROM conductores FOR UPDATE + re-chequeo (orden de locks chofer -> viaje).
- eta-emisor: Set sinPendientes. Cuando calcularEtaConApi devuelve null (no quedan
  paradas) los ticks siguientes no tocan ni la DB ni Redis; se borra al detener.
- viaje:finalizado de un viaje interno ahora llega tambien al chofer.

GUARDS VERIFICADOS REVIRTIENDOLOS (test-cierre-viaje.js):
| Guard | Caso que se pone en rojo sin el |
|-------|---------------------------------|
| eta-emisor: sinPendientes | eta-emisor.test.js (6 consultas en vez de 1) |
| cierre: estado en el WHERE del updateMany del viaje | 8b (orden FORZADO, la PyME commitea primero: finalizar 200 + salir 200 y 2 filas FINALIZADO). En la carrera libre (8, aun con RONDAS=20) no se ve: "salir" llega casi siempre antes a su tx, y en ese orden el guard de la parada abierta (salida_real null) tambien lo cubre. 8b toma el lock de la fila del viaje desde el test para fijar el orden |
| iniciar: lock del chofer + re-chequeo en la tx | 11c (200,200 y dos viajes CARGANDO del mismo chofer) |
| deteccion: salida_real / salida_detectada null en el updateMany | 13 (orden FORZADO: el test toma el lock de la fila de la parada, los 3 pings que cumplen el umbral se encolan en el updateMany -> 3 parada:salida_detectada). Sin el lock la carrera no se ve: el primero escribe antes de que los otros lean |

### PENDIENTES
- Remito: marcar las paradas no visitadas y quien cerro.
- Precio en vivo (costo:actualizar / costo-acumulado) sigue creciendo mientras
  el viaje este abierto; el corte aplica al precio REAL. Congelarlo pasada la
  hora prevista, si se quiere.
- El iniciar LEGACY no bloquea un segundo viaje en curso.
- Los timers de cierre: misma limitacion de un solo proceso que el resto.

## Pedido del front 20-10-2026

### Condiciones especiales FUERA del ciclo interno
- El ciclo interno NO tiene condiciones: no se piden (los schemas de crear /
  editar viaje y de crear serie ya no las tienen; si llegan, z.object las
  descarta sin error), no se validan (validarChoferAsignable exige vinculo +
  al menos un vehiculo propio; confirmar acepta cualquier vehiculo PROPIO;
  reasignar y editar no las miran) y no se devuelven (INCLUDE_VIAJE_INTERNO sin
  condiciones_req; serializarViaje, resumenViaje y serializarSerie sin
  condiciones_requeridas; GET /api/viajes/:id omite condiciones_req en un
  viaje interno).
- Un viaje viejo con condiciones guardadas se confirma con cualquier vehiculo
  propio y se reasigna a cualquier chofer vinculado con vehiculo: sus filas de
  condicion_requerida quedan en la base SIN USO.
- Las condiciones del VEHICULO son SOLO del marketplace (elegibilidad legacy).
  Los endpoints de vehiculos (/api/conductores/mis-vehiculos y
  /condiciones/:condicion) NO cambiaron: las condiciones son opcionales al
  crear (ya eran .optional().default([])), PUT no las acepta, y se siguen
  devolviendo (son datos del vehiculo; la lista de choferes de la PyME tambien
  las muestra). El ciclo interno no las lee en ningun lado.
- Lo unico compartido con la legacy que se toco: GET /api/viajes/:id (omitir
  condiciones_req si id_organizacion != null). El admin sigue viendo la fila
  cruda (no es PyME ni chofer).

### Motivo y descripcion — viaje-validacion.js
- Viaje.motivo y SerieViaje.motivo (String?, columnas nuevas; null en viajes
  viejos y legacy). schemaMotivo (trim, 1 a 120) y schemaDescripcion (trim, 1
  a 500). Mensajes: "motivo es requerido", "motivo debe ser texto", "motivo no
  puede estar vacio", "motivo puede tener como máximo 120 caracteres" (idem
  descripcion, "requerida" / "vacia").
- OBLIGATORIOS al crear un viaje interno y una serie (la serie los copia a cada
  viaje generado; despues cada viaje se edita por su cuenta).
- EDITAR valida el ESTADO RESULTANTE (faltantesContenido, pura): en el body son
  opcionales pero, si llegan, con las mismas reglas (null o vacio -> 400). Un
  viaje viejo sin motivo / descripcion -> 400 "El viaje no tiene motivo:
  completalo para poder editarlo" (o descripcion, o "motivo ni descripcion:
  completalos"), despues del 400 de estado no editable. "Al menos un campo" =
  paradas / fecha_programada / motivo / descripcion (un body con SOLO
  condiciones_requeridas -> 400).
- El chequeo va fuera de la tx y alcanza porque es MONOTONO: ningun endpoint
  vuelve a dejar motivo o descripcion vacios, asi que una vez completos no se
  pueden "descompletar" entre el chequeo y la escritura.
- NUNCA se bloquean por motivo / descripcion faltantes: reasignar (es
  operativo, no edita el contenido), cancelar, finalizar y todo el ciclo del
  chofer. Un viaje viejo sin motivo se lee, se reasigna y se cancela.
- Sale en la fila cruda (listas y detalle de la PyME y del chofer, respuestas
  de crear / editar / reasignar, GET /api/viajes/:id) y en resumenViaje
  (viaje:asignado, viaje:editado, serie:asignada). serializarSerie lo suma.
- La legacy (POST /api/viajes) no cambio: descripcion opcional, sin motivo.

### Licencia opcional — en dos pasos por la DB compartida
- Paso A (este pedido): nro_licencia y licencia_vencimiento nullable en la base
  y en Prisma. Sin indices ni unique sobre la licencia y nada la usa para
  decidir nada (ni elegibilidad, ni remito). Las lecturas toleran null sin
  codigo extra (spread de la fila; la licencia sale null). El registro la sigue
  EXIGIENDO: schemaConductor() se arma por request segun licenciaOpcional().
- Paso B (solo variable): LICENCIA_OPCIONAL=true -> nro_licencia y
  licencia_vencimiento opcionales en POST /api/auth/registro-conductor; si llega
  uno, se valida igual que siempre. PUT /api/auth/perfil NO acepta licencia (no
  la aceptaba antes y no se agrego: la verificacion futura va a ser con foto).
- Las lecturas con licencia null se prueban con UNITARIOS (prisma mockeado,
  src/controllers/licencia-null.test.js): admin usuarios lista y detalle, /me,
  choferes de la PyME, GET /api/viajes/:id. La integracion que ESCRIBE un
  conductor con licencia NULL (test-identidad CASO 15c/15d) va detras de
  TEST_LICENCIA_NULL=1 y se saltea por defecto.

### Simulador del front — e2e/sim/
- Test de caja negra del equipo del front (sim-finalizar-viaje.mjs + coleccion
  de Postman + CONTRATO-FINALIZAR.md + HALLAZGOS.md). Crea sus cuentas
  sim+...@fleter.test, recorre el viaje de PyME con GPS por socket y chequea el
  contrato: Paso 3, motivo / descripcion / sin condiciones, y Tarea 5
  (finalizar antes de la hora prevista -> 409, segundo viaje en curso -> 409,
  viaje:finalizado con cerrado_por CHOFER, secuencia exacta de
  viaje:estado_cambiado: la ultima salida no lo emite).
- Corre en CI (job e2e-staging, despues del E2E) y a mano:
  `FLETER_API=http://localhost:3000 node e2e/sim/sim-finalizar-viaje.mjs`. Lee
  FIREBASE_WEB_API_KEY (o FIREBASE_API_KEY) del entorno, de e2e/sim/.env o del
  .env de la raiz. La key NO se commitea (el .env.example del zip la traia).
- Deja datos (no puede borrar usuarios): 2 usuarios, PyME, vehiculo, un viaje
  FINALIZADO con remito y uno CANCELADO por corrida. Cancela al final todo
  viaje que haya quedado vivo. El resto: `node scripts/restos.js --solo sim`.
- NO registra un chofer sin licencia hasta que production tenga el Paso A.

### PENDIENTES
- Cuando este pedido este en main y DESPLEGADO en production: activar
  TEST_LICENCIA_NULL=1 en test-regresion.js (o sacar la variable y que el CASO
  15c/15d corra siempre) y prender LICENCIA_OPCIONAL=true en Railway staging y
  production (las dos a la vez: la DB es compartida).
- Limpieza para cuando se separen las DBs (Tarea 3): tabla
  condicion_requerida (en lo interno), series_viaje.condiciones y, si el
  marketplace no vuelve, el enum TipoCondicion y condicion_vehiculo.
- Motivo en el remito PDF, si se quiere.
- BUG en src (no se toco, vehiculos quedan como estan): conductores.controller
  hace `parsed.error.errors[0]`, que con Zod 4 es undefined -> un body invalido
  en POST / PUT /api/conductores/mis-vehiculos da 500 en vez de 400 (mismo
  archivo que el pendiente de PUT /mis-vehiculos/undefined).

## Maquina de estados — src/services/estado-viaje.service.js
Hay DOS ciclos con su tabla cada uno: TRANSICIONES (este, el LEGACY del
marketplace) y TRANSICIONES_INTERNO (el del viaje de PyME, que ademas dice
QUIEN puede; ver "Viaje interno"). validarTransicion(actual, destino, contexto?)
elige por el tercer parametro: sin contexto es la legacy, asi que los callers
viejos no cambiaron; con { ciclo: 'INTERNO', quien } es la interna.
ESTADOS_TERMINALES incluye los finales de los dos ciclos.

TRANSICIONES como estructura de datos + validarTransicion(actual, destino),
que tira error si la transicion no esta permitida. La usan:
- El PATCH /api/viajes/:id/estado (antes permitia retrocesos invalidos).
- Todos los endpoints de la estructura jerarquica que cambian estado.
PENDIENTE: matching.service, cierre.service y cancelacion.service todavia
setean un estado fijo directo, sin validarTransicion. Se migran despues.
(Desde el Paso 2, cierre.service al menos escribe con un updateMany
condicionado a EN_RUTA / DESCARGANDO: ya no puede pisar una cancelacion.)
OJO: esos caminos SI registran historial de estados — justamente por eso el
historial NO se centralizo dentro de validarTransicion, que no los ve. Ver
"Historial de estados".

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

> Viajes INTERNOS: desde el Paso 3 confirmar-parada es la LLEGADA a la
> siguiente parada (solo en EN_RUTA, orden obligatorio, pasa a DESCARGANDO) y
> NO cierra el viaje: lo cierra "salir" de la ultima. Ver "Ciclo por parada".
> Lo que sigue describe el ciclo LEGACY, sin cambios.

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
  duracion_estimada, duracion_real, duracion_carga, duracion_descarga y
  duracion_aproximacion_origen.
- Nomenclatura: `duracion_*` sin sufijo = minutos enteros. `tiempo_*` y
  `*_horas` = horas float.

- duracion_estimada_horas: columna en Viaje (Float?, aditiva y nullable).
  DESDE EL PASO 3 es el TOTAL estimado (manejo con trafico + peon en cada
  parada, ver "Algoritmo de duracion"); el precio sigue usando solo el manejo
  (desglose.tiempo_horas = manejo_estimado_horas). Antes era el
  desglose.tiempo_horas del precio. Antes ese
  valor se calculaba y se descartaba: salia una sola vez en la respuesta de
  creacion y no habia forma de recuperarlo (en PROVINCIA tarifa_hora es null y
  en MIXTO el precio mezcla los dos ejes, asi que NO es derivable del precio).
- duracion_real: NO hay columna, se calcula en el read con
  calcularDuracionRealMinutos(viaje) = max(paradas.fecha_entrega) − fecha de la
  fila EN_RUTA del historial.
  CAMBIO DE SEMANTICA: antes se medida desde fecha_inicio, que es cuando el
  conductor arranca HACIA el origen, antes de cargar. duracion_estimada solo
  suma los tramos de manejo entre paradas, asi que los dos numeros median cosas
  distintas y no se podian comparar. Ahora se mide desde la SALIDA DEL ORIGEN
  (la transicion CARGANDO -> EN_RUTA).
  Se usa max() y NO la parada de mayor `orden`: nada garantiza que las paradas
  se confirmen en orden (no se valida el orden de confirmacion). null si el
  viaje no esta FINALIZADO, o si no tiene fila EN_RUTA — que es el caso de TODOS
  los viajes anteriores a este cambio. Devolver el numero viejo seria devolver
  algo que ya no significa lo mismo.
- duracion_carga = EN_RUTA − CARGANDO, y duracion_descarga = FINALIZADO −
  DESCARGANDO. Son las dos mitades del "tiempo de peon". null si la transicion
  no ocurrio.
- duracion_aproximacion_origen = fecha_llegada_origen − fecha_inicio. Es el
  tramo que antes quedaba metido adentro de duracion_real; se expone aparte para
  no perder el dato. NO depende del historial: le alcanzan dos escalares.
- calcularMetricasViaje(viaje) devuelve las CINCO juntas (las cuatro duraciones
  + puntualidad_inicio). Existe para que los seis canales que las exponen no
  repitan el mismo bloque y no se puedan desincronizar.
- Los consumen los SEIS canales: GET /api/viajes/:id, GET /api/viajes/mis-viajes,
  GET /api/viajes/mis-viajes-conductor, GET /api/admin/viajes/:id,
  GET /api/empresas/:id/viajes y el evento viaje:finalizado. El detalle ademas
  incluye duracion_estimada y el vehiculo asignado (null si no hay conductor).
- Excepcion documentada: GET /api/empresas/:id/viajes devuelve
  duracion_estimada_horas en HORAS, porque ese endpoint serializa la fila cruda
  del viaje. El nombre lleva la unidad; la regla de minutos aplica a los campos
  derivados.

## Historial de estados — src/services/historial-estado.service.js

Tabla `historial_estado_viaje` (modelo HistorialEstadoViaje): UNA fila por CADA
cambio de estado, con id_viaje, estado, fecha, id_usuario y origen
(CLIENTE | CONDUCTOR | GERENTE | ADMIN | SISTEMA). Es aditiva; la back-relation
en Viaje NO agrega columna a la tabla viajes. Sin FK a Usuario a proposito:
evita tocar el modelo Usuario y evita una constraint que trabe borrados.

De estas filas salen duracion_carga, duracion_descarga y duracion_real.

### POR QUE NO se centralizo en validarTransicion
Es la opcion comoda y es una trampa:
- Solo 6 de los 12 sitios la llaman. Quedan afuera matching.socket (aceptar),
  cierre.service, iniciarViaje, cancelarViajeCliente y el cancelar de admin —
  los tres ultimos ni siquiera estaban en la lista de pendientes de este archivo.
  El historial quedaria con agujeros SILENCIOSOS.
- Corre ANTES de la escritura, y la escritura puede no ocurrir: los updateMany
  condicionados devuelven count === 0 -> 409. Registrarian transiciones que
  nunca pasaron.
- Ni siquiera sabe de que viaje habla: su firma es (estadoActual, destino).

Tampoco se uso una extension de Prisma (`$extends` sobre viaje.update): es el
unico mecanismo del que ningun caller se puede olvidar, pero no conoce al actor
(el timer y el barrido no tienen request), updateMany devuelve solo { count }, y
crearViaje ni pasa estado en el data (sale del @default).

Se escribe en CADA caller. Lo que reemplaza a la centralizacion es esta tabla +
el CASO 1 de test-historial-estados.js, que recorre un flujo completo y exige
una fila por transicion.

### Los 12 sitios que cambian estado
Hay 13 escrituras a la tabla Viaje en src/; 12 cambian estado. reasignarViaje es
la excepcion: escribe el viaje pero va de CONDUCTOR_ASIGNADO a
CONDUCTOR_ASIGNADO, asi que NO genera fila.

| #  | Funcion                 | Archivo                   | Transicion                                    | origen            |
|----|-------------------------|---------------------------|-----------------------------------------------|-------------------|
| 1  | crearViaje              | viajes.controller.js      | — -> BUSCANDO_CONDUCTOR (via @default)        | CLIENTE           |
| 2  | manejarAceptarViaje     | matching.socket.js        | BUSCANDO -> CONDUCTOR_ASIGNADO                | CONDUCTOR         |
| 3  | cambiarEstado           | viajes.controller.js      | -> CARGANDO / EN_RUTA / DESCARGANDO           | CONDUCTOR         |
| 4  | iniciarViaje            | viajes.controller.js      | CONDUCTOR_ASIGNADO -> EN_CAMINO_A_ORIGEN      | CONDUCTOR/GERENTE |
| 5  | cancelarViajeConductor  | viajes.controller.js      | -> RESERVADO_POR_EMPRESA o BUSCANDO_CONDUCTOR | CONDUCTOR         |
| 6  | cancelarViajeCliente    | viajes.controller.js      | -> CANCELADO                                  | CLIENTE           |
| 7  | cancelarViaje (admin)   | admin.controller.js       | -> CANCELADO                                  | ADMIN             |
| 8  | reservarViaje           | reserva.controller.js     | BUSCANDO -> RESERVADO_POR_EMPRESA             | GERENTE           |
| 9  | asignarViaje            | reserva.controller.js     | RESERVADO -> CONDUCTOR_ASIGNADO               | GERENTE           |
| 10 | liberarReserva          | reserva.service.js        | RESERVADO -> BUSCANDO_CONDUCTOR               | GERENTE o SISTEMA |
| 11 | cerrarViaje             | cierre.service.js         | DESCARGANDO -> FINALIZADO                     | CONDUCTOR         |
| 12 | ejecutarDesafiliacion   | afiliacion.service.js     | CONDUCTOR_ASIGNADO -> RESERVADO_POR_EMPRESA   | GERENTE o CONDUCTOR |
| —  | reasignarViaje          | reserva.controller.js     | SIN cambio de estado -> SIN fila              | —                 |

Sitios del ciclo INTERNO (Paso 2). Todos en viaje-interno.service.js salvo los
marcados. El origen reusa ORIGENES: el chofer es CONDUCTOR, el miembro de la
PyME es CLIENTE.

| #  | Funcion                    | Archivo                   | Transicion                                    | origen            |
|----|----------------------------|---------------------------|-----------------------------------------------|-------------------|
| 13 | crearViajeInterno          | viaje-interno.service.js  | — -> ASIGNADO                                 | CLIENTE           |
| 14 | confirmarViaje             | viaje-interno.service.js  | ASIGNADO -> CONFIRMADO                        | CONDUCTOR         |
| 15 | rechazarViaje              | viaje-interno.service.js  | ASIGNADO -> RECHAZADO                         | CONDUCTOR         |
| 16 | iniciarViajeInterno        | viaje-interno.service.js  | CONFIRMADO -> CARGANDO                        | CONDUCTOR         |
| 17 | cancelar (chofer / PyME)   | viaje-interno.service.js  | -> CANCELADO                                  | CONDUCTOR/CLIENTE |
| 18 | reasignarViaje / editarViaje | viaje-interno.service.js | CONFIRMADO -> ASIGNADO (ASIGNADO -> ASIGNADO: SIN fila) | CLIENTE  |
| 19 | vencerViajeInterno         | vencimiento.service.js    | ASIGNADO / CONFIRMADO -> VENCIDO              | SISTEMA           |
| 20 | desvincularChofer          | vinculo-chofer.service.js | no final -> CANCELADO (uno por viaje)         | CLIENTE o CONDUCTOR |
| 21 | salirDeParada              | viaje-interno.service.js  | CARGANDO / DESCARGANDO -> EN_RUTA (la ultima: cerrarViaje -> FINALIZADO) | CONDUCTOR |
| 22 | confirmarParadaInterna     | viaje-interno.service.js  | EN_RUTA -> DESCARGANDO                        | CONDUCTOR         |
| 23 | crearSerie                 | serie.service.js          | — -> ASIGNADO (uno por viaje, EN LOTE con registrarCambiosEstado) | CLIENTE |
| 24 | finalizarViajeOrganizacion | viaje-interno.service.js  | DESCARGANDO -> FINALIZADO (via cerrarViajeInterno, Tarea 5) | CLIENTE |
| 25 | cierre automatico          | cierre-automatico.service.js | en curso -> FINALIZADO (timer / barrido / perezoso, via cerrarViajeInterno) | SISTEMA |
| —  | cerrarViaje (11), cancelarViaje admin (7) | | los mismos sitios de arriba, ahora tambien para viajes internos | |
cambiarEstado (3) ya NO aplica a viajes internos desde el Paso 3 (400). Los
sitios 16, 21, 22 y el cierre pasan `fecha` al historial: el mismo instante que
la llegada / salida de la parada.

reasignar y editar leen el estado REAL con un SELECT ... FOR UPDATE dentro de su
tx, para saber si la transicion fue CONFIRMADO -> ASIGNADO (fila) o ASIGNADO ->
ASIGNADO (sin fila) aunque un confirmar concurrente se haya metido en el medio.

Tres de ellos no conocen al actor y lo reciben por parametro:
- liberarReserva(io, id_viaje, estadoActual, actor): gerente en cancelar-reserva,
  SISTEMA en el timer y en el barrido de arranque.
- cerrarViaje(id_viaje, io, actor): el conductor que confirma la ultima parada
  (legacy). El interno es cerrarViajeInterno({ modo, actor }): el origen sale
  del modo (CHOFER -> CONDUCTOR, ORGANIZACION -> CLIENTE, AUTOMATICO -> SISTEMA).
- ejecutarDesafiliacion(id_conductor, id_empresa, actor): GERENTE si lo echa la
  empresa, CONDUCTOR si se va solo.

### Reglas de llamada
- Siempre DESPUES de que la escritura del estado haya tenido exito. En los
  updateMany condicionados, recien despues de verificar count > 0: si matcheo 0
  filas no hubo cambio y no hay nada que registrar.
- Siempre FUERA de la `$transaction` (sitios 6, 7 y 12). Adentro, un fallo del
  historial haria rollback del cambio de estado.

### Si falla el insert, el cambio de estado ocurre IGUAL
registrarCambioEstado NUNCA tira: todo el cuerpo va en try/catch, loguea
"[historial-estado] no se pudo registrar ..." y devuelve false. Como no puede
tirar, ninguno de los 12 callers que la await-ean se puede romper por un fallo
del historial. Preferimos un historial con un hueco antes que un viaje que no se
puede cancelar porque la tabla de auditoria esta caida. Cubierto por el CASO 5
de test-historial-estados.js.

### fechaDeEstado y el guard defensivo
fechaDeEstado(viaje, estado) devuelve la PRIMERA aparicion del estado, o null.
TIRA si el viaje no viene con historial_estados incluido (INCLUDE_HISTORIAL),
mismo idiom que esViajeVencido y puedeVerViaje: un select al que se le olvido el
include devolveria null en silencio y todas las metricas por etapa saldrian
vacias sin que nadie se entere.

INCLUDE_HISTORIAL ordena por [fecha asc, id_historial asc]. El desempate por
id_historial no es decorativo: dos filas del mismo milisegundo ordenarian
ambiguo solo por fecha.

### Viajes anteriores al cambio
Los 845 viajes que ya existian no tienen ni una fila, y NO hay backfill: un
numero con la definicion vieja es peor que null. Los 159 FINALIZADO devuelven
duracion_real / duracion_carga / duracion_descarga en null para siempre. Los que
estaban a mitad de viaje se quedan con lo que alcancen a registrar de ahi en
adelante (p. ej. uno que estaba en EN_RUTA SI consigue duracion_descarga, porque
sus dos transiciones ocurren despues; pero no duracion_real, porque su fila
EN_RUTA ya no se va a escribir).

## Llegada al origen y puntualidad — src/services/puntualidad.service.js

### La confirmacion de la primera parada NO sirve como señal de llegada
confirmarParada exige estado EN_RUTA o DESCARGANDO. La parada #1 ES el origen
(orden 1; la ruta va de la primera a la ultima), asi que confirmarla es
estructuralmente imposible en EN_CAMINO_A_ORIGEN o CARGANDO: recien se puede
confirmar DESPUES de cargar y salir. Esta validada por proximidad, si, pero
llega tarde por construccion. NO existe como señal de llegada.

### La señal que SI existe: el primer ping GPS dentro del radio
gps.socket solo rechaza pings en BUSCANDO_CONDUCTOR y CONDUCTOR_ASIGNADO, o sea
que ACEPTA pings en EN_CAMINO_A_ORIGEN y ya trae viaje.paradas en el mismo
findUnique. Se toma el PRIMER ping dentro de RADIO_CONFIRMACION_METROS de la
parada de orden 1 mientras el viaje sigue yendo hacia alla, y se guarda en
Viaje.fecha_llegada_origen.

- Hora del SERVIDOR, no el timestamp del ping: el ping lo manda el celular y es
  falsificable, y esto alimenta una metrica de desempeño del conductor.
  confirmarParada usa hora de servidor por lo mismo.
- DOS guards redundantes a proposito: el chequeo en memoria
  (fecha_llegada_origen === null) y el WHERE del updateMany. Verificado
  quitandolos: sacando CUALQUIERA de los dos el test sigue verde (el otro
  alcanza); sacando LOS DOS se pone rojo. El del WHERE es el que cubre la
  carrera entre dos pings simultaneos.
- NO es un estado nuevo ni una fila del historial: es un evento de GPS, no una
  transicion formal.
- RESPALDO de ultimo recurso: si el viaje llega a CARGANDO sin que ningun ping
  haya registrado la llegada (sin señal, GPS apagado), cambiarEstado la rellena
  con ese instante. Es la señal peor — el conductor marca CARGANDO cuando
  EMPIEZA A CARGAR, no cuando llega, asi que una demora del cliente en la carga
  lo perjudica — pero es mejor que no tener nada.
- distanciaMetros vive en parada.service.js y la usan confirmarParada Y la
  deteccion de llegada: es la MISMA funcion, no se escribio una nueva.
  RADIO_CONFIRMACION_METROS se usa en esos DOS lugares y en ninguno mas;
  verificarParadaSospechosa comparte la funcion pero mantiene su propio 150m,
  para que los dos radios puedan cambiar por separado.

### Por que esta señal SI necesito columna nueva
Es la unica excepcion a "se calcula en el read". duracion_real y vencido se
derivan de timestamps ya persistidos para siempre (fecha_inicio,
Parada.fecha_entrega). El GPS es EFIMERO: vive en Redis y limpiarGPS lo borra al
cerrar el viaje. Si la llegada no se persiste en el instante en que ocurre, se
pierde para siempre. La columna es aditiva y nullable, mismo patron seguro que
duracion_estimada_horas y fecha_reserva.

### CUIDADO: hay DOS cosas distintas llamadas puntualidad_inicio
- La COLUMNA Viaje.puntualidad_inicio esta MUERTA. Nadie la escribe ni la lee.
  Sus 254 valores viejos se calcularon midiendo la SALIDA hacia el origen y no
  son comparables con nada. Queda en el schema por el mismo motivo que
  Parada.qr_token: la DB de Neon esta compartida con produccion y dropear
  columnas ahi es destructivo. Se limpia cuando se separen las DBs.
- El CAMPO puntualidad_inicio de las respuestas de la API es OTRA COSA: se
  calcula en el read con calcularPuntualidadInicio(viaje), midiendo la LLEGADA
  al origen contra fecha_programada, con los mismos umbrales de siempre
  (PUNTUALIDAD_TARDE_MINUTOS, PUNTUALIDAD_MUY_TARDE_MINUTOS). Si
  fecha_llegada_origen es null devuelve null, SIN IMPORTAR lo que diga la
  columna vieja.

No confundirlas. Como el campo calculado tiene que pisar a la columna muerta,
se aplica en los DIEZ endpoints que spreadean la fila cruda del viaje, siempre
DESPUES del spread — no solo en los seis canales de las metricas. Sin eso, el
admin veria A_TIEMPO en la lista y null en el detalle del MISMO viaje.
mis-viajes-conductor y asignados usan select explicito, asi que ahi la columna
muerta nunca se filtro. Solo necesita dos escalares, por eso no requiere include.

### iniciarViaje ya no calcula puntualidad
Su trabajo se redujo a validar la ventana, setear fecha_inicio e iniciado_por,
cancelar el aviso de vencimiento y emitir. El evento viaje:iniciado y la
respuesta del endpoint ya NO llevan puntualidad_inicio.

### GUARD ATOMICO en iniciarViaje
Era un update plano sobre la lectura previa: el estado se chequeaba en memoria y
no en el WHERE. Como el endpoint autoriza al conductor asignado Y al gerente de
la empresa, dos POST concurrentes devolvian los DOS 200 y fecha_inicio /
iniciado_por quedaban last-write-wins. Ahora es un updateMany con
where { id_viaje, estado: 'CONDUCTOR_ASIGNADO' }; count === 0 -> 409.
El chequeo en memoria se CONSERVA: sigue dando el 400 descriptivo de siempre en
el caso secuencial (doble inicio normal), y el 409 queda para la carrera real.
Cubierto por el CASO 3 de test-historial-estados.js, verificado revirtiendo el
guard: sin el, el caso se pone en rojo con ganadores=2.

## Viajes vencidos — src/services/vencimiento.service.js

Un viaje que llega a su fecha_programada sin que nadie lo tome
(BUSCANDO_CONDUCTOR) o sin que nadie lo inicie (CONDUCTOR_ASIGNADO) queda
COLGADO. DECISION DE PRODUCTO: NO se auto-cancela y NO cambia de estado — quien
decide cancelar es el cliente. Lo unico que se hace es que deje de ser
invisible, por dos canales con jerarquia explicita:
- `vencido`, el flag calculado en el read. Es la FUENTE DE VERDAD durable: se ve
  apenas el front carga sus viajes y sobrevive a cualquier caida del proceso.
- `viaje:vencido`, el evento de socket. Es el aviso EN VIVO y es BEST-EFFORT: si
  nadie esta conectado en ese instante se pierde. El front NO debe depender solo
  del evento.

Sin cambios de schema (no se corrio db push) y sin variables de entorno nuevas.

### El flag `vencido`
- esViajeVencido(viaje) -> bool. Criterio:
  fecha_programada < ahora Y estado en ESTADOS_VENCIBLES.
- ESTADOS_VENCIBLES = ['BUSCANDO_CONDUCTOR', 'CONDUCTOR_ASIGNADO']. La MISMA
  lista la usan el flag y el evento, para que no se puedan desincronizar.
- Se calcula en el read, no se persiste (mismo criterio que duracion_real).
- TIRA error si el viaje no trae estado o fecha_programada, igual que
  calcularDuracionRealMinutos con paradas y puedeVerViaje con sus relaciones: un
  select al que se le olvido un campo devolveria vencido:false en silencio.
- Lo devuelven los ONCE endpoints que serializan un viaje: POST /api/viajes,
  GET /api/viajes/disponibles, GET /api/viajes/:id, GET /api/viajes/mis-viajes,
  GET /api/viajes/mis-viajes-conductor, GET /api/viajes/asignados,
  GET /api/empresas/:id/viajes, GET /api/empresas/:id/viajes-disponibles,
  GET /api/admin/viajes (los DOS return: la rama de cantidad_paradas tambien),
  GET /api/admin/viajes/:id, y los historiales ANIDADOS de
  GET /api/admin/usuarios/:id (detalle.cliente.viajes y detalle.conductor.viajes
  — el lugar mas facil de olvidar). Ninguno necesito tocar su include/select:
  estado y fecha_programada ya estaban en los once.
- NO lo llevan las respuestas parciales tipo { mensaje, id_viaje, estado } de
  reservar / asignar / reasignar / cancelar-* / iniciar / confirmar-parada: no
  son objetos viaje.

### DECISION: el filtro fecha_programada > ahora NO se toca
Los tres lugares que filtran el mercado abierto por fecha futura se quedan como
estan: viajes.controller (GET /api/viajes/disponibles), empresas.controller
(GET /api/empresas/:id/viajes-disponibles) y sockets/index.js
(unirseARoomsDisponibles, al conectarse un conductor).

Que un viaje vencido DESAPAREZCA de la oferta a conductores es el comportamiento
CORRECTO, no un bug. "Dejar de ser invisible" aplica al cliente, al gerente y al
conductor ya asignado — no al mercado abierto. Consecuencia: en los dos
endpoints de disponibles `vencido` es siempre false. Se devuelve igual para que
el contrato sea uniforme, y API.md lo aclara. NO lo "arregles" despues.

### El evento viaje:vencido
Payload { id_viaje, estado, fecha_programada }, siempre al room personal
usuario:{id_usuario}. Destinatarios segun el estado al vencer:

| Estado al vencer                | Quienes lo reciben                   |
|---------------------------------|--------------------------------------|
| BUSCANDO_CONDUCTOR              | cliente                              |
| CONDUCTOR_ASIGNADO sin empresa  | cliente + conductor                  |
| CONDUCTOR_ASIGNADO con empresa  | cliente + conductor + gerente        |

En BUSCANDO_CONDUCTOR no hay conductor, y tampoco gerente: id_empresa se setea
recien al reservar. OJO: para el conductor el room va por su id_usuario, NO por
id_conductor (mismo cuidado que viaje:asignado).

El conductor esta en la lista porque en CONDUCTOR_ASIGNADO es el UNICO que puede
destrabarlo apretando "Iniciar viaje".

### Timers — un aviso por viaje, armado al crearlo
Mismo patron que los timers de reserva (un setTimeout por viaje, cero pollers,
barrido al arrancar), con dos diferencias deliberadas.

- programarAvisoVencimiento(io, id_viaje, fechaProgramada) /
  cancelarAvisoVencimiento(id_viaje), sobre un Map id_viaje → Timeout.
- Se PROGRAMA en UN SOLO lugar: crearViaje (mas el barrido de arranque). Alcanza
  con eso porque fecha_programada es INMUTABLE — el unico write en todo src/ es
  el create de crearViaje, no hay endpoint de reprogramacion. Por eso, a
  diferencia de las reservas (donde fecha_reserva se reinicia y habia que
  reprogramar en tres caminos), el aviso no se mueve nunca. Si algun dia se
  agrega un endpoint de reprogramacion, TIENE que volver a llamar a
  programarAvisoVencimiento.
- DIFERENCIA 1 — el clamp no puede disparar de mas. setTimeout desborda arriba
  de 2^31-1 ms (~24.8 dias). En reservas clampear degrada a "muy tarde" y es
  inofensivo; aca un viaje programado a mas de 24.8 dias dispararia ANTES de
  tiempo y emitiria un viaje:vencido FALSO. Por eso el handler, al disparar,
  RELEE el viaje: si fecha_programada todavia no llego, se RE-ARMA por lo que
  reste y no emite. El mismo guard cubre un reloj corrido.
- Esa relectura es tambien la segunda capa de defensa: si el estado ya no esta
  en ESTADOS_VENCIBLES no se emite nada. Es el equivalente al updateMany
  condicionado de liberarReserva — un timer que sobrevivio de mas es INOFENSIVO.
  Reusa INCLUDE_ACCESO_VIAJE (acceso-viaje.service), que ya trae exactamente
  cliente.id_usuario, conductor.id_usuario y empresa.id_gerente.
- Disparo UNICO por viaje: despues de emitir, el timer no se re-arma.

### Donde se CANCELA el aviso — y donde NO
Hay 13 escrituras a la tabla Viaje en todo src/. Solo CUATRO cancelan:
- iniciarViaje (→ EN_CAMINO_A_ORIGEN). La mas facil de olvidar: es un update
  plano (el estado se chequea en memoria, no en el WHERE) y hasta ahora no tenia
  ninguna cancelacion de timers.
- cancelarViajeCliente (→ CANCELADO), al lado del cancelarTimeoutReserva.
- cancelarViaje de admin (→ CANCELADO), idem.
- cerrarViaje (→ FINALIZADO). Defensivo: es inalcanzable sin pasar por
  iniciarViaje, que ya cancelo. Mismo criterio que el cancelarTimeoutReserva
  defensivo de cancelarViajeCliente.

Las otras NUEVE no cancelan, y cada una por su razon:
- aceptar (matching.socket) y asignar → CONDUCTOR_ASIGNADO: sigue siendo
  vencible.
- reservar → RESERVADO_POR_EMPRESA: no es vencible, pero el viaje puede VOLVER a
  BUSCANDO_CONDUCTOR antes de su hora (timeout de la reserva, cancelar-reserva),
  y ahi el aviso tiene que seguir vivo. Por eso ESTADOS_PRE_INICIO lo incluye.
- liberarReserva → BUSCANDO_CONDUCTOR, cancelar-conductor (las dos ramas) y
  ejecutarDesafiliacion → RESERVADO_POR_EMPRESA: siguen pre-inicio.
- reasignar: no cambia de estado, y el handler relee el conductor al disparar
  (no lo tiene cacheado), asi que el aviso le llega al conductor correcto.
- PATCH /:id/estado: validarTransicion hace IMPOSIBLE llegar ahi desde los dos
  estados vencibles, asi que nunca es una salida.

### Barrido de arranque
app.js corre barridoInicialVencimientos al lado de barridoInicialReservas: UNA
consulta (no un poller) de los viajes en ESTADOS_PRE_INICIO con
fecha_programada FUTURA, y le programa el timer a cada uno por el tiempo
RESTANTE. Loguea "[viaje-vencido] barrido de arranque: N viajes pre-inicio con
aviso programado".

- Los viajes cuya hora paso MIENTRAS el proceso estaba caido NO entran en la
  query y NO se avisan: emitir al arrancar seria tirar el evento al vacio
  (todavia no hay nadie conectado). Esos los cubre el flag `vencido`.
- DIFERENCIA 2 — este barrido NO lleva kill-switch tipo
  RESERVA_BARRIDO_ARRANQUE. Aquel lo necesita porque ESCRIBE en la DB de Neon
  compartida con produccion (libera reservas reales); este solo LEE y arma
  timers en memoria del proceso. Un server efimero de test que llegue a emitir
  viaje:vencido de un viaje real lo emite a sus propios rooms, y como no hay
  adapter de Redis nadie del lado de :3000 lo recibe.
- OJO al tocar el texto del log: test-timeout-reserva busca su linea por el
  prefijo COMPLETO "[reserva-timeout] barrido de arranque" justamente porque
  ahora hay DOS lineas de "barrido de arranque" en el arranque.

### LIMITACION CONOCIDA — un solo proceso
La misma que los timers de reserva: el Map vive en la memoria de UNA instancia.
Con mas de una instancia, una solo conoce los viajes que ella misma creo. Hoy se
corre una sola. El dia que se escale, esto va a una cola persistente (BullMQ
sobre el Redis que ya usamos). El barrido de arranque cubre el reinicio, NO el
multi-instancia.

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
| viaje:vencido   | Rooms personales del cliente, del conductor asignado y del gerente (usuario:{id_usuario}) |

Nota: viaje:asignado le puede llegar al mismo conductor desde varias
empresas donde trabaje — no asumir una sola empresa por conductor.

viaje:requiere_reasignacion avisa al gerente que un viaje YA asignado volvio
a RESERVADO_POR_EMPRESA y necesita reasignarse. Es distinto de
viaje:reserva_cancelada (ese es "vuelve al mercado abierto"). Payload
{ id_viaje, id_empresa, motivo }. Se emite en dos casos:
- Desafiliacion de un conductor con viajes CONDUCTOR_ASIGNADO de esa empresa
  (motivo: "conductor_desafiliado").
- Cancelacion del conductor de un viaje de empresa (motivo: "conductor_cancelo").

viaje:vencido avisa que un viaje llego a su fecha_programada SIN avanzar. El
viaje no cambia de estado. Payload { id_viaje, estado, fecha_programada }. Es
BEST-EFFORT: la fuente de verdad es el flag `vencido` del read. Los
destinatarios dependen del estado — ver "Viajes vencidos".

### Eventos del ciclo INTERNO (Paso 2)
Salas: `organizacion:{id}` (miembros activos de la PyME), `usuario:{id}` del
chofer (por id_usuario, NO id_conductor) y `viaje:{id}`. Mismos NOMBRES que
algunos eventos legacy, con payload propio (todos llevan id_viaje e
id_organizacion):
| Evento               | Destinatario                         | Cuando |
|----------------------|--------------------------------------|--------|
| viaje:asignado       | PyME + chofer nuevo                  | crear, reasignar |
| viaje:desasignado    | PyME + chofer viejo                  | reasignar |
| viaje:editado        | PyME + chofer                        | editar (`confirmacion_anulada` si estaba CONFIRMADO) |
| viaje:confirmado     | PyME                                 | el chofer confirma |
| viaje:rechazado      | PyME                                 | el chofer rechaza |
| viaje:iniciado / viaje:estado_cambiado / viaje:finalizado | PyME + viaje:{id} | iniciar, salir, confirmar-parada, cierre. estado_cambiado trae id_parada; finalizado trae estimado, real y paradas (Paso 3) |
| viaje:cancelado      | PyME + chofer                        | cualquier cancelacion: `causa` CHOFER / ORGANIZACION / ADMIN / DESVINCULACION |
| viaje:vencido        | PyME + chofer                        | VENCIDO (estado real; `estado_anterior`) |
| mapa:actualizar, costo:actualizar, eta:actualizar, alerta:desvio, alerta:parada, ruta:recalculada | viaje:{id} + PyME | tracking; mapa y costo sumaron `id_viaje` al payload |
| serie:asignada (Paso 4) | PyME + chofer | crear serie: UN evento con todos sus viajes (resumenViaje, sin nombres de lugar) en vez de N viaje:asignado |
| serie:cancelada (Paso 4) | PyME | cancelar serie (los viajes no cambian) |
| parada:salida_detectada (Tarea 5) | PyME + chofer | el GPS detecto la salida de una parada, una vez por parada |
| viaje:cierre_habilitado (Tarea 5) | PyME | se habilito el cierre manual (motivo TIEMPO o GPS), una vez por viaje |
| viaje:finalizado (Tarea 5) | PyME + viaje:{id} + chofer | suma cerrado_por, incompleto, paradas_no_visitadas y fecha_corte_precio |

El tracking llega a la sala de la PyME porque los emisores reciben las salas de
salasDeViaje(viaje) (sockets/salas.js) en vez de armar `viaje:${id}` a mano.

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
                                   antes el radio estaba fijo en 200. Se usa en
                                   DOS lugares y en ninguno mas: confirmar-parada
                                   y la deteccion de llegada al origen)

VENTANA_INICIO_MINUTOS            (ELIMINADA: ya no la lee nadie. El iniciar
                                   LEGACY usa VENTANA_INICIO_ANTES_MINUTOS, igual
                                   que el ciclo interno (sin cambio de
                                   comportamiento: ANTES ya estaba cargada en
                                   Railway). Borrarla de Railway.
                                   test-iniciar-viaje usa la MISMA funcion que el
                                   server, ventanaInicioAntesMinutos)

VENTANA_INICIO_ANTES_MINUTOS=60   (ventana para INICIAR un viaje de PyME:
VENTANA_INICIO_DESPUES_MINUTOS=90  [fecha - ANTES, fecha + DESPUES]; viaje a
                                   las 10 -> 9:00 a 11:30. El fin de la ventana
                                   es tambien cuando un ASIGNADO / CONFIRMADO
                                   VENCE. parseFloat (los tests usan 0.05 = 3 s);
                                   basura / negativo / vacio -> default. Se leen
                                   en cada uso. MISMO valor en staging y
                                   produccion mientras la DB este compartida:
                                   los dos procesos vencen viajes de la misma DB)
VENCIMIENTO_BARRIDO_ARRANQUE=1    (SOLO tests: =0 apaga el barrido de arranque
                                   de los viajes de PyME, que ESCRIBE (vence) y
                                   arma timers con la ventana del proceso. Un
                                   server efimero con ventana de segundos
                                   venceria viajes reales. En produccion NO se
                                   setea)
MARKETPLACE_HABILITADO=false      (solo 'true' o '1' prenden; ver "Viaje
CALIFICACIONES_HABILITADAS=false   interno — Flags". Se leen en cada request)
TEST_USER_EMAIL / TEST_USER_PASSWORD (cuenta del e2e; mismos valores que los
                                   secrets de GitHub. Las usa el e2e y
                                   seed-cuentas-test.js)

PUNTUALIDAD_TARDE_MINUTOS=30      (mismos umbrales de siempre, pero ahora se
PUNTUALIDAD_MUY_TARDE_MINUTOS=120  aplican al retraso de la LLEGADA al origen,
                                   no al de la salida. Se leen en CADA lectura,
                                   no se cachean)
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

TIEMPO_PEON_MINUTOS=30            (Paso 3: peon estimado en CADA parada. 0 es
                                   valido; basura / negativo -> 30. Se lee en
                                   cada estimacion)
MAPS_TIMEOUT_MS=8000              (timeout de cada llamada a Google)
MAPS_PROVIDER=routes              (routes | legacy. legacy = Directions, rollback
                                   temporal. Se lee en cada llamada)
GOOGLE_MAPS_API_KEY               (con Routes API habilitada. Sin key, crear /
                                   editar / estimar dan 503: no hay mock)

INVITACION_SECRETO                (SIN default: es un secreto. Sin el, el server
                                   arranca y los endpoints de invitaciones dan
                                   503. MISMO valor en staging y produccion
                                   mientras la DB este compartida)
INVITACION_VIGENCIA_HORAS=72      (vida de un codigo de invitacion)
INVITACION_INTENTOS_MAX=5         (rate limit del canje, por usuario Y por IP,
INVITACION_VENTANA_MINUTOS=15      en Redis. Los tests suben el max: todo sale
                                   de localhost y comparte la key por IP)
MAX_ORGANIZACIONES_POR_USUARIO=1  (PyMEs activas por cuenta CLIENTE)
MAX_PARADAS_POR_VIAJE=10          (Paso 4: tope GLOBAL de paradas por viaje,
                                   en todo lo que usa schemaParadas. Basura o
                                   < 2 -> 10)
SERIE_CONCURRENCIA_MAPS=4         (estimaciones a Google en vuelo a la vez al
                                   crear una serie. Basura o < 1 -> 4)
SERIE_TIMEOUT_MS=60000            (tope TOTAL de las estimaciones de una serie;
                                   si se pasa -> 503 y no se crea nada)
SALIDA_DETECCION_METROS=500       (Tarea 5: deteccion de salida de una parada:
SALIDA_DETECCION_SEGUNDOS=240      a mas de METROS durante SEGUNDOS seguidos.
                                   Se leen en cada ping. Los tests usan 4 s)
CIERRE_EXTENSION_MINUTOS=120      (Tarea 5: si la hora prevista de fin cae
                                   despues del fin del dia, el cierre automatico
                                   es la prevista + esto)
CIERRE_BARRIDO_ARRANQUE=1         (SOLO tests: =0 apaga el barrido de arranque
                                   del cierre automatico, que ESCRIBE en la DB
                                   compartida)
CIERRE_BARRIDO_ID_ORGANIZACION    (SOLO tests: limita ese barrido a una PyME)
CIERRE_FIN_DIA_SEGUNDOS_TEST      (SOLO tests: el "fin del dia" pasa a ser el
                                   inicio + N s. En Railway NUNCA)
LICENCIA_OPCIONAL=false           (pedido del front: 'true' o '1' hacen opcional
                                   la licencia en el registro del chofer. Se lee
                                   en cada request. NO prenderla hasta que
                                   production tenga el Paso A, y en los dos
                                   environments a la vez)
TEST_LICENCIA_NULL                (SOLO tests: =1 corre test-identidad CASO
                                   15c/15d, que escriben un conductor con
                                   licencia NULL)
FLETER_API                        (SOLO tests: backend del simulador del front,
                                   default staging; en CI = TEST_API_URL)
Todas se leen en CADA request (no se cachean), con guarda: un
valor basura o <= 0 cae al default.

La lista COMPLETA, agrupada, con el default de codigo de cada una y las marcas
[SOLO TESTS] / [LEGACY] / [SCRIPT], esta en .env.example (auditada contra src/,
scripts/, e2e/ y ci.yml en el mantenimiento de tests). Ademas de las de arriba:
ETA_EMISION_SEGUNDOS (30), ETA_RECALCULO_SEGUNDOS (360), ETA_EMISOR_IDLE_SEGUNDOS
(300; el .env.example viejo decia 600), RUTA_RECALCULO_COOLDOWN_SEGUNDOS (120),
DESVIO_UMBRAL_METROS (300), PARADA_SOSPECHOSA_* (3 km/h, 5 min), FEE_PORCENTAJE
(10), TARIFA_* (3500 / 5000 / 150 / 200), FIREBASE_WEB_API_KEY (SOLO tests: login
de los scripts) y TEST_BASE_URL (SOLO tests: server de las suites).
MERCADOPAGO_ACCESS_TOKEN se saco: no la lee nadie.

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
- Variables que tienen que valer LO MISMO en los dos environments mientras la
  DB sea compartida: INVITACION_SECRETO, VENTANA_INICIO_ANTES_MINUTOS y
  VENTANA_INICIO_DESPUES_MINUTOS (los dos procesos vencen viajes de la misma DB),
  y CIERRE_EXTENSION_MINUTOS (los dos procesos cierran solos viajes de la misma
  DB).
  Conviene que MAX_PARADAS_POR_VIAJE tambien valga lo mismo (un viaje creado en
  un environment se edita desde el otro). LICENCIA_OPCIONAL se prende en los
  dos a la vez, y solo con el Paso A en production.
- RADIO_CONFIRMACION_METROS esta en 200 en staging y production (el default de
  codigo es 50). El contrato del front (e2e/sim/CONTRATO-FINALIZAR.md) lo
  documenta asi.
- NO cargar en Railway las [SOLO TESTS] (RESERVA_BARRIDO_ARRANQUE,
  VENCIMIENTO_BARRIDO_ARRANQUE, CIERRE_BARRIDO_ARRANQUE,
  CIERRE_BARRIDO_ID_ORGANIZACION, CIERRE_FIN_DIA_SEGUNDOS_TEST,
  FIREBASE_WEB_API_KEY, TEST_*, FLETER_API). VENTANA_INICIO_MINUTOS
  ya no la lee nadie: borrarla. Las que el codigo lee y no estan cargadas
  (ETA_*, RUTA_RECALCULO_COOLDOWN_SEGUNDOS, FEE_PORCENTAJE, TARIFA_*) corren con
  el default de codigo: cargarlas solo para cambiar ese valor.
- Log de desconexion de socket: "[Socket] desconectado: ROL uid:N id:X
  motivo:<reason de socket.io> duracion:Ns" (sin email, token ni IP), para
  diagnosticar cortes del mobile.

## CI — .github/workflows/ci.yml
- `quality` (PR y push a main / develop): lint + tests unitarios. NO pega
  contra staging.
- `deploy-staging` (push a develop) y `deploy-production` (push a main), sin
  cambios.
- `e2e-staging`: needs deploy-staging, SOLO en push a develop. Antes de correr
  hace poll de GET /health cada 10 s, hasta 5 min, esperando que `capacidades`
  incluya "viaje-interno" (solo existe en el deploy nuevo); si no aparece, falla
  con "staging no tiene el deploy nuevo". Despues npm run test:e2e.
- Por que /health y no una ruta nueva: organizaciones.routes hace
  router.use(verificarToken, ...), asi que en el codigo VIEJO cualquier
  /api/organizaciones/* sin token ya daba 401 — no distingue los deploys. Para
  una capacidad futura: sumar el string en CAPACIDADES (app.js) y buscarlo en el
  poll.
- CONSECUENCIA ACEPTADA: el e2e ya NO bloquea el merge del PR. Antes corria en
  `quality` y pegaba contra el codigo VIEJO de staging (en el PR y tambien en el
  push, porque deploy-staging dependia de quality). Si falla, se ve en rojo en
  Actions despues del push a develop y se arregla con otro PR.
- El e2e usa los mismos secrets de siempre (TEST_API_URL, FIREBASE_WEB_API_KEY,
  TEST_USER_EMAIL, TEST_USER_PASSWORD) y resuelve solo la PyME y el chofer (via
  /api/auth/me y la lista de choferes). Crea un viaje y lo CANCELA (tambien en
  afterAll): staging comparte la DB con produccion.
- Paso "Simulador del front" (despues del E2E, `if: !cancelled()`, 10 min):
  `npm ci --omit=dev && npm run sim` en e2e/sim, con FLETER_API =
  TEST_API_URL y el secret FIREBASE_WEB_API_KEY. Deja sus cuentas
  sim+...@fleter.test en la DB compartida (ver "Simulador del front").
- ORDEN con un cambio de schema: el db push va ANTES del merge a develop (el
  deploy de staging escribe las columnas nuevas apenas sube; si no estan, el
  E2E y el simulador fallan).

## Comandos
npm run dev / npm run lint / npm run test
npm run test:regresion                     (TODAS las suites de abajo en serie,
                                            con server propio en :3900; ver
                                            "Regresion y limpieza de tests".
                                            --solo a,b / --desde x)
node scripts/restos.js                     (restos de tests en la DB compartida:
                                            SOLO cuenta; --borrar borra, --solo
                                            elige categorias; `sim` = lo que deja
                                            el simulador del front)
node e2e/sim/sim-finalizar-viaje.mjs       (simulador del front, caja negra contra
                                            FLETER_API (default staging); ver
                                            "Simulador del front")
Todas las suites necesitan FIREBASE_WEB_API_KEY en el .env (scripts/_firebase-auth.js).
Las que pegan a "el server" usan TEST_BASE_URL (default http://localhost:3000).
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
node scripts/test-viajes-vencidos.js       (flag vencido + evento viaje:vencido:
                                            los 3 destinatarios, los negativos
                                            (iniciado / cancelado antes de su
                                            hora), RESERVADO_POR_EMPRESA que no
                                            vence, y el barrido de arranque. NO
                                            usa el server de :3000 para los
                                            casos de timer — levanta uno propio
                                            por caso en 3301-3307 con
                                            ANTICIPACION_MINIMA_MINUTOS=0.
                                            Acepta numeros de caso para correr
                                            solo esos: `... vencidos.js 3 4`,
                                            util para el protocolo de reversion)
node scripts/test-historial-estados.js     (historial de estados: una fila por
                                            transicion, puntualidad medida en la
                                            llegada, doble iniciar concurrente,
                                            llegada por GPS y su respaldo, el
                                            fallo del historial que no tumba el
                                            cambio de estado, viajes sin
                                            historial y los 6 canales. NO usa el
                                            server de :3000 — levanta uno propio
                                            por caso en 3401-3407 con
                                            ANTICIPACION_MINIMA_MINUTOS=0.
                                            Acepta numeros de caso: `... 3`)
node scripts/test-timeout-reserva.js       (timers de reserva: vence y republica,
                                            asignar antes del timeout, cancelar
                                            -reserva a mano, y el barrido de
                                            arranque. NO usa el server de :3000
                                            para los casos de timer — levanta
                                            uno propio por caso en 3201-3204 con
                                            RESERVA_TIMEOUT_MINUTOS=0.1)
node scripts/test-identidad.js             (Paso 1: PyMEs, miembros, invitaciones,
                                            canje, choferes, roles, perfil y la
                                            concurrencia de las 3 invariantes.
                                            NO usa el server de :3000 — levanta
                                            uno propio en 3501 y casos aparte en
                                            3502-3504 (rate limit, sin secreto,
                                            Redis caido). Necesita Redis para el
                                            CASO 12. Borra TODO lo que crea (DB,
                                            Firebase y keys de Redis) y lo
                                            verifica. Acepta numeros de caso:
                                            `... identidad.js 9 10 11`)
node scripts/seed-cuentas-test.js          (recrea las cuentas FIJAS de las suites
                                            de regresion — cliente@, cliente2@,
                                            conductor@, conductor2@,
                                            stress-conductor2@test.com y
                                            admin-test@fleter.com — en Firebase y
                                            en la DB. Idempotente. CORRERLO
                                            despues de cualquier reset de la DB:
                                            si no, el registro de las suites da
                                            409 (el email sigue en Firebase) y
                                            todo request autenticado 404
                                            "Usuario no registrado").
                                            Ademas deja la cuenta del E2E: el
                                            usuario TEST_USER_EMAIL (si existe en
                                            Firebase NO le toca la password), la
                                            "PyME E2E" (CUIT 30999999995, ACTIVA,
                                            el usuario como RESPONSABLE) y
                                            chofer-e2e@test.com vinculado con el
                                            vehiculo E2E000 (FRAGIL). Sin
                                            TEST_USER_EMAIL / PASSWORD lo saltea
                                            con un aviso)
node scripts/test-maps.js                  (Paso 3, contra Google REAL: rutas
                                            corta / larga / a provincia, 4 paradas
                                            con llegadas crecientes y peon exacto,
                                            tabla antes / despues de precio y
                                            duracion, y servers efimeros 3701 /
                                            3702 (key invalida): crear y estimar
                                            -> 503 sin escribir nada, el ETA no
                                            se emite. ~16 llamadas Pro + 9
                                            elementos de Distance Matrix para la
                                            columna "antes")
node scripts/test-viaje-interno.js         (Paso 2: crear, confirmar, rechazar,
                                            iniciar (ventana y proximidad), ciclo
                                            completo con remito, cancelar (chofer,
                                            PyME, admin), reasignar, editar,
                                            vencimiento por timer y perezoso,
                                            desvinculacion, aislamiento entre
                                            PyMEs, flags y 7 carreras (CASO 17,
                                            5 rondas c/u). NO usa :3000 — levanta
                                            3601 (y 3602 para el timer, con
                                            ventana de 3 s). Acepta numeros de
                                            caso, SUBCASOS=17b,17d para una sola
                                            carrera (protocolo de reversion), y
                                            --restos para CONTAR lo que haya
                                            dejado una corrida cortada (p. ej.
                                            si Neon se cae a la mitad; borrar:
                                            --restos --borrar). Borra
                                            TODO lo suyo (DB, Firebase, Redis y
                                            remitos en R2) y lo verifica.
                                            Paso 3: usa Google REAL (~100
                                            llamadas Pro por corrida, las imprime
                                            al final); CASO 19 = 4 paradas de
                                            punta a punta, CASO 20 = cancelar en
                                            curso, 17h-j = carreras del ciclo
                                            por parada)
node scripts/test-lugares-series.js        (Paso 4: lugares (CRUD, nombre unico,
                                            soft delete, snapshot, aislamiento,
                                            SUSPENDIDA), el chofer sin el nombre
                                            por REST / sockets / remito, tope de
                                            paradas, series de las 4
                                            frecuencias con fechas exactas en
                                            hora AR, salteadas, todo o nada con
                                            Google caido (3802), editar /
                                            reasignar / confirmar / rechazar uno,
                                            cancelar, desvincular -> BORRADA, y 3
                                            carreras x 5 rondas (21a-c,
                                            SUBCASOS=21a). NO usa :3000 —
                                            levanta 3801 (y 3802 con key
                                            invalida). Acepta numeros de caso y
                                            --restos [--borrar]. Borra TODO lo suyo y lo
                                            verifica. Google REAL: ~60 llamadas
                                            Pro por corrida, las imprime al
                                            final junto con la tabla de series
                                            (viajes, llamadas y tiempos))
node scripts/test-cierre-viaje.js          (Tarea 5: finalizar de la PyME (antes
                                            de tiempo 409, pasada la prevista,
                                            con salida detectada), deteccion de
                                            salida (solo con llegada, reset al
                                            volver, una vez por parada), Salir
                                            tardio con la detectada (intermedia
                                            y ultima), cierre automatico por
                                            timer (3952, completo e incompleto),
                                            barrido de arranque (3953, limitado a
                                            la PyME del test), 409 sobre viajes
                                            cerrados, Salir vs finalizar (5
                                            rondas), un solo viaje en curso por
                                            chofer (3 rondas de dos iniciar) y el
                                            flujo normal sin cambios. CASO 8b =
                                            carrera con orden forzado (lock de la
                                            fila desde el test), CASO 13 = pings
                                            simultaneos al umbral. NO usa :3000 —
                                            levanta 3951. Acepta numeros de caso,
                                            RONDAS=N (carreras) y --restos
                                            [--borrar]. Google REAL: ~33 llamadas
                                            Pro por corrida)

scripts/_server-efimero.js es el helper compartido que levanta src/app.js en un
puerto propio con el env que se le pida. Lo usan el CASO 8 de test-jerarquia
(puerto 3210), test-timeout-reserva, test-viajes-vencidos, test-identidad,
test-viaje-interno y test-lugares-series. test-anticipacion tiene su propia copia
inline, anterior a la extraccion. OJO: no hay adapter de Redis en socket.io, o
sea que un socket conectado a :3000 NO recibe los eventos que emite un server
efimero — los tests que verifican eventos conectan sus sockets al puerto efimero.
Tambien exporta esperarLinea(leerLog, regex, ms): para los logs de tareas async
del arranque (barridos), que pueden salir DESPUES de /health. El runner de
regresion usa conServer para su propio server en :3900.

Nota de entorno: si el repo esta en una carpeta sincronizada por OneDrive,
node --watch (npm run dev) se reinicia solo cuando OneDrive toca node_modules y
corta requests en vuelo. Sintoma tipico: "fetch failed" a mitad de un script.

## Regresion y limpieza de tests

### Runner — scripts/test-regresion.js (npm run test:regresion)
- SUITES es un array unico al principio ({ archivo, timeoutMin, args? }).
  Corren en SERIE con spawn; cada una con su timeout (se mata el ARBOL de
  procesos, para no dejar servers efimeros con el puerto tomado -> FALLA
  "timeout"). Log completo de cada suite en scripts/.regresion/<suite>.log
  (gitignored) y del server en _server.log; en vivo con prefijo y sin las
  lineas prisma:query. Al final: tabla suite | resultado | duracion y exit 1 si
  alguna fallo. --solo a,b (subconjunto) y --desde x (retomar).
- Levanta SU PROPIO server en :3900 (conServer) con MARKETPLACE_HABILITADO y
  CALIFICACIONES_HABILITADAS en true y RESERVA_BARRIDO_ARRANQUE=0 /
  VENCIMIENTO_BARRIDO_ARRANQUE=0. No usa ni choca con un npm run dev en :3000.
  Las suites que pegan a "el server" leen TEST_BASE_URL (sueltas siguen yendo a
  :3000). Los flags van SOLO a ese server: las suites con servers efimeros fijan
  los suyos (viaje-interno / maps / lugares-series los ponen en false a
  proposito; las legacy con servers efimeros — timeout-reserva, viajes-vencidos,
  historial-estados, jerarquia CASO 8, anticipacion — prenden el marketplace en
  SU env, porque el .env local lo tiene en false).
- Requisitos: FIREBASE_WEB_API_KEY, INVITACION_SECRETO, Redis y las cuentas de
  seed-cuentas-test.js. Usa Google REAL (las suites del Paso 3/4 imprimen sus
  llamadas Pro).

### Login — scripts/_firebase-auth.js
UNICO lugar que conoce la Web API key (FIREBASE_WEB_API_KEY del .env; sin ella
tira "Falta FIREBASE_WEB_API_KEY ... NO la GOOGLE_MAPS_API_KEY"). getToken(email,
password). Antes estaba hardcodeada en 28 archivos (y test-vehiculos usaba la key
de Maps). `grep -r AIza scripts e2e src` -> vacio. La key sigue en el historial
de git: se restringe en GCP. El e2e (vitest, CI) la sigue leyendo directo.

### Limpieza — scripts/_limpieza.js
- crearRegistro(patron?) -> { patron(p), email, viaje, vehiculo, empresa, org,
  limpiar(), verificar() }. Con patron (las suites que registran usuarios
  propios: '-jer-<stamp>', '_veh_<TS>'...) se suman los usuarios de la DB con ese
  patron. A partir de los usuarios se derivan viajes (cliente / conductor /
  creador / empresa / vehiculo), empresas que gerencian, vehiculos propios y de
  flota, membresias y PyMEs. Las suites de CUENTAS FIJAS (fase5, cancelacion-*,
  admin, iniciar-viaje, zona, anticipacion, eta-recalculo, ruta-front,
  stress/cierre-exhaustivo) registran SOLO lo que crearon, por ID (viajes y
  vehiculos con 201); jamas la cuenta ni un vehiculo preexistente (FLT001 con 409
  no se toca).
- Borra en orden de FKs: remitos en R2 de los FINALIZADO, keys gps:{id}:* y de
  rate limit (usuarios + IPs de loopback), calificaciones, transacciones,
  historial, paradas, condiciones, viajes, series, lugares, conductor_vehiculo,
  condiciones de vehiculo, vehiculos, conductor_empresa, empresas, vinculos,
  invitaciones, membresias, PyMEs, metodos de pago, conductor, cliente, usuario
  y Firebase. verificar() cuenta lo que queda -> { ok, conteos }.
- GUARD DURO: si lo que se va a borrar incluye una cuenta del seed, la cuenta del
  E2E (TEST_USER_EMAIL, chofer-e2e@), la PyME de CUIT 30999999995 o el vehiculo
  E2E000 -> TIRA (no filtra en silencio).
- terminar(reg, ok): cierre comun de las suites legacy (limpia pase lo que pase,
  reporta "LIMPIEZA: no quedo nada de lo creado por el test", cierra Prisma /
  Redis, exit 1 si fallo un check o quedo algo). Los process.exit del medio
  pasaron a throw para que la limpieza corra. stress/test-cierre-exhaustivo
  ahora sale con 1 si tiene bugs (antes SIEMPRE 0: el runner no lo veia fallar).

### Restos — scripts/restos.js
Categorias: un patron por suite (-jer-, -vis-, -acc-, -dur-, -conc-, -conf-,
-vnc-, -hst-, -tmo-, cond-mvc-, _veh_, -vin-, -idn-, -lys-, maps-; usuarios en DB
y Firebase, incluidos los HUERFANOS de Firebase), `fijas` (viajes de las cuentas
del seed; las cuentas no se tocan), `e2e` (viajes de la cuenta del E2E),
`exploratorias` (vehiculos STR* de las stress viejas), `seed-test` (Empresa
Test / TEST001 del seed-test.js borrado) y `sim` (usuarios *@fleter.test del
simulador del front, DB y Firebase, con sus PyMEs, vehiculos, viajes y remitos;
el guard de protegidos sigue valiendo). Por defecto SOLO CUENTA; --borrar
borra, --solo elige. El --restos de test-viaje-interno y test-lugares-series
delega aca y TAMBIEN es solo conteo salvo --borrar (CAMBIO: antes borraba
directo).

### Intermitentes arreglados (sin tocar logs de produccion)
- test-timeout-reserva CASO 4d y test-viajes-vencidos CASO 5b: esperarLinea
  (_server-efimero.js, poll cada 200 ms, hasta 15 s) en vez de un esperar fijo,
  con la regex ANCLADA (en 5b el ':' justo despues de "arranque" distingue la
  linea legacy de la "(ciclo interno)"). El barrido es async y puede loguear
  despues de /health.
- test-identidad CASO 12: /health responde antes de que el Redis del server
  efimero este 'ready', y sin Redis el rate limit deja pasar (fail-open). SONDA:
  canjea basura hasta que aparece invitacion:canje:usuario:{R1} en Redis, borra
  las keys y recien ahi arrancan los 4 intentos.
- test-historial-estados CASO 3c (aparecio en la primera regresion completa):
  los dos iniciar salen en el mismo tick, pero eso no garantiza que las dos
  lecturas previas ocurran antes del commit del ganador. Si la del perdedor
  llega despues es el caso SECUENCIAL y el contrato es 400, no 409. 3c acepta
  los dos (y dice cual salio); el guard lo siguen probando 3b / 3d / 3e (un solo
  ganador, iniciado_por sin pisar, una sola fila de historial).
- test-concurrencia-jerarquia CASO A2 (aparecio en la regresion de la Tarea 5): el
  MISMO patron con dos reservar. El perdedor recibia el 400 de validarTransicion
  ("RESERVADO_POR_EMPRESA a RESERVADO_POR_EMPRESA") en vez del 409. NO es de la
  Tarea 5: el codigo BASE (3930e20) dio 1/3 en rojo y la version nueva 1/5,
  siempre en la PRIMERA corrida contra un server recien levantado (por eso
  `--solo`, que levanta uno nuevo cada vez, daba 3/3). A2 acepta 409 o ese 400 y
  dice cual salio; el guard lo siguen probando A1 / A3 (un solo ganador, la
  empresa ganadora sin pisar).
- test-vehiculos TEST C: se logueaba con la key de Maps y NUNCA pasaba del
  login, asi que nadie vio que esperaba el contrato viejo de viaje:aceptar
  ("Debes seleccionar un vehiculo", errores como { error }). Se alineo con el
  vigente de API.md: id_vehiculo OPCIONAL (auto-seleccion, probada en un segundo
  viaje) y errores como { mensaje: 'Ese vehiculo no te pertenece' }.

### scripts/legacy/ — exploratorias (NO entran al runner)
Se movieron sin borrar (solo se ajustaron imports). Triage del mantenimiento de
tests, corridas contra un server con los flags en true:
- legacy/test-bugs2.js (c): /disponibles + doble aceptar; fecha fija 2026-09-01
  ya pasada -> no crea el viaje. El guard lo cubre test-concurrencia-jerarquia B.
- legacy/test-fase4.js (c): GPS / desvio / parada del ciclo viejo; depende del
  inicio automatico por primer ping (se saco con el boton Iniciar). Cubierto por
  fase5 / eta-recalculo / ruta-front.
- legacy/test-matching-fix.js (c): aceptar con / sin id_vehiculo; fecha fija pasada.
- legacy/stress/test-concurrencia.js (c): sale SIEMPRE con 0; secciones 3 y 6
  dependen del inicio automatico.
- legacy/stress/test-gps-exhaustivo.js (c): sale SIEMPRE con 0; 13/22 en rojo
  por el inicio automatico (el GPS se rechaza en CONDUCTOR_ASIGNADO).
- legacy/stress/test-vehiculos-exhaustivo.js (b): lo cubre test-vehiculos;
  depende de que STR099 no exista.
- legacy/stress/run-all.js + REPORTE.md: el runner viejo de las stress.
test-bugs.js (JWT hardcodeado, 0/7 con login real) y seed-test.js (nadie lo
referenciaba) se BORRARON: quedan en el historial de git.

### PENDIENTES
- Portar a una suite oficial (que llame a iniciar) lo que SOLO cubrian
  gps-exhaustivo y concurrencia: bordes de lat/lng (+-90 / +-180 y apenas
  afuera), que el acumulado no se contamine con pings invalidos, rafaga de pings
  y carga / latencia de pings (284 pings, ~660 ms promedio en el triage).
- LAS EXPLORATORIAS DE scripts/legacy/ NO LIMPIAN LO QUE CREAN (no usan
  _limpieza.js). Una corrida del set deja ~24 viajes VIVOS colgados de las
  cuentas FIJAS (cliente@, conductor@, stress-conductor2@): test-fase4 deja 1
  EN_RUTA (lo fuerza con prisma.viaje.update, sin historial),
  stress/test-concurrencia ~18 y stress/test-gps-exhaustivo 4 en
  CONDUCTOR_ASIGNADO / BUSCANDO_CONDUCTOR, stress/test-vehiculos-exhaustivo 1
  viaje + STR001 / STR002. Paso el 2026-10-19 (viajes 1526-1549, 19:56 UTC, de
  una corrida que no fue del mantenimiento de tests; se borraron con
  restos.js). Si se vuelven a correr: despues, `node scripts/restos.js --solo
  fijas,exploratorias` y borrar con --borrar. Darles crearRegistro + terminar
  si alguna se porta a suite oficial (ver el punto anterior).
- BUG en src: PUT /api/conductores/mis-vehiculos/:id con un id no numerico da 500
  en vez de 400 (lo destapo vehiculos-exhaustivo: PUT /mis-vehiculos/undefined).
- Lint: scripts/ no entra en npm run lint; varias suites legacy tienen errores
  de eslint previos (no-empty, no-useless-assignment) que no se tocaron.
