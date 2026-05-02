# Fleter — Backend

## Descripcion del proyecto
Plataforma marketplace de fletes para PyMEs argentinas.
Similar a Uber pero para fletes. El cliente solicita un viaje,
el sistema lo publica a conductores elegibles via WebSocket,
el primero en aceptar queda asignado.

## Estado actual del proyecto
- Base de datos: schema.prisma completo, migracion inicial aplicada en Neon
- Scaffold: estructura de carpetas creada
- Config: prisma.js, firebase.js, redis.js, storage.js creados
- Middleware: auth.middleware.js creado (verificarToken, requireRol)
- Endpoints Fase 1: registro y login implementados y funcionando en local
- Deploy: Railway — fallando por imports de Prisma incompatibles con Node 22 ESM estricto

## Stack
- Node.js 22 con ES Modules (import/export — NUNCA require)
- Express
- PostgreSQL en Neon (serverless)
- Prisma v5 como ORM
- Firebase Admin SDK para autenticacion
- Socket.io para WebSockets
- Redis
- Zod para validacion
- BullMQ para colas

## PROBLEMA ACTIVO A RESOLVER
Railway (Node 22.22.2, ESM estricto) no puede importar PrismaClient como named export.
El error es: "Named export 'PrismaClient' not found. The requested module
'@prisma/client' is a CommonJS module"

La solucion correcta para CUALQUIER import de @prisma/client en ESM estricto es:
  import pkg from '@prisma/client';
  const { PrismaClient } = pkg;

Ademas Railway no ejecuta prisma generate automaticamente.
El script start en package.json debe ser:
  "start": "prisma generate && node src/app.js"

## Reglas de codigo
- ES Modules siempre. NUNCA require().
- Para modulos CommonJS (como @prisma/client) usar el patron:
    import pkg from 'nombre-modulo';
    const { NamedExport } = pkg;
- Async/await siempre.
- Validar todos los inputs con Zod.
- Respuestas de error: { error: "mensaje" }
- Variables de entorno: todas en .env, nunca hardcodeadas.
- Nombres de archivos: kebab-case.
- Named exports en controllers y services.

## Estructura de carpetas
src/
├── config/
│   ├── firebase.js
│   ├── prisma.js        ← TIENE EL BUG DE IMPORT
│   ├── redis.js
│   └── storage.js
├── routes/
│   └── auth.routes.js
├── controllers/
│   └── auth.controller.js
├── services/
├── middlewares/
│   └── auth.middleware.js
├── sockets/
├── jobs/
└── app.js
prisma/
├── schema.prisma
└── migrations/

## Variables de entorno
Todas en .env (no se pushea). Ver .env.example para la lista completa.

## Endpoints existentes (Fase 1)
POST /api/auth/registro-cliente
POST /api/auth/registro-conductor
POST /api/auth/registro-gerente
POST /api/auth/login         (requiere Bearer token de Firebase)
GET  /api/auth/me            (requiere Bearer token de Firebase)
PUT  /api/auth/perfil        (requiere Bearer token de Firebase)
GET  /health

## Comandos importantes
npm run dev                                → desarrollo local con hot reload
npm run start                              → produccion (debe incluir prisma generate)
npx prisma migrate dev --name descripcion  → nueva migracion
npx prisma studio                          → UI para ver la DB