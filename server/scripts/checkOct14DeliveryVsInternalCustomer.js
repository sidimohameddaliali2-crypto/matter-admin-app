// Read-only: for every Delivery scheduled 2026-10-14, compares its own
// address/gpsLocation (set at creation time, from whichever source created
// it — Matter import, manual entry, etc.) against the internal
// Customer.gpsLocation/address on file for that customerId. Two internal
// sources, not Matter — this is "did the delivery get created with the
// same location this customer's own profile has," not a freshness check
// against Matter.
//
// Makes NO changes.
//
// Usage: node scripts/checkOct14DeliveryVsInternalCustomer.js

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

const run = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI);

  const start = new Date('2026-10-14T00:00:00.000Z');
  start.setUTCHours(start.getUTCHours() - 4);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);

  const deliveries = await Delivery.find({ scheduledTime: { $gte: start, $lte: end } })
    .select('customerId customerName address gpsLocation')
    .lean();
  console.log(`Oct 14 deliveries: ${deliveries.length}\n`);

  const customerIds = [...new Set(deliveries.map((d) => d.customerId).filter(Boolean))];
  const customers = await Customer.find({ customerId: { $in: customerIds } })
    .select('customerId address gpsLocation')
    .lean();
  const customerById = new Map(customers.map((c) => [c.customerId, c]));

  const results = [];
  let match = 0, mismatch = 0, noInternalCustomer = 0, noDeliveryGps = 0, noInternalGps = 0;

  for (const d of deliveries) {
    const c = customerById.get(d.customerId);
    if (!c) {
      noInternalCustomer += 1;
      results.push({ customerId: d.customerId, name: d.customerName, status: 'NO_INTERNAL_CUSTOMER_RECORD', distanceKm: '', deliveryAddress: d.address || '', internalAddress: '' });
      continue;
    }

    const hasDeliveryGps = Number.isFinite(d.gpsLocation?.lat) && Number.isFinite(d.gpsLocation?.lng);
    const hasInternalGps = Number.isFinite(c.gpsLocation?.lat) && Number.isFinite(c.gpsLocation?.lng);

    let status, distanceKm = '';
    if (!hasDeliveryGps) { noDeliveryGps += 1; status = 'DELIVERY_HAS_NO_GPS'; }
    else if (!hasInternalGps) { noInternalGps += 1; status = 'INTERNAL_CUSTOMER_HAS_NO_GPS'; }
    else {
      const km = haversineKm(d.gpsLocation.lat, d.gpsLocation.lng, c.gpsLocation.lat, c.gpsLocation.lng);
      distanceKm = km.toFixed(3);
      if (km < 0.15) { match += 1; status = 'MATCH'; }
      else { mismatch += 1; status = `MISMATCH (${km.toFixed(2)} km apart)`; }
    }

    results.push({
      customerId: d.customerId, name: d.customerName, status, distanceKm,
      deliveryAddress: d.address || '', deliveryLat: d.gpsLocation?.lat ?? '', deliveryLng: d.gpsLocation?.lng ?? '',
      internalAddress: c.address || '', internalLat: c.gpsLocation?.lat ?? '', internalLng: c.gpsLocation?.lng ?? ''
    });
  }

  console.log('================ OCT 14 DELIVERY vs INTERNAL CUSTOMER ================\n');
  console.log(`Total Oct 14 deliveries checked: ${deliveries.length}`);
  console.log(`  Match (<150m):                  ${match}`);
  console.log(`  Mismatch:                       ${mismatch}`);
  console.log(`  Delivery has no GPS at all:     ${noDeliveryGps}`);
  console.log(`  Internal customer has no GPS:   ${noInternalGps}`);
  console.log(`  No internal customer record:    ${noInternalCustomer}`);

  console.log('\n--- Mismatches ---');
  results.filter((r) => r.status.startsWith('MISMATCH')).forEach((r) => {
    console.log(`  ${r.customerId} (${r.name}) — ${r.status}`);
    console.log(`     delivery: ${r.deliveryLat}, ${r.deliveryLng} — ${r.deliveryAddress}`);
    console.log(`     internal: ${r.internalLat}, ${r.internalLng} — ${r.internalAddress}`);
  });

  console.log('\n--- Other issues ---');
  results.filter((r) => !r.status.startsWith('MISMATCH') && r.status !== 'MATCH').forEach((r) => {
    console.log(`  ${r.customerId} (${r.name}) — ${r.status}`);
  });

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'oct14-delivery-vs-internal-customer.csv');
  const headers = ['customerId', 'name', 'status', 'distanceKm', 'deliveryAddress', 'deliveryLat', 'deliveryLng', 'internalAddress', 'internalLat', 'internalLng'];
  fs.writeFileSync(outFile, [headers.join(','), ...results.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n'));
  console.log(`\nFull CSV: ${outFile}`);

  await mongoose.disconnect();
};

run().catch((err) => { console.error('Check failed:', err); process.exitCode = 1; mongoose.disconnect(); });
