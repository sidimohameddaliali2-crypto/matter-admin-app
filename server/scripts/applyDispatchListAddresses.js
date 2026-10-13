// Applies the "Dispatch" sheet of the Oct 14 Dubai Delivery List workbook
// onto both the internal Delivery record AND the internal Customer record
// (kept in sync, same as every other address-correction step this
// session) — address text + Google lat/lng, for every row that matches an
// internal delivery by customer name.
//
// Skips any customer whose entry in the workbook's own "Dubai review
// queue" sheet explicitly says "Preserve selected values; evidence gaps
// are not correction instructions" — that's Jacob's own flag meaning this
// specific discrepancy is a known open question, not a confirmed
// correction, so it is reported separately and never auto-applied.
//
// SAFE BY DEFAULT: dry run unless you pass --apply.
//
// Usage:
//   node scripts/applyDispatchListAddresses.js "<xlsx path>"            (dry run)
//   node scripts/applyDispatchListAddresses.js "<xlsx path>" --apply    (writes)

import '../loadEnv.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import { detectAreaFromAddress } from '../config/areas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const collapseWhitespace = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const normalizeName = (value) => collapseWhitespace(value).toLowerCase();

const run = async () => {
  const xlsxPath = process.argv[2];
  if (!xlsxPath || xlsxPath === '--apply') throw new Error('Usage: node scripts/applyDispatchListAddresses.js "<xlsx path>" [--apply]');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');

  const wb = XLSX.readFile(xlsxPath);

  // Dispatch sheet — the source of addresses to apply.
  const dispatchSheet = wb.Sheets['Dispatch'];
  const dRows = XLSX.utils.sheet_to_json(dispatchSheet, { header: 1, defval: '' });
  const dHeaderIdx = dRows.findIndex((r) => r[0] === 'Source ID');
  const dHeader = dRows[dHeaderIdx];
  const dCol = (name) => dHeader.indexOf(name);
  const iCustomer = dCol('Customer'), iAddress = dCol('Delivery address'), iGLat = dCol('Google latitude'), iGLng = dCol('Google longitude');
  const dispatchRows = dRows.slice(dHeaderIdx + 1).filter((r) => r[iCustomer]);

  // Review queue sheet — find the "do not correct, preserve as-is" names.
  const reviewSheet = wb.Sheets['Dubai review queue'];
  const rRows = XLSX.utils.sheet_to_json(reviewSheet, { header: 1, defval: '' });
  const rHeaderIdx = rRows.findIndex((r) => r[0] === 'Source row');
  const rHeader = rRows[rHeaderIdx];
  const rCol = (name) => rHeader.indexOf(name);
  const riCustomer = rCol('Customer'), riNext = rCol('Next check');
  const preserveNames = new Set();
  rRows.slice(rHeaderIdx + 1).forEach((r) => {
    if (r[riCustomer] && /preserve selected values/i.test(r[riNext] || '')) {
      preserveNames.add(normalizeName(r[riCustomer]));
    }
  });
  console.log(`Flagged "preserve, do not correct" by the review queue: ${preserveNames.size} customer(s)\n`);

  await mongoose.connect(process.env.MONGODB_URI);
  const start = new Date('2026-10-14T00:00:00.000Z');
  start.setUTCHours(start.getUTCHours() - 4);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);

  const deliveries = await Delivery.find({ scheduledTime: { $gte: start, $lte: end } });
  const byName = new Map();
  for (const d of deliveries) {
    const key = normalizeName(d.customerName);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(d);
  }

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${dispatchRows.length} dispatch row(s)\n`);

  let updated = 0, unchanged = 0, preserved = 0, noMatch = 0, ambiguous = 0;
  const now = new Date();
  const preservedList = [];
  const noMatchList = [];

  for (const r of dispatchRows) {
    const name = r[iCustomer];
    const sheetAddress = collapseWhitespace(r[iAddress]);
    const sheetLat = parseFloat(r[iGLat]);
    const sheetLng = parseFloat(r[iGLng]);
    const nameKey = normalizeName(name);

    if (preserveNames.has(nameKey)) { preserved += 1; preservedList.push(name); continue; }

    const candidates = byName.get(nameKey) || [];
    if (candidates.length === 0) { noMatch += 1; noMatchList.push({ name, sheetAddress }); continue; }
    if (candidates.length > 1) ambiguous += 1;

    for (const d of candidates) {
      const hasCoords = Number.isFinite(sheetLat) && Number.isFinite(sheetLng);
      const addressChanged = sheetAddress && d.address !== sheetAddress;
      const coordsChanged = hasCoords && (d.gpsLocation?.lat !== sheetLat || d.gpsLocation?.lng !== sheetLng);

      if (!addressChanged && !coordsChanged) { unchanged += 1; continue; }

      updated += 1;
      console.log(`UPDATE  ${d.customerId} (${name})`);
      if (addressChanged) console.log(`   address: "${d.address || ''}" -> "${sheetAddress}"`);
      if (coordsChanged) console.log(`   gps: ${d.gpsLocation?.lat ?? 'none'},${d.gpsLocation?.lng ?? 'none'} -> ${sheetLat},${sheetLng}`);

      if (APPLY) {
        d.address = sheetAddress || d.address;
        if (hasCoords) {
          d.gpsLocation = { ...(d.gpsLocation || {}), lat: sheetLat, lng: sheetLng };
          d.zone = detectAreaFromAddress(sheetAddress) || d.zone;
        }
        await d.save();

        const customer = await Customer.findOne({ customerId: d.customerId });
        if (customer) {
          // Guard against a malformed/shared customerId (found live: two
          // different deliveries — "Augustus Media" and "RAPTORS GYM" —
          // both carry the literal customerId "CUST-", which also belongs
          // to an unrelated real customer, "Aliasgar Raja"). Only sync onto
          // the Customer record when its name plausibly matches the
          // delivery's; otherwise the Delivery fix above still applies
          // (it was matched by name directly, not by this customerId), but
          // the Customer side is skipped rather than overwriting a
          // stranger's address.
          const customerName = normalizeName(`${customer.firstName || ''} ${customer.lastName || ''}`);
          const nameIsPlausible = !customerName || customerName === nameKey
            || customerName.includes(nameKey) || nameKey.includes(customerName);
          if (nameIsPlausible) {
            customer.address = sheetAddress || customer.address;
            if (hasCoords) {
              customer.gpsLocation = { lat: sheetLat, lng: sheetLng, source: 'manual', address: sheetAddress || customer.address, geocodedAt: now };
            }
            await customer.save();
          } else {
            console.log(`   !! customerId ${d.customerId} belongs to "${customer.firstName} ${customer.lastName}", not "${name}" — Customer record NOT touched (likely a shared/malformed customerId)`);
          }
        }
      }
    }
  }

  console.log(`\nUpdated: ${updated}`);
  console.log(`Already matched, no change needed: ${unchanged}`);
  console.log(`Preserved (review queue says don't correct): ${preserved}`);
  console.log(`No internal delivery found: ${noMatch}`);
  console.log(`Ambiguous (name shared by 2+): ${ambiguous}`);

  console.log('\n--- Preserved (not touched) ---');
  preservedList.forEach((n) => console.log(`  ${n}`));

  console.log('\n--- No internal delivery found ---');
  noMatchList.forEach((r) => console.log(`  ${r.name} — ${r.sheetAddress}`));

  if (!APPLY) console.log('\nDry run only — nothing was changed. Re-run with --apply to write these changes.');
  await mongoose.disconnect();
};

run().catch((err) => { console.error('Apply failed:', err); process.exitCode = 1; mongoose.disconnect(); });
