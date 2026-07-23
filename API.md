El API.md que tenés mezcló contenido del CLAUDE.md adentro. Acá está el API.md correcto y completo hasta Fase 3. Reemplazás todo el contenido del archivo con esto:
markdown# Fleter — Contrato de API

Documento de referencia para el equipo mobile y web.
Base URL desarrollo: `http://localhost:3000`
Base URL producción: `https://nombre-proyecto-back-production.up.railway.app`

---

## Autenticación

La mayoría de endpoints requieren un JWT de Firebase en el header:
Authorization: Bearer <firebase-id-token>

El token se obtiene del cliente Firebase después de que el usuario inicia sesión.
Este backend **nunca autentica contraseñas directamente** — solo verifica el token.

**En React Native:**
```js
import auth from '@react-native-firebase/auth';
const token = await auth().currentUser.getIdToken();
```

**En Next.js:**
```js
import { getAuth } from 'firebase/auth';
const token = await getAuth().currentUser.getIdToken();
```

El token dura 1 hora. Firebase lo renueva automáticamente.

**Para testing (Thunder Client / Postman):**
POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=TU_FIREBASE_WEB_API_KEY
Body:
{
"email": "usuario@test.com",
"password": "password",
"returnSecureToken": true
}
El campo `idToken` de la respuesta es el Bearer token.

---

## GET /health

Verificación de estado del servidor. No requiere autenticación.

**Respuesta exitosa — 200:**
```json
{
  "status": "ok",
  "timestamp": "2026-05-09T12:00:00.000Z"
}
```

---

## /auth — Autenticación y usuarios

### POST /api/auth/registro-cliente

Crea una cuenta de cliente. Firebase genera las credenciales, luego se persiste en la DB.

**Autenticación:** No requerida

**Body:**
```json
{
  "nombre": "string (requerido)",
  "apellido": "string (requerido)",
  "dni": "string 7-9 dígitos (requerido)",
  "email": "string email válido (requerido)",
  "contrasena": "string mínimo 6 caracteres (requerido)",
  "telefono": "string (opcional)",
  "cuit": "string (opcional)",
  "nombre_empresa": "string (opcional)",
  "direccion_principal": "string (opcional)"
}
```

**Respuesta exitosa — 201:**
```json
{
  "mensaje": "Registrado correctamente",
  "id_usuario": 1
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "mensaje de validación" }` | Campo faltante o inválido |
| 409 | `{ "error": "El email ya esta registrado" }` | Email duplicado en Firebase |
| 409 | `{ "error": "El DNI ya esta registrado" }` | DNI duplicado en DB |
| 500 | `{ "error": "Internal Server Error" }` | Error inesperado |

---

### POST /api/auth/registro-conductor

Crea una cuenta de conductor.

**Autenticación:** No requerida

**Body:**
```json
{
  "nombre": "string (requerido)",
  "apellido": "string (requerido)",
  "dni": "string 7-9 dígitos (requerido)",
  "email": "string email válido (requerido)",
  "contrasena": "string mínimo 6 caracteres (requerido)",
  "telefono": "string (opcional)",
  "nro_licencia": "string (requerido)",
  "licencia_vencimiento": "string ISO 8601 (requerido) — ej: '2027-12-31T00:00:00.000Z'"
}
```

**Respuesta exitosa — 201:**
```json
{
  "mensaje": "Registrado correctamente",
  "id_usuario": 5
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "mensaje de validación" }` | Campo faltante o inválido |
| 409 | `{ "error": "El email ya esta registrado" }` | Email duplicado en Firebase |
| 409 | `{ "error": "El DNI ya esta registrado" }` | DNI duplicado en DB |

---

### POST /api/auth/registro-gerente

Crea una cuenta de gerente y la empresa asociada en una sola operación.

**Autenticación:** No requerida

**Body:**
```json
{
  "nombre": "string (requerido)",
  "apellido": "string (requerido)",
  "dni": "string 7-9 dígitos (requerido)",
  "email": "string email válido (requerido)",
  "contrasena": "string mínimo 6 caracteres (requerido)",
  "telefono": "string (opcional)",
  "cuit_empresa": "string 11-13 caracteres (requerido)",
  "nombre_empresa": "string (requerido)"
}
```

**Respuesta exitosa — 201:**
```json
{
  "mensaje": "Registrado correctamente",
  "id_usuario": 12
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "mensaje de validación" }` | Campo faltante o inválido |
| 409 | `{ "error": "El email ya esta registrado" }` | Email duplicado en Firebase |
| 409 | `{ "error": "El DNI ya esta registrado" }` | DNI duplicado en DB |

---

### POST /api/auth/login

Verifica que el usuario autenticado por Firebase existe en la DB.
**No autentica credenciales** — eso lo hace Firebase en el cliente.

**Autenticación:** Requerida

**Body:** Ninguno

**Respuesta exitosa — 200:**
```json
{
  "id_usuario": 1,
  "nombre": "Juan",
  "apellido": "Pérez",
  "email": "juan@example.com",
  "rol": "CLIENTE"
}
```

`rol` puede ser: `CLIENTE`, `CONDUCTOR`, `GERENTE`, `ADMIN`

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 401 | `{ "error": "Token no proporcionado" }` | Header Authorization ausente |
| 401 | `{ "error": "Token invalido o expirado" }` | JWT inválido o vencido |
| 404 | `{ "error": "Usuario no registrado" }` | Token válido pero sin registro en DB |

---

### GET /api/auth/me

Retorna el perfil completo del usuario autenticado.

**Autenticación:** Requerida

**Respuesta exitosa — 200:**
```json
{
  "id_usuario": 1,
  "firebase_uid": "abc123xyz",
  "nombre": "Juan",
  "apellido": "Pérez",
  "dni": "12345678",
  "email": "juan@example.com",
  "telefono": "+5491112345678",
  "rol": "CLIENTE",
  "fecha_registro": "2026-04-28T00:00:00.000Z"
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 401 | `{ "error": "Token no proporcionado" }` | Header Authorization ausente |
| 401 | `{ "error": "Token invalido o expirado" }` | JWT inválido o vencido |
| 404 | `{ "error": "Usuario no registrado" }` | Token válido pero sin registro en DB |

---

### PUT /api/auth/perfil

Actualiza el perfil del usuario autenticado. Solo se actualizan los campos presentes en el body.

**Autenticación:** Requerida

**Body (todos opcionales, al menos uno requerido):**
```json
{
  "nombre": "string",
  "apellido": "string",
  "telefono": "string"
}
```

**Respuesta exitosa — 200:**
```json
{
  "id_usuario": 1,
  "firebase_uid": "abc123xyz",
  "nombre": "Juan Actualizado",
  "apellido": "Pérez",
  "dni": "12345678",
  "email": "juan@example.com",
  "telefono": "+5491199999999",
  "rol": "CLIENTE",
  "fecha_registro": "2026-04-28T00:00:00.000Z"
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "mensaje de validación" }` | Valor de campo inválido |
| 401 | `{ "error": "Token no proporcionado" }` | Header Authorization ausente |
| 401 | `{ "error": "Token invalido o expirado" }` | JWT inválido o vencido |

---

## /viajes — Gestión de viajes

### POST /api/viajes/estimar-costo

Calcula el costo estimado de un viaje sin crearlo.
Si `GOOGLE_MAPS_API_KEY` no está configurada usa valores mock (10 km, 0.5 h).

**Rol requerido:** `CLIENTE`

**Body:**
```json
{
  "zona": "CABA",
  "paradas": [
    { "lat": -34.6037, "lng": -58.3816, "direccion": "Plaza de Mayo, CABA" },
    { "lat": -34.5895, "lng": -58.3974, "direccion": "Recoleta, CABA" }
  ],
  "fecha_programada": "2026-07-01T08:00:00.000Z"
}
```

- `zona`: `"CABA"` | `"PROVINCIA"` | `"MIXTO"`
- `paradas`: mínimo 2 elementos
- `fecha_programada`: opcional. Si se omite se usa la fecha/hora actual para determinar si es hora pico.

**Respuesta exitosa — 200:**
```json
{
  "precio_estimado": 2500,
  "desglose": {
    "precio_por_tiempo": 2500,
    "precio_por_distancia": null,
    "tiempo_horas": 0.5,
    "distancia_km": 2.3,
    "tarifa_hora": 5000,
    "tarifa_km": null,
    "es_hora_pico": true
  }
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "mensaje de validación" }` | Campo faltante o inválido |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CLIENTE |
| 503 | `{ "error": "No se pudo calcular la distancia" }` | Error en Google Maps API |

---

### POST /api/viajes

Crea un viaje nuevo. El viaje queda en estado `BUSCANDO_CONDUCTOR` y se publica
instantáneamente a los conductores elegibles conectados via WebSocket.

**Rol requerido:** `CLIENTE`

**Body:**
```json
{
  "zona": "MIXTO",
  "paradas": [
    { "lat": -34.6037, "lng": -58.3816, "direccion": "Plaza de Mayo, CABA" },
    { "lat": -34.92, "lng": -57.95, "direccion": "La Plata, Buenos Aires" }
  ],
  "fecha_programada": "2026-07-01T10:00:00.000Z",
  "condiciones_requeridas": ["FRAGIL", "REFRIGERADO"],
  "descripcion": "Carga frágil, llamar al llegar, portón azul"
}
```

- `fecha_programada`: fecha ISO 8601 y **estrictamente mayor** a 1 hora (60 minutos) desde el
  momento del request. Solo se valida ese **mínimo**: no hay tope máximo de anticipación. Si el
  valor no es una fecha válida o no supera ese mínimo → `400` con
  `{ "error": "fecha_programada debe ser una fecha ISO futura (al menos 1 hora desde ahora)" }`
- `condiciones_requeridas`: opcional. Valores posibles: `FRAGIL`, `REFRIGERADO`,
  `CARGA_PESADA`, `PELIGROSO`, `VOLUMINOSO`
- `descripcion`: opcional. Texto libre visible para el conductor antes de aceptar y en el
  remito PDF. Máximo 500 caracteres. No afecta matching ni costo.

Las tarifas se calculan automáticamente según la zona y si la `fecha_programada` cae en hora pico
(7–10 h o 17–20 h). Se usan las variables de entorno `TARIFA_*` o los valores por defecto.

**Respuesta exitosa — 201:**
```json
{
  "id_viaje": 42,
  "id_cliente": 3,
  "id_conductor": null,
  "id_vehiculo": null,
  "id_empresa": null,
  "zona": "MIXTO",
  "tarifa_hora": 5000,
  "tarifa_km": 200,
  "fecha_programada": "2026-07-01T10:00:00.000Z",
  "descripcion": "Carga frágil, llamar al llegar, portón azul",
  "estado": "BUSCANDO_CONDUCTOR",
  "fecha_inicio": null,
  "puntualidad_inicio": null,
  "precio_estimado": 4500,
  "precio_real": null,
  "creado_en": "2026-05-09T12:00:00.000Z",
  "paradas": [
    {
      "id_parada": 1,
      "orden": 1,
      "direccion": "Plaza de Mayo, CABA",
      "latitud": -34.6037,
      "longitud": -58.3816,
      "qr_token": "cuid_generado_automaticamente",
      "estado": "PENDIENTE",
      "fecha_entrega": null
    }
  ],
  "condiciones_req": [
    { "id_condicion_req": 1, "condicion": "FRAGIL" },
    { "id_condicion_req": 2, "condicion": "REFRIGERADO" }
  ],
  "ruta_planeada": [[-58.38162, -34.60361], [-58.38201, -34.60280], "..."],
  "desglose_estimado": {
    "precio_por_tiempo": 2500,
    "precio_por_distancia": 2000,
    "tiempo_horas": 0.5,
    "distancia_km": 10,
    "tarifa_hora": 5000,
    "tarifa_km": 200,
    "es_hora_pico": true
  }
}
```

- `ruta_planeada`: array de puntos `[lng, lat]` (ver [Formato de ruta](#formato-de-ruta)). La
  ruta se calcula al crear el viaje. Es **`null`** si Google Maps falla en ese momento; en ese
  caso se reintenta automáticamente en el primer ping GPS —es decir, una vez que el conductor
  inició el viaje— y el viaje se crea igual (201).

**Comportamiento adicional:** después de crear el viaje, el servidor emite el evento
`viaje:disponible` via WebSocket a todos los conductores elegibles conectados.

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "mensaje de validación" }` | Campo faltante o inválido |
| 400 | `{ "error": "fecha_programada debe ser una fecha ISO futura (al menos 1 hora desde ahora)" }` | `fecha_programada` ausente, no es ISO válida, o no supera el mínimo de 1 hora desde el request |
| 400 | `{ "error": "El usuario no tiene perfil de cliente" }` | El usuario no tiene registro de cliente |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CLIENTE |
| 503 | `{ "error": "No se pudo calcular la distancia" }` | Error en Google Maps API |

