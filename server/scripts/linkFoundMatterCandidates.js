// Links the 15 customers found by auditCustomerMatterLinkage.js
// (linkage-missing-both-with-candidate.csv) to their Matter subscription.
// Email matches are trusted directly (same confidence tier as
// resolveCustomerMatch's email cascade). Name-only matches get an extra
// phone-number corroboration check (1 detail fetch per row) before linking,
// since a name alone can collide between two different people — several of
// these internal records have corrupted emails (typos, placeholder values),
// which is WHY they fell through to a name-only match in the first place.
//
// SAFE BY DEFAULT: dry run unless you pass --apply.
//
// Usage:
//   node scripts/linkFoundMatterCandidates.js            (dry run)
//   node scripts/linkFoundMatterCandidates.js --apply     (writes)

import '../loadEnv.js';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Customer from '../models/Customer.js';
import matterApiService from '../services/matterApiService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');

const parseCsv = (text) => {
  const lines = text.split('\n').filter((l) => l.trim());
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || [])
      .filter((c) => c !== '')
      .map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
};

const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '');
const phoneSuffix = (value, len = 9) => normalizePhoneDigits(value).slice(-len);

const run = async () => {
  const csvPath = path.join(__dirname, 'output', 'linkage-missing-both-with-candidate.csv');
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${rows.length} candidate(s)\n`);

  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI);

  for (const row of rows) {
    const customer = await Customer.findOne({ customerId: row.customerId });
    if (!customer) { console.log(`SKIP  ${row.customerId}: not found`); continue; }

    // Never overwrite an existing link — this script only fills gaps.
    if (customer.matterSubscriptionId || customer.matterCustomerId) {
      console.log(`SKIP  ${row.customerId}: already has a Matter link, re-run the audit instead of trusting this stale CSV row`);
      continue;
    }

    const clashSub = await Customer.findOne({ matterSubscriptionId: row.candidateSubscriptionId, _id: { $ne: customer._id } });
    if (clashSub) {
      console.log(`SKIP  ${row.customerId}: subscription ${row.candidateSubscriptionId} already linked to ${clashSub.customerId} — needs manual review`);
      continue;
    }

    let confidence = row.matchedBy;
    let reason = 'matched by email';

    if (row.matchedBy === 'name') {
      try {
        const detail = await matterApiService.getSubscription(row.candidateSubscriptionId);
        const matterPhone = detail?.data?.phone || '';
        const internalSuffix = phoneSuffix(customer.phone);
        const matterSuffix = phoneSuffix(matterPhone);

        if (!internalSuffix) {
          reason = 'name match, no internal phone on file to cross-check — linking on name alone';
        } else if (internalSuffix === matterSuffix) {
          confidence = 'name+phone';
          reason = 'name match, phone number corroborates';
        } else {
          console.log(`SKIP  ${row.customerId} (${row.name}): name matched but phone does NOT corroborate (internal ...${internalSuffix} vs Matter ...${matterSuffix}) — needs manual review, not linking`);
          continue;
        }
      } catch (err) {
        console.log(`SKIP  ${row.customerId}: could not fetch subscription detail to verify (${err.message})`);
        continue;
      }
    }

    console.log(`LINK  ${row.customerId} (${row.name || row.email}) -> subscription ${row.candidateSubscriptionId}, matterCustomerId ${row.candidateMatterCustomerId} [${reason}]`);
    if (APPLY) {
      await Customer.updateOne(
        { _id: customer._id },
        { $set: { matterSubscriptionId: String(row.candidateSubscriptionId), matterCustomerId: String(row.candidateMatterCustomerId) } }
      );
    }
  }

  if (!APPLY) console.log('\nDry run only — nothing was changed. Re-run with --apply to write these changes.');
  await mongoose.disconnect();
};

run().catch((err) => { console.error('Linking failed:', err); process.exitCode = 1; mongoose.disconnect(); });
