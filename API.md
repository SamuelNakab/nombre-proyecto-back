# Fleter — Contrato de API

Documento de referencia para el equipo mobile y web.
Base URL: `https://<dominio>/api`

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