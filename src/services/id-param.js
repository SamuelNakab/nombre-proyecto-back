// Los ids de la base son Int de Postgres (INT4). Un id fuera de rango (o NaN, o
// "undefined") llegaba a Prisma y daba 500: Prisma no lo puede meter en un INT4 y
// tira PrismaClientValidationError. Por eso el tope.
export const ID_MAX = 2147483647;

// Parsea un :param numerico. Devuelve el entero en 1..ID_MAX o null.
export function idParam(valor) {
  if (typeof valor !== 'string' && typeof valor !== 'number') return null;
  if (typeof valor === 'string' && !/^\d+$/.test(valor.trim())) return null;
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 && n <= ID_MAX ? n : null;
}