---

### GET /api/viajes/disponibles

Devuelve los viajes en estado `BUSCANDO_CONDUCTOR` con fecha futura para los que
el conductor es elegible. Un conductor es elegible si y solo si tiene al menos
un vehículo (propio o asignado vía empresa) que cumple todas las condiciones
requeridas del viaje. Si el viaje no requiere condiciones, alcanza con tener
al menos un vehículo — un conductor sin ningún vehículo registrado no es
elegible para ningún viaje, tenga o no condiciones requeridas.

**Rol requerido:** `CONDUCTOR`

**Respuesta exitosa — 200:**
```json
[
  {
    "id_viaje": 42,
    "zona": "CABA",
    "precio_estimado": 2500,
    "fecha_programada": "2026-07-01T10:00:00.000Z",
    "descripcion": "Carga frágil, llamar al llegar, portón azul",
    "estado": "BUSCANDO_CONDUCTOR",
    "paradas": [
      {
        "orden": 1,
        "direccion": "Plaza de Mayo, CABA",
        "latitud": -34.6037,
        "longitud": -58.3816
      }
    ],
    "condiciones_req": [],
    "cliente": {
      "usuario": {
        "nombre": "Juan",
        "apellido": "Pérez",
        "telefono": "+5491112345678"
      }
    }
  }
]
```

`descripcion` es `null` si el cliente no escribió una.

Ordenados por `fecha_programada` ascendente.

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "El usuario no tiene perfil de conductor" }` | Sin registro de conductor |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CONDUCTOR |

---

### GET /api/viajes/mis-viajes

Devuelve todos los viajes del cliente autenticado, del más reciente al más antiguo.

**Rol requerido:** `CLIENTE`

**Respuesta exitosa — 200:**
```json
[
  {
    "id_viaje": 42,
    "zona": "CABA",
    "precio_estimado": 2500,
    "precio_real": null,
    "estado": "BUSCANDO_CONDUCTOR",
    "fecha_programada": "2026-07-01T10:00:00.000Z",
    "fecha_inicio": null,
    "puntualidad_inicio": null,
    "creado_en": "2026-05-09T12:00:00.000Z",
    "paradas": [
      { "orden": 1, "direccion": "Plaza de Mayo, CABA" }
    ],
    "conductor": null
  }
]
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "El usuario no tiene perfil de cliente" }` | Sin registro de cliente |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CLIENTE |

---

### GET /api/viajes/mis-viajes-conductor

Devuelve todos los viajes que el conductor autenticado tiene asignados (donde es el conductor
del viaje), del más reciente al más antiguo. Es el equivalente de `mis-viajes` para el conductor.

**Rol requerido:** `CONDUCTOR`

**Query params (opcionales):**
- `estado`: filtra por estado del viaje. Debe ser un `EstadoViaje` válido: `BUSCANDO_CONDUCTOR`,
  `CONDUCTOR_ASIGNADO`, `EN_CAMINO_A_ORIGEN`, `CARGANDO`, `EN_RUTA`, `DESCARGANDO`, `FINALIZADO`
  o `CANCELADO`. Sin este parámetro se devuelven todos los estados.

**Respuesta exitosa — 200:**
```json
[
  {
    "id_viaje": 42,
    "zona": "CABA",
    "precio_estimado": 2500,
    "precio_real": null,
    "estado": "CONDUCTOR_ASIGNADO",
    "fecha_programada": "2026-07-01T10:00:00.000Z",
    "descripcion": "Carga frágil, llamar al llegar, portón azul",
    "creado_en": "2026-05-09T12:00:00.000Z",
    "paradas": [
      { "orden": 1, "direccion": "Plaza de Mayo, CABA", "estado": "PENDIENTE", "fecha_entrega": null }
    ],
    "cliente": {
      "usuario": {
        "nombre": "Juan",
        "apellido": "Pérez",
        "telefono": "+5491112345678"
      }
    }
  }
]
```

Un conductor sin viajes asignados recibe un array vacío `[]` (no es un error). Cada conductor
ve únicamente sus propios viajes.

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "Estado invalido" }` | El query param `estado` no es un `EstadoViaje` válido |
| 400 | `{ "error": "El usuario no tiene perfil de conductor" }` | Sin registro de conductor |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CONDUCTOR |

---

### GET /api/viajes/:id

Detalle de un viaje. Solo puede acceder el cliente que lo creó o el conductor asignado.

**Rol requerido:** Autenticado (`CLIENTE` o `CONDUCTOR`)

**Respuesta exitosa — 200:**
```json
{
  "id_viaje": 42,
  "zona": "CABA",
  "precio_estimado": 2500,
  "precio_real": null,
  "descripcion": "Carga frágil, llamar al llegar, portón azul",
  "estado": "CONDUCTOR_ASIGNADO",
  "fecha_programada": "2026-07-01T10:00:00.000Z",
  "fecha_inicio": null,
  "puntualidad_inicio": null,
  "creado_en": "2026-05-09T12:00:00.000Z",
  "paradas": [
    {
      "orden": 1,
      "direccion": "Plaza de Mayo, CABA",
      "latitud": -34.6037,
      "longitud": -58.3816,
      "estado": "PENDIENTE",
      "fecha_entrega": null
    }
  ],
  "condiciones_req": [
    { "condicion": "FRAGIL" }
  ],
  "cliente": {
    "id_cliente": 3,
    "usuario": {
      "nombre": "Juan",
      "apellido": "Pérez",
      "email": "juan@example.com"
    }
  },
  "conductor": {
    "id_conductor": 7,
    "calificacion_promedio": 4.8,
    "usuario": {
      "nombre": "Carlos",
      "apellido": "López",
      "telefono": "+5491187654321"
    }
  },
  "ruta_planeada": [[-58.38162, -34.60361], [-58.38201, -34.60280], "..."]
}
```

