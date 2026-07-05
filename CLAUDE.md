# Fleter — Backend

## Descripcion del proyecto
Plataforma de fletes para PyMEs argentinas.
El cliente crea un viaje, el sistema lo publica a conductores elegibles via
WebSocket, el primero en aceptar queda asignado. Fee porcentual por viaje.
MVP: CABA + Gran Buenos Aires.

## Estado actual del proyecto
- Fases 0-5 COMPLETAS
- Gestion de vehiculos, descripcion, ETA/recalculo/ruta_planeada COMPLETO
- Pipeline CI/CD + deploy a Railway por environment COMPLETO
- Cancelacion de viaje por conductor COMPLETO
- Cancelacion de viaje por cliente COMPLETO
- Panel de administracion (rol ADMIN) COMPLETO

## Stack
- Node.js 22 con ES Modules
- Express
- PostgreSQL en Neon — Prisma 6
- Firebase Admin SDK
- Socket.io v4
- Redis con ioredis
- Turf.js, Zod
- pdfkit, @aws-sdk/client-s3 (Cloudflare R2)
- Google Maps Directions API

## Reglas de codigo
- ES Modules siempre. NUNCA require().
- Modulos CommonJS: import pkg from 'modulo'; const { X } = pkg;
- Async/await siempre.
- Validar con Zod en endpoints REST.
- Errores como { error: "mensaje" }
- Variables en .env, nunca hardcodeadas.
- kebab-case en archivos.
- Named exports en controllers/services.
- Instancia unica de PrismaClient en src/config/prisma.js

## Reglas de migraciones Prisma
- Hay drift en el historial. Usar npx prisma db push para cambios de schema.
- No usar prisma migrate reset sin autorizacion explicita de Samuel.

## Roles
- CLIENTE, CONDUCTOR, GERENTE (para el futuro) y ADMIN.
- ADMIN existe en el enum pero hasta ahora no tenia endpoints. Esta tarea
  agrega los endpoints admin y un script para crear cuentas admin.

## Panel de administracion (esta tarea)

### Objetivo
Un rol ADMIN puede leer datos generales de la app, ver detalles de
usuarios y viajes, ver estadisticas agregadas, y cancelar viajes en
cualquier estado excepto FINALIZADO y CANCELADO. Todos los endpoints
protegidos con rol ADMIN.

### Autenticacion
Un admin es un usuario mas, con firebase_uid, email/contrasena y rol ADMIN.
No hay endpoint publico de registro. Se crea via script/seed que crea el
usuario en Firebase Y en la DB en una sola operacion (con rollback si
falla la DB, igual que el flujo de registro cliente/conductor existente).

Script: scripts/crear-admin.js
- Lee ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NOMBRE, ADMIN_APELLIDO, ADMIN_DNI
  del entorno. Son variables OPCIONALES: solo hacen falta al correr este
  script para crear un admin, no en el runtime normal ni en el pipeline CI/CD.
- Idempotente: si el email ya existe (en Firebase o DB), lo informa y no
  duplica. Si existe en Firebase pero no en la DB, reutiliza el uid y
  completa el registro en la DB.
- Se corre manualmente contra la DB target (production o staging), p. ej.:
  ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_NOMBRE=... ADMIN_APELLIDO=... \
  ADMIN_DNI=... node scripts/crear-admin.js

### Endpoints

