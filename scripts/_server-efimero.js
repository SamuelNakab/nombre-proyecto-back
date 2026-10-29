// Helper compartido para los tests que necesitan probar una variable de entorno
// del PROCESO del server (no del request): levanta src/app.js en un puerto
// propio con el env que se le pida, corre fn() y lo baja pase lo que pase.
//
// Mismo patron que ya usaba test-anticipacion.js inline. Se extrajo cuando el
// timeout de reservas paso a ser un setTimeout por reserva: el valor de
// RESERVA_TIMEOUT_MINUTOS se congela al programar el timer, asi que un server
// ya levantado con el default de 10 minutos no puede probar otra cosa.
//
// OJO con la DB: es la MISMA base (Neon, compartida con produccion) y el MISMO
// Redis que el server de :3000. Lo unico aislado es el proceso y sus rooms de
// socket.io — no hay adapter de Redis, asi que un socket conectado a :3000 NO
// recibe los eventos que emite el server efimero. Los tests que verifican
// eventos tienen que conectar sus sockets al puerto efimero.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// env: variables extra para el proceso hijo (pisan al .env local, porque dotenv
//      no sobrescribe lo que ya esta en process.env). RATE_LIMIT_HABILITADO va en
//      '0' por defecto (las suites hacen rafagas de requests desde localhost);
//      la suite que prueba el limiter lo pisa con '1'. SENTRY_DSN va vacio: un
//      server de test no manda eventos aunque el .env local tenga un DSN.
// fn(base, leerLog): recibe la URL base y un getter del stdout+stderr acumulado.
export async function conServer(env, puerto, fn) {
  const base = `http://localhost:${puerto}`;
  const resumen = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`\n  ⏳ levantando server en :${puerto} con ${resumen}...`);

  const hijo = spawn(process.execPath, ['src/app.js'], {
    cwd: RAIZ,
    env: { ...process.env, PORT: String(puerto), RATE_LIMIT_HABILITADO: '0', SENTRY_DSN: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  hijo.stdout.on('data', (d) => (log += d));
  hijo.stderr.on('data', (d) => (log += d));

  let murio = false;
  hijo.on('exit', () => (murio = true));

  try {
    // Espera a que /health responda (hasta 45s: arranca Prisma, Redis y sockets).
    const limite = Date.now() + 45000;
    let arriba = false;
    while (Date.now() < limite && !murio) {
      try {
        const res = await fetch(`${base}/health`);
        if (res.ok) {
          arriba = true;
          break;
        }
      } catch {
        /* todavia no escucha */
      }
      await esperar(500);
    }
    if (!arriba) {
      throw new Error(
        `El server en :${puerto} no levanto${murio ? ' (el proceso murio)' : ''}.\n--- log ---\n${log}`
      );
    }
    console.log(`  ✅ server :${puerto} arriba`);
    return await fn(base, () => log);
  } finally {
    hijo.kill();
    await esperar(500);
  }
}

// Espera (poll cada 200 ms) a que el log del server tenga una linea que matchee
// `regex`. Devuelve el match (o null si se cumple el plazo). Para los logs que
// salen de tareas async del arranque, que pueden aparecer DESPUES de /health.
export async function esperarLinea(leerLog, regex, ms = 15000) {
  const limite = Date.now() + ms;
  for (;;) {
    const m = leerLog().match(regex);
    if (m || Date.now() >= limite) return m;
    await esperar(200);
  }
}
