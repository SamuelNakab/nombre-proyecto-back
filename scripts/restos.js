// Restos de los tests en la DB compartida con produccion (y en Firebase / Redis /
// R2): lo que dejaron corridas cortadas a la mitad, suites viejas que no
// limpiaban y las exploratorias.
//
//   node scripts/restos.js                  SOLO CUENTA (tabla por categoria)
//   node scripts/restos.js --borrar         borra TODAS las categorias con algo
//   node scripts/restos.js --solo -vin-,fijas            cuenta solo esas
//   node scripts/restos.js --solo -vin- --borrar         borra solo esas
//
// Categorias:
//   - un PATRON de email por suite (-jer-, -vin-, _veh_, ...): los usuarios
//     *<patron>*@test.com (DB y Firebase, incluidos los huerfanos de Firebase) y
//     todo lo que cuelga de ellos (viajes, empresas, vehiculos, PyMEs, ...).
//   - fijas: los viajes de las cuentas FIJAS del seed (cliente@, conductor@...).
//     Las cuentas NO se tocan, solo sus viajes.
//   - e2e: los viajes de la cuenta del E2E (TEST_USER_EMAIL y chofer-e2e@). La
//     cuenta, la PyME E2E y el vehiculo E2E000 NO se tocan.
//   - exploratorias: vehiculos STR* que dejaron las stress de scripts/legacy/.
//   - seed-test: la "Empresa Test" (CUIT 20-99999999-9) y el vehiculo TEST001 del
//     seed-test.js que se borro.
//   - sim: lo que deja el simulador del front (e2e/sim): los usuarios
//     sim+...@fleter.test (DB y Firebase, huerfanos incluidos) con sus PyMEs,
//     vehiculos, viajes y remitos. Corre en CI en cada push a develop y no puede
//     borrar lo suyo (es caja negra): se limpia desde aca.
//
// El --restos de cada suite delega aca con su patron (y tambien es solo conteo
// salvo --borrar). La guarda de protegidos de _limpieza.js vale igual.
import { pathToFileURL } from 'node:url';
import prisma from '../src/config/prisma.js';
import admin from '../src/config/firebase.js';
import { resolver, borrar, contar, cerrarConexiones, EMAILS_PROTEGIDOS } from './_limpieza.js';

export const PATRONES = [
  '-jer-', // test-jerarquia
  '-vis-', // test-visibilidad-gerente
  '-acc-', // test-acceso-gerente
  '-dur-', // test-campos-duracion
  '-conc-', // test-concurrencia-jerarquia
  '-conf-', // test-confirmar-parada
  '-vnc-', // test-viajes-vencidos
  '-hst-', // test-historial-estados
  '-tmo-', // test-timeout-reserva
  'cond-mvc-', // test-mis-viajes-conductor
  '_veh_', // test-vehiculos
  '-vin-', // test-viaje-interno
  '-idn-', // test-identidad
  '-lys-', // test-lugares-series
  '-cie-', // test-cierre-viaje
  'maps-', // test-maps
];
// Dominio de las cuentas del simulador del front (e2e/sim). Sirve de patron para
// contar lo que quede despues de borrar.
const DOMINIO_SIM = '@fleter.test';
const FIJAS = EMAILS_PROTEGIDOS.filter((e) => e !== 'chofer-e2e@test.com' && e !== 'admin-test@fleter.com');
const ESTADOS_FINALES = ['FINALIZADO', 'CANCELADO', 'RECHAZADO', 'VENCIDO'];

// Todos los emails de Firebase (paginado): sirve para contar los huerfanos (en
// Firebase y no en la DB), que hacen fallar el registro de la proxima corrida.
async function emailsFirebase() {
  const out = [];
  let token;
  do {
    const pagina = await admin.auth().listUsers(1000, token);
    out.push(...pagina.users.map((u) => u.email?.toLowerCase()).filter(Boolean));
    token = pagina.pageToken;
  } while (token);
  return out;
}

const deCuentas = async (emails) => {
  const us = await prisma.usuario.findMany({
    where: { email: { in: emails } },
    select: { cliente: { select: { id_cliente: true } }, conductor: { select: { id_conductor: true } } },
  });
  const idsCliente = us.map((u) => u.cliente?.id_cliente).filter(Boolean);
  const idsConductor = us.map((u) => u.conductor?.id_conductor).filter(Boolean);
  const viajes = await prisma.viaje.findMany({
    where: { OR: [{ id_cliente: { in: idsCliente } }, { id_conductor: { in: idsConductor } }] },
    select: { id_viaje: true },
  });
  return viajes.map((v) => v.id_viaje);
};

