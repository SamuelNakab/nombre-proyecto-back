# Fleter — Contrato de API

Documento de referencia para el equipo mobile y web.
Base URL: `https://nombre-proyecto-back-production.up.railway.app/`

---

## Autenticación

La mayoría de endpoints requieren un JWT de Firebase en el header:
```
Authorization: Bearer <firebase-id-token>
```
El token se obtiene del cliente Firebase (iOS/Android/Web) después de que el usuario inicia sesión. Este backend **nunca autentica contraseñas directamente** — solo verifica el token.

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
  "licencia_vencimiento": "string ISO 8601 datetime (requerido) — ej: '2027-12-31T00:00:00.000Z'"
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

Verifica que el usuario autenticado por Firebase existe en la DB. **No autentica credenciales** — eso lo hace Firebase en el cliente.

**Autenticación:** Requerida (`Authorization: Bearer <token>`)

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
| 404 | `{ "error": "Usuario no registrado" }` | Token válido pero no hay registro en DB |

---

### GET /api/auth/me

Retorna el perfil completo del usuario autenticado.

**Autenticación:** Requerida (`Authorization: Bearer <token>`)

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
| 404 | `{ "error": "Usuario no registrado" }` | Token válido pero no hay registro en DB |

---

### PUT /api/auth/perfil

Actualiza el perfil del usuario autenticado. Solo se actualizan los campos presentes en el body.

**Autenticación:** Requerida (`Authorization: Bearer <token>`)

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

## GET /health

Endpoint de verificación de estado del servidor. No requiere autenticación.

**Respuesta exitosa — 200:**
```json
{
  "status": "ok",
  "timestamp": "2026-04-28T03:00:00.000Z"
}
```

---

---

## /viajes — Gestión de viajes (Fase 2)

### POST /api/viajes/estimar-costo

Calcula el costo estimado de un viaje sin crearlo. Si `GOOGLE_MAPS_API_KEY` no está configurada, usa distancia mock (10 km, 0.5 h).

**Rol requerido:** `CLIENTE`

**Headers:**
```
Authorization: Bearer <firebase-id-token>
```

**Body:**
```json
{
  "zona": "CABA",
  "paradas": [
    { "lat": -34.603722, "lng": -58.381592, "direccion": "Av. de Mayo 1370, CABA" },
    { "lat": -34.615, "lng": -58.370, "direccion": "San Telmo, CABA" }
  ],
  "tarifa_hora": 5000
}
```
- `zona`: `"CABA"` | `"PROVINCIA"` | `"MIXTO"`
- `paradas`: mínimo 2 elementos
- `tarifa_hora`: requerido si zona es `CABA` o `MIXTO`
- `tarifa_km`: requerido si zona es `PROVINCIA` o `MIXTO`

**Respuesta exitosa — 200:**
```json
{
  "precio_estimado": 2500,
  "distancia_total_km": 2.3,
  "tiempo_total_horas": 0.5
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

Crea un viaje nuevo. El viaje queda en estado `BUSCANDO_CONDUCTOR`.

**Rol requerido:** `CLIENTE`

**Headers:**
```
Authorization: Bearer <firebase-id-token>
```

**Body:**
```json
{
  "zona": "MIXTO",
  "paradas": [
    { "lat": -34.603722, "lng": -58.381592, "direccion": "Av. de Mayo 1370, CABA" },
    { "lat": -34.92, "lng": -57.95, "direccion": "La Plata, Buenos Aires" }
  ],
  "tarifa_hora": 5000,
  "tarifa_km": 800,
  "fecha_programada": "2026-05-10T10:00:00.000Z",
  "condiciones_requeridas": ["FRAGIL", "REFRIGERADO"]
}
```
- `fecha_programada`: fecha ISO futura, mínimo 1 hora desde el momento del request
- `condiciones_requeridas`: opcional, valores posibles: `FRAGIL`, `REFRIGERADO`, `CARGA_PESADA`, `PELIGROSO`, `VOLUMINOSO`

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
  "tarifa_km": 800,
  "fecha_programada": "2026-05-10T10:00:00.000Z",
  "estado": "BUSCANDO_CONDUCTOR",
  "precio_estimado": 10800,
  "precio_real": null,
  "creado_en": "2026-05-03T12:00:00.000Z",
  "paradas": [
    {
      "id_parada": 1,
      "id_viaje": 42,
      "orden": 1,
      "direccion": "Av. de Mayo 1370, CABA",
      "latitud": -34.603722,
      "longitud": -58.381592,
      "qr_token": "cuid_generado",
      "estado": "PENDIENTE",
      "fecha_entrega": null
    }
  ],
  "condiciones_req": [
    { "id_condicion_req": 1, "id_viaje": 42, "condicion": "FRAGIL" },
    { "id_condicion_req": 2, "id_viaje": 42, "condicion": "REFRIGERADO" }
  ]
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "mensaje de validación" }` | Campo faltante o inválido |
| 400 | `{ "error": "El usuario no tiene perfil de cliente" }` | El usuario autenticado no tiene registro de cliente |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CLIENTE |
| 503 | `{ "error": "No se pudo calcular la distancia" }` | Error en Google Maps API |

