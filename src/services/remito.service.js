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

    // ── Cliente ──
    const cliente = viaje.cliente?.usuario;
    doc.fontSize(11).font('Helvetica-Bold').text('CLIENTE');
    doc.fontSize(10).font('Helvetica');
    if (cliente) {
      doc.text(`Nombre: ${cliente.nombre} ${cliente.apellido}`);
      if (viaje.cliente.nombre_empresa) doc.text(`Empresa: ${viaje.cliente.nombre_empresa}`);
      if (cliente.telefono) doc.text(`Teléfono: ${cliente.telefono}`);
    }
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
