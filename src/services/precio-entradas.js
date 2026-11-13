// ENTRADAS del precio v2 (PURO, salvo el poligono de CABA de zona.service, que es
// un calculo sobre un archivo fijo). Separa "que se declaro" (lo que se guarda en
// el viaje, null = no declarado) de "que se uso" (lo que entra en la formula y
// queda en el snapshot).
//
//   ESTIMADO  km_ida = suma de distancias de los tramos de Routes (sin vuelta)
//             horas  = manejo con transito + PRECIO_MINUTOS_POR_PARADA x paradas
//             (distinto de TIEMPO_PEON_MINUTOS, que sigue siendo de la duracion)
//   MEDIDO    horas  = reloj real: llegada a la parada 1 -> instante de corte
//             km_ida = GPS hasta el corte, con fallback (ver kmMedidos)
//   el resto (servicio, ayudantes, provincia, paradas extra, escalera, factura A,
//   peajes) sale del SNAPSHOT del estimado.
import { contarParadasPorZona } from './zona.service.js';

export const SERVICIO_DEFAULT = 'LIVIANO';
export const ACCESO_DEFAULT = 'PLANTA_BAJA';
const HORA_MS = 3_600_000;

export const servicioEfectivo = (tipo_servicio) => tipo_servicio ?? SERVICIO_DEFAULT;

// EQUIPO lleva siempre PRECIO_EQUIPO_AYUDANTES; el resto, lo declarado o 0.
export function ayudantesEfectivos(servicio, ayudantes, p) {
  return servicio === 'EQUIPO' ? p.PRECIO_EQUIPO_AYUDANTES : (ayudantes ?? 0);
}

export const accesoEfectivo = (parada) => parada?.acceso ?? ACCESO_DEFAULT;
export const hayEscalera = (paradas) => paradas.some((p) => accesoEfectivo(p) === 'ESCALERA');

// Factura A: la del viaje; si no vino, la de la organizacion; si tampoco, false.
export function elegirFacturaA(declarada, porDefectoOrganizacion) {
  if (declarada === true || declarada === false) return { valor: declarada, fuente: 'VIAJE' };
  if (porDefectoOrganizacion === true || porDefectoOrganizacion === false) {
    return { valor: porDefectoOrganizacion, fuente: 'ORGANIZACION' };
  }
  return { valor: false, fuente: 'DEFAULT' };
}

// Peajes del calculo: lo declarado por la PyME (total del viaje, ida y vuelta);
// si no, lo de Google (no implementado: Enterprise); si no, 0.
export function elegirPeajes(declaradosPyme, google = null) {
  if (declaradosPyme != null) return { monto: declaradosPyme, fuente: 'PYME' };
  if (google != null) return { monto: google, fuente: 'GOOGLE' };
  return { monto: 0, fuente: 'NINGUNA' };
}

// Validaciones de negocio de la Parte B sobre el ESTADO RESULTANTE (lo declarado
// mas las paradas ya resueltas, con el acceso copiado de los lugares). Devuelve
// el mensaje del 400 o null.
export function validarDatosPrecio({ tipo_servicio, ayudantes, paradas }, p) {
  const servicio = servicioEfectivo(tipo_servicio);
  if (servicio === 'EQUIPO') {
    if (ayudantes != null && ayudantes !== p.PRECIO_EQUIPO_AYUDANTES) {
      return `Con el servicio EQUIPO los ayudantes son siempre ${p.PRECIO_EQUIPO_AYUDANTES}`;
    }
  } else if (ayudantes != null && ayudantes > p.PRECIO_AYUDANTES_MAX) {
    return `Con el servicio ${servicio} los ayudantes pueden ser como máximo ${p.PRECIO_AYUDANTES_MAX}`;
  }
  if (
    hayEscalera(paradas ?? []) &&
    servicio !== 'EQUIPO' &&
    ayudantesEfectivos(servicio, ayudantes, p) < 1
  ) {
    return 'Si alguna parada tiene acceso por escalera, el viaje necesita al menos 1 ayudante o el servicio EQUIPO';
  }
  return null;
}

// Lo DECLARADO por la PyME que se guarda en el viaje (y en la serie). null = no
// declarado.
export const CAMPOS_DECLARADOS = [
  'tipo_servicio',
  'ayudantes',
  'factura_a',
  'peajes_estimados',
  'tipo_carga',
  'bultos',
  'peso_kg',
  'volumen_m3',
  'pallets',
  'valor_declarado',
];
// Los que cambian el precio (los de carga se guardan pero no entran).
export const CAMPOS_DECLARADOS_PRECIO = ['tipo_servicio', 'ayudantes', 'factura_a', 'peajes_estimados'];

export function declaradosDe(fuente) {
  const out = {};
  for (const c of CAMPOS_DECLARADOS) out[c] = fuente?.[c] ?? null;
  return out;
}