---

### GET /api/viajes/disponibles

Devuelve los viajes en estado `BUSCANDO_CONDUCTOR` con fecha futura para los que el conductor es elegible (tiene al menos un vehículo que cumple todas las condiciones requeridas).

**Rol requerido:** `CONDUCTOR`

**Headers:**
```
Authorization: Bearer <firebase-id-token>
```

**Respuesta exitosa — 200:**
```json
[
  {
    "id_viaje": 42,
    "zona": "CABA",
    "precio_estimado": 2500,
    "fecha_programada": "2026-05-10T10:00:00.000Z",
    "estado": "BUSCANDO_CONDUCTOR",
    "paradas": [
      { "orden": 1, "direccion": "Av. de Mayo 1370, CABA", "latitud": -34.603722, "longitud": -58.381592 }
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

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "El usuario no tiene perfil de conductor" }` | El usuario autenticado no tiene registro de conductor |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CONDUCTOR |

---

### GET /api/viajes/mis-viajes

Devuelve todos los viajes creados por el cliente autenticado, ordenados del más reciente al más antiguo.

**Rol requerido:** `CLIENTE`

**Headers:**
```
Authorization: Bearer <firebase-id-token>
```

**Respuesta exitosa — 200:**
```json
[
  {
    "id_viaje": 42,
    "zona": "CABA",
    "precio_estimado": 2500,
    "precio_real": null,
    "estado": "BUSCANDO_CONDUCTOR",
    "fecha_programada": "2026-05-10T10:00:00.000Z",
    "creado_en": "2026-05-03T12:00:00.000Z",
    "paradas": [
      { "orden": 1, "direccion": "Av. de Mayo 1370, CABA" }
    ],
    "conductor": null
  }
]
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 400 | `{ "error": "El usuario no tiene perfil de cliente" }` | El usuario autenticado no tiene registro de cliente |
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Acceso denegado" }` | El usuario no tiene rol CLIENTE |

---

### GET /api/viajes/:id

Devuelve el detalle de un viaje. Solo puede acceder el cliente que lo creó o el conductor asignado.

**Rol requerido:** Autenticado (CLIENTE o CONDUCTOR)

**Headers:**
```
Authorization: Bearer <firebase-id-token>
```

**Respuesta exitosa — 200:**
```json
{
  "id_viaje": 42,
  "zona": "CABA",
  "precio_estimado": 2500,
  "precio_real": null,
  "estado": "BUSCANDO_CONDUCTOR",
  "fecha_programada": "2026-05-10T10:00:00.000Z",
  "creado_en": "2026-05-03T12:00:00.000Z",
  "paradas": [
    { "orden": 1, "direccion": "Av. de Mayo 1370, CABA", "latitud": -34.603722, "longitud": -58.381592, "estado": "PENDIENTE" }
  ],
  "condiciones_req": [
    { "condicion": "FRAGIL" }
  ],
  "cliente": {
    "id_cliente": 3,
    "usuario": { "nombre": "Juan", "apellido": "Pérez", "email": "juan@example.com" }
  },
  "conductor": null
}
```

**Errores posibles:**
| Status | Body | Causa |
|--------|------|-------|
| 401 | `{ "error": "Token no proporcionado" }` | Sin header Authorization |
| 403 | `{ "error": "Sin acceso a este viaje" }` | El usuario no es el cliente ni el conductor del viaje |
| 404 | `{ "error": "Viaje no encontrado" }` | No existe viaje con ese id |

---

## Eventos de Socket.io

### ⚠️ PENDIENTE — conductor:aceptado

Emitido por el servidor cuando un conductor acepta un viaje.

**Room:** `viaje:{id_viaje}` — el cliente debe unirse a esta room al crear el viaje.

