// Read-only, detailed version of the address-review check: for each of the
// 57 flagged customers, reports side-by-side:
//   - the address text we were SENT (the file's "Supplied address")
//   - the address text in the internal database (Customer.address)
//   - raw GPS values from all three sources: file, internal database, and
//     the driver's actual captured delivery location
//   - whether file-vs-internal matches, and whether file-vs-driver matches
//     (each with the exact distance in km, not just yes/no)
//
// Driver evidence search order: Oct 19, then 18, then 17 (as before) — but
// if NONE of those three produces a match against the file's coordinates,
// this now searches the customer's ENTIRE delivery history (any date, not
// just those 3) for a delivery whose captured proof.location does match,
// and reports exactly which date that was.
//
// Makes NO changes.
//
// Usage: node scripts/checkAddressReviewDetailed.js "<xlsx path>"

import '../loadEnv.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import { haversineKm } from '../services/geocoding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATCH_THRESHOLD_KM = 0.15;
const RECENT_DATES = ['2026-10-19', '2026-10-18', '2026-10-17'];
const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const collapseWhitespace = (v) => String(v || '').trim().replace(/\s+/g, ' ');
const normalizeName = (v) => collapseWhitespace(v).toLowerCase();
const normAddr = (v) => collapseWhitespace(v).toLowerCase().replace(/[.,]/g, '');

const dayBounds = (dateKey) => {
  const start = new Date(`${dateKey}T00:00:00.000Z`);
  start.setUTCHours(start.getUTCHours() - 4);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
};
const toDateKey = (d) => new Date(d).toISOString().slice(0, 10);

