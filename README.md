## Convención de branches

- `feature/nombre-corto` — nueva funcionalidad
- `fix/nombre-corto` — corrección de bug

Todo cambio entra a `main` y a `develop` exclusivamente vía Pull Request,
con al menos 1 aprobación requerida por la branch protection del repositorio.

## Entornos

| Entorno     | Rama      | URL |
|-------------|-----------|-----|
| Producción  | `main`    | https://nombre-proyecto-back-production.up.railway.app |
| Staging     | `develop` | https://nombre-proyecto-back-staging.up.railway.app |

Cada entorno tiene su propia base de datos PostgreSQL (Neon) y su propio
servicio Redis, completamente separados. El proyecto de Firebase
(autenticación) es compartido entre ambos.

## Correr el proyecto localmente

```bash
npm install
npx prisma generate
npm run dev
```

El servidor levanta en el puerto definido por la variable `PORT` (3000 por
defecto). Requiere un archivo `.env` con las variables documentadas en
`CLAUDE.md`.

## Tests

```bash
npm run lint        # ESLint
npm run test         # Tests unitarios (Vitest), solo carpeta src/
npm run test:e2e     # Test E2E contra staging, requiere variables de entorno:
                      #   TEST_API_URL, FIREBASE_WEB_API_KEY,
                      #   TEST_USER_EMAIL, TEST_USER_PASSWORD
```

## CI/CD

El pipeline (`.github/workflows/ci.yml`) corre lint, tests unitarios y el
test E2E en cada push o Pull Request hacia `main` o `develop`. Si todo pasa:

- Push a `develop` → deploy automático a staging
- Push a `main` → deploy automático a producción

El deploy nunca ocurre si alguno de los pasos anteriores falla. Ver
`CALIDAD.md` para el detalle de las decisiones de diseño del pipeline.