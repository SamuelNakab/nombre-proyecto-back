// Runner UNICO de la regresion: corre todas las suites de scripts/ en serie y
// al final imprime suite | resultado | duracion. Exit 1 si alguna fallo.
//
//   npm run test:regresion
//   node scripts/test-regresion.js --solo identidad,zona     solo esas
//   node scripts/test-regresion.js --desde jerarquia         retoma desde esa
//
// Levanta SU PROPIO server (src/app.js) en :3900 con el marketplace y las
// calificaciones prendidos (las suites legacy los prueban) y los dos barridos
// de arranque apagados (la DB esta compartida con produccion). No usa ni choca
// con un `npm run dev` en :3000. Las suites que pegan a "el server" lo leen de
// TEST_BASE_URL; las que levantan servers efimeros propios fijan sus flags ahi.
//
// Cada suite limpia lo que crea (ver _limpieza.js). Log completo de cada una en
// scripts/.regresion/<suite>.log (gitignored); en vivo se ve con prefijo y sin
// las lineas prisma:query.
import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { conServer } from './_server-efimero.js';

// Orden: primero las del modelo nuevo (con servers propios), despues las del
// marketplace legacy contra el server del runner. timeoutMin = tope por suite.
const SUITES = [
  { archivo: 'test-seguridad.js', timeoutMin: 8 },
  { archivo: 'test-identidad.js', timeoutMin: 10 },
  { archivo: 'test-viaje-interno.js', timeoutMin: 30 },
  { archivo: 'test-maps.js', timeoutMin: 10 },
  { archivo: 'test-lugares-series.js', timeoutMin: 25 },
  { archivo: 'test-cierre-viaje.js', timeoutMin: 15 },
  { archivo: 'test-fase5.js', timeoutMin: 5 },
  { archivo: 'test-cancelacion-conductor.js', timeoutMin: 5 },
  { archivo: 'test-cancelacion-cliente.js', timeoutMin: 5 },
  { archivo: 'test-admin.js', timeoutMin: 5 },
  { archivo: 'test-iniciar-viaje.js', timeoutMin: 5 },
  { archivo: 'test-jerarquia.js', timeoutMin: 8 },
  { archivo: 'test-visibilidad-gerente.js', timeoutMin: 5 },
  { archivo: 'test-zona.js', timeoutMin: 5 },
  { archivo: 'test-acceso-gerente.js', timeoutMin: 5 },
  { archivo: 'test-campos-duracion.js', timeoutMin: 5 },
  { archivo: 'test-concurrencia-jerarquia.js', timeoutMin: 5 },
  { archivo: 'test-confirmar-parada.js', timeoutMin: 5 },
  { archivo: 'test-anticipacion.js', timeoutMin: 5 },
  { archivo: 'test-historial-estados.js', timeoutMin: 12 },
  { archivo: 'test-timeout-reserva.js', timeoutMin: 10 },
  { archivo: 'test-viajes-vencidos.js', timeoutMin: 12 },
  { archivo: 'test-mis-viajes-conductor.js', timeoutMin: 5 },
  { archivo: 'stress/test-cierre-exhaustivo.js', timeoutMin: 5 },
  { archivo: 'test-eta-recalculo.js', timeoutMin: 8 },
  { archivo: 'test-ruta-front.js', timeoutMin: 5 },
  { archivo: 'test-vehiculos.js', timeoutMin: 5 },
];

const PUERTO = 3900;
const ENV_SERVER = {
  MARKETPLACE_HABILITADO: 'true',
  CALIFICACIONES_HABILITADAS: 'true',
  RESERVA_BARRIDO_ARRANQUE: '0',
  VENCIMIENTO_BARRIDO_ARRANQUE: '0',
  CIERRE_BARRIDO_ARRANQUE: '0',
  // Las suites legacy registran usuarios y hacen rafagas contra este server desde
  // localhost. test-seguridad prueba el limiter con servers propios.
  RATE_LIMIT_HABILITADO: '0',
};

const DIR_SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(DIR_SCRIPTS, '..');
const DIR_LOGS = path.join(DIR_SCRIPTS, '.regresion');

// 'stress/test-cierre-exhaustivo.js' -> 'cierre-exhaustivo'
const nombre = (archivo) => path.basename(archivo, '.js').replace(/^test-/, '');

