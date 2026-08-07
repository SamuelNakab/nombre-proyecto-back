import { randomInt } from 'crypto';
import prisma from '../config/prisma.js';
import { validarTransicion } from './estado-viaje.service.js';
import { io } from '../sockets/index.js';

// ─── Codigo de afiliacion ────────────────────────────────────────────────────

// Alfabeto sin caracteres ambiguos (0/O, 1/I/L) para que el codigo sea facil de
// dictar y tipear.
const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LARGO_CODIGO = 8;

function generarCodigo() {
  let codigo = '';
  for (let i = 0; i < LARGO_CODIGO; i++) {
    codigo += ALFABETO_CODIGO[randomInt(ALFABETO_CODIGO.length)];
  }
  return codigo;
}

// Genera un codigo_afiliacion unico. Reintenta ante una colision (muy improbable
// con 31^8 combinaciones) y se rinde tras varios intentos para no colgar.
export async function generarCodigoUnico() {
  for (let intento = 0; intento < 10; intento++) {
    const codigo = generarCodigo();
    const existe = await prisma.empresa.findUnique({
      where: { codigo_afiliacion: codigo },
    });
    if (!existe) return codigo;
  }
  throw new Error('No se pudo generar un codigo de afiliacion unico');
}

// ─── Desafiliacion ───────────────────────────────────────────────────────────

// Estados en los que el viaje ya arranco: no se puede desafiliar al conductor.
const ESTADOS_EN_CURSO = ['EN_CAMINO_A_ORIGEN', 'CARGANDO', 'EN_RUTA', 'DESCARGANDO'];

// Corta el vinculo conductor<->empresa aplicando las reglas de CLAUDE.md:
// - Si hay un viaje EN CURSO de esa empresa con ese conductor -> no se permite.
// - Los viajes CONDUCTOR_ASIGNADO (sin iniciar) de esa empresa vuelven a
//   RESERVADO_POR_EMPRESA, liberando conductor y vehiculo para reasignar.
// - La afiliacion se marca de baja (fecha_baja), conservando el historial. El
//   vinculo se puede reactivar mas adelante volviendo a ingresar el codigo.
//
// Devuelve { ok: false, error } si hay un viaje en curso (el caller responde
// 400) o { ok: true, viajes_devueltos: [...] } si se ejecuto la baja.
export async function ejecutarDesafiliacion(id_conductor, id_empresa) {
  const enCurso = await prisma.viaje.count({
    where: { id_conductor, id_empresa, estado: { in: ESTADOS_EN_CURSO } },
  });
  if (enCurso > 0) {
    return {
      ok: false,
      error: 'No se puede desafiliar: el conductor tiene un viaje en curso de esta empresa',
    };
  }

  const asignados = await prisma.viaje.findMany({
    where: { id_conductor, id_empresa, estado: 'CONDUCTOR_ASIGNADO' },
    select: { id_viaje: true, estado: true },
  });

  await prisma.$transaction(async (tx) => {
    for (const viaje of asignados) {
      // Defensivo: la transicion siempre es valida aca (CONDUCTOR_ASIGNADO ->
      // RESERVADO_POR_EMPRESA), pero pasamos por la maquina de estados igual.
      validarTransicion(viaje.estado, 'RESERVADO_POR_EMPRESA');
      await tx.viaje.update({
        where: { id_viaje: viaje.id_viaje },
        data: {
          estado: 'RESERVADO_POR_EMPRESA',
          id_conductor: null,
          id_vehiculo: null,
          fecha_reserva: new Date(),
        },
      });
    }

    await tx.conductorEmpresa.update({
      where: { id_conductor_id_empresa: { id_conductor, id_empresa } },
      data: { fecha_baja: new Date() },
    });
  });

  // Ya commiteada la baja: avisar al gerente que cada viaje devuelto necesita
  // reasignacion. Es un evento propio, distinto del timeout / cancelacion manual
  // de reserva: aca el viaje YA estaba asignado y volvio por una desafiliacion.
  if (io && asignados.length > 0) {
    const empresa = await prisma.empresa.findUnique({
      where: { id_empresa },
      select: { id_gerente: true },
    });
    if (empresa) {
      for (const viaje of asignados) {
        io.to(`usuario:${empresa.id_gerente}`).emit('viaje:requiere_reasignacion', {
          id_viaje: viaje.id_viaje,
          id_empresa,
          motivo: 'conductor_desafiliado',
        });
      }
    }
  }

  return { ok: true, viajes_devueltos: asignados.map((v) => v.id_viaje) };
}
