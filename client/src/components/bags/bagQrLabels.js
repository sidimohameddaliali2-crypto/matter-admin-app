import React from 'react';
import {createRoot} from 'react-dom/client';
import {QRCodeCanvas} from 'qrcode.react';
import jsPDF from 'jspdf';

// Batch QR label sheet (owner, 2026-10-07) — mirrors the "QR Setting.pdf"
// reference layout: a 9-column grid of cut-apart cells, each holding one
// bag's code + QR, filled left-to-right then top-to-bottom. The QR payload
// is the plain bagId string, same convention as the search bar above (a
// handheld scanner just types the decoded text in, no URL/JSON wrapper).
const QR_PDF_COLUMNS = 9;
const QR_PDF_ROW_HEIGHT_MM = 24;
const QR_PDF_MARGIN_MM = 10;
const QR_PDF_PAGE_W_MM = 210; // A4
const QR_PDF_PAGE_H_MM = 297;

// Renders one QRCodeCanvas per id into a detached, off-screen container so
// each canvas's pixel data (toDataURL) can be read for jsPDF's addImage —
// jsPDF can't embed a live React component, only an image data URL.
async function renderQrDataUrls(ids, pxSize = 240) {
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-99999px';
  container.style.top = '0';
  document.body.appendChild(container);
  const root = createRoot(container);

  await new Promise((resolve) => {
    root.render(
      <>
        {ids.map((id) => (
          <div key={id} data-bagid={id}>
            <QRCodeCanvas value={id} size={pxSize} includeMargin={false} level="M" />
          </div>
        ))}
      </>
    );
    // Two frames: one to commit the render, one to be sure each canvas has painted.
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

  const dataUrlById = new Map();
  ids.forEach((id) => {
    const wrapper = container.querySelector(`[data-bagid="${CSS.escape(id)}"]`);
    const canvas = wrapper?.querySelector('canvas');
    if (canvas) dataUrlById.set(id, canvas.toDataURL('image/png'));
  });

  root.unmount();
  document.body.removeChild(container);
  return dataUrlById;
}

export async function downloadBulkQrPdf(bagIds) {
  if (bagIds.length === 0) return;
  const dataUrlById = await renderQrDataUrls(bagIds);

  const colW = (QR_PDF_PAGE_W_MM - QR_PDF_MARGIN_MM * 2) / QR_PDF_COLUMNS;
  const rowsPerPage = Math.floor((QR_PDF_PAGE_H_MM - QR_PDF_MARGIN_MM * 2) / QR_PDF_ROW_HEIGHT_MM);
  const perPage = QR_PDF_COLUMNS * rowsPerPage;
  const qrSize = Math.min(colW, QR_PDF_ROW_HEIGHT_MM) - 6;

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  bagIds.forEach((id, i) => {
    const onPage = i % perPage;
    if (i > 0 && onPage === 0) doc.addPage();
    const col = onPage % QR_PDF_COLUMNS;
    const row = Math.floor(onPage / QR_PDF_COLUMNS);
    const x = QR_PDF_MARGIN_MM + col * colW;
    const y = QR_PDF_MARGIN_MM + row * QR_PDF_ROW_HEIGHT_MM;

    doc.setDrawColor(180);
    doc.rect(x, y, colW, QR_PDF_ROW_HEIGHT_MM); // cut guide

    doc.setFontSize(7);
    doc.setFont('courier', 'bold');
    doc.text(id, x + 1.5, y + 4);

    const dataUrl = dataUrlById.get(id);
    if (dataUrl) {
      doc.addImage(dataUrl, 'PNG', x + 1.5, y + 5.5, qrSize, qrSize);
    }
  });

  doc.save(`bag-qr-codes-${bagIds[0]}-to-${bagIds[bagIds.length - 1]}.pdf`);
}

