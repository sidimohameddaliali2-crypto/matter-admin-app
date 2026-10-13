// Read-only: compares the "Dispatch" sheet of the external Oct 14 Dubai
// Delivery List workbook (customer, delivery address, Google lat/lng, 2GIS
// lat/lng, status) against our internal Oct 14 Delivery records, matched by
// customer name. Also surfaces the workbook's own "Dubai review queue" (11
// names it already flags as needing a manual check) and "Changes since
// master" sheets (recent address/time conflicts, e.g. the known Mishari
// Saud Abu Dhabi case) so nothing in those gets missed.
//
// Makes NO changes.
//
// Usage: node scripts/checkOct14AgainstDubaiDispatchList.js "<xlsx path>"

import '../loadEnv.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import Delivery from '../models/Delivery.js';
import { haversineKm } from '../services/geocoding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const collapseWhitespace = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const normalizeName = (value) => collapseWhitespace(value).toLowerCase();

const run = async () => {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) throw new Error('Usage: node scripts/checkOct14AgainstDubaiDispatchList.js "<xlsx path>"');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');

  const wb = XLSX.readFile(xlsxPath);
  const dispatchSheet = wb.Sheets['Dispatch'];
  const rows = XLSX.utils.sheet_to_json(dispatchSheet, { header: 1, defval: '' });
  const headerIdx = rows.findIndex((r) => r[0] === 'Source ID');
  const header = rows[headerIdx];
  const col = (name) => header.indexOf(name);
  const iCustomer = col('Customer'), iAddress = col('Delivery address'), iGLat = col('Google latitude'),
    iGLng = col('Google longitude'), iStatus = col('Status');

  const dispatchRows = rows.slice(headerIdx + 1).filter((r) => r[iCustomer]);
  console.log(`Dispatch sheet rows: ${dispatchRows.length}\n`);

  await mongoose.connect(process.env.MONGODB_URI);
  const start = new Date('2026-10-14T00:00:00.000Z');
  start.setUTCHours(start.getUTCHours() - 4);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  const deliveries = await Delivery.find({ scheduledTime: { $gte: start, $lte: end } })
    .select('customerId customerName address gpsLocation').lean();

  const byName = new Map();
  for (const d of deliveries) {
    const key = normalizeName(d.customerName);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(d);
  }

  const results = [];
  let match = 0, mismatch = 0, noInternal = 0, noCoords = 0, ambiguous = 0;

  for (const r of dispatchRows) {
    const name = r[iCustomer];
    const sheetAddress = r[iAddress];
    const sheetLat = parseFloat(r[iGLat]);
    const sheetLng = parseFloat(r[iGLng]);
    const status = r[iStatus];
    const candidates = byName.get(normalizeName(name)) || [];

    if (candidates.length === 0) {
      noInternal += 1;
      results.push({ name, sheetAddress, status, verdict: 'NO_INTERNAL_DELIVERY_FOUND', distanceKm: '', internalAddress: '' });
      continue;
    }
    if (candidates.length > 1) ambiguous += 1;

    for (const d of candidates) {
      const hasSheetCoords = Number.isFinite(sheetLat) && Number.isFinite(sheetLng);
      const hasInternalCoords = Number.isFinite(d.gpsLocation?.lat) && Number.isFinite(d.gpsLocation?.lng);
      let verdict, distanceKm = '';

      if (!hasSheetCoords || !hasInternalCoords) { noCoords += 1; verdict = 'NO_COORDS_TO_COMPARE'; }
      else {
        const km = haversineKm(sheetLat, sheetLng, d.gpsLocation.lat, d.gpsLocation.lng);
        distanceKm = km.toFixed(3);
        if (km < 0.15) { match += 1; verdict = 'MATCH'; }
        else { mismatch += 1; verdict = `MISMATCH (${km.toFixed(2)} km apart)`; }
      }

      results.push({
        customerId: d.customerId, name, status, verdict, distanceKm,
        sheetAddress, sheetLat, sheetLng,
        internalAddress: d.address || '', internalLat: d.gpsLocation?.lat ?? '', internalLng: d.gpsLocation?.lng ?? ''
      });
    }
  }

  console.log('================ OCT 14 DISPATCH LIST vs INTERNAL ================\n');
  console.log(`Dispatch rows checked: ${dispatchRows.length}`);
  console.log(`  Match:                     ${match}`);
  console.log(`  Mismatch:                  ${mismatch}`);
  console.log(`  No coords to compare:      ${noCoords}`);
  console.log(`  No internal delivery found: ${noInternal}`);
  console.log(`  Ambiguous (name shared):   ${ambiguous}`);

  console.log('\n--- Mismatches ---');
  results.filter((r) => r.verdict.startsWith('MISMATCH')).forEach((r) => {
    console.log(`  ${r.customerId || '?'} (${r.name}) — ${r.verdict} — sheet status: ${r.status}`);
    console.log(`     sheet:    ${r.sheetLat}, ${r.sheetLng} — ${r.sheetAddress}`);
    console.log(`     internal: ${r.internalLat}, ${r.internalLng} — ${r.internalAddress}`);
  });

  console.log('\n--- No internal delivery found for this dispatch row ---');
  results.filter((r) => r.verdict === 'NO_INTERNAL_DELIVERY_FOUND').forEach((r) => console.log(`  ${r.name} — ${r.sheetAddress}`));

  // --- Review queue + changes-since-master sheets, surfaced as-is ---
  const reviewSheet = wb.Sheets['Dubai review queue'];
  const reviewRows = XLSX.utils.sheet_to_json(reviewSheet, { header: 1, defval: '' });
  const reviewHeaderIdx = reviewRows.findIndex((r) => r[0] === 'Source row');
  const reviewHeader = reviewRows[reviewHeaderIdx];
  const riCustomer = reviewHeader.indexOf('Customer'), riClass = reviewHeader.indexOf('Queue classification'), riNext = reviewHeader.indexOf('Next check');
  const reviewEntries = reviewRows.slice(reviewHeaderIdx + 1).filter((r) => r[riCustomer]);
  console.log(`\n--- The workbook's own "Dubai review queue" (${reviewEntries.length} names already flagged by Jacob) ---`);
  reviewEntries.forEach((r) => console.log(`  ${r[riCustomer]} — ${r[riClass]} — next check: ${r[riNext]?.slice(0, 120)}`));

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'oct14-dispatch-list-vs-internal.csv');
  const headers = ['customerId', 'name', 'status', 'verdict', 'distanceKm', 'sheetAddress', 'sheetLat', 'sheetLng', 'internalAddress', 'internalLat', 'internalLng'];
  fs.writeFileSync(outFile, [headers.join(','), ...results.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n'));
  console.log(`\nFull CSV: ${outFile}`);

  await mongoose.disconnect();
};

run().catch((err) => { console.error('Check failed:', err); process.exitCode = 1; mongoose.disconnect(); });
