// Applies the external "Matter Address and Pin Master" CSV onto internal
// Customer records — overwrites Customer.address AND Customer.gpsLocation
// (lat/lng/source/address/geocodedAt) for every row that matches an
// internal customer by name, INCLUDING rows where the pin already agreed
// (per explicit request — the sheet's address text is more complete than
// what's on file even when the coordinates already matched, e.g. several
// "agree" rows had an empty internal Customer.address).
//
// source is set to 'manual' (not 'google') — this is a vetted external
// audit's pin, not an automatic Google geocode, and resolveDeliveryCoordinates
// Cached (services/geocoding.js) treats gpsLocation.address as the cache key:
// setting it to the same standardized address string here means this pin
// will be reused, not silently re-geocoded, on the next delivery for this
// customer.
//
// Skips rows with no internal customer match (reported, not writable) and
// rows with no usable coordinates in the sheet (the ~4 "UNRESOLVED" rows) —
// those update the address text only, never fabricate a pin.
//
// SAFE BY DEFAULT: dry run unless you pass --apply.
//
// Usage:
//   node scripts/applyAddressPinMasterToInternal.js "<csv path>"            (dry run)
//   node scripts/applyAddressPinMasterToInternal.js "<csv path>" --apply    (writes)

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

const run = async () => {
  const csvPath = process.argv[2];
  if (!csvPath || csvPath === '--apply') throw new Error('Usage: node scripts/applyAddressPinMasterToInternal.js "<csv path>" [--apply]');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');

  const raw = fs.readFileSync(csvPath, 'utf8');
  const allRows = parseCsv(raw);
  const headerIdx = allRows.findIndex((r) => r[0] === 'Address ID');
  if (headerIdx === -1) throw new Error('Could not find the "Address ID" header row in this CSV');
  const header = allRows[headerIdx];
  const col = (name) => header.indexOf(name);
  const idxCustomer = col('Customer');
  const idxAddress = col('Standardized address');
  const idxLat = col('Latitude');
  const idxLng = col('Longitude');

  const dataRows = allRows.slice(headerIdx + 1).filter((r) => r[idxCustomer]);
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${dataRows.length} sheet row(s)\n`);

  await mongoose.connect(process.env.MONGODB_URI);
  const customers = await Customer.find({}).select('customerId firstName lastName address gpsLocation');
  const byName = new Map();
  for (const c of customers) {
    const name = normalizeName(`${c.firstName || ''} ${c.lastName || ''}`);
    if (name && !byName.has(name)) byName.set(name, []);
    if (name) byName.get(name).push(c);
  }

  let updated = 0, noCoords = 0, noMatch = 0, ambiguous = 0, unchanged = 0;
  const now = new Date();

  for (const r of dataRows) {
    const sheetName = normalizeName(r[idxCustomer]);
    const sheetAddress = collapseWhitespace(r[idxAddress]);
    const sheetLat = parseFloat(r[idxLat]);
    const sheetLng = parseFloat(r[idxLng]);
    const candidates = byName.get(sheetName) || [];

    if (candidates.length === 0) {
      noMatch += 1;
      console.log(`SKIP  "${r[idxCustomer]}": no internal customer found by name`);
      continue;
    }
    if (candidates.length > 1) {
      ambiguous += 1;
      console.log(`SKIP  "${r[idxCustomer]}": ${candidates.length} internal customers share this name — needs manual review, not applying`);
      continue;
    }

    const c = candidates[0];
    const hasCoords = Number.isFinite(sheetLat) && Number.isFinite(sheetLng);
    if (!hasCoords) noCoords += 1;

    const addressChanged = sheetAddress && c.address !== sheetAddress;
    const coordsChanged = hasCoords && (c.gpsLocation?.lat !== sheetLat || c.gpsLocation?.lng !== sheetLng);

    if (!addressChanged && !coordsChanged) {
      unchanged += 1;
      continue;
    }

    updated += 1;
    console.log(`${hasCoords ? 'UPDATE' : 'UPDATE (address only, no coords in sheet)'}  ${c.customerId} (${r[idxCustomer]})`);
    if (addressChanged) console.log(`   address: "${c.address || ''}" -> "${sheetAddress}"`);
    if (coordsChanged) console.log(`   gps: ${c.gpsLocation?.lat ?? 'none'},${c.gpsLocation?.lng ?? 'none'} -> ${sheetLat},${sheetLng}`);

    if (APPLY) {
      const set = { address: sheetAddress || c.address };
      if (hasCoords) {
        set.gpsLocation = {
          lat: sheetLat,
          lng: sheetLng,
          source: 'manual',
          address: sheetAddress || c.address,
          geocodedAt: now
        };
      }
      await Customer.updateOne({ _id: c._id }, { $set: set });
    }
  }

  console.log(`\nUpdated: ${updated}`);
  console.log(`Already matched, no change needed: ${unchanged}`);
  console.log(`Sheet rows with no usable coordinates (address-only update): ${noCoords}`);
  console.log(`No internal customer found: ${noMatch}`);
  console.log(`Ambiguous (name shared by 2+ internal customers): ${ambiguous}`);
  if (!APPLY) console.log('\nDry run only — nothing was changed. Re-run with --apply to write these changes.');

  await mongoose.disconnect();
};

run().catch((err) => { console.error('Apply failed:', err); process.exitCode = 1; mongoose.disconnect(); });