- `ruta_planeada`: array de puntos `[lng, lat]` (ver [Formato de ruta](#formato-de-ruta)). Es
  **`null`** si el viaje ya terminó (`FINALIZADO`/`CANCELADO`, con el cache de Redis ya limpio)
  o si la ruta nunca llegó a calcularse.
- `fecha_inicio`: momento real en que el conductor pulsó **Iniciar viaje** (ISO 8601). Es
  **`null`** mientras el viaje no se haya iniciado (`BUSCANDO_CONDUCTOR`/`CONDUCTOR_ASIGNADO`).
- `puntualidad_inicio`: `"A_TIEMPO"` | `"TARDE"` | `"MUY_TARDE"`, calculado al iniciar contra la
  `fecha_programada` (umbrales en `POST /api/viajes/:id/iniciar`). **`null`** si aún no se inició.

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Sin acceso a este viaje" }` | El usuario no es el cliente ni el conductor del viaje |
| 404 | `{ "error": "Viaje no encontrado" }` | No existe viaje con ese id |

---

## WebSockets — Matching en tiempo real

La conexión WebSocket se establece con autenticación JWT igual que los endpoints REST.

**Conexión:**
```js
import { io } from 'socket.io-client';

const socket = io('https://nombre-proyecto-back-production.up.railway.app', {
  auth: {
    token: 'Bearer ' + firebaseIdToken
  }
});
```

**Error de conexión si el token es inválido:**
```js
socket.on('connect_error', (err) => {
  console.log(err.message); // "Token invalido" o "Usuario no registrado"
});
```

**Errores de lógica emitidos durante el flujo (evento `error`):**
```js
socket.on('error', (data) => {
  console.log(data.mensaje); // descripción del error
});
```
La mayoría de los errores de negocio del servidor usan `{ "mensaje": "..." }` — **no**
`{ "error": "..." }`. **Excepción:** los errores del evento `conductor:ubicacion` (GPS) se
emiten con `{ "error": "..." }` (ver esa sección). Conviene leer ambos campos:
`data.mensaje ?? data.error`.

---

### Evento: viaje:disponible

**Dirección:** servidor → conductor  
**Quién lo recibe:** conductores elegibles conectados cuando se crea un viaje nuevo  
**Cuándo:** inmediatamente después de que un cliente hace `POST /api/viajes`

**Payload:**
```json
{
  "id_viaje": 42,
  "zona": "CABA",
  "precio_estimado": 2500,
  "fecha_programada": "2026-07-01T10:00:00.000Z",
  "descripcion": "Carga frágil, llamar al llegar, portón azul",
  "paradas": [
    { "orden": 1, "direccion": "Plaza de Mayo, CABA" },
    { "orden": 2, "direccion": "Recoleta, CABA" }
  ],
  "condiciones_req": []
}
```

**Cómo escucharlo:**
```js
socket.on('viaje:disponible', (data) => {
  // mostrar notificación al conductor con los datos del viaje
  console.log('Nuevo viaje disponible:', data.id_viaje);
});
```

---

### Evento: viaje:aceptar

**Dirección:** conductor → servidor  
**Quién lo emite:** el conductor que quiere tomar el viaje  
**Cuándo:** cuando el conductor toca "Aceptar" en la pantalla del viaje disponible

**Payload a emitir:**
```json
{
  "id_viaje": 42
}
```

- `id_vehiculo`: **opcional**. Si se incluye, el servidor valida que pertenece al conductor y cumple las condiciones del viaje. Si se omite, el servidor elige automáticamente el primer vehículo elegible del conductor.

**Cómo emitirlo:**
```js
// sin vehículo (el backend lo elige automáticamente)
socket.emit('viaje:aceptar', { id_viaje: 42 });

// con vehículo específico
socket.emit('viaje:aceptar', { id_viaje: 42, id_vehiculo: 7 });
```

**Validaciones del servidor:**

Si se envía `id_vehiculo`:
1. El vehículo debe existir; si no: evento `error` con `{ "mensaje": "Vehiculo no encontrado" }`
2. El vehículo debe pertenecer al conductor; si no: evento `error` con `{ "mensaje": "Ese vehiculo no te pertenece" }`
3. El vehículo debe cumplir las condiciones del viaje; si falta alguna: evento `error` con `{ "mensaje": "Tu vehiculo no cumple las condiciones del viaje" }`

Si NO se envía `id_vehiculo` (auto-selección):
4. El servidor busca, entre los vehículos propios y los asignados vía empresa
   del conductor, el primero que cumpla todas las condiciones requeridas del
   viaje (si el viaje no tiene condiciones, alcanza con tener al menos un
   vehículo). Si el conductor no tiene ningún vehículo, o ninguno cumple las
   condiciones, el servidor **no asigna el viaje** y emite únicamente el
   evento `error`:
   ```json
   { "mensaje": "No tenes un vehiculo que cumpla las condiciones del viaje" }
   ```
   Esta es la misma regla de elegibilidad usada para filtrar
   `GET /api/viajes/disponibles`: un viaje que no aparece ahí tampoco puede
   ser aceptado, y viceversa.

**Nota:** después de emitir este evento el conductor recibirá `viaje:conductor_asignado`
si ganó la carrera o `viaje:ya_asignado` si otro conductor fue más rápido.

---

### Evento: viaje:conductor_asignado

**Dirección:** servidor → room del viaje  
**Quién lo recibe:** el cliente que creó el viaje y el conductor que aceptó  
**Cuándo:** cuando un conductor acepta exitosamente el viaje

**Payload:** (idéntico para ambos destinatarios — cliente y conductor)
```json
{
  "id_viaje": 42,
  "conductor": {
    "nombre": "Carlos",
    "apellido": "López",
    "calificacion_promedio": 4.8
  },
  "vehiculo": {
    "patente": "ABC123",
    "marca": "Ford",
    "modelo": "Transit",
    "tipo_vehiculo": "camioneta"
  },
  "ruta_planeada": [[-58.38162, -34.60361], [-58.38201, -34.60280], "..."]
}
```

- `ruta_planeada`: array de puntos `[lng, lat]` (ver [Formato de ruta](#formato-de-ruta)) para
  dibujar la ruta en el mapa apenas se asigna el conductor. Puede ser `null` si la ruta falló al
  crearse y todavía no se recalculó.

**Cómo escucharlo:**
```js
socket.on('viaje:conductor_asignado', (data) => {
  // para el cliente: mostrar datos del conductor asignado
  // para el conductor: navegar a la pantalla del viaje activo
  console.log('Conductor asignado:', data.conductor.nombre);
  if (data.ruta_planeada) mapa.setRuta(data.ruta_planeada);
});
```

---

### Evento: viaje:ya_asignado

**Dirección:** servidor → conductor  
**Quién lo recibe:** el conductor que intentó aceptar pero llegó tarde  
**Cuándo:** cuando dos conductores aceptan al mismo tiempo y el otro ganó

La asignación es **atómica**: aunque dos (o más) conductores emitan `viaje:aceptar` para el
mismo viaje de forma prácticamente simultánea, el servidor garantiza un único ganador. El
ganador recibe `viaje:conductor_asignado` y **todos los demás** reciben `viaje:ya_asignado`
(nunca dos `viaje:conductor_asignado` para el mismo viaje).

**Payload:**
```json
{
  "id_viaje": 42,
  "mensaje": "Otro conductor fue mas rapido"
}
```

**Cómo escucharlo:**
```js
socket.on('viaje:ya_asignado', (data) => {
  // mostrar mensaje: "Otro conductor llegó primero"
  console.log(data.mensaje);
});
```

---

### Evento: viaje:cancelado_sin_conductor

**Dirección:** servidor → cliente  
**Quién lo recibe:** el cliente que creó el viaje  
**Cuándo:** cuando nadie acepta el viaje dentro del tiempo límite (10 minutos por defecto)

**Payload:**
```json
{
  "id_viaje": 42,
  "mensaje": "No se encontro un conductor disponible"
}
```

**Cómo escucharlo:**
```js
socket.on('viaje:cancelado_sin_conductor', (data) => {
  // mostrar mensaje y ofrecer volver a publicar el viaje
  console.log(data.mensaje);
});
```

---

### Evento: viaje:iniciado

**Dirección:** servidor → cliente  
**Quién lo recibe:** el cliente dueño del viaje, en su **room personal** `usuario:{id_usuario_cliente}`  
**Cuándo:** el conductor asignado pulsa **Iniciar viaje** (cuando `POST /api/viajes/:id/iniciar` responde `200`)

**Payload:**
```json
{
  "id_viaje": 42,
  "fecha_inicio": "2026-07-14T21:51:39.023Z",
  "puntualidad_inicio": "A_TIEMPO"
}
```

- `fecha_inicio`: momento real del inicio (ISO 8601).
- `puntualidad_inicio`: `"A_TIEMPO"` | `"TARDE"` | `"MUY_TARDE"` — umbrales documentados en
  `POST /api/viajes/:id/iniciar`.

**Cómo escucharlo:**
```js
socket.on('viaje:iniciado', (data) => {
  console.log(`El viaje ${data.id_viaje} arrancó (${data.puntualidad_inicio})`);
});
```

> Se emite al room **personal** del cliente (no al room del viaje): le llega aunque no esté
> siguiendo el mapa en ese momento.

---

### PATCH /api/viajes/:id/estado

Cambia el estado del viaje manualmente. Solo puede ejecutarlo el conductor asignado al viaje.
Estados válidos para este endpoint: `CARGANDO`, `EN_RUTA`, `DESCARGANDO`.

**Rol requerido:** `CONDUCTOR`

**Body:**
```json
{
  "estado": "CARGANDO"
}
```

- `estado`: `"CARGANDO"` | `"EN_RUTA"` | `"DESCARGANDO"`

**Respuesta exitosa — 200:**
```json
{
  "id_viaje": 42,
  "estado_anterior": "EN_RUTA",
  "estado_nuevo": "CARGANDO"
}
```

**Comportamiento adicional:** emite el evento `viaje:estado_cambiado` al room del viaje via WebSocket.

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "mensaje de validación" }` | Estado no válido |
| 400 | `{ "error": "El viaje ya esta finalizado o cancelado" }` | Viaje en estado terminal |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CONDUCTOR |
| 403 | `{ "error": "No sos el conductor de este viaje" }` | El conductor no está asignado a este viaje |
| 404 | `{ "error": "Viaje no encontrado" }` | No existe viaje con ese id |

---

### POST /api/viajes/:id/iniciar

El conductor asignado inicia el viaje (**botón "Iniciar viaje"**). Es la **única** forma de pasar
de `CONDUCTOR_ASIGNADO` a `EN_CAMINO_A_ORIGEN`: el inicio automático por primer ping GPS **ya no
existe**. Registra el momento real del inicio (`fecha_inicio`) y califica la puntualidad
(`puntualidad_inicio`) contra la `fecha_programada`.

> **Flujo correcto del mobile:** botón → `200` → **recién ahí** arrancar el GPS. Los pings
> enviados antes de iniciar se rechazan (ver el evento `conductor:ubicacion`).

**Rol requerido:** `CONDUCTOR` (debe ser el conductor asignado al viaje)

**Body:** Ninguno (vacío)

**Validaciones en orden:**
1. El viaje existe. Si no → `404`.
2. El usuario autenticado es el conductor asignado al viaje. Si no → `403`.
3. El viaje está en estado `CONDUCTOR_ASIGNADO`. Cualquier otro estado → `400`.
4. Ventana de tiempo (ver abajo). Demasiado temprano → `400`.

**Ventana de tiempo:**
El viaje puede iniciarse a partir de `fecha_programada - VENTANA_INICIO_MINUTOS` (variable de
entorno, default `30`). **No hay límite superior**: el conductor puede iniciar aunque la hora
programada ya haya pasado, sin importar cuánto. Si intenta iniciar antes de que abra la ventana
→ `400`, con la hora de apertura en hora local de Argentina (`America/Argentina/Buenos_Aires`),
formato `HH:MM`.

**Puntualidad (`puntualidad_inicio`):**
Se calcula con el retraso en minutos entre el momento del inicio y la `fecha_programada`.

| Valor | Condición (retraso respecto de `fecha_programada`) |
|-------|----------------------------------------------------|
| `A_TIEMPO` | retraso ≤ `PUNTUALIDAD_TARDE_MINUTOS` (default `30`). Incluye iniciar **antes** de hora (retraso negativo). |
| `TARDE` | `PUNTUALIDAD_TARDE_MINUTOS` < retraso ≤ `PUNTUALIDAD_MUY_TARDE_MINUTOS` (default `120`) |
| `MUY_TARDE` | retraso > `PUNTUALIDAD_MUY_TARDE_MINUTOS` (default `120`) |

**Respuesta exitosa — 200:**
```json
{
  "mensaje": "Viaje iniciado",
  "id_viaje": 42,
  "estado": "EN_CAMINO_A_ORIGEN",
  "fecha_inicio": "2026-07-14T21:51:39.023Z",
  "puntualidad_inicio": "A_TIEMPO"
}
```

**Efectos secundarios:**
- El viaje pasa a `EN_CAMINO_A_ORIGEN` y se persisten `fecha_inicio` y `puntualidad_inicio`.
- Se emite `viaje:iniciado` al room personal del cliente (`usuario:{id_usuario_cliente}`).
- A partir de este momento se aceptan los pings `conductor:ubicacion` de este viaje.

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "Solo se puede iniciar un viaje en estado CONDUCTOR_ASIGNADO, el viaje actual esta en estado <ESTADO>" }` | El viaje no está en `CONDUCTOR_ASIGNADO`. Incluye el **doble inicio** (ya está en `EN_CAMINO_A_ORIGEN`) |
| 400 | `{ "error": "El viaje solo puede iniciarse a partir de las <HH:MM>" }` | Todavía no abrió la ventana de inicio |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CONDUCTOR |
| 403 | `{ "error": "No autorizado para iniciar este viaje" }` | El viaje está asignado a otro conductor |
| 404 | `{ "error": "Viaje no encontrado" }` | No existe viaje con ese id |

---

### POST /api/viajes/:id/cancelar-conductor

El conductor asignado cancela el viaje y lo devuelve al pool de búsqueda. El viaje
**mantiene su `id_viaje`**, vuelve a estado `BUSCANDO_CONDUCTOR` con `id_conductor` e
`id_vehiculo` en `null`, y se vuelve a publicar a los conductores elegibles reutilizando
el mismo flujo que la creación (`POST /api/viajes`). Solo se permite mientras el viaje está
en estado `CONDUCTOR_ASIGNADO` (es decir, hasta el instante en que el conductor pulsa
**Iniciar viaje** con `POST /api/viajes/:id/iniciar`, que ya lo lleva a `EN_CAMINO_A_ORIGEN`).

**Rol requerido:** `CONDUCTOR` (debe ser el conductor asignado al viaje)

**Body:** Ninguno (vacío)

**Validaciones en orden:**
1. El viaje existe.
2. El usuario autenticado es el conductor asignado al viaje. Si hay otro conductor asignado
   distinto al autenticado → `403`. (Si el viaje no tiene conductor asignado no es un problema
   de autorización sino de estado, y cae en la validación 3.)
3. El viaje está en estado `CONDUCTOR_ASIGNADO`. Cualquier otro estado → `400`.

**Respuesta exitosa — 200:**
```json
{
  "mensaje": "Viaje cancelado y republicado",
  "id_viaje": 42,
  "estado": "BUSCANDO_CONDUCTOR"
}
```

**Efectos secundarios al cancelar:**
- El viaje vuelve a `BUSCANDO_CONDUCTOR` con `id_conductor` e `id_vehiculo` en `null` (mismo `id_viaje`).
- Se detiene el emisor de ETA del viaje (dejan de llegar `eta:actualizar`).
- Se eliminan **todas** las keys `gps:{id_viaje}:*` de Redis (mismo cleanup que al finalizar).
- Se vuelve a emitir el evento `viaje:disponible` a los conductores elegibles conectados,
  reutilizando el flujo de la creación del viaje. El recálculo de `ruta_planeada` con Google
  Maps ocurre cuando el siguiente conductor acepte, inicie el viaje y se haga el primer ping,
  igual que en un viaje nuevo.

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "Solo se puede cancelar un viaje en estado CONDUCTOR_ASIGNADO, el viaje actual esta en estado <ESTADO>" }` | El viaje no está en `CONDUCTOR_ASIGNADO` (incluye un viaje en `BUSCANDO_CONDUCTOR` sin conductor) |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CONDUCTOR |
| 403 | `{ "error": "No autorizado para cancelar este viaje" }` | El viaje está asignado a otro conductor |
| 404 | `{ "error": "Viaje no encontrado" }` | No existe viaje con ese id |

> **Notas:**
> - El conductor que canceló **sigue siendo elegible** para este mismo viaje: puede volver a
>   recibir `viaje:disponible` y reaceptarlo. No hay penalización ni límite por ahora (esa
>   lógica queda pendiente para futuro).
> - **No se envía una notificación específica al cliente** sobre la cancelación (decisión
>   explícita por ahora, pendiente para futuro). El cliente solo verá que el viaje volvió a
>   `BUSCANDO_CONDUCTOR` y, eventualmente, recibirá un nuevo `viaje:conductor_asignado` cuando
>   otro conductor acepte.

---

### POST /api/viajes/:id/cancelar-cliente

El cliente dueño del viaje lo cancela. Solo se permite **antes de que el viaje comience**, es
decir mientras está en `BUSCANDO_CONDUCTOR` (todavía nadie lo aceptó) o `CONDUCTOR_ASIGNADO`
(un conductor lo aceptó pero todavía no pulsó **Iniciar viaje**, que lo llevaría a
`EN_CAMINO_A_ORIGEN`). El viaje pasa a `CANCELADO`, que es un estado **terminal**.

**Rol requerido:** `CLIENTE` (debe ser el dueño del viaje)

**Body:** Ninguno (vacío)

**Validaciones en orden:**
1. El viaje existe.
2. El cliente autenticado es el dueño del viaje (`viaje.id_cliente` coincide con el del usuario
   autenticado). Si no → `403`.
3. El viaje está en `BUSCANDO_CONDUCTOR` o `CONDUCTOR_ASIGNADO`. Cualquier otro estado
   (`EN_CAMINO_A_ORIGEN`, `CARGANDO`, `EN_RUTA`, `DESCARGANDO`, `FINALIZADO`, `CANCELADO`) → `400`.

**Respuesta exitosa — 200:**
```json
{
  "mensaje": "Viaje cancelado",
  "id_viaje": 42,
  "estado": "CANCELADO"
}
```

**Efectos secundarios al cancelar:**
- El viaje pasa a `CANCELADO` (terminal — no hay transiciones desde `CANCELADO`).
- **`id_conductor` e `id_vehiculo` se preservan** tal como estaban al momento de cancelar (no se
  ponen en `null`): si el viaje estaba en `CONDUCTOR_ASIGNADO`, el viaje `CANCELADO` retiene con
  qué conductor/vehículo estaba asociado, para historial.
- Si el viaje estaba en `CONDUCTOR_ASIGNADO`, se detiene el emisor de ETA y se eliminan **todas**
  las keys `gps:{id_viaje}:*` de Redis. Si estaba en `BUSCANDO_CONDUCTOR` no hay ETA ni GPS que
  limpiar (el cleanup es idempotente y se llama igual, sin efecto).

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "Solo se puede cancelar un viaje antes de que comience, el viaje actual esta en estado <ESTADO>" }` | El viaje no está en `BUSCANDO_CONDUCTOR` ni `CONDUCTOR_ASIGNADO` (incluye un viaje ya `CANCELADO`) |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CLIENTE |
| 403 | `{ "error": "No autorizado para cancelar este viaje" }` | El usuario no es el dueño del viaje |
| 404 | `{ "error": "Viaje no encontrado" }` | No existe viaje con ese id |

> **Nota:** por ahora **no se envía ninguna notificación WebSocket a otros usuarios** por esta
> cancelación (en particular, no se notifica al conductor asignado si lo había). Es una decisión
> explícita, pendiente para el futuro.

---

### GET /api/viajes/:id/costo-acumulado

Devuelve el costo acumulado del viaje en curso calculado a partir de los datos GPS en Redis.
Solo puede acceder el cliente que creó el viaje o el conductor asignado.

**Rol requerido:** Autenticado (`CLIENTE` o `CONDUCTOR`)

**Respuesta exitosa — 200 (con GPS activo):**
```json
{
  "precio_acumulado": 1837.5,
  "desglose": {
    "precio_por_tiempo": 1750,
    "precio_por_distancia": 87.5,
    "tiempo_horas": 0.5,
    "distancia_km": 8.75,
    "tarifa_hora": 3500,
    "tarifa_km": 10,
    "es_hora_pico": false
  }
}
```

**Respuesta exitosa — 200 (sin GPS todavía):**
```json
{
  "precio_acumulado": 0,
  "desglose": null
}
```

- `precio_por_tiempo`: `null` si la zona es `PROVINCIA`
- `precio_por_distancia`: `null` si la zona es `CABA`

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Sin acceso a este viaje" }` | El usuario no es el cliente ni el conductor del viaje |
| 404 | `{ "error": "Viaje no encontrado" }` | No existe viaje con ese id |

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

### Evento: mapa:actualizar

**Dirección:** servidor → room del viaje  
**Quién lo recibe:** cliente y conductor conectados al room `viaje:{id_viaje}`  
**Cuándo:** cada vez que el conductor emite `conductor:ubicacion`

**Payload:**
```json
{
  "lat": -34.6037,
  "lng": -58.3816,
  "timestamp": 1746700000000,
  "velocidad_kmh": 47
}
```

**Cómo escucharlo:**
```js
socket.on('mapa:actualizar', (data) => {
  // actualizar marcador del conductor en el mapa
  console.log(`Conductor en ${data.lat}, ${data.lng} — ${data.velocidad_kmh} km/h`);
});
```

---

### Evento: costo:actualizar

**Dirección:** servidor → room del viaje  
**Quién lo recibe:** cliente y conductor conectados al room  
**Cuándo:** aproximadamente una vez por minuto (cuando `timestamp % 60000 < 16000`)

**Payload:**
```json
{
  "precio_acumulado": 1750,
  "desglose": {
    "precio_por_tiempo": 1750,
    "precio_por_distancia": null,
    "tiempo_horas": 0.5,
    "distancia_km": 8.2,
    "tarifa_hora": 3500,
    "tarifa_km": null,
    "es_hora_pico": false
  }
}
```

**Cómo escucharlo:**
```js
socket.on('costo:actualizar', (data) => {
  // actualizar el medidor de costo en la pantalla del cliente
  console.log('Costo acumulado:', data.precio_acumulado);
});
```

---

### Evento: alerta:desvio

**Dirección:** servidor → room del viaje  
**Quién lo recibe:** cliente y conductor  
**Cuándo:** cuando el conductor se aleja más de `DESVIO_UMBRAL_METROS` (default 300 m) de la ruta trazada  
**Solo aplica:** viajes en estado `EN_RUTA`

**Payload:**
```json
{
  "id_viaje": 42,
  "distancia_metros": 450,
  "mensaje": "El conductor se desvio 450m de la ruta"
}
```

**Cómo escucharlo:**
```js
socket.on('alerta:desvio', (data) => {
  // mostrar alerta al cliente
  console.log(data.mensaje);
});
```

---

### Evento: alerta:parada

**Dirección:** servidor → room del viaje  
**Quién lo recibe:** cliente y conductor  
**Cuándo:** cuando el conductor lleva más de `PARADA_SOSPECHOSA_MINUTOS` (default 5 min) detenido
fuera de las paradas del viaje  
**Solo aplica:** viajes en estado `EN_RUTA`, zonas `CABA` y `MIXTO`

**Payload:**
```json
{
  "id_viaje": 42,
  "minutos_detenido": 7,
  "mensaje": "El conductor lleva 7 minutos detenido"
}
```

**Cómo escucharlo:**
```js
socket.on('alerta:parada', (data) => {
  // mostrar alerta al cliente
  console.log(data.mensaje);
});
```

---

### Evento: eta:actualizar

**Dirección:** servidor → room del viaje  
**Quién lo recibe:** cliente y conductor  
**Cuándo:** cada `ETA_EMISION_SEGUNDOS` (default 30 s) mientras el viaje tiene GPS activo
(estados `EN_CAMINO_A_ORIGEN` … `EN_RUTA`). El emisor arranca con el primer ping GPS —que solo
se acepta con el viaje ya iniciado— y se detiene al finalizar o cancelar el viaje.

Además, el emisor tiene un **watchdog de inactividad**: si el viaje deja de recibir pings GPS
durante más de `ETA_EMISOR_IDLE_SEGUNDOS` (default 300 s), el emisor se auto-detiene y dejan de
llegar `eta:actualizar`. Cubre viajes que nunca finalizan formalmente (el conductor abandona,
cierra la app, etc.) para no dejar un timer huérfano emitiendo al room para siempre. El emisor
vuelve a arrancar solo en cuanto llega un nuevo ping GPS válido.

El ETA hacia la próxima parada **pendiente** se calcula con Google Maps Directions API
(con tráfico). Para no consumir la API en cada emisión, el servidor recalcula con la API
sólo cada `ETA_RECALCULO_SEGUNDOS` (default 360 s), cuando cambia la próxima parada (al
confirmar una parada) o cuando se recalcula la ruta por desvío. **Entre recalculos, el valor
emitido es un countdown local del servidor** (último ETA de la API menos el tiempo
transcurrido). El countdown nunca baja de 0; si llega a 0 se fuerza un recálculo con la API.

**Payload:**
```json
{
  "id_viaje": 42,
  "proxima_parada_id": 18,
  "segundos_restantes": 1827,
  "minutos_restantes": 31
}
```

- `segundos_restantes`: entero, nunca negativo.
- `minutos_restantes`: `Math.ceil(segundos_restantes / 60)`, listo para mostrar.
- `proxima_parada_id`: id de la parada pendiente de menor orden hacia la que se mide el ETA.

**Cómo escucharlo:**
```js
socket.on('eta:actualizar', (data) => {
  // actualizar el contador de "llega en X min" en la UI
  console.log(`Llega en ~${data.minutos_restantes} min`);
});
```

---

### Evento: ruta:recalculada

**Dirección:** servidor → room del viaje  
**Quién lo recibe:** cliente y conductor  
**Cuándo:** cuando el conductor se desvía de la ruta en **2 pings GPS consecutivos** (cada uno
a más de `DESVIO_UMBRAL_METROS`, default 300 m) y además pasó el cooldown de
`RUTA_RECALCULO_COOLDOWN_SEGUNDOS` (default 120 s) desde el último recálculo.  
**Solo aplica:** viajes en estado `EN_RUTA`

Un único ping desviado sólo emite `alerta:desvio` (puede ser ruido GPS). Al segundo ping
consecutivo desviado, si pasó el cooldown, el servidor recalcula la ruta con Google Maps
Directions API desde la posición actual del conductor hasta la última parada pendiente
(las paradas pendientes intermedias se pasan como waypoints en orden), reemplaza la ruta
guardada y fuerza un recálculo de ETA inmediato (llega un `eta:actualizar` nuevo justo
después). Si el desvío persiste pero no pasó el cooldown, sólo se emite `alerta:desvio`.

`nueva_ruta` **reemplaza a la `ruta_planeada`** original del viaje (la que llegó al crear el
viaje, al asignar conductor y en `GET /api/viajes/:id`): es el mismo formato y representa lo
mismo — la ruta vigente que el front dibuja en el mapa —, sólo que recalculada desde la
posición actual del conductor. El front debe descartar la ruta anterior y quedarse con esta.

**Payload:**
```json
{
  "id_viaje": 42,
  "nueva_ruta": [[-58.4066, -34.6287], [-58.4050, -34.6270], "..."],
  "proxima_parada_id": 18,
  "motivo": "desvio"
}
```

- `nueva_ruta`: array de puntos `[lng, lat]` de la ruta recalculada (ver
  [Formato de ruta](#formato-de-ruta)). El front debe **redibujar la ruta del mapa** con este
  array, reemplazando la `ruta_planeada` anterior.
- `proxima_parada_id`: id de la parada pendiente de menor orden (destino inmediato).
- `motivo`: `"desvio"`.

**Cómo escucharlo:**
```js
socket.on('ruta:recalculada', (data) => {
  // redibujar la polilínea de la ruta en el mapa
  mapa.setRuta(data.nueva_ruta);
});
```

---

### Evento: viaje:estado_cambiado

**Dirección:** servidor → room del viaje  
**Quién lo recibe:** cliente y conductor  
**Cuándo:** cambio manual de estado via `PATCH /:id/estado`

> El paso `CONDUCTOR_ASIGNADO → EN_CAMINO_A_ORIGEN` **no** emite este evento: lo dispara el
> botón **Iniciar viaje** (`POST /api/viajes/:id/iniciar`), que emite `viaje:iniciado` al room
> personal del cliente.

**Payload:**
```json
{
  "id_viaje": 42,
  "estado_anterior": "EN_CAMINO_A_ORIGEN",
  "estado_nuevo": "CARGANDO"
}
```

Estados posibles del viaje (flujo completo):

| Estado | Descripción |
|--------|-------------|
| `BUSCANDO_CONDUCTOR` | Viaje creado, esperando que un conductor acepte |
| `CONDUCTOR_ASIGNADO` | Conductor aceptó, aún no se movió |
| `EN_CAMINO_A_ORIGEN` | El conductor pulsó **Iniciar viaje** (`POST /api/viajes/:id/iniciar`) |
| `EN_RUTA` | En curso — activar algoritmos de desvío y parada |
| `CARGANDO` | Detenido cargando mercadería (manual via endpoint) |
| `DESCARGANDO` | Detenido descargando mercadería (manual via endpoint) |
| `FINALIZADO` | Viaje completado |
| `CANCELADO` | Viaje cancelado |

**Cómo escucharlo:**
```js
socket.on('viaje:estado_cambiado', (data) => {
  console.log(`Viaje ${data.id_viaje}: ${data.estado_anterior} → ${data.estado_nuevo}`);
});
```

---

---

## /conductores — Vehículos de conductores independientes

### POST /api/conductores/mis-vehiculos

Registra un vehículo propio del conductor autenticado.

**Rol requerido:** `CONDUCTOR`

**Headers requeridos:**
```
Authorization: Bearer <firebase-id-token>
```

**Body:**
```json
{
  "patente": "string 6-8 caracteres (requerido)",
  "marca": "string (requerido)",
  "modelo": "string (requerido)",
  "anio": "number entero entre 1990 y año actual (requerido)",
  "color": "string (requerido)",
  "tipo_vehiculo": "string (requerido)",
  "condiciones": ["FRAGIL", "REFRIGERADO"]
}
```

- `condiciones`: opcional, default `[]`. Valores válidos: `FRAGIL`, `REFRIGERADO`, `CARGA_PESADA`, `PELIGROSO`, `VOLUMINOSO`

**Respuesta exitosa — 201:**
```json
{
  "id_vehiculo": 10,
  "id_empresa": null,
  "id_conductor": 3,
  "patente": "ABC123",
  "marca": "Ford",
  "modelo": "Transit",
  "anio": 2022,
  "color": "Blanco",
  "tipo_vehiculo": "furgon",
  "condiciones": [
    { "id_condicion": 5, "id_vehiculo": 10, "condicion": "FRAGIL" },
    { "id_condicion": 6, "id_vehiculo": 10, "condicion": "REFRIGERADO" }
  ]
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "mensaje de validación" }` | Campo faltante o inválido |
| 400 | `{ "error": "El usuario no tiene perfil de conductor" }` | Sin registro de conductor |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CONDUCTOR |
| 409 | `{ "error": "La patente ya esta registrada" }` | Patente duplicada |

---

### GET /api/conductores/mis-vehiculos

Devuelve todos los vehículos propios del conductor autenticado.

**Rol requerido:** `CONDUCTOR`

**Headers requeridos:**
```
Authorization: Bearer <firebase-id-token>
```

**Respuesta exitosa — 200:**
```json
[
  {
    "id_vehiculo": 10,
    "id_empresa": null,
    "id_conductor": 3,
    "patente": "ABC123",
    "marca": "Ford",
    "modelo": "Transit",
    "anio": 2022,
    "color": "Blanco",
    "tipo_vehiculo": "furgon",
    "condiciones": [
      { "id_condicion": 5, "id_vehiculo": 10, "condicion": "FRAGIL" }
    ]
  }
]
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "El usuario no tiene perfil de conductor" }` | Sin registro de conductor |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CONDUCTOR |

---

### PUT /api/conductores/mis-vehiculos/:id

Actualiza los datos de un vehículo propio del conductor. Solo se actualizan los campos presentes.

**Rol requerido:** `CONDUCTOR`

**Headers requeridos:**
```
Authorization: Bearer <firebase-id-token>
```

**Body (todos opcionales):**
```json
{
  "marca": "string",
  "modelo": "string",
  "anio": 2023,
  "color": "Negro",
  "tipo_vehiculo": "camion"
}
```

**Respuesta exitosa — 200:**
```json
{
  "id_vehiculo": 10,
  "id_empresa": null,
  "id_conductor": 3,
  "patente": "ABC123",
  "marca": "Ford",
  "modelo": "Transit",
  "anio": 2023,
  "color": "Negro",
  "tipo_vehiculo": "camion",
  "condiciones": []
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "mensaje de validación" }` | Valor de campo inválido |
| 400 | `{ "error": "El usuario no tiene perfil de conductor" }` | Sin registro de conductor |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CONDUCTOR |
| 403 | `{ "error": "Este vehiculo no te pertenece" }` | El vehículo pertenece a otro conductor |
| 404 | `{ "error": "Vehiculo no encontrado" }` | No existe vehículo con ese id |

---

### DELETE /api/conductores/mis-vehiculos/:id

Elimina un vehículo propio del conductor. No se puede eliminar si está en un viaje activo.

**Rol requerido:** `CONDUCTOR`

**Headers requeridos:**
```
Authorization: Bearer <firebase-id-token>
```

**Respuesta exitosa — 200:**
```json
{
  "mensaje": "Vehiculo eliminado"
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "El usuario no tiene perfil de conductor" }` | Sin registro de conductor |
| 400 | `{ "error": "No se puede eliminar un vehiculo en uso" }` | El vehículo está en un viaje activo |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CONDUCTOR |
| 403 | `{ "error": "Este vehiculo no te pertenece" }` | El vehículo pertenece a otro conductor |
| 404 | `{ "error": "Vehiculo no encontrado" }` | No existe vehículo con ese id |

---

### POST /api/conductores/mis-vehiculos/:id/condiciones/:condicion

Agrega una condición a un vehículo propio del conductor.

**Rol requerido:** `CONDUCTOR`

**Headers requeridos:**
```
Authorization: Bearer <firebase-id-token>
```

- `:condicion`: uno de `FRAGIL`, `REFRIGERADO`, `CARGA_PESADA`, `PELIGROSO`, `VOLUMINOSO`

**Respuesta exitosa — 201:**
```json
{
  "id_vehiculo": 10,
  "id_empresa": null,
  "id_conductor": 3,
  "patente": "ABC123",
  "marca": "Ford",
  "modelo": "Transit",
  "anio": 2022,
  "color": "Blanco",
  "tipo_vehiculo": "furgon",
  "condiciones": [
    { "id_condicion": 7, "id_vehiculo": 10, "condicion": "FRAGIL" }
  ]
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "Condicion invalida" }` | Valor de condición no reconocido |
| 400 | `{ "error": "El usuario no tiene perfil de conductor" }` | Sin registro de conductor |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CONDUCTOR |
| 403 | `{ "error": "Este vehiculo no te pertenece" }` | El vehículo pertenece a otro conductor |
| 404 | `{ "error": "Vehiculo no encontrado" }` | No existe vehículo con ese id |
| 409 | `{ "error": "El vehiculo ya tiene esa condicion" }` | Condición duplicada |

---

### DELETE /api/conductores/mis-vehiculos/:id/condiciones/:condicion

Elimina una condición de un vehículo propio del conductor.

**Rol requerido:** `CONDUCTOR`

**Headers requeridos:**
```
Authorization: Bearer <firebase-id-token>
```

- `:condicion`: uno de `FRAGIL`, `REFRIGERADO`, `CARGA_PESADA`, `PELIGROSO`, `VOLUMINOSO`

**Respuesta exitosa — 200:**
```json
{
  "id_vehiculo": 10,
  "id_empresa": null,
  "id_conductor": 3,
  "patente": "ABC123",
  "marca": "Ford",
  "modelo": "Transit",
  "anio": 2022,
  "color": "Blanco",
  "tipo_vehiculo": "furgon",
  "condiciones": []
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "Condicion invalida" }` | Valor de condición no reconocido |
| 400 | `{ "error": "El usuario no tiene perfil de conductor" }` | Sin registro de conductor |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CONDUCTOR |
| 403 | `{ "error": "Este vehiculo no te pertenece" }` | El vehículo pertenece a otro conductor |
| 404 | `{ "error": "Vehiculo no encontrado" }` | No existe vehículo con ese id |

---

---

## Fase 5 — Confirmación, cierre y remito


### GET /api/viajes/:id/qr-paradas


Devuelve los tokens QR firmados de cada parada del viaje. El cliente los muestra
como código QR en pantalla para que el conductor los escanee al llegar.


**Rol requerido:** `CLIENTE` (debe ser el dueño del viaje)


**Respuesta exitosa — 200:**
```json
[
  {
    "id_parada": 1,
    "orden": 1,
    "direccion": "Plaza de Mayo, CABA",
    "qr_firmado": "eyJpZF9wYXJhZGEiOjEsImlkX3ZpYWplIjo0Miwib3JkZW4iOjF9.a3f9c8..."
  },
  {
    "id_parada": 2,
    "orden": 2,
    "direccion": "Recoleta, CABA",
    "qr_firmado": "eyJpZF9wYXJhZGEiOjIsImlkX3ZpYWplIjo0Miwib3JkZW4iOjJ9.d72b1e..."
  }
]
```


El campo `qr_firmado` es un string `base64url_payload.hmac_hex`. Es lo que
se debe codificar como imagen QR y mostrar al cliente para que el conductor lo escanee.


**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CLIENTE |
| 403 | `{ "error": "Sin acceso a este viaje" }` | El cliente no es el dueño del viaje |
| 404 | `{ "error": "Viaje no encontrado" }` | No existe viaje con ese id |


---


### POST /api/viajes/:id/confirmar-parada


El conductor escanea el QR al llegar a una parada y confirma la entrega.
Si era la última parada pendiente, cierra el viaje automáticamente.


**Rol requerido:** `CONDUCTOR` (debe ser el conductor asignado al viaje)


**Body:**
```json
{
  "qr_firmado": "eyJpZF9wYXJhZGEiOjEsImlkX3ZpYWplIjo0Miwib3JkZW4iOjF9.a3f9c8...",
  "lat": -34.6037,
  "lng": -58.3816
}
```


- `qr_firmado`: el string escaneado del QR (generado por `GET /api/viajes/:id/qr-paradas`)
- `lat`, `lng`: coordenada GPS actual del conductor al momento del escaneo


**Validaciones en orden:**
1. Firma HMAC válida
2. `id_viaje` del QR coincide con el `:id` de la URL
3. El conductor es el asignado al viaje
4. El viaje está en estado `EN_RUTA` o `DESCARGANDO`
5. La parada no está ya en estado `ENTREGADO`
6. El conductor está a menos de 200 metros de la parada (Turf.js)


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


**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "QR invalido o firma incorrecta" }` | HMAC inválido o token malformado |
| 400 | `{ "error": "El QR no corresponde a este viaje" }` | El QR es de otro viaje |
| 400 | `{ "error": "El viaje debe estar en estado EN_RUTA o DESCARGANDO" }` | Estado incorrecto |
| 400 | `{ "error": "La parada ya fue confirmada" }` | La parada ya tiene estado ENTREGADO |
| 400 | `{ "error": "Estas a Xm de la parada. Debes estar a menos de 200m" }` | Demasiado lejos de la parada |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CONDUCTOR |
| 403 | `{ "error": "No sos el conductor de este viaje" }` | Conductor diferente al asignado |
| 404 | `{ "error": "Viaje no encontrado" }` | No existe viaje con ese id |
| 404 | `{ "error": "Parada no encontrada" }` | La parada del QR no existe en este viaje |


---


### WebSocket — Evento: viaje:finalizado


**Dirección:** servidor → room del viaje  
**Quién lo recibe:** cliente y conductor conectados al room `viaje:{id_viaje}`  
**Cuándo:** cuando se confirma la última parada via `POST /api/viajes/:id/confirmar-parada`


**Payload:**
```json
{
  "id_viaje": 42,
  "precio_real": 1750.00,
  "desglose": {
    "precio_por_tiempo": 1750.00,
    "precio_por_distancia": null,
    "tiempo_horas": 0.5,
    "distancia_km": 8.2,
    "tarifa_hora": 3500,
    "tarifa_km": null
  },
  "remito_url": "https://pub.r2.example.com/remitos/42.pdf"
}
```


**Cómo escucharlo:**
```js
socket.on('viaje:finalizado', (data) => {
  console.log('Viaje finalizado. Precio real:', data.precio_real);
  console.log('Remito:', data.remito_url);
});
```


---


### POST /api/viajes/:id/calificacion


El cliente califica al conductor después de que el viaje finalizó.
Solo se permite una calificación por viaje.


**Rol requerido:** `CLIENTE` (debe ser el dueño del viaje)


**Body:**
```json
{
  "puntuacion": 5,
  "comentario": "Excelente servicio, muy puntual"
}
```


- `puntuacion`: entero entre 1 y 5 (requerido)
- `comentario`: string (opcional)


**Respuesta exitosa — 201:**
```json
{
  "id_calificacion": 7,
  "puntuacion": 5,
  "comentario": "Excelente servicio, muy puntual"
}
```


**Efecto secundario:** recalcula y actualiza `conductor.calificacion_promedio`
como el promedio de todos sus puntajes en DB.


**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "mensaje de validación" }` | Puntuación fuera de rango o tipo inválido |
| 400 | `{ "error": "Solo se puede calificar un viaje finalizado" }` | El viaje no está en estado FINALIZADO |
| 400 | `{ "error": "El viaje no tiene conductor asignado" }` | Sin conductor asignado |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CLIENTE |
| 403 | `{ "error": "Sin acceso a este viaje" }` | El cliente no es el dueño del viaje |
| 404 | `{ "error": "Viaje no encontrado" }` | No existe viaje con ese id |
| 409 | `{ "error": "Este viaje ya tiene una calificacion" }` | Calificación duplicada |


---


### GET /api/viajes/:id/remito


Devuelve la URL pública del remito PDF del viaje. Solo disponible para viajes finalizados.


**Rol requerido:** `CLIENTE` o `CONDUCTOR` del viaje


**Respuesta exitosa — 200:**
```json
{
  "remito_url": "https://pub.r2.example.com/remitos/42.pdf"
}
```


El PDF incluye: datos del cliente y conductor, lista de paradas con fecha de entrega,
y desglose de costo (tiempo, distancia, tarifas, precio real).


**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "El remito solo esta disponible para viajes finalizados" }` | Estado incorrecto |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Sin acceso a este viaje" }` | No es el cliente ni el conductor del viaje |
| 404 | `{ "error": "Viaje no encontrado" }` | No existe viaje con ese id |


---


### GET /api/viajes/:id — cambios en Fase 5


El endpoint ahora incluye el campo `calificacion` en la respuesta (si existe):

```json
{
  "id_viaje": 42,
  "estado": "FINALIZADO",
  "precio_real": 1750.00,
  "paradas": [...],
  "calificacion": {
    "id_calificacion": 7,
    "puntaje": 5,
    "comentario": "Excelente servicio",
    "fecha_hora": "2026-06-06T15:00:00.000Z"
  }
}
```

`calificacion` es `null` si el viaje aún no fue calificado.


---

## /admin — Panel de administración

Endpoints de solo lectura + cancelación para el rol `ADMIN`. Sirven para monitorear
la operación: listar e inspeccionar usuarios y viajes, ver estadísticas agregadas y
cancelar viajes.

**El registro de un admin no es público:** no existe endpoint de alta. Un admin se
crea con el script `scripts/crear-admin.js`, que lo da de alta en Firebase **y** en la
DB en una sola operación (con rollback en Firebase si falla la DB), leyendo las
variables `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NOMBRE`, `ADMIN_APELLIDO`,
`ADMIN_DNI` del entorno. Es idempotente.

**Autenticación:** todos los endpoints requieren `Authorization: Bearer <token>` de un
usuario con rol `ADMIN`. Sin token → `401`; con token de un rol distinto de ADMIN →
`403`.

**Nota:** `POST /api/admin/viajes/:id/cancelar` es la **única** cancelación que puede
interrumpir un viaje en marcha (`EN_CAMINO_A_ORIGEN`, `CARGANDO`, `EN_RUTA`,
`DESCARGANDO`) — la cancelación por conductor y por cliente solo operan antes de que el
viaje arranque. Está pensada para debugging/operación en desarrollo.

---

### GET /api/admin/usuarios

Lista paginada de usuarios. Cada usuario trae sus campos públicos (sin `firebase_uid`)
más el registro asociado a su rol (`cliente` / `conductor` / `empresas_gerente`; los no
aplicables vienen `null` o `[]`).

**Rol requerido:** `ADMIN`

**Query params (opcionales):**
- `rol`: filtra por rol. Uno de `CLIENTE`, `CONDUCTOR`, `GERENTE`, `ADMIN`.
- `page`: número de página (default `1`).
- `limit`: tamaño de página (default `50`, se topa en `200`).

**Respuesta exitosa — 200:**
```json
{
  "total": 14,
  "page": 1,
  "limit": 50,
  "usuarios": [
    {
      "id_usuario": 3,
      "nombre": "Juan",
      "apellido": "Pérez",
      "dni": "12345678",
      "email": "juan@example.com",
      "telefono": "+5491112345678",
      "rol": "CLIENTE",
      "fecha_registro": "2026-05-09T12:00:00.000Z",
      "cliente": {
        "id_cliente": 3,
        "id_usuario": 3,
        "cuit": null,
        "nombre_empresa": null,
        "direccion_principal": null
      },
      "conductor": null,
      "empresas_gerente": []
    }
  ]
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "mensaje de validación" }` | `rol`, `page` o `limit` inválidos |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol ADMIN |

---

### GET /api/admin/usuarios/:id

Detalle de un usuario, con include **condicional según su rol**:
- `CLIENTE`: datos personales + `cliente` con su historial de viajes creados.
- `CONDUCTOR`: datos personales + `conductor` con `nro_licencia`,
  `licencia_vencimiento`, `calificacion_promedio`, `vehiculos` (propios + asignados vía
  empresa, en un array plano) y su historial de viajes aceptados.
- `GERENTE`: datos personales + `empresas` (empresa(s) asociada(s), sus conductores y
  vehículos). Puede venir vacío en el MVP.
- `ADMIN`: solo datos personales.

**Rol requerido:** `ADMIN`

**Respuesta exitosa — 200 (conductor):**
```json
{
  "id_usuario": 7,
  "nombre": "Carlos",
  "apellido": "López",
  "dni": "23456789",
  "email": "carlos@example.com",
  "telefono": "+5491187654321",
  "rol": "CONDUCTOR",
  "fecha_registro": "2026-05-01T00:00:00.000Z",
  "conductor": {
    "id_conductor": 4,
    "id_usuario": 7,
    "nro_licencia": "LIC001",
    "licencia_vencimiento": "2028-01-01T00:00:00.000Z",
    "calificacion_promedio": 4.8,
    "vehiculos": [
      {
        "id_vehiculo": 10,
        "patente": "FLT001",
        "marca": "Ford",
        "modelo": "Transit",
        "anio": 2020,
        "color": "Blanco",
        "tipo_vehiculo": "furgon",
        "condiciones": []
      }
    ],
    "vehiculos_propios": [ "..." ],
    "conductor_vehiculos": [ "..." ],
    "viajes": [
      { "id_viaje": 42, "estado": "FINALIZADO", "precio_real": 1750, "creado_en": "2026-05-09T12:00:00.000Z" }
    ]
  }
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol ADMIN |
| 404 | `{ "error": "Usuario no encontrado" }` | No existe usuario con ese id |

---

### GET /api/admin/viajes

Lista paginada de viajes con filtros. Cada viaje trae sus datos básicos + `cliente`,
+ `conductor` (si está asignado) + `_count.paradas`.

**Rol requerido:** `ADMIN`

**Query params (opcionales):**
- `estado`: cualquier `EstadoViaje` (`BUSCANDO_CONDUCTOR` … `CANCELADO`).
- `cantidad_paradas`: número exacto de paradas del viaje.
- `zona`: `CABA` | `PROVINCIA` | `MIXTO`.
- `desde`: fecha ISO (inclusive), filtra por `creado_en`.
- `hasta`: fecha ISO (inclusive), filtra por `creado_en`.
- `page` (default `1`), `limit` (default `50`, máx `200`).

**Respuesta exitosa — 200:**
```json
{
  "total": 74,
  "page": 1,
  "limit": 50,
  "viajes": [
    {
      "id_viaje": 42,
      "zona": "CABA",
      "estado": "BUSCANDO_CONDUCTOR",
      "precio_estimado": 2500,
      "precio_real": null,
      "fecha_programada": "2026-07-01T10:00:00.000Z",
      "creado_en": "2026-05-09T12:00:00.000Z",
      "cliente": {
        "usuario": { "nombre": "Juan", "apellido": "Pérez", "email": "juan@example.com" }
      },
      "conductor": null,
      "_count": { "paradas": 2 }
    }
  ]
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "mensaje de validación" }` | Algún filtro inválido (`estado`, `zona`, `cantidad_paradas`, `desde`, `hasta`, `page`, `limit`) |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol ADMIN |

---

### GET /api/admin/viajes/:id

Detalle completo de un viaje: paradas, cliente completo, conductor completo (si existe),
vehículo, precios (`precio_estimado` / `precio_real`), `fee` calculado sobre el precio
real (`precio_real * FEE_PORCENTAJE / 100`, `null` si aún no hay precio), `remito_url`
(solo si el viaje está `FINALIZADO`, si no `null`), `calificacion` (si existe),
`motivo_cancelacion` y `cancelado_por_admin` (si fue cancelado por un admin).

**Rol requerido:** `ADMIN`

**Respuesta exitosa — 200:**
```json
{
  "id_viaje": 42,
  "zona": "CABA",
  "estado": "FINALIZADO",
  "precio_estimado": 2500,
  "precio_real": 1750,
  "fee": 175,
  "remito_url": "https://pub.r2.example.com/remitos/42.pdf",
  "motivo_cancelacion": null,
  "cancelado_por_admin_id": null,
  "cancelado_por_admin": null,
  "fecha_programada": "2026-07-01T10:00:00.000Z",
  "creado_en": "2026-05-09T12:00:00.000Z",
  "paradas": [
    { "orden": 1, "direccion": "Plaza de Mayo, CABA", "estado": "ENTREGADO", "fecha_entrega": "2026-05-09T13:00:00.000Z" }
  ],
  "condiciones_req": [],
  "cliente": { "id_cliente": 3, "usuario": { "nombre": "Juan", "apellido": "Pérez", "email": "juan@example.com" } },
  "conductor": { "id_conductor": 4, "calificacion_promedio": 4.8, "usuario": { "nombre": "Carlos", "apellido": "López" } },
  "vehiculo": { "id_vehiculo": 10, "patente": "FLT001", "marca": "Ford", "modelo": "Transit" },
  "calificacion": { "puntaje": 5, "comentario": "Excelente", "fecha_hora": "2026-05-09T13:05:00.000Z" }
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol ADMIN |
| 404 | `{ "error": "Viaje no encontrado" }` | No existe viaje con ese id |

---

### GET /api/admin/estadisticas

Devuelve, en un solo request, todas las métricas agregadas (calculadas con queries
agregadas en la DB, no en memoria). Los montos de `plata` cuentan **solo viajes
`FINALIZADO`** — los `CANCELADO` no suman plata para nadie. El fee usa la variable de
entorno `FEE_PORCENTAJE` (entero, default `10`).

**Rol requerido:** `ADMIN`

**Respuesta exitosa — 200:**
```json
{
  "usuarios": {
    "total": 14,
    "por_rol": { "CLIENTE": 6, "CONDUCTOR": 6, "GERENTE": 1, "ADMIN": 1 },
    "registrados_ultimo_mes": 14,
    "registrados_por_dia_ultimos_30_dias": [
      { "fecha": "2026-06-28", "cantidad": 9 },
      { "fecha": "2026-06-29", "cantidad": 5 }
    ]
  },
  "viajes": {
    "total": 74,
    "por_estado": {
      "BUSCANDO_CONDUCTOR": 32, "CONDUCTOR_ASIGNADO": 0, "EN_CAMINO_A_ORIGEN": 1,
      "CARGANDO": 0, "EN_RUTA": 0, "DESCARGANDO": 0, "FINALIZADO": 5, "CANCELADO": 36
    },
    "por_dia_ultimos_30_dias": [
      { "fecha": "2026-06-29", "cantidad_creados": 74, "cantidad_finalizados": 5 }
    ]
  },
  "plata": {
    "total_precio_real_finalizados": 63.33,
    "total_fee_app": 6.333,
    "total_neto_conductores": 56.997,
    "top_conductores_por_ganancia": [
      { "id_conductor": 4, "nombre": "Carlos", "apellido": "López", "total_ganado": 63.33, "cantidad_viajes": 5 }
    ],
    "top_clientes_por_gasto": [
      { "id_cliente": 3, "nombre": "Juan", "apellido": "Pérez", "total_gastado": 63.33, "cantidad_viajes": 5 }
    ]
  }
}
```

- `total_fee_app` = `total_precio_real_finalizados * FEE_PORCENTAJE / 100`.
- `total_neto_conductores` = `total_precio_real_finalizados - total_fee_app`.
  (Se cumple `total_fee_app + total_neto_conductores == total_precio_real_finalizados`.)
- `top_conductores_por_ganancia` / `top_clientes_por_gasto`: top 10 por suma de
  `precio_real` sobre viajes finalizados, orden descendente.

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol ADMIN |

---

### POST /api/admin/viajes/:id/cancelar

Cancela un viaje en cualquier estado **excepto** `FINALIZADO` y `CANCELADO`. El viaje pasa
a `CANCELADO` (terminal), se guarda el `motivo_cancelacion` y el admin que lo canceló
(`cancelado_por_admin_id`). Se **preservan** `id_conductor`/`id_vehiculo` y las paradas
ya `ENTREGADO` (historial). Si el viaje tenía (o tuvo) tracking activo —
`CONDUCTOR_ASIGNADO` en adelante— se detiene el emisor de ETA y se limpian todas las keys
`gps:{id_viaje}:*` de Redis (helper `limpiarViajeActivo`).

**Rol requerido:** `ADMIN`

**Body (opcional):**
```json
{ "motivo": "Cancelado por soporte: cliente reportó problema" }
```
- `motivo`: string opcional. Si se omite, se guarda `null`.

**Respuesta exitosa — 200:**
```json
{
  "mensaje": "Viaje cancelado por admin",
  "id_viaje": 42,
  "estado": "CANCELADO",
  "motivo": "Cancelado por soporte: cliente reportó problema"
}
```

**Comportamiento adicional:** emite el evento `viaje:cancelado_por_admin` al room del
viaje y al room personal del cliente (ver más abajo).

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "No se puede cancelar un viaje en estado FINALIZADO" }` | El viaje ya está finalizado |
| 400 | `{ "error": "No se puede cancelar un viaje en estado CANCELADO" }` | El viaje ya está cancelado |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol ADMIN |
| 404 | `{ "error": "Viaje no encontrado" }` | No existe viaje con ese id |

---

### WebSocket — Evento: viaje:cancelado_por_admin

**Dirección:** servidor → room del viaje **y** room personal del cliente
**Quién lo recibe:** el conductor asignado y el cliente conectados al room
`viaje:{id_viaje}`, y el cliente en su room personal `usuario:{id_usuario_cliente}`
**Cuándo:** cuando un admin ejecuta `POST /api/admin/viajes/:id/cancelar`

**Payload:**
```json
{
  "id_viaje": 42,
  "motivo": "Cancelado por soporte: cliente reportó problema",
  "estado": "CANCELADO"
}
```

`motivo` es `null` si el admin no envió uno.

**Cómo escucharlo:**
```js
socket.on('viaje:cancelado_por_admin', (data) => {
  // mostrar aviso: el viaje fue cancelado por un administrador
  console.log(`Viaje ${data.id_viaje} cancelado por admin. Motivo: ${data.motivo ?? '—'}`);
});
```

Es la única cancelación de viaje que emite evento por ahora (las cancelaciones por
conductor y por cliente no notifican por WebSocket — pendiente para el futuro).

---

## Convenciones generales

- Todos los errores devuelven `{ "error": "mensaje legible" }`
- Fechas en formato ISO 8601 UTC
- El campo `contrasena` nunca se almacena en la DB — solo va a Firebase
- `id_conductor`, `id_vehiculo` e `id_empresa` en el viaje son `null` hasta que se asigne un conductor
- El campo `vehiculo` en `viaje:conductor_asignado` siempre es un objeto no nulo — si el conductor no tiene vehículo elegible el servidor emite `error` antes de asignar el viaje

<a id="formato-de-ruta"></a>
### Formato de ruta

La ruta de un viaje (la polilínea que el front dibuja en el mapa) es siempre un **array de
puntos `[lng, lat]`** — primero longitud, después latitud — trazado por Google Maps Directions
desde la primera parada hasta la última, con las paradas intermedias como waypoints en orden:

```json
[[-58.38162, -34.60361], [-58.38201, -34.60280], "..."]
```

Este mismo formato se usa en los cuatro lugares donde la ruta viaja al front:
- `ruta_planeada` en la respuesta de `POST /api/viajes`
- `ruta_planeada` en la respuesta de `GET /api/viajes/:id`
- `ruta_planeada` en el payload del evento `viaje:conductor_asignado`
- `nueva_ruta` en el payload del evento `ruta:recalculada`

La ruta se calcula y cachea al **crear** el viaje. `ruta_planeada` puede ser `null` si Google
Maps falló en la creación (se reintenta en el primer ping GPS, ya con el viaje iniciado) o si el
viaje ya terminó y se limpió el cache. El evento `ruta:recalculada` reemplaza esta ruta cuando el conductor se desvía.