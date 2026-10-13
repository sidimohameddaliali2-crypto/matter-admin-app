// For every MISMATCH row in oct14-deliveries-not-in-correction-list.csv,
// overwrites the internal Customer's address + gpsLocation with the
// DELIVERY's address/coordinates (the delivery was built from Matter's
// current live subscription address as of Oct 13, more likely current than
// whatever stale value the internal record had — same reasoning as every
// other "apply the fresher source" step this session).
//
// Then rewrites the report CSV: removes ABU_DHABI_EXCLUDED_FROM_CHECK rows
// entirely (out of scope, not actionable), and updates the fixed rows'
// status to reflect the applied fix.
//
// SAFE BY DEFAULT: dry run unless you pass --apply.
//
// Usage:
//   node scripts/fixMismatchesAndCleanReport.js            (dry run)
//   node scripts/fixMismatchesAndCleanReport.js --apply    (writes)

import '../loadEnv.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Customer from '../models/Customer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');

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

const run = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  const csvPath = path.join(__dirname, 'output', 'oct14-deliveries-not-in-correction-list.csv');
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = rows[0];
  const idx = (n) => header.indexOf(n);
  const entries = rows.slice(1).filter((r) => r[idx('customerId')] || r[idx('name')]);

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'}\n`);

  const now = new Date();
  const updatedRows = [];

  for (const r of entries) {
    const customerId = r[idx('customerId')];
    const name = r[idx('name')];
    const status = r[idx('status')];
    const deliveryAddress = r[idx('deliveryAddress')];
    const deliveryLat = parseFloat(r[idx('deliveryLat')]);
    const deliveryLng = parseFloat(r[idx('deliveryLng')]);
    const internalAddress = r[idx('internalAddress')];
    const internalLat = r[idx('internalLat')];
    const internalLng = r[idx('internalLng')];

    if (status === 'ABU_DHABI_EXCLUDED_FROM_CHECK') continue; // dropped from the report

    if (!status.startsWith('MISMATCH')) {
      // Keep as-is (MATCH, DELIVERY_HAS_NO_GPS, INTERNAL_HAS_NO_GPS, NOT_CHECKED)
      updatedRows.push({ customerId, name, status, distanceKm: r[idx('distanceKm')], deliveryAddress, deliveryLat: r[idx('deliveryLat')], deliveryLng: r[idx('deliveryLng')], internalAddress, internalLat, internalLng });
      continue;
    }

    const hasCoords = Number.isFinite(deliveryLat) && Number.isFinite(deliveryLng);
    console.log(`FIX  ${customerId} (${name})`);
    console.log(`   internal address: "${internalAddress}" -> "${deliveryAddress}"`);
    console.log(`   internal gps: ${internalLat},${internalLng} -> ${deliveryLat},${deliveryLng}`);

    if (APPLY) {
      const customer = await Customer.findOne({ customerId });
      if (customer) {
        customer.address = deliveryAddress || customer.address;
        if (hasCoords) {
          customer.gpsLocation = {
            lat: deliveryLat,
            lng: deliveryLng,
            source: 'manual',
            address: deliveryAddress || customer.address,
            geocodedAt: now
          };
        }
        await customer.save();
      } else {
        console.log(`   !! customer ${customerId} not found, skipped`);
      }
    }

    updatedRows.push({
      customerId, name, status: 'FIXED (internal updated to match delivery)', distanceKm: '0.000',
      deliveryAddress, deliveryLat: r[idx('deliveryLat')], deliveryLng: r[idx('deliveryLng')],
      internalAddress: deliveryAddress, internalLat: hasCoords ? deliveryLat : internalLat, internalLng: hasCoords ? deliveryLng : internalLng
    });
  }

  const headers = ['customerId', 'name', 'status', 'distanceKm', 'deliveryAddress', 'deliveryLat', 'deliveryLng', 'internalAddress', 'internalLat', 'internalLng'];
  const csv = [headers.join(','), ...updatedRows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n');

  if (APPLY) {
    fs.writeFileSync(csvPath, csv);
    console.log(`\nReport rewritten: ${csvPath} (${updatedRows.length} rows, Abu Dhabi rows removed)`);
  } else {
    console.log(`\nDry run only — database and report file both unchanged. Re-run with --apply.`);
  }

  await mongoose.disconnect();
};

run().catch((err) => { console.error('Fix failed:', err); process.exitCode = 1; mongoose.disconnect(); });
