// Runner para los 4 tests de stress.
// Uso: node scripts/stress/run-all.js
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TESTS = [
  'test-vehiculos-exhaustivo.js',
  'test-gps-exhaustivo.js',
  'test-cierre-exhaustivo.js',
  'test-concurrencia.js',
];

function correr(script) {
  return new Promise((resolve) => {
    const p = spawn('node', [join(__dirname, script)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    p.stdout.on('data', (c) => { out += c.toString(); process.stdout.write(c); });
    p.stderr.on('data', (c) => { process.stderr.write(c); });
    p.on('close', () => {
      const idx = out.lastIndexOf('__RESULT_JSON__');
      if (idx === -1) return resolve({ nombre: script, error: 'sin resultado', total: 0, ok: 0, bugs: [], huecos: [], todos: [] });
      try { resolve(JSON.parse(out.slice(idx + '__RESULT_JSON__'.length).trim())); }
      catch (e) { resolve({ nombre: script, error: e.message, total: 0, ok: 0, bugs: [], huecos: [], todos: [] }); }
    });
  });
}

const resultados = [];
for (const t of TESTS) {
  console.log(`\n\n>>> Corriendo ${t}\n`);
  resultados.push(await correr(t));
}

// Render REPORTE.md
const lines = [];
lines.push('# Reporte de stress tests — Fleter backend\n');
lines.push(`Fecha: ${new Date().toISOString()}\n`);

const totalTests = resultados.reduce((a, r) => a + r.total, 0);
const totalOk = resultados.reduce((a, r) => a + r.ok, 0);
const totalBugs = resultados.reduce((a, r) => a + r.bugs.length, 0);
const totalHuecos = resultados.reduce((a, r) => a + r.huecos.length, 0);

lines.push('## Resumen\n');
lines.push(`- ${totalTests} tests corridos`);
lines.push(`- ${totalOk} pasaron`);
lines.push(`- ${totalBugs} bugs`);
lines.push(`- ${totalHuecos} huecos conocidos / comportamientos no definidos\n`);

for (const r of resultados) {
  lines.push(`## ${r.nombre}\n`);
  lines.push('| # | Caso | Resultado |');
  lines.push('|---|------|-----------|');
  r.todos.forEach((p, i) => {
    const icono = p.ok ? '✅' : (p.categoria === 'hueco' ? '⚠️' : '❌');
    const detalle = p.detalle ? ` — ${p.detalle.replace(/\|/g, '\\|')}` : '';
    lines.push(`| ${i + 1} | ${p.nombre.replace(/\|/g, '\\|')} | ${icono}${detalle} |`);
  });
  lines.push('');
}

const reportPath = join(__dirname, 'REPORTE.md');
writeFileSync(reportPath, lines.join('\n'), 'utf8');
console.log(`\n\nReporte escrito en ${reportPath}`);
console.log(`\n${totalOk}/${totalTests} ok | ${totalBugs} bugs | ${totalHuecos} huecos`);
process.exit(totalBugs === 0 ? 0 : 1);
