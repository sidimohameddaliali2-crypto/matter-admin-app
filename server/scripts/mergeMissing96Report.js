// Read-only: rewrites scripts/output/oct14-deliveries-not-in-correction-list.csv
// in place, merging in everything already computed (missing96-vs-internal.csv)
// so it's one single, clearly-labeled file instead of two — every row shows
// its delivery address/coords, the internal customer's address/coords,
// distance apart, and a clear status (including Abu Dhabi rows, explicitly
// labeled as excluded from the comparison rather than just missing).
//
// Makes NO changes to the database — only rewrites this one report CSV.
//
// Usage: node scripts/mergeMissing96Report.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'output');

const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; } else field += c; }
    else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
};
const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

const originalPath = path.join(outDir, 'oct14-deliveries-not-in-correction-list.csv');
const comparisonPath = path.join(outDir, 'missing96-vs-internal.csv');

const originalRows = parseCsv(fs.readFileSync(originalPath, 'utf8'));
const originalHeader = originalRows[0];
const oIdx = (n) => originalHeader.indexOf(n);
const original = originalRows.slice(1).filter((r) => r[oIdx('customerId')] || r[oIdx('name')]);

const comparisonRows = parseCsv(fs.readFileSync(comparisonPath, 'utf8'));
const cHeader = comparisonRows[0];
const cIdx = (n) => cHeader.indexOf(n);
const comparisonByCustomerId = new Map(
  comparisonRows.slice(1).map((r) => [r[cIdx('customerId')], r])
);

const merged = original.map((r) => {
  const customerId = r[oIdx('customerId')];
  const name = r[oIdx('name')];
  const currentAddress = r[oIdx('currentAddress')];
  const currentLat = r[oIdx('currentLat')];
  const currentLng = r[oIdx('currentLng')];
  const isAbuDhabi = /abu\s*dhabi/i.test(currentAddress);

  const comp = comparisonByCustomerId.get(customerId);
  let status, distanceKm, internalAddress, internalLat, internalLng;

  if (isAbuDhabi) {
    status = 'ABU_DHABI_EXCLUDED_FROM_CHECK';
    distanceKm = ''; internalAddress = ''; internalLat = ''; internalLng = '';
  } else if (comp) {
    status = comp[cIdx('status')];
    distanceKm = comp[cIdx('distanceKm')];
    internalAddress = comp[cIdx('internalAddress')];
    internalLat = comp[cIdx('internalLat')];
    internalLng = comp[cIdx('internalLng')];
  } else {
    status = 'NOT_CHECKED';
    distanceKm = ''; internalAddress = ''; internalLat = ''; internalLng = '';
  }

  return {
    customerId, name, status, distanceKm,
    deliveryAddress: currentAddress, deliveryLat: currentLat, deliveryLng: currentLng,
    internalAddress, internalLat, internalLng
  };
});

const headers = ['customerId', 'name', 'status', 'distanceKm', 'deliveryAddress', 'deliveryLat', 'deliveryLng', 'internalAddress', 'internalLat', 'internalLng'];
const csv = [headers.join(','), ...merged.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n');
fs.writeFileSync(originalPath, csv);

const counts = merged.reduce((acc, r) => {
  const key = r.status.startsWith('MISMATCH') ? 'MISMATCH' : r.status;
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});
console.log(`Rewrote ${originalPath} with ${merged.length} rows.`);
console.log('Status breakdown:', JSON.stringify(counts, null, 2));
