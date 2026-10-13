// Read-only report, reverse direction from auditCustomerMatterLinkage.js:
// starting from every subscription that currently exists in Matter, checks
// (1) is there an internal Customer profile for it at all, (2) does that
// profile have BOTH matterCustomerId and matterSubscriptionId stored, and
// (3) do the shared fields actually agree between Matter and the internal
// record — name, email, phone, meal plan/frequency, breakfast, snacks,
// macros, exclusions. Address and GPS coordinates are deliberately never
// compared (per request) — Matter's customer_addresses are a different
// concern (resolveDeliveryCoordinatesCached / Customer.gpsLocation) from
// identity/plan data, and are known to differ in shape/source already.
//
// Field mapping (Matter -> internal), confirmed against a live subscription
// sample before writing this:
//   name              -> firstName + lastName (case-insensitive, whitespace-collapsed)
//   email             -> email
//   phone             -> phone (compared by last-9-digit suffix, formats differ)
//   plan.meal_frequency -> mealPerDay
//   breakfast_included  -> breakfastInclude
//   snacks_per_day      -> snackCount (and snacks_per_day > 0 vs mealSnack)
//   macros.protein/carbohydrates/fat -> macros.P/C/F
//   plan.name           -> mealPlan (reported only, not flagged as a hard
//                          mismatch — Matter's plan names, e.g. "Custom",
//                          don't correspond 1:1 to the internal enum, so an
//                          automatic match/mismatch verdict here would be
//                          noise; shown for a human to judge)
//   exclusions[].title  -> mealExclusion (comma string, compared as sets)
//
// Makes NO changes.
//
// Usage: node scripts/auditMatterVsInternalProfiles.js

import '../loadEnv.js';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Customer from '../models/Customer.js';
import matterApiService from '../services/matterApiService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current], current);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

const csvEscape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const collapseWhitespace = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '');
const phoneSuffix = (value, len = 9) => normalizePhoneDigits(value).slice(-len);
const normName = (value) => collapseWhitespace(value).toLowerCase();
const setFromExclusions = (str) => new Set(
  String(str || '').split(/[,;|]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
);
const setsEqual = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));