Todos bajo /api/admin/*, todos requieren rol ADMIN (403 si no lo es).

1. GET /api/admin/usuarios
   - Query params opcionales: rol (CLIENTE|CONDUCTOR|GERENTE|ADMIN),
     page (default 1), limit (default 50, max 200)
   - Respuesta: { total, page, limit, usuarios: [...] }
   - Cada usuario incluye: campos publicos del usuario + su rol especifico
     con los datos asociados (cliente/conductor/gerente/admin)

2. GET /api/admin/usuarios/:id
   - Detalle completo de un usuario segun su rol:
     * CLIENTE: datos personales + historial de viajes creados
     * CONDUCTOR: datos personales + licencia + vehiculos + calificacion
       promedio + historial de viajes aceptados
     * GERENTE: datos personales + empresa asociada + conductores de la
       empresa + vehiculos de la empresa (si el modelo lo tiene disponible;
       en el MVP actual puede que este vacio)
     * ADMIN: solo datos personales
   - 404 si no existe

3. GET /api/admin/viajes
   - Query params opcionales:
     * estado (cualquier EstadoViaje)
     * cantidad_paradas (numero exacto)
     * zona (CABA|PROVINCIA|MIXTO)
     * desde (fecha ISO, inclusive, filtra por creado_en)
     * hasta (fecha ISO, inclusive)
     * page (default 1), limit (default 50, max 200)
   - Respuesta: { total, page, limit, viajes: [...] }
   - Cada viaje incluye datos basicos + cliente + conductor si asignado

4. GET /api/admin/viajes/:id
   - Detalle completo del viaje: paradas, cliente completo, conductor
     completo si existe, vehiculo, precios (estimado/real), fee, remito_url
     si existe, calificacion si existe, motivo_cancelacion si existe.
   - 404 si no existe

5. GET /api/admin/estadisticas
   - Un solo request, devuelve un objeto con todas las metricas:
     {
       usuarios: {
         total,
         por_rol: { CLIENTE, CONDUCTOR, GERENTE, ADMIN },
         registrados_ultimo_mes,
         registrados_por_dia_ultimos_30_dias: [{ fecha, cantidad }]
       },
       viajes: {
         total,
         por_estado: { BUSCANDO_CONDUCTOR, CONDUCTOR_ASIGNADO, ... },
         por_dia_ultimos_30_dias: [{ fecha, cantidad_creados,
                                      cantidad_finalizados }]
       },
       plata: {
         total_precio_real_finalizados,     // suma de precio_real de
                                             // viajes FINALIZADO
         total_fee_app,                     // suma de fee sobre esos
         total_neto_conductores,            // suma de precio_neto
                                             // (precio_real - fee)
         top_conductores_por_ganancia: [    // top 10, cada uno con
           { id_conductor, nombre, apellido, // sus datos + total ganado
             total_ganado, cantidad_viajes }
         ],
         top_clientes_por_gasto: [          // top 10
           { id_cliente, nombre, apellido,
             total_gastado, cantidad_viajes }
         ]
       }
     }

6. POST /api/admin/viajes/:id/cancelar
   - Rol ADMIN
   - Body: { motivo: string opcional }
   - Validaciones:
     * Viaje existe (404 si no)
     * Estado del viaje NO es FINALIZADO ni CANCELADO (400 si lo es, con
       mensaje claro)
   - Logica (selectiva por estado — enfoque 1):
     * Si el estado era CONDUCTOR_ASIGNADO en adelante (o sea, hay o hubo
       tracking activo): llamar a limpiarViajeActivo(id_viaje) — el helper
       que ya existe y detiene ETA emisor + limpia keys Redis.
     * En cualquier caso: cambiar viaje.estado a CANCELADO. Guardar el
       motivo en un campo motivo_cancelacion (nuevo, se agrega al schema).
       Guardar quien lo cancelo en cancelado_por_admin_id (nuevo,
       referencia al id_usuario del admin).
     * Las paradas que ya estaban ENTREGADO mantienen su estado (historial).
     * Emitir viaje:cancelado_por_admin al room viaje:{id_viaje} Y al
       room personal usuario:{id_usuario_cliente} (si el cliente existe),
       con payload { id_viaje, motivo }.
   - Respuesta 200: { mensaje: "Viaje cancelado por admin", id_viaje,
     estado: "CANCELADO", motivo }

### Cambios de schema requeridos
Agregar en modelo Viaje:
- motivo_cancelacion  String?
- cancelado_por_admin_id  Int?  (referencia opcional a usuarios.id_usuario)

Aplicar con: npx prisma db push (no crear migracion — sigue la regla de
drift ya documentada).

### FEE_PORCENTAJE
Variable de entorno nueva, default 10 (porcentaje entero). Se usa en las
estadisticas para calcular total_fee_app y total_neto_conductores.

## Cancelaciones de viaje — resumen unificado
- Por CONDUCTOR: solo CONDUCTOR_ASIGNADO → viaje vuelve a BUSCANDO_CONDUCTOR
  y se republica.
- Por CLIENTE: BUSCANDO_CONDUCTOR o CONDUCTOR_ASIGNADO → viaje termina en
  CANCELADO.
- Por ADMIN: cualquier estado excepto FINALIZADO y CANCELADO → viaje
  termina en CANCELADO. Es la unica cancelacion que puede interrumpir un
  viaje en marcha (EN_CAMINO_A_ORIGEN, CARGANDO, EN_RUTA, DESCARGANDO).

Las tres reutilizan el helper limpiarViajeActivo(id_viaje) que detiene ETA
y limpia Redis.

## WebSockets — eventos nuevos (esta tarea)

| Evento                     | Direccion            | Destinatario                          |
|----------------------------|----------------------|---------------------------------------|
| viaje:cancelado_por_admin  | servidor → room      | Room viaje:{id_viaje}                 |
| viaje:cancelado_por_admin  | servidor → cliente   | Room personal usuario:{id_cliente}    |

Payload: { id_viaje, motivo, estado: "CANCELADO" }

## Redis — Keys de GPS (sin cambios)
gps:{id_viaje}:ultima, :historial, :ruta, :acumulado, :pings_detenido,
:eta, :ultimo_recalculo, :pings_desviado
limpiarGPS (en gps.service.js) borra todas de una vez.

## Deploy
- Backend: Railway (production: branch main, staging: branch develop)
- DB: Neon separada por environment
- Redis: Railway separado por environment
- Firebase compartido

## Comandos
npm run dev
npm run lint
npm run test
node scripts/test-fase5.js
node scripts/test-cancelacion-conductor.js
node scripts/test-cancelacion-cliente.js
node scripts/test-admin.js
node scripts/crear-admin.js