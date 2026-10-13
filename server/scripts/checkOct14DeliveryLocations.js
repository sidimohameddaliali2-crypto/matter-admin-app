// Read-only: finds every Matter subscription with an active delivery on
// 2026-10-14 (per Matter's own delivery_schedule, via
// matterApiService.findSubscriptionsWithDeliveryOnDate — used instead of
// querying the local Delivery collection because the next day's Delivery
// documents aren't created by the import job until closer to the date, so
// no local record exists yet even though Matter already knows who's due a
// delivery that day). For each, resolves the internal Customer record,
// compares Matter's live address/coordinates against internal
// Customer.gpsLocation, and separately flags which of these customers were
// NOT part of the "Matter Address and Pin Master" correction list applied
// earlier (matched by normalized name, same join key used then).
//
// Makes NO changes.
//
// Usage: node scripts/checkOct14DeliveryLocations.js "<correction csv path>"

import '../loadEnv.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Customer from '../models/Customer.js';
import matterApiService from '../services/matterApiService.js';
import { resolveCustomerMatchBulk } from '../services/customerMatchService.js';
import { haversineKm } from '../services/geocoding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const correctionCsvPath = process.argv[2];
  if (!correctionCsvPath) throw new Error('Usage: node scripts/checkOct14DeliveryLocations.js "<correction csv path>"');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');

  const correctionNames = new Set();
  const rawCsv = fs.readFileSync(correctionCsvPath, 'utf8');
  const allRows = parseCsv(rawCsv);
  const headerIdx = allRows.findIndex((r) => r[0] === 'Address ID');
  const header = allRows[headerIdx];
  const idxCustomer = header.indexOf('Customer');
  allRows.slice(headerIdx + 1).forEach((r) => { if (r[idxCustomer]) correctionNames.add(normalizeName(r[idxCustomer])); });
  console.log(`Correction list has ${correctionNames.size} unique customer names.\n`);

  await mongoose.connect(process.env.MONGODB_URI);

  console.log('Checking Matter for every subscription with an active delivery on 2026-10-14 (this fetches full detail per candidate, can take a minute)...\n');
  const subsWithDelivery = await matterApiService.findSubscriptionsWithDeliveryOnDate('2026-10-14');
  console.log(`Matter subscriptions with a delivery on 2026-10-14: ${subsWithDelivery.length}\n`);

  const allCustomers = await Customer.find({})
    .select('customerId email phone firstName lastName address gpsLocation matterSubscriptionId matterCustomerId')
    .lean();

  const matchMap = resolveCustomerMatchBulk(allCustomers, subsWithDelivery);

  const results = [];
  for (const sub of subsWithDelivery) {
    const subId = String(sub.subscription_id);
    const matchEntry = matchMap.get(subId);
    const customer = matchEntry?.customer || null;
    const name = sub.name || customer ? `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim() || sub.name : sub.name;
    const inCorrectionList = correctionNames.has(normalizeName(sub.name)) || (customer && correctionNames.has(normalizeName(`${customer.firstName || ''} ${customer.lastName || ''}`)));

    if (!customer) {
      results.push({
        subscriptionId: subId, customerId: '', name: sub.name || '', status: 'NO_INTERNAL_CUSTOMER_MATCH',
        matchedBy: '', inCorrectionList, distanceKm: '', matterAddress: sub.address || '',
        matterLat: sub.address_detail?.coordinates?.lat ?? '', matterLng: sub.address_detail?.coordinates?.lng ?? '',
        internalAddress: '', internalLat: '', internalLng: ''
      });
      continue;
    }

    const matterLat = sub.address_detail?.coordinates?.lat;
    const matterLng = sub.address_detail?.coordinates?.lng;
    const hasInternalGps = Number.isFinite(customer.gpsLocation?.lat) && Number.isFinite(customer.gpsLocation?.lng);
    const hasMatterGps = Number.isFinite(matterLat) && Number.isFinite(matterLng);

    let status, distanceKm = '';
    if (!hasMatterGps) status = 'MATTER_HAS_NO_COORDINATES';
    else if (!hasInternalGps) status = 'NO_INTERNAL_GPS_ON_FILE';
    else {
      const km = haversineKm(matterLat, matterLng, customer.gpsLocation.lat, customer.gpsLocation.lng);
      distanceKm = km.toFixed(3);
      status = km < 0.15 ? 'MATCH' : `MISMATCH (${km.toFixed(2)} km apart)`;
    }

    results.push({
      subscriptionId: subId, customerId: customer.customerId, name,
      status, matchedBy: matchEntry?.matchedBy || '', inCorrectionList, distanceKm,
      matterAddress: sub.address || '', matterLat: matterLat ?? '', matterLng: matterLng ?? '',
      internalAddress: customer.address || '', internalLat: customer.gpsLocation?.lat ?? '', internalLng: customer.gpsLocation?.lng ?? ''
    });
  }

  const mismatches = results.filter((r) => r.status.startsWith('MISMATCH'));
  const matches = results.filter((r) => r.status === 'MATCH');
  const notInCorrectionList = results.filter((r) => !r.inCorrectionList);

  console.log('================ OCT 14 LIVE MATTER DELIVERY LOCATION CHECK ================\n');
  console.log(`Total Oct 14 customers checked: ${results.length}`);
  console.log(`  Match (<150m vs live Matter address):        ${matches.length}`);
  console.log(`  Mismatch:                                     ${mismatches.length}`);
  console.log(`  Other status (no link/no coords/etc):         ${results.length - matches.length - mismatches.length}`);
  console.log(`  NOT in the correction list applied earlier:   ${notInCorrectionList.length}`);

  console.log('\n--- Mismatches ---');
  mismatches.forEach((r) => {
    console.log(`  ${r.customerId} (${r.name}) — ${r.status} — in correction list: ${r.inCorrectionList}`);
    console.log(`     Matter:   ${r.matterLat}, ${r.matterLng} — ${r.matterAddress}`);
    console.log(`     Internal: ${r.internalLat}, ${r.internalLng} — ${r.internalAddress}`);
  });

  console.log('\n--- Other issues (not plain match/mismatch) ---');
  results.filter((r) => !r.status.startsWith('MISMATCH') && r.status !== 'MATCH').forEach((r) => {
    console.log(`  ${r.customerId || '(unmatched)'} (${r.name}) — ${r.status} — in correction list: ${r.inCorrectionList}`);
  });

  console.log('\n--- NOT included in the correction list (regardless of match status) ---');
  notInCorrectionList.forEach((r) => {
    console.log(`  ${r.customerId || '(unmatched)'} (${r.name}) — ${r.status}`);
  });

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'oct14-delivery-location-check.csv');
  const headers = ['subscriptionId', 'customerId', 'name', 'status', 'matchedBy', 'inCorrectionList', 'distanceKm', 'matterAddress', 'matterLat', 'matterLng', 'internalAddress', 'internalLat', 'internalLng'];
  fs.writeFileSync(outFile, [headers.join(','), ...results.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n'));
  console.log(`\nFull CSV: ${outFile}`);

  await mongoose.disconnect();
};

run().catch((err) => { console.error('Check failed:', err); process.exitCode = 1; mongoose.disconnect(); });
