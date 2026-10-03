// Validacion de CUIT/CUIL argentino.
//
// Se normaliza sacando guiones y espacios ("30-71234567-1" -> "30712345671") y
// se guarda SIEMPRE normalizado, asi la unicidad entre PyMEs (que valida
// organizacion.service.js) compara peras con peras.

const MULTIPLICADORES = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

export function normalizarCuit(raw) {
  return String(raw ?? '').replace(/[-\s]/g, '');
}

// Digito verificador: suma ponderada de los 10 primeros digitos, mod 11.
// 11 - resto; si da 11 el digito es 0, y si da 10 el CUIT no es valido (AFIP
// nunca emite esos: cambia el prefijo a 23/33 y recalcula).
export function digitoVerificador(primeros10) {
  const suma = MULTIPLICADORES.reduce((acc, m, i) => acc + m * Number(primeros10[i]), 0);
  const dv = 11 - (suma % 11);
  if (dv === 11) return 0;
  if (dv === 10) return null;
  return dv;
}

// -> { ok: true, cuit } con el CUIT normalizado, o { ok: false, error }.
// Formato y digito tienen mensajes distintos a proposito: el front puede
// distinguir "te falto un numero" de "te equivocaste en uno".
export function validarCuit(raw) {
  const cuit = normalizarCuit(raw);
  if (!/^\d{11}$/.test(cuit)) {
    return { ok: false, error: 'CUIT con formato invalido: deben ser 11 digitos' };
  }
  const dv = digitoVerificador(cuit.slice(0, 10));
  if (dv === null || dv !== Number(cuit[10])) {
    return { ok: false, error: 'CUIT con digito verificador invalido' };
  }
  return { ok: true, cuit };
}
