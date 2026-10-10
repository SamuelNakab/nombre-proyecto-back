// FECHAS de una serie de viajes (Paso 4). Todo PURO: `ahora`, la anticipacion
// y la zona horaria se inyectan, asi se testea sin reloj, sin .env y sin red.
//
// La serie se piensa en HORA LOCAL ARGENTINA: "todos los dias a las 9:00" son las
// 9:00 de Buenos Aires, no las 9:00 UTC. fecha_desde / fecha_hasta son fechas
// del calendario local ("YYYY-MM-DD") y la hora es "HH:MM" local. Cada
// ocurrencia se convierte a un instante UTC con localAUtc, que no depende de que
// Argentina no tenga horario de verano hoy: calcula el offset de la zona con
// Intl para ESE instante.
//
// Reglas:
//   - Ventana: [fecha_desde, fecha_hasta] INCLUSIVA, con fecha_hasta <=
//     fecha_desde + 30 dias (default). DIARIA da como maximo 31 ocurrencias.
//   - fecha_desde entre hoy (local) y hoy + 90 dias.
//   - Una ocurrencia que no cumple la anticipacion minima (la MISMA regla que
//     crear un viaje: fecha <= ahora + ANTICIPACION_MINIMA_MINUTOS) se SALTEA
//     con su motivo: PASADA (ya paso) o SIN_ANTICIPACION.
//   - MENSUAL con dia_mes 29-31 en un mes que no lo tiene: se AJUSTA al ultimo
//     dia del mes y la ocurrencia queda marcada con ajuste 'FIN_DE_MES'. "El 31
//     de cada mes" en logistica quiere decir "a fin de mes"; saltear el mes
//     dejaria un hueco en silencio.
//   - Dias de la semana en ISO: 1 = lunes ... 7 = domingo.

export const ZONA_HORARIA = 'America/Argentina/Buenos_Aires';
export const VENTANA_SERIE_DIAS = 30;
export const MAX_VIAJES_POR_SERIE = VENTANA_SERIE_DIAS + 1;
export const MAX_DIAS_HASTA_INICIO = 90;
export const FRECUENCIAS = ['DIARIA', 'DIAS_SEMANA', 'SEMANAL', 'MENSUAL'];

const RE_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ─── Fechas del calendario (sin zona) ────────────────────────────────────────

// "YYYY-MM-DD" -> { anio, mes, dia }, o null si no es una fecha real (2026-02-30).
export function parsearFecha(texto) {
  const m = RE_FECHA.exec(texto ?? '');
  if (!m) return null;
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > diasDelMes(anio, mes)) return null;
  return { anio, mes, dia };
}

export const esFechaValida = (texto) => parsearFecha(texto) !== null;
export const esHoraValida = (texto) => RE_HORA.test(texto ?? '');

const dos = (n) => String(n).padStart(2, '0');
export const formatearFecha = ({ anio, mes, dia }) => `${anio}-${dos(mes)}-${dos(dia)}`;

