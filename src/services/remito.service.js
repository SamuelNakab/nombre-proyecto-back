import PDFDocument from 'pdfkit';
import prisma from '../config/prisma.js';
import { subirArchivo } from '../config/storage.js';

export async function generarRemito(id_viaje) {
  const viaje = await prisma.viaje.findUnique({
    where: { id_viaje },
    include: {
      paradas: { orderBy: { orden: 'asc' } },
      conductor: { include: { usuario: true } },
      cliente: { include: { usuario: true } },
      // Viaje INTERNO: el remito muestra la PyME (nombre y CUIT), no el cliente.
      organizacion: { select: { nombre: true, cuit: true, razon_social: true } },
      vehiculo: true,
    },
  });

  const buffer = await generarPDF(viaje);
  const key = `remitos/${id_viaje}.pdf`;
  const url = await subirArchivo(buffer, key, 'application/pdf');
  return url;
}

function formatFecha(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
}

// CUIT normalizado (11 digitos) -> XX-XXXXXXXX-X. Si no tiene 11 digitos se
// devuelve tal cual.
export function formatearCuit(cuit) {
  if (!cuit || !/^\d{11}$/.test(cuit)) return cuit ?? '';
  return `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`;
}

// Quien pidio el viaje, para el encabezado del remito. PURA, para poder
// testearla sin generar ni parsear el PDF.
//   - Viaje de PyME (ciclo interno): titulo PYME, con nombre, CUIT y razon
//     social. El creador del viaje NO aparece: el remito es de la PyME.
//   - Viaje legacy: titulo CLIENTE, como siempre.
export function bloqueSolicitante(viaje) {
  if (viaje.organizacion) {
    const org = viaje.organizacion;
    const lineas = [`Nombre: ${org.nombre}`, `CUIT: ${formatearCuit(org.cuit)}`];
    if (org.razon_social) lineas.push(`Razón social: ${org.razon_social}`);
    return { titulo: 'PYME', lineas };
  }

  const cliente = viaje.cliente?.usuario;
  const lineas = [];
  if (cliente) {
    lineas.push(`Nombre: ${cliente.nombre} ${cliente.apellido}`);
    if (viaje.cliente.nombre_empresa) lineas.push(`Empresa: ${viaje.cliente.nombre_empresa}`);
    if (cliente.telefono) lineas.push(`Teléfono: ${cliente.telefono}`);
  }
  return { titulo: 'CLIENTE', lineas };
}

function formatPeso(n) {
  if (n == null) return '—';
  return '$' + Number(n).toFixed(2);
}

async function generarPDF(viaje) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 100; // ancho util

    // ── Encabezado ──
    doc.fontSize(18).font('Helvetica-Bold').text('Remito de entrega — Fleter', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').text(
      `Viaje #${viaje.id_viaje}   |   ${formatFecha(viaje.creado_en)}`,
      { align: 'center' }
    );
    doc.moveDown(0.8);
    doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).stroke();
    doc.moveDown(0.8);

    // ── Solicitante: la PyME (viaje interno) o el cliente (legacy) ──
    const solicitante = bloqueSolicitante(viaje);
    doc.fontSize(11).font('Helvetica-Bold').text(solicitante.titulo);
    doc.fontSize(10).font('Helvetica');
    for (const linea of solicitante.lineas) doc.text(linea);
    doc.moveDown(0.8);

    // ── Conductor ──
    const conductor = viaje.conductor?.usuario;
    doc.fontSize(11).font('Helvetica-Bold').text('CONDUCTOR');
    doc.fontSize(10).font('Helvetica');
    if (conductor) {
      doc.text(`Nombre: ${conductor.nombre} ${conductor.apellido}`);
    }
    if (viaje.vehiculo) {
      doc.text(`Vehículo: ${viaje.vehiculo.patente} — ${viaje.vehiculo.marca} ${viaje.vehiculo.modelo}`);
    }
    doc.moveDown(0.8);

    // ── Descripcion ──
    if (viaje.descripcion) {
      doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).stroke();
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica-Bold').text('DESCRIPCIÓN');
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').text(viaje.descripcion);
      doc.moveDown(0.8);
    }

    // ── Paradas ──
    doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).stroke();
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica-Bold').text('PARADAS');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica');

    for (const p of viaje.paradas) {
      const estadoStr = p.estado === 'ENTREGADO' ? '✓ ENTREGADO' : '○ PENDIENTE';
      const fechaStr = p.fecha_entrega ? formatFecha(p.fecha_entrega) : '';
      doc.text(
        `${p.orden}.  ${p.direccion}`,
        { continued: false }
      );
      doc.fontSize(9).fillColor('#555555').text(
        `     ${estadoStr}${fechaStr ? '   ' + fechaStr : ''}`,
        { indent: 0 }
      );
      doc.fillColor('#000000').fontSize(10);
      doc.moveDown(0.2);
    }
    doc.moveDown(0.5);

    // ── Desglose de costo ──
    doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).stroke();
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica-Bold').text('DESGLOSE DE COSTO');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica');

    if (viaje.zona === 'CABA' || viaje.zona === 'MIXTO') {
      const t = viaje.tiempo_capital ?? 0;
      const tarifa = viaje.tarifa_hora ?? 0;
      doc.text(`Tiempo:      ${t.toFixed(2)} h  ×  ${formatPeso(tarifa)}/h  =  ${formatPeso(t * tarifa)}`);
    }
    if (viaje.zona === 'PROVINCIA' || viaje.zona === 'MIXTO') {
      const d = viaje.distancia_provincia ?? 0;
      const tarifa = viaje.tarifa_km ?? 0;
      doc.text(`Distancia:   ${d.toFixed(2)} km  ×  ${formatPeso(tarifa)}/km  =  ${formatPeso(d * tarifa)}`);
    }

    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).stroke();
    doc.moveDown(0.3);
    doc.fontSize(12).font('Helvetica-Bold').text(
      `TOTAL:   ${formatPeso(viaje.precio_real)}`,
      { align: 'right' }
    );

    doc.end();
  });
}
