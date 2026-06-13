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

- `fecha_programada`: fecha ISO futura, mínimo 1 hora desde el momento del request
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
  caso se reintenta automáticamente en el primer ping GPS y el viaje se crea igual (201).

**Comportamiento adicional:** después de crear el viaje, el servidor emite el evento
`viaje:disponible` via WebSocket a todos los conductores elegibles conectados.

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "mensaje de validación" }` | Campo faltante o inválido |
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
Los errores de negocio del servidor usan `{ "mensaje": "..." }` — **no** `{ "error": "..." }`.

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

---

### PATCH /api/viajes/:id/estado

Cambia el estado del viaje manualmente. Solo puede ejecutarlo el conductor asignado al viaje.
Estados válidos para este endpoint: `CARGANDO`, `DESCARGANDO`.

**Rol requerido:** `CONDUCTOR`

**Body:**
```json
{
  "estado": "CARGANDO"
}
```

- `estado`: `"CARGANDO"` | `"DESCARGANDO"`

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

**Efectos secundarios en el servidor:**
- Guarda coordenada en Redis (historial de últimas 20)
- Acumula distancia y tiempo
- Si el viaje estaba en `CONDUCTOR_ASIGNADO` y es el primer ping: cambia automáticamente a `EN_CAMINO_A_ORIGEN`
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
(estados `EN_CAMINO_A_ORIGEN` … `EN_RUTA`). El emisor arranca con el primer ping GPS y se
detiene al finalizar o cancelar el viaje.

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
**Cuándo:** cambio automático de estado por GPS (primer ping) o cambio manual via `PATCH /:id/estado`

**Payload:**
```json
{
  "id_viaje": 42,
  "estado_anterior": "CONDUCTOR_ASIGNADO",
  "estado_nuevo": "EN_CAMINO_A_ORIGEN"
}
```

Estados posibles del viaje (flujo completo):

| Estado | Descripción |
|--------|-------------|
| `BUSCANDO_CONDUCTOR` | Viaje creado, esperando que un conductor acepte |
| `CONDUCTOR_ASIGNADO` | Conductor aceptó, aún no se movió |
| `EN_CAMINO_A_ORIGEN` | Primer ping GPS recibido (automático) |
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
Maps falló en la creación (se reintenta en el primer ping GPS) o si el viaje ya terminó y se
limpió el cache. El evento `ruta:recalculada` reemplaza esta ruta cuando el conductor se desvía.