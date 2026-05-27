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
  "condiciones_requeridas": ["FRAGIL", "REFRIGERADO"]
}
```


- `fecha_programada`: fecha ISO futura, mínimo 1 hora desde el momento del request
- `condiciones_requeridas`: opcional. Valores posibles: `FRAGIL`, `REFRIGERADO`,
  `CARGA_PESADA`, `PELIGROSO`, `VOLUMINOSO`


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
el conductor es elegible (tiene al menos un vehículo que cumple todas las
condiciones requeridas del viaje).


**Rol requerido:** `CONDUCTOR`


**Respuesta exitosa — 200:**
```json
[
  {
    "id_viaje": 42,
    "zona": "CABA",
    "precio_estimado": 2500,
    "fecha_programada": "2026-07-01T10:00:00.000Z",
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


Ordenados por `fecha_programada` ascendente.


**Ejemplo de llamada (React Native / fetch):**
```js
const res = await fetch('http://localhost:3000/api/viajes/disponibles', {
  headers: { Authorization: 'Bearer ' + conductorToken }
});
const viajes = await res.json(); // array
```


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
  }
}
```


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
  "paradas": [
    { "orden": 1, "direccion": "Plaza de Mayo, CABA" },
    { "orden": 2, "direccion": "Recoleta, CABA" }
  ],
  "condiciones_req": [
    { "condicion": "FRAGIL" },
    { "condicion": "REFRIGERADO" }
  ]
}
```


**Nota:** `condiciones_req` puede ser un array vacío si el viaje
no requiere condiciones especiales de vehículo.


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


**Cómo emitirlo:**
```js
socket.emit('viaje:aceptar', { id_viaje: 42 });
```


**Nota:** después de emitir este evento el conductor recibirá `viaje:conductor_asignado`
si ganó la carrera o `viaje:ya_asignado` si otro conductor fue más rápido.


---


### Evento: viaje:conductor_asignado


**Dirección:** servidor → conductor ganador (socket directo) y cliente (socket directo)  
**Quién lo recibe:** exclusivamente el conductor que ganó la asignación y el cliente dueño del viaje  
**Cuándo:** cuando un conductor acepta exitosamente el viaje


**Payload:**
```json
{
  "id_viaje": 42,
  "id_usuario_conductor": 5,
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
  }
}
```


**Cómo escucharlo:**
```js
socket.on('viaje:conductor_asignado', (data) => {
  // para el cliente: mostrar datos del conductor asignado
  // para el conductor: navegar a la pantalla del viaje activo
  console.log('Conductor asignado:', data.conductor.nombre);
});
```


**Nota:** este evento se emite directamente al socket del conductor ganador y al socket
del cliente — no se broadcast al room. Los conductores que intentaron y perdieron reciben
`viaje:ya_asignado` (si emitieron `viaje:aceptar`) o `viaje:no_disponible` (si aún
estaban esperando en el room).


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


### Evento: viaje:no_disponible


**Dirección:** servidor → conductores del room (broadcast, excluye al ganador)  
**Quién lo recibe:** todos los conductores conectados al room `viaje:{id_viaje}` que no ganaron la asignación  
**Cuándo:** inmediatamente después de que otro conductor acepta exitosamente el viaje


**Payload:**
```json
{
  "id_viaje": 42
}
```


**Cómo escucharlo:**
```js
socket.on('viaje:no_disponible', (data) => {
  // remover el viaje de la lista de disponibles
  console.log('Viaje ya no disponible:', data.id_viaje);
});
```


**Diferencia con `viaje:ya_asignado`:** este evento llega a conductores que estaban
en el room pero **no llegaron a emitir `viaje:aceptar`**. Quien emitió `viaje:aceptar`
y llegó tarde recibe `viaje:ya_asignado`, no este evento.


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
- Emite `mapa:actualizar`, y cada ~60 s emite `costo:actualizar`
- Si el viaje está en `EN_RUTA`: verifica desvíos y paradas sospechosas

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

## Convenciones generales


- Todos los errores devuelven `{ "error": "mensaje legible" }`
- Fechas en formato ISO 8601 UTC
- El campo `contrasena` nunca se almacena en la DB — solo va a Firebase
- `id_conductor`, `id_vehiculo` e `id_empresa` en el viaje son `null` hasta que se asigne un conductor
- El campo `vehiculo` en `viaje:conductor_asignado` puede ser `null` si el conductor
  no tiene vehículo registrado en la DB (se resuelve en Fase 4)