const run = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected (read-only). Loading Matter subscriptions and internal customers...\n');

  const allSubs = await matterApiService.listAllSubscriptions();
  console.log(`Matter subscriptions (all statuses): ${allSubs.length}`);

  const allCustomers = await Customer.find({})
    .select('customerId email phone firstName lastName macros mealPerDay breakfastInclude mealSnack snackCount mealPlan mealExclusion matterSubscriptionId matterCustomerId')
    .lean();
  console.log(`Internal customers: ${allCustomers.length}\n`);

  const byMatterCustomerId = new Map();
  const byMatterSubscriptionId = new Map();
  const byEmail = new Map();
  for (const c of allCustomers) {
    if (c.matterCustomerId) byMatterCustomerId.set(String(c.matterCustomerId), c);
    if (c.matterSubscriptionId) byMatterSubscriptionId.set(String(c.matterSubscriptionId), c);
    const email = String(c.email || '').trim().toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, c);
  }

  const rows = [];
  let noProfile = 0;
  let missingLinkFields = 0;
  let mismatched = 0;
  let clean = 0;

  await mapWithConcurrency(allSubs, 10, async (sub) => {
    let detail;
    try {
      detail = await matterApiService.getSubscription(sub.subscription_id);
    } catch (err) {
      rows.push({ subscriptionId: sub.subscription_id, matterCustomerId: sub.customer_id, status: 'DETAIL_FETCH_FAILED', detail: err.message });
      return;
    }
    const m = detail?.data;
    if (!m) return;

    const matterCustId = m.customer_id != null ? String(m.customer_id) : null;
    const matterSubId = String(m.subscription_id);
    const matched = (matterCustId && byMatterCustomerId.get(matterCustId))
      || byMatterSubscriptionId.get(matterSubId)
      || (m.email && byEmail.get(String(m.email).trim().toLowerCase()))
      || null;

    if (!matched) {
      noProfile += 1;
      rows.push({
        subscriptionId: matterSubId, matterCustomerId: matterCustId, matterName: m.name || '', matterEmail: m.email || '',
        status: 'NO_INTERNAL_PROFILE', detail: 'no internal Customer found by matterCustomerId, matterSubscriptionId, or email'
      });
      return;
    }

    const linkGaps = [];
    if (!matched.matterCustomerId) linkGaps.push('matterCustomerId not stored');
    if (!matched.matterSubscriptionId) linkGaps.push('matterSubscriptionId not stored');
    if (matched.matterCustomerId && matterCustId && String(matched.matterCustomerId) !== matterCustId) linkGaps.push(`matterCustomerId mismatch (internal=${matched.matterCustomerId}, matter=${matterCustId})`);
    if (matched.matterSubscriptionId && String(matched.matterSubscriptionId) !== matterSubId) linkGaps.push(`matterSubscriptionId mismatch (internal=${matched.matterSubscriptionId}, matter=${matterSubId})`);

    const fieldDiffs = [];

    const internalName = normName(`${matched.firstName || ''} ${matched.lastName || ''}`);
    const matterName = normName(m.name);
    if (matterName && internalName && matterName !== internalName) fieldDiffs.push(`name: internal="${internalName}" matter="${matterName}"`);

    const internalEmail = String(matched.email || '').trim().toLowerCase();
    const matterEmail = String(m.email || '').trim().toLowerCase();
    if (matterEmail && internalEmail && matterEmail !== internalEmail) fieldDiffs.push(`email: internal="${internalEmail}" matter="${matterEmail}"`);

    const internalPhoneSuffix = phoneSuffix(matched.phone);
    const matterPhoneSuffix = phoneSuffix(m.phone);
    if (matterPhoneSuffix && internalPhoneSuffix && matterPhoneSuffix !== internalPhoneSuffix) fieldDiffs.push(`phone: internal=...${internalPhoneSuffix} matter=...${matterPhoneSuffix}`);

    const matterMealFreq = m.plan?.meal_frequency ?? null;
    if (matterMealFreq != null && Number(matched.mealPerDay) !== Number(matterMealFreq)) fieldDiffs.push(`mealPerDay: internal=${matched.mealPerDay} matter=${matterMealFreq}`);

    const matterBreakfast = !!m.breakfast_included;
    if (!!matched.breakfastInclude !== matterBreakfast) fieldDiffs.push(`breakfastInclude: internal=${!!matched.breakfastInclude} matter=${matterBreakfast}`);

    const matterSnacks = m.snacks_per_day ?? 0;
    if (Number(matched.snackCount || 0) !== Number(matterSnacks)) fieldDiffs.push(`snackCount: internal=${matched.snackCount || 0} matter=${matterSnacks}`);
    const expectedMealSnack = Number(matterSnacks) > 0;
    if (!!matched.mealSnack !== expectedMealSnack) fieldDiffs.push(`mealSnack: internal=${!!matched.mealSnack} matter-implied=${expectedMealSnack}`);

    const mC = matched.macros?.C ?? 0;
    const mP = matched.macros?.P ?? 0;
    const mF = matched.macros?.F ?? 0;
    const matterMacros = m.macros || {};
    if (matterMacros.carbohydrates != null && Number(mC) !== Number(matterMacros.carbohydrates)) fieldDiffs.push(`macros.C: internal=${mC} matter=${matterMacros.carbohydrates}`);
    if (matterMacros.protein != null && Number(mP) !== Number(matterMacros.protein)) fieldDiffs.push(`macros.P: internal=${mP} matter=${matterMacros.protein}`);
    if (matterMacros.fat != null && Number(mF) !== Number(matterMacros.fat)) fieldDiffs.push(`macros.F: internal=${mF} matter=${matterMacros.fat}`);

    const matterExclusionSet = new Set((m.exclusions || []).map((e) => String(e.title || '').trim().toLowerCase()).filter(Boolean));
    const internalExclusionSet = setFromExclusions(matched.mealExclusion);
    if (matterExclusionSet.size > 0 && !setsEqual(matterExclusionSet, internalExclusionSet)) {
      fieldDiffs.push(`exclusions: internal={${[...internalExclusionSet].join('|')}} matter={${[...matterExclusionSet].join('|')}}`);
    }

    const planNameNote = (m.plan?.name && matched.mealPlan && m.plan.name !== matched.mealPlan)
      ? `plan name differs (not flagged as error): internal="${matched.mealPlan}" matter="${m.plan.name}"`
      : '';

    if (linkGaps.length) missingLinkFields += 1;
    if (fieldDiffs.length) mismatched += 1;
    if (!linkGaps.length && !fieldDiffs.length) clean += 1;

    rows.push({
      subscriptionId: matterSubId,
      matterCustomerId: matterCustId,
      internalCustomerId: matched.customerId,
      matterName: m.name || '',
      internalName: `${matched.firstName || ''} ${matched.lastName || ''}`.trim(),
      status: linkGaps.length || fieldDiffs.length ? 'ISSUES' : 'OK',
      linkGaps: linkGaps.join(' | '),
      fieldDiffs: fieldDiffs.join(' | '),
      planNameNote
    });
  });

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'matter-vs-internal-profile-audit.csv');
  const headers = ['subscriptionId', 'matterCustomerId', 'internalCustomerId', 'matterName', 'internalName', 'status', 'linkGaps', 'fieldDiffs', 'planNameNote', 'matterEmail', 'detail'];
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n');
  fs.writeFileSync(outFile, csv);

  console.log('================ MATTER -> INTERNAL PROFILE AUDIT ================\n');
  console.log(`Total Matter subscriptions checked:        ${allSubs.length}`);
  console.log(`  No internal profile found at all:        ${noProfile}`);
  console.log(`  Internal profile found, link field gaps: ${missingLinkFields}`);
  console.log(`  Internal profile found, field mismatches: ${mismatched}`);
  console.log(`  Clean (profile exists, fully matches):    ${clean}`);

  console.log('\n--- No internal profile at all ---');
  rows.filter((r) => r.status === 'NO_INTERNAL_PROFILE').forEach((r) => {
    console.log(`  sub ${r.subscriptionId} (cust ${r.matterCustomerId}): ${r.matterName} <${r.matterEmail}>`);
  });

  console.log('\n--- Link field gaps ---');
  rows.filter((r) => r.linkGaps).forEach((r) => {
    console.log(`  ${r.internalCustomerId} (sub ${r.subscriptionId}): ${r.linkGaps}`);
  });

  console.log('\n--- Field mismatches ---');
  rows.filter((r) => r.fieldDiffs).forEach((r) => {
    console.log(`  ${r.internalCustomerId} (sub ${r.subscriptionId}, ${r.matterName}):`);
    r.fieldDiffs.split(' | ').forEach((d) => console.log(`     - ${d}`));
    if (r.planNameNote) console.log(`     (note) ${r.planNameNote}`);
  });

  console.log(`\nFull CSV: ${outFile}`);
  await mongoose.disconnect();
};

run().catch((err) => { console.error('Audit failed:', err); process.exitCode = 1; mongoose.disconnect(); });