function argumento(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

function elegirSuites() {
  const solo = argumento('--solo')?.split(',').map((s) => nombre(s.trim()));
  const desde = argumento('--desde') ? nombre(argumento('--desde')) : null;
  const conocidas = SUITES.map((s) => nombre(s.archivo));
  for (const n of [...(solo ?? []), ...(desde ? [desde] : [])]) {
    if (!conocidas.includes(n)) throw new Error(`Suite desconocida: ${n}. Hay: ${conocidas.join(', ')}`);
  }
  let lista = SUITES;
  if (desde) lista = lista.slice(conocidas.indexOf(desde));
  if (solo) lista = lista.filter((s) => solo.includes(nombre(s.archivo)));
  return lista;
}

// Mata la suite Y lo que haya levantado (sus servers efimeros), si no quedarian
// puertos tomados para la siguiente.
function matarArbol(hijo) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(hijo.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-hijo.pid, 'SIGKILL');
    } catch {
      hijo.kill('SIGKILL');
    }
  }
}

function correrSuite(suite, base) {
  const n = nombre(suite.archivo);
  const log = createWriteStream(path.join(DIR_LOGS, `${n}.log`));
  const inicio = Date.now();
  return new Promise((resolve) => {
    const hijo = spawn(process.execPath, [path.join(DIR_SCRIPTS, suite.archivo), ...(suite.args ?? [])], {
      cwd: RAIZ,
      env: { ...process.env, TEST_BASE_URL: base },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let pendiente = '';
    const enVivo = (chunk) => {
      log.write(chunk);
      pendiente += chunk;
      const lineas = pendiente.split('\n');
      pendiente = lineas.pop();
      for (const l of lineas) if (!l.startsWith('prisma:query')) console.log(`[${n}] ${l}`);
    };
    hijo.stdout.on('data', enVivo);
    hijo.stderr.on('data', enVivo);

    let porTimeout = false;
    const timer = setTimeout(() => {
      porTimeout = true;
      log.write(`\n[regresion] TIMEOUT a los ${suite.timeoutMin} min: se mata la suite\n`);
      matarArbol(hijo);
    }, suite.timeoutMin * 60000);

    hijo.on('close', (code) => {
      clearTimeout(timer);
      if (pendiente && !pendiente.startsWith('prisma:query')) console.log(`[${n}] ${pendiente}`);
      log.end();
      const seg = Math.round((Date.now() - inicio) / 1000);
      const resultado = porTimeout ? 'FALLA (timeout)' : code === 0 ? 'OK' : `FALLA (exit ${code})`;
      resolve({ suite: n, resultado, duracion: `${Math.floor(seg / 60)}m${String(seg % 60).padStart(2, '0')}s`, seg });
    });
  });
}

// Requisitos que, si faltan, hacen fallar a varias suites a la mitad: mejor
// cortar antes de levantar nada.
function chequearRequisitos() {
  const faltan = ['FIREBASE_WEB_API_KEY', 'INVITACION_SECRETO', 'TEST_ADMIN_PASSWORD'].filter((k) => !process.env[k]);
  if (faltan.length > 0) throw new Error(`Faltan en el .env: ${faltan.join(', ')}`);
}

async function main() {
  chequearRequisitos();
  const lista = elegirSuites();
  mkdirSync(DIR_LOGS, { recursive: true });
  console.log(`\n  Regresion: ${lista.length} suites, logs en scripts/.regresion/\n`);

  const resultados = [];
  const t0 = Date.now();
  await conServer(ENV_SERVER, PUERTO, async (base, leerLog) => {
    try {
      for (const suite of lista) {
        console.log(`\n========== ${nombre(suite.archivo)} ==========\n`);
        resultados.push(await correrSuite(suite, base));
      }
    } finally {
      writeFileSync(path.join(DIR_LOGS, '_server.log'), leerLog());
    }
  });

  const fallaron = resultados.filter((r) => r.resultado !== 'OK');
  const total = Math.round((Date.now() - t0) / 1000);
  console.log('\n  RESULTADO DE LA REGRESION\n');
  console.table(resultados.map(({ suite, resultado, duracion }) => ({ suite, resultado, duracion })));
  console.log(
    `  ${resultados.length - fallaron.length}/${resultados.length} OK en ${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s` +
      (fallaron.length > 0 ? ` — fallaron: ${fallaron.map((r) => r.suite).join(', ')}` : '')
  );
  process.exit(fallaron.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n💥', e.message);
  process.exit(1);
});
