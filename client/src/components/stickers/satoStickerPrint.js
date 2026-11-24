import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MatterLogo from '../menuSelectionLink/MatterLogo';

export const SATO_ALIGNMENT_KEY = 'matterSatoLabelAlignment';
export const clampOffset = (value) => Number.isFinite(Number(value)) ? Math.max(-3, Math.min(3, Number(value))) : 0;

export function loadSatoAlignment() {
  try {
    const saved = JSON.parse(localStorage.getItem(SATO_ALIGNMENT_KEY) || '{}');
    return { x: clampOffset(saved?.x), y: clampOffset(saved?.y) };
  } catch { return { x: 0, y: 0 }; }
}

export function expandSatoDeliveries(deliveries = []) {
  return deliveries.flatMap((delivery) => delivery?.combinedSunday?.scheduledTime ? [delivery, {
    ...delivery,
    _id: delivery.combinedSunday.deliveryId || `${delivery._id}-sunday`,
    scheduledTime: delivery.combinedSunday.scheduledTime,
    combinedSunday: null,
  }] : [delivery]);
}

export function sortSatoDeliveries(deliveries) {
  // Match the owner's zone rules: Abu Dhabi emirate/sub-areas and Dubai South
  // are dispatched with Abu Dhabi. Preserve the incoming order within each group.
  const priority = (delivery) => (
    /^\s*abu\s*dhabi\b/i.test(String(delivery.addressDetails?.city || '')) ||
    /^\s*abu\s*dhabi\b/i.test(String(delivery.zone || '')) ||
    /^\s*dubai\s+south\s*$/i.test(String(delivery.zone || ''))
  ) ? 0 : 1;
  return deliveries.map((delivery, index) => ({ delivery, index }))
    .sort((a, b) => priority(a.delivery) - priority(b.delivery) || a.index - b.index)
    .map(({ delivery }) => delivery);
}

export function SatoDeliverySticker({ delivery }) {
  const date = new Date(delivery.scheduledTime || NaN);
  const dateText = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai' });
  const timingText = Number.isNaN(date.getTime()) ? 'Not scheduled' : date.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hour12: true,
  });
  return (
    <section className="sato-label">
      <div className="sato-box"><div className="sato-layout">
        <div className="sato-logo"><MatterLogo height={30} fill="#000000" /></div>
        <div className="sato-customer"><div className="sato-caption">Customer</div>
          <h1>{delivery.customerName || 'Unnamed customer'}</h1></div>
        <div className="sato-address"><div className="sato-caption">Delivery address</div>
          <p>{delivery.address || 'Address not provided'}</p></div>
        <div className="sato-zone"><div className="sato-caption">Zone</div>
          <strong>{delivery.zone || 'Zone not assigned'}</strong></div>
        <div className="sato-timing"><div className="sato-caption">Delivery timing</div>
          <strong>{timingText}</strong></div>
        {dateText && <div className="sato-date">{dateText}</div>}
      </div></div>
    </section>
  );
}

// Both the modal preview and printed pages use this layout and the same SVG logo.
export const SATO_STICKER_CSS = `
  .sato-label, .sato-label * { box-sizing: border-box; margin: 0; padding: 0; }
  .sato-label { width: 60mm; height: 80mm; flex: none; background: white; color: black;
    display: flex; align-items: center; justify-content: center; overflow: hidden;
    font: 9pt/1.2 Arial, sans-serif; break-inside: avoid; page-break-inside: avoid; }
  .sato-box { width: 54mm; height: 74mm; border: .3mm solid black; padding: 2.5mm;
    transform: translate(var(--sato-x, 0mm), var(--sato-y, 0mm)); }
  .sato-layout { height: 100%; display: flex; flex-direction: column; overflow-wrap: anywhere; }
  .sato-logo { display: flex; justify-content: center; flex: none; padding-bottom: 2mm; border-bottom: .3mm solid black; }
  .sato-logo svg { width: 42mm !important; height: 8mm; }
  .sato-caption { font-size: .67em; font-weight: bold; letter-spacing: .6pt; text-transform: uppercase; }
  .sato-customer { padding: 1mm 0 1.5mm; border-bottom: .3mm solid black; }
  .sato-customer h1 { font-size: 1em; font-weight: 700; line-height: 1.2; margin-top: .5mm; }
  .sato-address { padding: 1.5mm 0; flex: 1 0 auto; }
  .sato-address p { margin-top: .5mm; white-space: pre-wrap; }
  .sato-zone { padding: 1mm 0; border-top: .3mm solid black; }
  .sato-zone strong { display: block; font-size: 1.2em; margin-top: .5mm; }
  .sato-timing { display: flex; align-items: center; justify-content: space-between; gap: 2mm;
    padding-top: 1.5mm; border-top: .3mm solid black; }
  .sato-timing .sato-caption { flex: none; }
  .sato-timing strong { text-align: right; min-width: 0; font-size: 1.2em; }
  .sato-date { text-align: center; font-size: .67em; margin-top: 1mm; }
`;

export function buildSatoPrintMarkup(deliveries, alignment) {
  const stickers = sortSatoDeliveries(deliveries).map((delivery, index) => <SatoDeliverySticker key={index} delivery={delivery} />);
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>MATTER delivery stickers</title>
    <style>@page { size: 60mm 80mm; margin: 0; }
    html, body { width: 60mm; margin: 0; padding: 0; background: white; }
    :root { --sato-x: ${clampOffset(alignment.x)}mm; --sato-y: ${clampOffset(alignment.y)}mm; }
    ${SATO_STICKER_CSS}
    .sato-label + .sato-label { break-before: page; page-break-before: always; }
    </style></head><body>${renderToStaticMarkup(<>{stickers}</>)}</body></html>`;
}

export function fitSatoLabels(document) {
  let fits = true;
  document.querySelectorAll('.sato-layout').forEach((layout) => {
    let size = 9;
    layout.style.fontSize = '9pt';
    while ((layout.scrollHeight > layout.clientHeight + 1 || layout.scrollWidth > layout.clientWidth + 1) && size > 7) {
      size -= .25;
      layout.style.fontSize = `${size}pt`;
    }
    if (layout.scrollHeight > layout.clientHeight + 1 || layout.scrollWidth > layout.clientWidth + 1) fits = false;
  });
  return fits;
}
