// Applies the "Matter Address and Pin Master" correction CSV onto Oct 14
// Delivery records (not Customer records this time — those were already
// updated earlier). For every Oct 14 delivery whose customer name is in the
// correction list, overwrites Delivery.address + Delivery.gpsLocation with
// the CSV's standardized address/pin (zone is re-derived the same way the
// Matter import job does it, via the address text).
//
// Separately reports every Oct 14 delivery whose customer is NOT in the
// correction list at all — these have no vetted address to apply, and need
// a manual check.
//
// SAFE BY DEFAULT: dry run unless you pass --apply.
//
// Usage:
//   node scripts/applyCorrectionListToOct14Deliveries.js "<csv path>"            (dry run)
//   node scripts/applyCorrectionListToOct14Deliveries.js "<csv path>" --apply    (writes)

import '../loadEnv.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import { detectAreaFromAddress } from '../config/areas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');

const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
};

const collapseWhitespace = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const normalizeName = (value) => collapseWhitespace(value).toLowerCase();
const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

const run = async () => {
  const csvPath = process.argv[2];
  if (!csvPath || csvPath === '--apply') throw new Error('Usage: node scripts/applyCorrectionListToOct14Deliveries.js "<csv path>" [--apply]');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');

  const rawCsv = fs.readFileSync(csvPath, 'utf8');
  const allRows = parseCsv(rawCsv);
  const headerIdx = allRows.findIndex((r) => r[0] === 'Address ID');
  const header = allRows[headerIdx];
  const idxCustomer = header.indexOf('Customer');
  const idxAddress = header.indexOf('Standardized address');
  const idxLat = header.indexOf('Latitude');
  const idxLng = header.indexOf('Longitude');

  const correctionByName = new Map();
  allRows.slice(headerIdx + 1).forEach((r) => {
    if (!r[idxCustomer]) return;
    const key = normalizeName(r[idxCustomer]);
    if (!correctionByName.has(key)) {
      correctionByName.set(key, {
        address: collapseWhitespace(r[idxAddress]),
        lat: parseFloat(r[idxLat]),
        lng: parseFloat(r[idxLng])
      });
    }
  });
  console.log(`Correction list has ${correctionByName.size} unique customer names.\n`);

  await mongoose.connect(process.env.MONGODB_URI);

  const start = new Date('2026-10-14T00:00:00.000Z');
  start.setUTCHours(start.getUTCHours() - 4);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);

  const deliveries = await Delivery.find({ scheduledTime: { $gte: start, $lte: end } });
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${deliveries.length} Oct 14 delivery(ies)\n`);

  const customers = await Customer.find({ customerId: { $in: deliveries.map((d) => d.customerId) } })
    .select('customerId firstName lastName').lean();
  const customerById = new Map(customers.map((c) => [c.customerId, c]));

  let updated = 0, unchanged = 0, missingFromList = [];

  for (const d of deliveries) {
    const customer = customerById.get(d.customerId);
    const name = customer ? `${customer.firstName || ''} ${customer.lastName || ''}`.trim() : d.customerName;
    const correction = correctionByName.get(normalizeName(name)) || correctionByName.get(normalizeName(d.customerName));

    if (!correction) {
      missingFromList.push({ customerId: d.customerId, name: d.customerName, currentAddress: d.address || '', currentLat: d.gpsLocation?.lat ?? '', currentLng: d.gpsLocation?.lng ?? '' });
      continue;
    }

    const hasCoords = Number.isFinite(correction.lat) && Number.isFinite(correction.lng);
    const addressChanged = correction.address && d.address !== correction.address;
    const coordsChanged = hasCoords && (d.gpsLocation?.lat !== correction.lat || d.gpsLocation?.lng !== correction.lng);

    if (!addressChanged && !coordsChanged) { unchanged += 1; continue; }

    updated += 1;
    console.log(`UPDATE  ${d.customerId} (${name})`);
    if (addressChanged) console.log(`   address: "${d.address || ''}" -> "${correction.address}"`);
    if (coordsChanged) console.log(`   gps: ${d.gpsLocation?.lat ?? 'none'},${d.gpsLocation?.lng ?? 'none'} -> ${correction.lat},${correction.lng}`);

    if (APPLY) {
      d.address = correction.address || d.address;
      if (hasCoords) {
        d.gpsLocation = { ...(d.gpsLocation || {}), lat: correction.lat, lng: correction.lng };
        d.zone = detectAreaFromAddress(correction.address) || d.zone;
      }
      await d.save();
    }
  }

  console.log(`\nUpdated: ${updated}`);
  console.log(`Already matched, no change needed: ${unchanged}`);
  console.log(`NOT in the correction list (need manual check): ${missingFromList.length}`);

  console.log('\n--- NOT in the correction list — check these addresses manually ---');
  missingFromList.forEach((r) => {
    console.log(`  ${r.customerId} (${r.name}) — current: ${r.currentLat}, ${r.currentLng} — ${r.currentAddress}`);
  });

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'oct14-deliveries-not-in-correction-list.csv');
  const headers = ['customerId', 'name', 'currentAddress', 'currentLat', 'currentLng'];
  fs.writeFileSync(outFile, [headers.join(','), ...missingFromList.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n'));
  console.log(`\nFull CSV of missing ones: ${outFile}`);

  if (!APPLY) console.log('\nDry run only — nothing was changed. Re-run with --apply to write these changes.');
  await mongoose.disconnect();
};

run().catch((err) => { console.error('Apply failed:', err); process.exitCode = 1; mongoose.disconnect(); });
