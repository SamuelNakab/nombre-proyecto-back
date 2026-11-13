// CSV minimo (RFC 4180), sin dependencias. PURO.
//   - null / undefined -> celda vacia
//   - objetos -> JSON
//   - un texto con coma, comillas o salto de linea va entre comillas, con las
//     comillas duplicadas
//   - un TEXTO que empieza con = + - @ tab o CR lleva un apostrofe adelante
//     (inyeccion de formulas al abrirlo en una planilla). Los numeros no.
// Lineas separadas por CRLF.

const PELIGROSO = /^[=+\-@\t\r]/;

export function celdaCsv(valor) {
  if (valor === null || valor === undefined) return '';
  if (valor instanceof Date) return valor.toISOString();
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  let texto = typeof valor === 'object' ? JSON.stringify(valor) : String(valor);
  if (typeof valor === 'string' && PELIGROSO.test(texto)) texto = `'${texto}`;
  return /[",\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

// filas: [{...}]; columnas: nombres en orden (el encabezado).
export function aCsv(filas, columnas) {
  const lineas = [columnas.map(celdaCsv).join(',')];
  for (const fila of filas) lineas.push(columnas.map((c) => celdaCsv(fila[c])).join(','));
  return lineas.join('\r\n') + '\r\n';
}