const run = async () => {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) throw new Error('Usage: node scripts/checkAddressReviewDetailed.js "<xlsx path>"');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');

  const wb = XLSX.readFile(xlsxPath);
  const evidenceSheet = wb.Sheets['Source and evidence'];
  const evRows = XLSX.utils.sheet_to_json(evidenceSheet, { header: 1, defval: '' });
  const evHeaderIdx = evRows.findIndex((r) => r[0] === 'row');
  const evHeader = evRows[evHeaderIdx];
  const eCol = (name) => evHeader.indexOf(name);
  const evidenceList = evRows.slice(evHeaderIdx + 1)
    .filter((r) => r[eCol('row')] !== '')
    .map((r) => ({
      workbookRow: r[eCol('row')],
      name: r[eCol('name')],
      email: String(r[eCol('email')] || '').trim().toLowerCase(),
      address: r[eCol('address')],
      lat: parseFloat(r[eCol('lat')]),
      lon: parseFloat(r[eCol('lon')])
    }));

  await mongoose.connect(process.env.MONGODB_URI);

  const results = [];

  for (const ev of evidenceList) {
    // Resolve the internal customer — by email first, falling back to name
    // (several rows in this file have a blank or stale email).
    let customer = ev.email ? await Customer.findOne({ email: ev.email }).select('customerId firstName lastName address gpsLocation').lean() : null;
    if (!customer && ev.name) {
      const all = await Customer.find({}).select('customerId firstName lastName address gpsLocation').lean();
      customer = all.find((c) => normalizeName(`${c.firstName || ''} ${c.lastName || ''}`) === normalizeName(ev.name)) || null;
    }

    const fileHasCoords = Number.isFinite(ev.lat) && Number.isFinite(ev.lon);
    const internalAddress = customer?.address || '';
    const addressTextMatch = fileHasCoords && internalAddress
      ? (normAddr(internalAddress) === normAddr(ev.address) ? 'EXACT' : (normAddr(internalAddress).includes(normAddr(ev.address).slice(0, 15)) ? 'SIMILAR' : 'DIFFERENT'))
      : '';

    const hasInternalGps = customer && Number.isFinite(customer.gpsLocation?.lat) && Number.isFinite(customer.gpsLocation?.lng);
    const fileVsInternalKm = fileHasCoords && hasInternalGps
      ? haversineKm(ev.lat, ev.lon, customer.gpsLocation.lat, customer.gpsLocation.lng)
      : null;

    let driverLat = '', driverLng = '', driverDate = '', fileVsDriverKm = null, driverSearchNote = '';

    if (customer) {
      // Step 1: the 3 recent candidate dates, stop at the first MATCH (not
      // just the first one with any proof at all — a non-matching recent
      // proof shouldn't block checking older history for a real match).
      let bestRecent = null;
      for (const dateKey of RECENT_DATES) {
        const { start, end } = dayBounds(dateKey);
        const delivery = await Delivery.findOne({ customerId: customer.customerId, scheduledTime: { $gte: start, $lte: end } })
          .select('proof.location').lean();
        if (delivery?.proof?.location?.lat != null && delivery?.proof?.location?.lng != null) {
          const km = fileHasCoords ? haversineKm(ev.lat, ev.lon, delivery.proof.location.lat, delivery.proof.location.lng) : null;
          if (!bestRecent) bestRecent = { lat: delivery.proof.location.lat, lng: delivery.proof.location.lng, date: dateKey, km };
          if (km != null && km < MATCH_THRESHOLD_KM) { bestRecent = { lat: delivery.proof.location.lat, lng: delivery.proof.location.lng, date: dateKey, km }; break; }
        }
      }

      const recentMatched = bestRecent && bestRecent.km != null && bestRecent.km < MATCH_THRESHOLD_KM;

      if (recentMatched) {
        driverLat = bestRecent.lat; driverLng = bestRecent.lng; driverDate = bestRecent.date; fileVsDriverKm = bestRecent.km;
      } else {
        // Step 2: Oct 19/18/17 didn't match (or had no proof at all) — widen
        // to the customer's ENTIRE delivery history, looking for ANY day
        // whose captured proof location matches the file's coordinates.
        const allDeliveries = await Delivery.find({ customerId: customer.customerId })
          .select('proof.location scheduledTime').sort({ scheduledTime: -1 }).lean();
        let widerMatch = null;
        for (const d of allDeliveries) {
          if (d?.proof?.location?.lat == null || d?.proof?.location?.lng == null) continue;
          if (!fileHasCoords) break;
          const km = haversineKm(ev.lat, ev.lon, d.proof.location.lat, d.proof.location.lng);
          if (km < MATCH_THRESHOLD_KM) { widerMatch = { lat: d.proof.location.lat, lng: d.proof.location.lng, date: toDateKey(d.scheduledTime), km }; break; }
        }

        if (widerMatch) {
          driverLat = widerMatch.lat; driverLng = widerMatch.lng; driverDate = widerMatch.date; fileVsDriverKm = widerMatch.km;
          driverSearchNote = `No match in Oct 17-19; found in wider history (${allDeliveries.length} deliveries checked)`;
        } else if (bestRecent) {
          // Had proof on a recent day, just didn't match, and nothing in
          // full history matches either — report the closest recent one.
          driverLat = bestRecent.lat; driverLng = bestRecent.lng; driverDate = bestRecent.date; fileVsDriverKm = bestRecent.km;
          driverSearchNote = `Checked full history (${allDeliveries.length} deliveries) — no match anywhere, showing closest recent (${bestRecent.date})`;
        } else {
          driverSearchNote = `No captured GPS on any of ${allDeliveries.length} delivery record(s) for this customer`;
        }
      }
    } else {
      driverSearchNote = 'No internal customer found at all';
    }

    const fileVsInternalMatch = fileVsInternalKm != null ? (fileVsInternalKm < MATCH_THRESHOLD_KM ? 'MATCH' : 'NO MATCH') : 'N/A';
    const fileVsDriverMatch = fileVsDriverKm != null ? (fileVsDriverKm < MATCH_THRESHOLD_KM ? 'MATCH' : 'NO MATCH') : 'N/A';

    let outcome;
    if (fileVsDriverMatch === 'MATCH') outcome = 'Confirm';
    else if (fileVsInternalMatch === 'MATCH' && fileVsDriverMatch === 'NO MATCH') outcome = 'Open (internal matches, driver disagrees)';
    else outcome = 'Open';

    results.push({
      workbookRow: ev.workbookRow,
      name: ev.name,
      email: ev.email,
      customerId: customer?.customerId || '',
      sentAddress: ev.address,
      internalAddress,
      addressTextMatch,
      fileLat: ev.lat, fileLon: ev.lon,
      internalLat: customer?.gpsLocation?.lat ?? '', internalLng: customer?.gpsLocation?.lng ?? '',
      fileVsInternalKm: fileVsInternalKm != null ? fileVsInternalKm.toFixed(3) : '',
      fileVsInternalMatch,
      driverLat, driverLng, driverDate,
      fileVsDriverKm: fileVsDriverKm != null ? fileVsDriverKm.toFixed(3) : '',
      fileVsDriverMatch,
      driverSearchNote,
      outcome
    });
  }

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'address-review-detailed.csv');
  const headers = Object.keys(results[0]);
  fs.writeFileSync(outFile, [headers.join(','), ...results.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n'));

  console.log(`Total rows: ${results.length}`);
  console.log(`  Confirm:                                  ${results.filter(r => r.outcome === 'Confirm').length}`);
  console.log(`  Open (internal matches, driver disagrees): ${results.filter(r => r.outcome.startsWith('Open (internal')).length}`);
  console.log(`  Open (no match basis):                     ${results.filter(r => r.outcome === 'Open').length}`);
  console.log(`\nFull detailed CSV: ${outFile}`);

  // Also write a detailed sheet into a copy of the workbook.
  const detailHeaders = ['Workbook Row', 'Customer', 'Email', 'Customer ID', 'Sent Address', 'Internal Address', 'Address Text Match',
    'File Lat', 'File Lon', 'Internal Lat', 'Internal Lng', 'File vs Internal (km)', 'File vs Internal Match',
    'Driver Lat', 'Driver Lng', 'Driver Proof Date', 'File vs Driver (km)', 'File vs Driver Match', 'Search Note', 'Outcome'];
  const detailRows = results.map((r) => [r.workbookRow, r.name, r.email, r.customerId, r.sentAddress, r.internalAddress, r.addressTextMatch,
    r.fileLat, r.fileLon, r.internalLat, r.internalLng, r.fileVsInternalKm, r.fileVsInternalMatch,
    r.driverLat, r.driverLng, r.driverDate, r.fileVsDriverKm, r.fileVsDriverMatch, r.driverSearchNote, r.outcome]);
  const newSheet = XLSX.utils.aoa_to_sheet([detailHeaders, ...detailRows]);
  wb.Sheets['Detailed GPS Check'] = newSheet;
  if (!wb.SheetNames.includes('Detailed GPS Check')) wb.SheetNames.push('Detailed GPS Check');
  const outXlsx = xlsxPath.replace(/\.xlsx$/i, '-reviewed-detailed.xlsx').replace(/-reviewed(-detailed)?-reviewed-detailed/, '-reviewed-detailed');
  try {
    XLSX.writeFile(wb, outXlsx);
  } catch (err) {
    if (err.code === 'EBUSY') {
      console.log(`\nCould not write ${outXlsx} — it's open in Excel right now. Close it and re-run, or the CSV above already has everything.`);
    } else {
      throw err;
    }
  }
  console.log(`Detailed sheet added to: ${outXlsx}`);

  await mongoose.disconnect();
};

run().catch((err) => { console.error('Check failed:', err); process.exitCode = 1; mongoose.disconnect(); });
