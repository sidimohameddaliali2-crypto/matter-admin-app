// Bulk-runs the app's own self-healing Matter link resolution
// (services/matterNutritionLookup.js getNutritionForCustomerLink) over every
// customer flagged by auditCustomerMatterLinkage.js as having a stale/dead
// matterSubscriptionId. This is the exact same logic that already runs
// opportunistically whenever Kitchen List fetches a customer's nutrition —
// this script just triggers it proactively for all of them at once instead
// of waiting for each to be touched individually.
//
// Safe by construction: getNutritionForCustomerLink only ever writes
// matterCustomerId (permanent, never wrong once found) and replaces
// matterSubscriptionId only when the existing one is empty or is the exact
// stale id being looked up — never overwrites a different live link, and
// gracefully no-ops on a unique-index collision.
//
// Usage: node scripts/bulkResolveStaleMatterLinks.js

import '../loadEnv.js';
import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import { getNutritionForCustomerLink } from '../services/matterNutritionLookup.js';

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

const run = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI);

  const candidates = await Customer.find({
    matterSubscriptionId: { $type: 'string' },
    $or: [{ matterCustomerId: null }, { matterCustomerId: { $exists: false } }]
  }).select('customerId email matterSubscriptionId matterCustomerId').lean();

  console.log(`Candidates with a subscription id but no matterCustomerId: ${candidates.length}\n`);

  let resolved = 0;
  let stillDead = 0;
  let failed = 0;

  await mapWithConcurrency(candidates, 8, async (c) => {
    try {
      const before = await Customer.findById(c._id).select('matterCustomerId matterSubscriptionId').lean();
      const nutrition = await getNutritionForCustomerLink({
        matterCustomerId: c.matterCustomerId,
        matterSubscriptionId: c.matterSubscriptionId,
        email: c.email
      });
      if (!nutrition) {
        stillDead += 1;
        console.log(`DEAD   ${c.customerId} (${c.email || 'no email'}) — no live Matter account found by subscription id or email`);
        return;
      }
      const after = await Customer.findById(c._id).select('matterCustomerId matterSubscriptionId').lean();
      if (after.matterCustomerId !== before.matterCustomerId || after.matterSubscriptionId !== before.matterSubscriptionId) {
        resolved += 1;
        console.log(`FIXED  ${c.customerId}: sub ${before.matterSubscriptionId || 'none'} -> ${after.matterSubscriptionId}, cust -> ${after.matterCustomerId}`);
      } else {
        stillDead += 1;
        console.log(`UNCHANGED ${c.customerId} — nutrition found but nothing new to persist (likely a unique-index conflict, see logs above)`);
      }
    } catch (error) {
      failed += 1;
      console.log(`ERROR  ${c.customerId}: ${error.message}`);
    }
  });

  console.log(`\nResolved/relinked: ${resolved}`);
  console.log(`Still dead (no live Matter account found): ${stillDead}`);
  console.log(`Errored: ${failed}`);

  await mongoose.disconnect();
};

run().catch((err) => { console.error('Bulk resolve failed:', err); process.exitCode = 1; mongoose.disconnect(); });
