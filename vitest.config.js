import { defineConfig } from 'vitest/config';

// SENTRY_DSN vacio en los tests: aunque el .env local tenga uno, ningun test
// manda eventos (dotenv no pisa una variable ya definida, aunque este vacia).
export default defineConfig({
  test: {
    env: { SENTRY_DSN: '' },
  },
});
