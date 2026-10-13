// Read-only report: every internal Customer should be linked to Matter by
// BOTH matterCustomerId (permanent, survives renewals) and
// matterSubscriptionId (the currently-active subscription, can go stale).
// Reports who's missing either, who has a stale/dead subscription id, and
// finds duplicate internal Customer records — using matterCustomerId as the
// authoritative signal (Customer.js's own comment: "a customer who exists
// twice internally shares one Matter customer id"), which is far more
// reliable than fuzzy name/phone matching.
//
// Makes NO changes — pure report.
//
// Usage: node scripts/auditCustomerMatterLinkage.js

import '../loadEnv.js';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Customer from '../models/Customer.js';
import matterApiService from '../services/matterApiService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const csvEscape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const writeCsv = (filePath, rows) => {
  if (rows.length === 0) {
    fs.writeFileSync(filePath, '(no rows)\n');
    return;
  }
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n');
  fs.writeFileSync(filePath, csv);
};

const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '');
const phoneSuffix = (value, len = 9) => normalizePhoneDigits(value).slice(-len);
const collapseWhitespace = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const normalizeName = (first, last) => collapseWhitespace([first, last].filter(Boolean).join(' ')).toLowerCase();

const run = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected (read-only). Loading customers and Matter subscriptions...\n');

  const customers = await Customer.find({})
    .select('customerId email phone firstName lastName matterSubscriptionId matterCustomerId dataSource isActive')
    .lean();
  console.log(`Internal customers: ${customers.length}`);

  const allSubs = await matterApiService.listAllSubscriptions();
  console.log(`Matter subscriptions (all statuses): ${allSubs.length}\n`);

  // Lookup maps built once from the full list — avoids a per-customer API
  // call for the common cases (resolving matterCustomerId for an already-
  // linked subscription id, or checking whether a stored subscription id is
  // still alive).
  const bySubscriptionId = new Map();
  const byEmail = new Map();
  const byName = new Map();
  for (const sub of allSubs) {
    if (sub.subscription_id != null) bySubscriptionId.set(String(sub.subscription_id), sub);
    const email = String(sub.email || '').trim().toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, sub);
    const name = collapseWhitespace(sub.name).toLowerCase();
    if (name && !byName.has(name)) byName.set(name, sub);
  }

  const buckets = {
    fullyLinked: [],
    missingCustomerIdOnly: [],   // has subscriptionId, no customerId — fixable from the list alone
    staleSubscriptionId: [],     // has subscriptionId, but it's not in Matter's current list at all
    missingBoth: [],
    noMatterAccountFound: []     // missingBoth/missingCustomerIdOnly with no email/name match in Matter at all
  };

  for (const c of customers) {
    const hasSubId = !!c.matterSubscriptionId;
    const hasCustId = !!c.matterCustomerId;

    if (hasSubId && hasCustId) {
      buckets.fullyLinked.push(c);
      continue;
    }

    if (hasSubId && !hasCustId) {
      const liveSub = bySubscriptionId.get(String(c.matterSubscriptionId));
      if (liveSub) {
        buckets.missingCustomerIdOnly.push({ ...c, resolvedCustomerId: liveSub.customer_id, resolvedFrom: 'subscription id still active in Matter' });
      } else {
        buckets.staleSubscriptionId.push({ ...c, note: 'matterSubscriptionId not found in current Matter list — likely dead/renewed' });
      }
      continue;
    }

    // No subscription id at all — try to find a candidate via email, then name.
    const email = String(c.email || '').trim().toLowerCase();
    const name = normalizeName(c.firstName, c.lastName);
    const candidate = (email && byEmail.get(email)) || (name && byName.get(name)) || null;

    if (candidate) {
      buckets.missingBoth.push({
        ...c,
        candidateSubscriptionId: candidate.subscription_id,
        candidateCustomerId: candidate.customer_id,
        matchedBy: (email && byEmail.get(email) === candidate) ? 'email' : 'name'
      });
    } else {
      buckets.noMatterAccountFound.push(c);
    }
  }

  // ---- Duplicate detection ------------------------------------------------
  // 1. matterCustomerId shared by >1 internal Customer — the authoritative
  //    "this is the same real person, duplicated internally" signal.
  const byMatterCustomerId = new Map();
  customers.filter((c) => c.matterCustomerId).forEach((c) => {
    const key = String(c.matterCustomerId);
    if (!byMatterCustomerId.has(key)) byMatterCustomerId.set(key, []);
    byMatterCustomerId.get(key).push(c);
  });
  const confirmedDuplicates = [...byMatterCustomerId.entries()].filter(([, group]) => group.length > 1);

  // 2. matterSubscriptionId duplicates — should be impossible (unique sparse
  //    index), checked anyway in case of a pre-index-era data issue.
  const bySubId = new Map();
  customers.filter((c) => c.matterSubscriptionId).forEach((c) => {
    const key = String(c.matterSubscriptionId);
    if (!bySubId.has(key)) bySubId.set(key, []);
    bySubId.get(key).push(c);
  });
  const subIdViolations = [...bySubId.entries()].filter(([, group]) => group.length > 1);

  // 3. Duplicate email (case-insensitive) — should also be impossible per
  //    unique sparse index, checked for the same reason.
  const byEmailLocal = new Map();
  customers.filter((c) => c.email).forEach((c) => {
    const key = String(c.email).trim().toLowerCase();
    if (!byEmailLocal.has(key)) byEmailLocal.set(key, []);
    byEmailLocal.get(key).push(c);
  });
  const emailViolations = [...byEmailLocal.entries()].filter(([, group]) => group.length > 1);

  // 4. Among customers with NO matterCustomerId at all (can't use the
  //    authoritative check), a weaker fuzzy pass: same normalized name AND
  //    matching phone suffix — reported as candidates only, never auto-merged.
  const noCustIdPool = customers.filter((c) => !c.matterCustomerId && (c.firstName || c.lastName));
  const fuzzyGroups = new Map();
  noCustIdPool.forEach((c) => {
    const name = normalizeName(c.firstName, c.lastName);
    const suffix = phoneSuffix(c.phone);
    if (!name || !suffix) return;
    const key = `${name}::${suffix}`;
    if (!fuzzyGroups.has(key)) fuzzyGroups.set(key, []);
    fuzzyGroups.get(key).push(c);
  });
  const fuzzyDuplicates = [...fuzzyGroups.entries()].filter(([, group]) => group.length > 1);

  // ---- Report ---------------------------------------------------------------
  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });

  writeCsv(path.join(outDir, 'linkage-missing-customerid-only.csv'), buckets.missingCustomerIdOnly.map((c) => ({
    customerId: c.customerId, email: c.email || '', name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    matterSubscriptionId: c.matterSubscriptionId, resolvedMatterCustomerId: c.resolvedCustomerId
  })));
  writeCsv(path.join(outDir, 'linkage-stale-subscription-id.csv'), buckets.staleSubscriptionId.map((c) => ({
    customerId: c.customerId, email: c.email || '', name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    deadMatterSubscriptionId: c.matterSubscriptionId, matterCustomerId: c.matterCustomerId || ''
  })));
  writeCsv(path.join(outDir, 'linkage-missing-both-with-candidate.csv'), buckets.missingBoth.map((c) => ({
    customerId: c.customerId, email: c.email || '', name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    candidateSubscriptionId: c.candidateSubscriptionId, candidateMatterCustomerId: c.candidateCustomerId, matchedBy: c.matchedBy
  })));
  writeCsv(path.join(outDir, 'linkage-no-matter-account-found.csv'), buckets.noMatterAccountFound.map((c) => ({
    customerId: c.customerId, email: c.email || '', name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    phone: c.phone || '', dataSource: c.dataSource || '', isActive: c.isActive
  })));
  writeCsv(path.join(outDir, 'duplicates-confirmed-by-matter-customer-id.csv'),
    confirmedDuplicates.flatMap(([matterCustomerId, group]) => group.map((c) => ({
      matterCustomerId, customerId: c.customerId, email: c.email || '',
      name: `${c.firstName || ''} ${c.lastName || ''}`.trim(), matterSubscriptionId: c.matterSubscriptionId || '',
      dataSource: c.dataSource || ''
    }))));
  writeCsv(path.join(outDir, 'duplicates-fuzzy-name-phone.csv'),
    fuzzyDuplicates.flatMap(([key, group]) => group.map((c) => ({
      groupKey: key, customerId: c.customerId, email: c.email || '',
      name: `${c.firstName || ''} ${c.lastName || ''}`.trim(), phone: c.phone || '', dataSource: c.dataSource || ''
    }))));

  console.log('================ CUSTOMER MATTER LINKAGE AUDIT ================\n');
  console.log(`Total internal customers:                    ${customers.length}`);
  console.log(`  Fully linked (customerId + subscriptionId): ${buckets.fullyLinked.length}`);
  console.log(`  Missing matterCustomerId only (fixable free): ${buckets.missingCustomerIdOnly.length}`);
  console.log(`  Stale/dead matterSubscriptionId:             ${buckets.staleSubscriptionId.length}`);
  console.log(`  Missing both, candidate found in Matter:     ${buckets.missingBoth.length}`);
  console.log(`  Missing both, NO Matter account found:       ${buckets.noMatterAccountFound.length}`);
  console.log('');
  console.log(`Confirmed duplicate internal records (same matterCustomerId): ${confirmedDuplicates.length} group(s), ${confirmedDuplicates.reduce((s, [, g]) => s + g.length, 0)} record(s)`);
  if (subIdViolations.length) console.log(`  !! matterSubscriptionId unique-index violations: ${subIdViolations.length} (should be impossible — data integrity issue)`);
  if (emailViolations.length) console.log(`  !! email unique-index violations: ${emailViolations.length} (should be impossible — data integrity issue)`);
  console.log(`Fuzzy duplicate candidates (no matterCustomerId to confirm, same name+phone): ${fuzzyDuplicates.length} group(s)`);

  console.log('\n--- Confirmed duplicates (by matterCustomerId) ---');
  confirmedDuplicates.forEach(([matterCustomerId, group]) => {
    console.log(`  Matter customer ${matterCustomerId}:`);
    group.forEach((c) => console.log(`    ${c.customerId} | ${c.email || '(no email)'} | ${c.firstName || ''} ${c.lastName || ''} | source=${c.dataSource || '?'}`));
  });

  if (subIdViolations.length) {
    console.log('\n--- matterSubscriptionId violations (unexpected) ---');
    subIdViolations.forEach(([subId, group]) => {
      console.log(`  Subscription ${subId}: ${group.map((c) => c.customerId).join(', ')}`);
    });
  }
  if (emailViolations.length) {
    console.log('\n--- email violations (unexpected) ---');
    emailViolations.forEach(([email, group]) => {
      console.log(`  ${email}: ${group.map((c) => c.customerId).join(', ')}`);
    });
  }

  console.log(`\nFull CSVs written to: ${outDir}`);
  console.log('  linkage-missing-customerid-only.csv       — zero-cost fix, resolved from the Matter list already pulled');
  console.log('  linkage-stale-subscription-id.csv         — needs relinking (same pattern as matterNutritionLookup.js auto-repair)');
  console.log('  linkage-missing-both-with-candidate.csv   — found via email/name, needs confirmation before linking');
  console.log('  linkage-no-matter-account-found.csv       — no match at all; may be manual/non-Matter customers');
  console.log('  duplicates-confirmed-by-matter-customer-id.csv — same real person, two+ internal records');
  console.log('  duplicates-fuzzy-name-phone.csv           — unconfirmed candidates, review manually');

  await mongoose.disconnect();
};

run().catch((err) => { console.error('Audit failed:', err); process.exitCode = 1; mongoose.disconnect(); });