export function diasDelMes(anio, mes) {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

// Aritmetica de calendario sobre UTC: un dia del calendario es siempre un dia,
// sin importar la zona.
export function sumarDias(fecha, n) {
  const d = new Date(Date.UTC(fecha.anio, fecha.mes - 1, fecha.dia + n));
  return { anio: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}

// 1 = lunes ... 7 = domingo. El dia de la semana de una fecha del calendario no
// depende de la zona.
export function diaSemanaIso(fecha) {
  const d = new Date(Date.UTC(fecha.anio, fecha.mes - 1, fecha.dia)).getUTCDay();
  return d === 0 ? 7 : d;
}

const comparar = (a, b) => formatearFecha(a).localeCompare(formatearFecha(b));

// ─── Zona horaria ────────────────────────────────────────────────────────────

const formateadores = new Map();
function formateador(tz) {
  if (!formateadores.has(tz)) {
    formateadores.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
    );
  }
  return formateadores.get(tz);
}

// Fecha y hora locales de un instante en la zona tz.
export function partesLocales(instante, tz = ZONA_HORARIA) {
  const partes = {};
  for (const { type, value } of formateador(tz).formatToParts(new Date(instante))) {
    partes[type] = value;
  }
  return {
    anio: Number(partes.year),
    mes: Number(partes.month),
    dia: Number(partes.day),
    hora: Number(partes.hour),
    minuto: Number(partes.minute),
    segundo: Number(partes.second),
  };
}

// Offset de la zona en ese instante, en ms (Buenos Aires: -3 h).
function offsetMs(instanteMs, tz) {
  const p = partesLocales(instanteMs, tz);
  const comoUtc = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return comoUtc - Math.floor(instanteMs / 1000) * 1000;
}

// Fecha + hora LOCALES de la zona -> instante (Date, UTC). Dos pasadas: la
// primera estima el offset con la hora "ingenua"; si en el instante resultante
// el offset es otro (un cambio de horario en el medio), se recalcula con ese.
export function localAUtc({ anio, mes, dia, hora, minuto }, tz = ZONA_HORARIA) {
  const ingenuo = Date.UTC(anio, mes - 1, dia, hora, minuto);
  const primero = offsetMs(ingenuo, tz);
  let instante = ingenuo - primero;
  const segundo = offsetMs(instante, tz);
  if (segundo !== primero) instante = ingenuo - segundo;
  return new Date(instante);
}

// La fecha local de "hoy" en la zona.
export const hoyLocal = (ahora, tz = ZONA_HORARIA) => {
  const p = partesLocales(ahora, tz);
  return { anio: p.anio, mes: p.mes, dia: p.dia };
};

// ─── Ventana de la serie ─────────────────────────────────────────────────────

// Valida la ventana y completa fecha_hasta. Devuelve { fecha_desde, fecha_hasta }
// como "YYYY-MM-DD", o { error } con el mensaje para el 400.
export function resolverVentana({ fecha_desde, fecha_hasta, ahora, tz = ZONA_HORARIA }) {
  const desde = parsearFecha(fecha_desde);
  if (!desde) return { error: 'fecha_desde debe ser una fecha YYYY-MM-DD valida' };

  const hoy = hoyLocal(ahora, tz);
  if (comparar(desde, hoy) < 0) return { error: 'fecha_desde no puede ser anterior a hoy' };
  if (comparar(desde, sumarDias(hoy, MAX_DIAS_HASTA_INICIO)) > 0) {
    return { error: `fecha_desde no puede ser mas de ${MAX_DIAS_HASTA_INICIO} dias despues de hoy` };
  }

  const maximo = sumarDias(desde, VENTANA_SERIE_DIAS);
  let hasta = maximo;
  if (fecha_hasta !== undefined && fecha_hasta !== null) {
    hasta = parsearFecha(fecha_hasta);
    if (!hasta) return { error: 'fecha_hasta debe ser una fecha YYYY-MM-DD valida' };
    if (comparar(hasta, desde) < 0) return { error: 'fecha_hasta no puede ser anterior a fecha_desde' };
    if (comparar(hasta, maximo) > 0) {
      return { error: `fecha_hasta puede ser como maximo ${VENTANA_SERIE_DIAS} dias despues de fecha_desde` };
    }
  }
  return { fecha_desde: formatearFecha(desde), fecha_hasta: formatearFecha(hasta) };
}

// ─── Ocurrencias ─────────────────────────────────────────────────────────────

function coincide(fecha, { frecuencia, dias_semana, dia_semana, dia_mes }) {
  switch (frecuencia) {
    case 'DIARIA':
      return { si: true };
    case 'DIAS_SEMANA':
      return { si: dias_semana.includes(diaSemanaIso(fecha)) };
    case 'SEMANAL':
      return { si: diaSemanaIso(fecha) === dia_semana };
    case 'MENSUAL': {
      const ultimo = diasDelMes(fecha.anio, fecha.mes);
      const objetivo = Math.min(dia_mes, ultimo);
      return { si: fecha.dia === objetivo, ajuste: dia_mes > ultimo ? 'FIN_DE_MES' : null };
    }
    default:
      throw new Error(`Frecuencia desconocida: ${frecuencia}`);
  }
}

// Devuelve:
//   ocurrencias: [{ fecha: 'YYYY-MM-DD', fecha_programada: Date, ajuste? }]
//   salteadas:   [{ fecha, fecha_programada, motivo: 'PASADA' | 'SIN_ANTICIPACION' }]
// fecha_desde y fecha_hasta ya validadas (resolverVentana).
export function generarOcurrencias({
  frecuencia,
  dias_semana = [],
  dia_semana = null,
  dia_mes = null,
  hora,
  fecha_desde,
  fecha_hasta,
  ahora,
  anticipacionMinutos,
  tz = ZONA_HORARIA,
}) {
  if (!esHoraValida(hora)) throw new Error(`generarOcurrencias: hora invalida "${hora}"`);
  const desde = parsearFecha(fecha_desde);
  const hasta = parsearFecha(fecha_hasta);
  if (!desde || !hasta) throw new Error('generarOcurrencias: ventana invalida');

  const [hh, mm] = hora.split(':').map(Number);
  const ahoraMs = new Date(ahora).getTime();
  const minimoMs = ahoraMs + anticipacionMinutos * 60_000;
  const regla = { frecuencia, dias_semana, dia_semana, dia_mes };

  const ocurrencias = [];
  const salteadas = [];
  for (let fecha = desde; comparar(fecha, hasta) <= 0; fecha = sumarDias(fecha, 1)) {
    const { si, ajuste } = coincide(fecha, regla);
    if (!si) continue;

    const fecha_programada = localAUtc({ ...fecha, hora: hh, minuto: mm }, tz);
    const texto = formatearFecha(fecha);
    const t = fecha_programada.getTime();
    // Misma comparacion que schemaFechaProgramada: date <= minimo se rechaza.
    if (t <= ahoraMs) {
      salteadas.push({ fecha: texto, fecha_programada, motivo: 'PASADA' });
    } else if (t <= minimoMs) {
      salteadas.push({ fecha: texto, fecha_programada, motivo: 'SIN_ANTICIPACION' });
    } else {
      ocurrencias.push({ fecha: texto, fecha_programada, ...(ajuste ? { ajuste } : {}) });
    }
  }

  // Defensivo: la ventana ya lo garantiza (31 dias como maximo).
  if (ocurrencias.length > MAX_VIAJES_POR_SERIE) {
    throw new Error(`generarOcurrencias: ${ocurrencias.length} ocurrencias superan el tope de ${MAX_VIAJES_POR_SERIE}`);
  }
  return { ocurrencias, salteadas };
}
