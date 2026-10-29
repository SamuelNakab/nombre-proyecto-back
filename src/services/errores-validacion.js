import { z } from 'zod';

// Mensajes de validacion en español, con el nombre del campo (Tarea 6).
//
// Se instala como `customError` GLOBAL de Zod 4. Zod lo consulta SOLO cuando el
// schema no trae su propio mensaje (finalizeIssue: mensaje del schema > ctx >
// customError > locale), asi que los mensajes en español que ya existen ("motivo
// es requerido", "id_lugar invalido", el de fecha_programada...) no cambian: el
// front y el simulador dependen de ellos. Recibe el issue con el path COMPLETO
// (se finaliza al terminar el parse, despues de prefixIssues).
//
// Basta con importar este modulo antes de parsear: app.js lo importa antes que
// las rutas, y todo controller que responde un 400 lo importa por responder400.

const TIPOS = {
  string: 'texto',
  number: 'un número',
  int: 'un número entero',
  bigint: 'un número entero',
  boolean: 'verdadero o falso',
  array: 'una lista',
  object: 'un objeto',
  date: 'una fecha',
};

const UNIDADES = { string: 'caracteres', array: 'elementos', set: 'elementos', file: 'bytes' };

const FORMATOS = {
  email: 'un email válido',
  datetime: 'una fecha ISO válida',
  date: 'una fecha válida (AAAA-MM-DD)',
  time: 'una hora válida',
  url: 'una URL válida',
  uuid: 'un UUID válido',
  regex: 'un valor con el formato esperado',
};

// ['paradas', 0, 'lat'] -> 'paradas[0].lat'
export function nombreCampo(path = []) {
  return path.reduce((acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p)), '');
}

const valor = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

export function mensajeEnEspanol(iss) {
  const campo = nombreCampo(iss.path);
  const el = campo ? `El campo ${campo}` : null;

  switch (iss.code) {
    case 'invalid_type': {
      if (!el) return 'El cuerpo de la solicitud debe ser un objeto JSON';
      if (iss.input === undefined) return `${el} es obligatorio`;
      return `${el} debe ser ${TIPOS[iss.expected] ?? 'de otro tipo'}`;
    }
    case 'too_small': {
      if (!el) return 'La solicitud es inválida';
      const n = Number(iss.minimum);
      if (iss.origin === 'string' && n === 1) return `${el} no puede estar vacío`;
      if (UNIDADES[iss.origin]) return `${el} debe tener al menos ${n} ${UNIDADES[iss.origin]}`;
      return `${el} debe ser ${iss.inclusive === false ? 'mayor a' : 'mayor o igual a'} ${n}`;
    }
    case 'too_big': {
      if (!el) return 'La solicitud es inválida';
      const n = Number(iss.maximum);
      if (UNIDADES[iss.origin]) return `${el} puede tener como máximo ${n} ${UNIDADES[iss.origin]}`;
      return `${el} debe ser ${iss.inclusive === false ? 'menor a' : 'menor o igual a'} ${n}`;
    }
    case 'invalid_format':
      return `${el ?? 'El valor'} debe ser ${FORMATOS[iss.format] ?? 'un valor con el formato esperado'}`;
    case 'invalid_value':
      return `${el ?? 'El valor'} debe ser ${iss.values?.length === 1 ? valor(iss.values[0]) : `uno de: ${(iss.values ?? []).map(valor).join(', ')}`}`;
    case 'not_multiple_of':
      return `${el ?? 'El valor'} debe ser múltiplo de ${iss.divisor}`;
    case 'unrecognized_keys':
      return `${campo ? `En ${campo}: c` : 'C'}ampos no permitidos: ${(iss.keys ?? []).join(', ')}`;
    default:
      return `${el ?? 'La solicitud'} es inválid${el ? 'o' : 'a'}`;
  }
}

z.config({ customError: mensajeEnEspanol });

// El primer issue, como hacian los controllers con issues[0].message.
export function mensajeValidacion(zodError) {
  return zodError?.issues?.[0]?.message ?? 'La solicitud es inválida';
}

// 400 de validacion con el formato de siempre: { error: "mensaje" }.
export function responder400(res, parsed) {
  return res.status(400).json({ error: mensajeValidacion(parsed.error) });
}