// Cada categoria -> la entrada para resolver() de _limpieza.js.
async function categorias(fb) {
  const out = [];
  for (const patron of PATRONES) {
    const db = await prisma.usuario.findMany({
      where: { email: { contains: patron, endsWith: '@test.com' } },
      select: { email: true },
    });
    // includes en JS: el LIKE de Prisma no escapa '_' (comodin en '_veh_').
    const emails = [...new Set([...db.map((u) => u.email.toLowerCase()), ...fb])].filter(
      (e) => e.includes(patron) && e.endsWith('@test.com')
    );
    out.push({ nombre: patron, entrada: { emails }, emails });
  }
  out.push({ nombre: 'fijas', entrada: { viajes: await deCuentas(FIJAS) }, emails: [] });
  const e2e = ['chofer-e2e@test.com', process.env.TEST_USER_EMAIL?.toLowerCase()].filter(Boolean);
  out.push({ nombre: 'e2e', entrada: { viajes: await deCuentas(e2e) }, emails: [] });
  const str = await prisma.vehiculo.findMany({ where: { patente: { startsWith: 'STR' } }, select: { id_vehiculo: true } });
  out.push({ nombre: 'exploratorias', entrada: { vehiculos: str.map((v) => v.id_vehiculo) }, emails: [] });
  const empTest = await prisma.empresa.findMany({ where: { cuit: { in: ['20-99999999-9', '20999999999'] } }, select: { id_empresa: true } });
  const test001 = await prisma.vehiculo.findMany({ where: { patente: 'TEST001' }, select: { id_vehiculo: true } });
  out.push({
    nombre: 'seed-test',
    entrada: { empresas: empTest.map((e) => e.id_empresa), vehiculos: test001.map((v) => v.id_vehiculo) },
    emails: [],
  });
  const sim = await prisma.usuario.findMany({ where: { email: { endsWith: DOMINIO_SIM } }, select: { email: true } });
  const emailsSim = [...new Set([...sim.map((u) => u.email.toLowerCase()), ...fb])].filter((e) => e.endsWith(DOMINIO_SIM));
  out.push({ nombre: 'sim', entrada: { emails: emailsSim }, emails: emailsSim, patron: DOMINIO_SIM });
  return out;
}

async function fila(nombre, r, fb, emails) {
  const vivos = r.viajes.filter((v) => !ESTADOS_FINALES.includes(v.estado)).length;
  return {
    categoria: nombre,
    usuarios: r.idsUsuario.length,
    firebase: emails.filter((e) => fb.includes(e)).length,
    viajes: `${r.idsViaje.length} (${vivos} vivos)`,
    empresas: r.idsEmpresa.length,
    vehiculos: r.idsVehiculo.length,
    pymes: r.idsOrg.length,
  };
}

const vacia = (f) => f.usuarios + f.firebase + f.empresas + f.vehiculos + f.pymes === 0 && f.viajes.startsWith('0 ');

// solo: lista de categorias (null = todas). borrarTodo: borra lo contado.
// Devuelve true si al final no queda nada en las categorias pedidas.
export async function restos({ solo = null, borrarTodo = false } = {}) {
  const fb = await emailsFirebase();
  const cats = (await categorias(fb)).filter((c) => !solo || solo.includes(c.nombre));
  const filas = [];
  for (const c of cats) {
    // Firebase: los huerfanos tambien (borrar() borra por email).
    const r = await resolver(c.entrada);
    r.emails = c.emails;
    filas.push({ c, r, f: await fila(c.nombre, r, fb, c.emails) });
  }
  console.log('\n  Restos (solo conteo' + (borrarTodo ? ', despues se borra' : '') + '):\n');
  console.table(filas.map((x) => x.f));

  if (!borrarTodo) {
    const conAlgo = filas.filter((x) => !vacia(x.f)).map((x) => x.c.nombre);
    console.log(conAlgo.length === 0 ? '  No hay restos.' : `  Con restos: ${conAlgo.join(', ')}. Para borrarlos: --borrar (y --solo para elegir).`);
    return conAlgo.length === 0;
  }

  let ok = true;
  for (const { c, r, f } of filas) {
    if (vacia(f)) continue;
    const b = await borrar(r);
    const v = await contar(r, c.patron ?? (PATRONES.includes(c.nombre) ? c.nombre : null));
    const fbQuedan = c.emails.length > 0 ? (await emailsFirebase()).filter((e) => c.emails.includes(e)).length : 0;
    ok &&= v.ok && fbQuedan === 0;
    console.log(`  ${c.nombre}: borrados ${JSON.stringify(b)} | quedan ${JSON.stringify({ ...v.conteos, firebase: fbQuedan })}`);
  }
  console.log(ok ? '\n  Listo: no quedo nada.' : '\n  ❌ Quedaron restos (ver arriba).');
  return ok;
}

// Ejecucion directa (no cuando una suite lo importa).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--solo');
  const solo = i >= 0 ? process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;
  restos({ solo, borrarTodo: process.argv.includes('--borrar') })
    .then(async (ok) => {
      await cerrarConexiones();
      process.exit(ok ? 0 : 1);
    })
    .catch(async (e) => {
      console.error('💥', e.message);
      await cerrarConexiones();
      process.exit(1);
    });
}
