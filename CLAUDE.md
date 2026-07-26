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
  soltarlo el gerente a mano.

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

### Tracking del gerente
- Al gerente se lo suma al room viaje:{id} de los viajes de su empresa,
  para que reciba mapa:actualizar / eta:actualizar como el cliente.

## Eventos WebSocket nuevos
| Evento          | Destinatario                                   |
|-----------------|------------------------------------------------|
| viaje:reservado | Room viaje:{id} (sacar del pool a los demas)   |
| viaje:asignado  | Room personal del conductor (usuario:{id})     |
| viaje:reserva_cancelada | Room viaje:{id} (vuelve al mercado)    |

Nota: viaje:asignado le puede llegar al mismo conductor desde varias
empresas donde trabaje — no asumir una sola empresa por conductor.

## Variables de entorno de esta tarea
RESERVA_TIMEOUT_MINUTOS=10   (nueva)
Eliminar MATCHING_TIMEOUT_MINUTOS (variable muerta, sin efecto).

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
node scripts/test-jerarquia.js   (nuevo, esta tarea)