**Evento:** `conductor:aceptado`

**Payload:**
```json
{
  "id_viaje": 42,
  "id_conductor": 7,
  "nombre_conductor": "Carlos López",
  "calificacion_promedio": 4.8,
  "vehiculo": {
    "patente": "ABC123",
    "marca": "Ford",
    "modelo": "Transit",
    "color": "Blanco"
  },
  "eta_minutos": 12
}
```

**Estado:** No implementado. Se emitirá desde `src/sockets/matching.socket.js` cuando se complete el flujo de matching.

---

## Convenciones generales

- Todos los errores devuelven `{ "error": "mensaje legible" }`
- Fechas en formato ISO 8601 UTC
- El campo `contrasena` nunca se almacena en la DB — solo va a Firebase
- Los campos `firebase_uid` se incluyen en `GET /me` pero el cliente no debe usarlos directamente

## Autenticacion

Los endpoints protegidos requieren un header:
  Authorization: Bearer <token>

El token se obtiene de Firebase en el cliente, NO de esta API.

En React Native:
  import auth from '@react-native-firebase/auth';
  const token = await auth().currentUser.getIdToken();

En Next.js:
  import { getAuth } from 'firebase/auth';
  const token = await getAuth().currentUser.getIdToken();

El token dura 1 hora. Firebase lo renueva automaticamente.
Pasarlo en cada request a endpoints que digan "requiere token".

Firebase config (misma para mobile y web):
  apiKey: "..."
  authDomain: "..."
  projectId: "..."

{
    "email": "mail@domain.com",
    "password": "password",
    "returnSecureToken": true
}

{
  "kind": "identitytoolkit#VerifyPasswordResponse",
  "localId": "EJGLVSmawodt4lmKpRRREYxgzVo2",
  "email": "mail@domain.com",
  "displayName": "",
  "idToken": "eyJhbGciOiJSUzI1NiIsImtpZCI6Ijg2OGU0YWNlMGI2NTE2ZDM2YjlmNTZkZThjZTQ5Nzg4ZmNjZGFjNDMiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vZmxldGVzLThmYWJhIiwiYXVkIjoiZmxldGVzLThmYWJhIiwiYXV0aF90aW1lIjoxNzc4Mjk3OTM0LCJ1c2VyX2lkIjoiRUpHTFZTbWF3b2R0NGxtS3BSUlJFWXhnelZvMiIsInN1YiI6IkVKR0xWU21hd29kdDRsbUtwUlJSRVl4Z3pWbzIiLCJpYXQiOjE3NzgyOTc5MzQsImV4cCI6MTc3ODMwMTUzNCwiZW1haWwiOiJtYWlsQGRvbWFpbi5jb20iLCJlbWFpbF92ZXJpZmllZCI6ZmFsc2UsImZpcmViYXNlIjp7ImlkZW50aXRpZXMiOnsiZW1haWwiOlsibWFpbEBkb21haW4uY29tIl19LCJzaWduX2luX3Byb3ZpZGVyIjoicGFzc3dvcmQifX0.L0AvQYE7S7YzFr9Ih96m2w2FKRK20VVSISQ3vic6FqHL00H7Q6EXxRN924VgGjcyZvscZIoODthjtpjyIGKq2Ur0VPxjV0kr8JYd-pxxvUHpWox-MEGrPSFKUfvyTcq2FEYF_MuJl81w7n3QREmCqXmmXw0tQHg5oAmLpM6WT_cbw1o2-5BARZvmtWGl2DrNMqpVfCOGmApbz45iQaVfhuJqPuJp-YLL_Ogs3I3pisAy7LLAowp_Uto-fvOB3TIWOUsYcPPYhGU3Jg0LzzI78XReICYQnx77VXIfvWnpEUyciNRilVgv_NM-ak2PTufXMVL_DYQd3ewda4CJOx4tpw",
  "registered": true,
  "refreshToken": "AMf-vBwLZMK7VVyk2rM4Tm2-1nM-FVIDKvtLLsv2zPDdos1i0As7lkK2SYDEKNf7zxqP6kAepOiHbY6Mljr36wGPe1-cDBO4NlaWwFYwfg2M2gphgJI8ZDh0bcdW-qAgV9AxYEgoYlaJiOAxSZ2xWaQmq9wDXRmAiIxzO18BtmGz4xnTrgkJugmiZXXo7e20xkWKUzMUX-LG",
  "expiresIn": "3600"
}