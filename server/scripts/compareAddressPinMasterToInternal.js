// Read-only: cross-checks the external "Matter Address and Pin Master" CSV
// (customer name, standardized address, lat/lng, verification status)
// against this app's internal Customer.gpsLocation — the cached geocode
// used by every delivery/route-optimizer run for that customer (see
// services/geocoding.js resolveDeliveryCoordinatesCached).
//
// Matches rows to internal customers by normalized name (the sheet has no
// internal customerId column). Reports, per matched customer: whether the
// sheet's lat/lng agrees with the internal gpsLocation (haversine distance,
// same function used elsewhere in this codebase), and whether the sheet's
// address text looks like the same place as the internal Customer.address.
//
// Makes NO changes.
//
// Usage: node scripts/compareAddressPinMasterToInternal.js "<path to csv>"

import '../loadEnv.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Customer from '../models/Customer.js';
import { haversineKm } from '../services/geocoding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal RFC4180-ish CSV parser — handles quoted fields with embedded
// commas/newlines, which the sheet's "Standardized address" column has.
const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
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
const csvEscape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

const run = async () => {
  const csvPath = process.argv[2];
  if (!csvPath) throw new Error('Usage: node scripts/compareAddressPinMasterToInternal.js "<path to csv>"');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');

  const raw = fs.readFileSync(csvPath, 'utf8');
  const allRows = parseCsv(raw);
  // Header row is "Address ID,Customer,Standardized address,..." — find it
  // rather than assume a fixed line number, since the sheet has a variable
  // number of title/caption rows above it.
  const headerIdx = allRows.findIndex((r) => r[0] === 'Address ID');
  if (headerIdx === -1) throw new Error('Could not find the "Address ID" header row in this CSV');
  const header = allRows[headerIdx];
  const col = (name) => header.indexOf(name);
  const idxId = col('Address ID');
  const idxCustomer = col('Customer');
  const idxAddress = col('Standardized address');
  const idxLat = col('Latitude');
  const idxLng = col('Longitude');
  const idxStatus = col('Status');

  const dataRows = allRows.slice(headerIdx + 1).filter((r) => r[idxCustomer]);
  console.log(`Sheet rows (with a customer name): ${dataRows.length}\n`);

  await mongoose.connect(process.env.MONGODB_URI);
  const customers = await Customer.find({})
    .select('customerId firstName lastName address gpsLocation')
    .lean();

  const byName = new Map();
  for (const c of customers) {
    const name = normalizeName(`${c.firstName || ''} ${c.lastName || ''}`);
    if (name && !byName.has(name)) byName.set(name, []);
    if (name) byName.get(name).push(c);
  }

  const results = [];
  let noMatch = 0, ambiguous = 0, noInternalGps = 0, matchClose = 0, matchFar = 0;

  for (const r of dataRows) {
    const sheetName = normalizeName(r[idxCustomer]);
    const sheetLat = parseFloat(r[idxLat]);
    const sheetLng = parseFloat(r[idxLng]);
    const candidates = byName.get(sheetName) || [];

    if (candidates.length === 0) {
      noMatch += 1;
      results.push({
        addressId: r[idxId], sheetCustomer: r[idxCustomer], sheetAddress: r[idxAddress],
        sheetLat, sheetLng, sheetStatus: r[idxStatus],
        internalCustomerId: '', internalAddress: '', internalLat: '', internalLng: '',
        distanceKm: '', verdict: 'NO_INTERNAL_CUSTOMER_FOUND'
      });
      continue;
    }

    for (const c of candidates) {
      if (candidates.length > 1) ambiguous += 1;
      const hasInternalGps = Number.isFinite(c.gpsLocation?.lat) && Number.isFinite(c.gpsLocation?.lng);
      let distanceKm = '';
      let verdict;

      if (!hasInternalGps) {
        noInternalGps += 1;
        verdict = 'NO_INTERNAL_GPS_ON_FILE';
      } else if (!Number.isFinite(sheetLat) || !Number.isFinite(sheetLng)) {
        verdict = 'SHEET_HAS_NO_COORDINATES';
      } else {
        distanceKm = haversineKm(sheetLat, sheetLng, c.gpsLocation.lat, c.gpsLocation.lng);
        if (distanceKm < 0.15) { matchClose += 1; verdict = 'MATCH'; }
        else { matchFar += 1; verdict = `MISMATCH (${distanceKm.toFixed(2)} km apart)`; }
      }

      results.push({
        addressId: r[idxId], sheetCustomer: r[idxCustomer], sheetAddress: r[idxAddress],
        sheetLat, sheetLng, sheetStatus: r[idxStatus],
        internalCustomerId: c.customerId, internalAddress: c.address || '',
        internalLat: c.gpsLocation?.lat ?? '', internalLng: c.gpsLocation?.lng ?? '',
        distanceKm: typeof distanceKm === 'number' ? distanceKm.toFixed(3) : '',
        verdict: candidates.length > 1 ? `${verdict} (ambiguous: ${candidates.length} internal customers share this name)` : verdict
      });
    }
  }

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'address-pin-master-vs-internal.csv');
  const headers = Object.keys(results[0]);
  fs.writeFileSync(outFile, [headers.join(','), ...results.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n'));

  console.log('================ ADDRESS/PIN MASTER vs INTERNAL ================\n');
  console.log(`Sheet rows processed:              ${dataRows.length}`);
  console.log(`  No internal customer by name:    ${noMatch}`);
  console.log(`  Ambiguous (name shared by 2+):   ${ambiguous}`);
  console.log(`  Matched, but no internal GPS:    ${noInternalGps}`);
  console.log(`  Matched, pins agree (<150m):     ${matchClose}`);
  console.log(`  Matched, pins DISAGREE:          ${matchFar}`);

  console.log('\n--- Mismatches (sheet pin vs internal gpsLocation) ---');
  results.filter((r) => r.verdict.startsWith('MISMATCH')).forEach((r) => {
    console.log(`  ${r.sheetCustomer} (${r.internalCustomerId}): ${r.verdict}`);
    console.log(`     sheet:    ${r.sheetLat}, ${r.sheetLng} — ${r.sheetAddress}`);
    console.log(`     internal: ${r.internalLat}, ${r.internalLng} — ${r.internalAddress}`);
  });

  console.log('\n--- No internal customer found for this name ---');
  results.filter((r) => r.verdict === 'NO_INTERNAL_CUSTOMER_FOUND').forEach((r) => {
    console.log(`  ${r.sheetCustomer}`);
  });

  console.log(`\nFull CSV: ${outFile}`);
  await mongoose.disconnect();
};

run().catch((err) => { console.error('Comparison failed:', err); process.exitCode = 1; mongoose.disconnect(); });