// Entradas del ESTIMADO.
//   paradas: [{ lat, lng } o { latitud, longitud }, acceso? ] (ya resueltas)
//   manejo_horas / distancia_km: totales del recorrido de Routes
//   declarados: { tipo_servicio, ayudantes, factura_a, peajes_estimados }
//   facturaAOrganizacion: Organizacion.factura_a_por_defecto (o null)
// Devuelve { entradas (las de la formula), snapshot (version, parametros,
// entradas y declarados: lo que se guarda en Viaje.precio_parametros) }.
export function entradasEstimado({ paradas, manejo_horas, distancia_km, declarados, facturaAOrganizacion }, p) {
  const servicio = servicioEfectivo(declarados.tipo_servicio);
  const cantidad = paradas.length;
  const factura = elegirFacturaA(declarados.factura_a, facturaAOrganizacion);
  const peajes = elegirPeajes(declarados.peajes_estimados);
  const entradas = {
    km_ida: distancia_km,
    horas: manejo_horas + (p.PRECIO_MINUTOS_POR_PARADA * cantidad) / 60,
    manejo_horas,
    cantidad_paradas: cantidad,
    servicio,
    ayudantes: ayudantesEfectivos(servicio, declarados.ayudantes, p),
    provincia: contarParadasPorZona(paradas).fuera_caba > 0,
    paradas_extra: Math.max(0, cantidad - 2),
    escalera: hayEscalera(paradas),
    factura_a: factura.valor,
    fuente_factura_a: factura.fuente,
    peajes: peajes.monto,
    fuente_peajes: peajes.fuente,
  };
  return {
    entradas,
    snapshot: {
      version: 2,
      parametros: { ...p },
      entradas,
      declarados: {
        tipo_servicio: declarados.tipo_servicio ?? null,
        ayudantes: declarados.ayudantes ?? null,
        factura_a: declarados.factura_a ?? null,
        factura_a_organizacion: facturaAOrganizacion ?? null,
        peajes_estimados: declarados.peajes_estimados ?? null,
      },
    },
  };
}

// Suma de distancia_estimada_km de los tramos hasta la ULTIMA parada con
// llegada_real (la parada 1 no tiene tramo que llegue). Para los cierres
// incompletos.
export function kmEstimadosHastaUltimaLlegada(paradas) {
  const ordenadas = [...paradas].sort((a, b) => a.orden - b.orden);
  let ultimo = -1;
  ordenadas.forEach((pa, i) => {
    if (pa.llegada_real) ultimo = i;
  });
  let km = 0;
  for (let i = 1; i <= ultimo; i++) km += ordenadas[i].distancia_estimada_km ?? 0;
  return km;
}

// km del MEDIDO con el fallback de GPS: se usa la distancia GPS salvo que la
// medicion no sea confiable (menos de PRECIO_GPS_MIN_PUNTOS pings, o menos del
// PRECIO_GPS_DISTANCIA_MIN_PORCENTAJE % de la referencia). Referencia y fallback:
//   - incompleto (paradas sin visitar, AUTOMATICO en EN_RUTA, cancelado en curso):
//     los km estimados hasta la ultima parada con llegada -> ESTIMADA_PARCIAL
//   - si no: los km estimados del snapshot -> ESTIMADA
export function kmMedidos({ kmGps, pings, kmEstimadosTotal, kmEstimadosParcial, incompleto }, p) {
  const referencia = incompleto ? kmEstimadosParcial : kmEstimadosTotal;
  const confiable =
    (pings ?? 0) >= p.PRECIO_GPS_MIN_PUNTOS && (kmGps ?? 0) >= (referencia * p.PRECIO_GPS_DISTANCIA_MIN_PORCENTAJE) / 100;
  if (confiable) return { km_ida: kmGps, fuente_km: 'GPS', referencia_km: referencia };
  return { km_ida: referencia, fuente_km: incompleto ? 'ESTIMADA_PARCIAL' : 'ESTIMADA', referencia_km: referencia };
}

// Entradas del MEDIDO (cierre, cancelacion en curso) y del VIVO.
//   snapshot: Viaje.precio_parametros
//   inicio: llegada a la parada 1; corte: instante de corte (o ahora, en vivo)
//   medicion: { distancia_km, pings, sin_pings } hasta el corte
//   paradas: [{ orden, llegada_real, distancia_estimada_km }] (para la parcial)
//   incompleto: ver kmMedidos. En vivo siempre false (estimada completa).
export function entradasMedido({ snapshot, inicio, corte, medicion, paradas, incompleto }) {
  const p = snapshot.parametros;
  const horas = inicio ? Math.max(0, (new Date(corte).getTime() - new Date(inicio).getTime()) / HORA_MS) : 0;
  const km = kmMedidos(
    {
      kmGps: medicion?.sin_pings ? 0 : (medicion?.distancia_km ?? 0),
      pings: medicion?.pings ?? 0,
      kmEstimadosTotal: snapshot.entradas.km_ida,
      kmEstimadosParcial: incompleto ? kmEstimadosHastaUltimaLlegada(paradas ?? []) : 0,
      incompleto,
    },
    p
  );
  return {
    ...snapshot.entradas,
    horas,
    km_ida: km.km_ida,
    fuente_km: km.fuente_km,
    km_gps: medicion?.sin_pings ? null : (medicion?.distancia_km ?? null),
    pings: medicion?.pings ?? 0,
    referencia_km: km.referencia_km,
    km_estimados: snapshot.entradas.km_ida,
    horas_estimadas: snapshot.entradas.horas,
  };
}
