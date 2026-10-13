// Read-only: for the 96 Oct 14 deliveries NOT covered by the correction
// list (scripts/output/oct14-deliveries-not-in-correction-list.csv),
// compares each delivery's own address/gpsLocation against the internal
// Customer record, excluding Abu Dhabi deliveries (the correction list was
// scoped to Dubai only, so Abu Dhabi addresses were never expected to be in
// it — not itself a sign of a problem).
//
// Makes NO changes.
//
// Usage: node scripts/checkMissing96VsInternal.js

import '../loadEnv.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import { haversineKm } from '../services/geocoding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

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

const run = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  const missingCsvPath = path.join(__dirname, 'output', 'oct14-deliveries-not-in-correction-list.csv');
  const rows = parseCsv(fs.readFileSync(missingCsvPath, 'utf8'));
  const header = rows[0];
  const idx = (n) => header.indexOf(n);
  const iId = idx('customerId'), iName = idx('name'), iAddr = idx('currentAddress');
  const entries = rows.slice(1).filter((r) => r[iId] || r[iName]);
  console.log(`Loaded ${entries.length} customers from the missing-96 list.\n`);

  await mongoose.connect(process.env.MONGODB_URI);

  const start = new Date('2026-10-14T00:00:00.000Z');
  start.setUTCHours(start.getUTCHours() - 4);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);

  let abuDhabiExcluded = 0;
  const results = [];

  for (const r of entries) {
    const customerId = r[iId];
    const name = r[iName];
    const currentAddress = r[iAddr] || '';

    if (/abu\s*dhabi/i.test(currentAddress)) { abuDhabiExcluded += 1; continue; }

    const delivery = await Delivery.findOne({ customerId, scheduledTime: { $gte: start, $lte: end } })
      .select('address gpsLocation addressDetails').lean();
    const customer = await Customer.findOne({ customerId }).select('address gpsLocation').lean();

    if (!delivery) { results.push({ customerId, name, status: 'DELIVERY_NOT_FOUND', deliveryAddress: '', internalAddress: '', distanceKm: '' }); continue; }
    if (!customer) { results.push({ customerId, name, status: 'NO_INTERNAL_CUSTOMER', deliveryAddress: delivery.address || '', internalAddress: '', distanceKm: '' }); continue; }

    const hasDeliveryGps = Number.isFinite(delivery.gpsLocation?.lat) && Number.isFinite(delivery.gpsLocation?.lng);
    const hasInternalGps = Number.isFinite(customer.gpsLocation?.lat) && Number.isFinite(customer.gpsLocation?.lng);

    let status, distanceKm = '';
    if (!hasDeliveryGps) status = 'DELIVERY_HAS_NO_GPS';
    else if (!hasInternalGps) status = 'INTERNAL_HAS_NO_GPS';
    else {
      const km = haversineKm(delivery.gpsLocation.lat, delivery.gpsLocation.lng, customer.gpsLocation.lat, customer.gpsLocation.lng);
      distanceKm = km.toFixed(3);
      status = km < 0.15 ? 'MATCH' : `MISMATCH (${km.toFixed(2)} km apart)`;
    }

    results.push({
      customerId, name, status, distanceKm,
      deliveryAddress: delivery.address || '', deliveryLat: delivery.gpsLocation?.lat ?? '', deliveryLng: delivery.gpsLocation?.lng ?? '',
      internalAddress: customer.address || '', internalLat: customer.gpsLocation?.lat ?? '', internalLng: customer.gpsLocation?.lng ?? ''
    });
  }

  const match = results.filter((r) => r.status === 'MATCH');
  const mismatch = results.filter((r) => r.status.startsWith('MISMATCH'));
  const other = results.filter((r) => !r.status.startsWith('MISMATCH') && r.status !== 'MATCH');

  console.log('================ MISSING-96 (Dubai only) vs INTERNAL CUSTOMER ================\n');
  console.log(`Total: ${entries.length} | Abu Dhabi excluded: ${abuDhabiExcluded} | Checked: ${results.length}`);
  console.log(`  Match:    ${match.length}`);
  console.log(`  Mismatch: ${mismatch.length}`);
  console.log(`  Other (no GPS / no record): ${other.length}`);

  console.log('\n--- Mismatches ---');
  mismatch.forEach((r) => {
    console.log(`  ${r.customerId} (${r.name}) — ${r.status}`);
    console.log(`     delivery: ${r.deliveryLat}, ${r.deliveryLng} — ${r.deliveryAddress}`);
    console.log(`     internal: ${r.internalLat}, ${r.internalLng} — ${r.internalAddress}`);
  });

  console.log('\n--- Matches (consistent, likely fine) ---');
  match.forEach((r) => console.log(`  ${r.customerId} (${r.name})`));

  console.log('\n--- Other issues ---');
  other.forEach((r) => console.log(`  ${r.customerId} (${r.name}) — ${r.status}`));

  const outDir = path.join(__dirname, 'output');
  const outFile = path.join(outDir, 'missing96-vs-internal.csv');
  const headers = ['customerId', 'name', 'status', 'distanceKm', 'deliveryAddress', 'deliveryLat', 'deliveryLng', 'internalAddress', 'internalLat', 'internalLng'];
  fs.writeFileSync(outFile, [headers.join(','), ...results.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n'));
  console.log(`\nFull CSV: ${outFile}`);

  await mongoose.disconnect();
};

run().catch((err) => { console.error('Check failed:', err); process.exitCode = 1; mongoose.disconnect(); });
