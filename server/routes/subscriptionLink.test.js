// Issue #3: relinking a subscription must leave exactly one valid owner.
// Runs the real POST /customers/match/link handler against an in-memory
// stand-in for Customer, with a fake session whose transaction rolls back the
// in-memory data when the callback throws (what MongoDB does for real).
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import customersRouter from './customers.js';
import { MATCH_PROJECTION } from '../services/customerMatchService.js';

const linkHandler = customersRouter.stack
  .find((l) => l.route?.path === '/match/link' && l.route.methods.post)
  .route.stack.at(-1).handle;

const SUB = 'SUB-A';
const seed = () => [
  { _id: 'oid-a', customerId: 'CUSTOMER-A', matterSubscriptionId: SUB },
  { _id: 'oid-b', customerId: 'CUSTOMER-B', matterSubscriptionId: null },
  { _id: 'oid-c', customerId: 'CUSTOMER-C', matterSubscriptionId: null }
];

async function withFakeDb({ transactions = true, failTargetUpdate = null } = {}, fn) {
  let rows = seed();
  const log = { sessionWrites: [], plainWrites: [], locks: [], selected: [], lockBeforeClear: null };
  const orig = {
    findOne: Customer.findOne, find: Customer.find, updateMany: Customer.updateMany,
    findOneAndUpdate: Customer.findOneAndUpdate, startSession: mongoose.startSession, dbCollection: Customer.db.collection
  };
  const query = (resolveValue, onSelect) => {
    const q = {
      select: (p) => { onSelect?.(p); return q; },
      lean: async () => resolveValue(),
      then: (res, rej) => Promise.resolve(resolveValue()).then(res, rej)
    };
    return q;
  };
  const match = (filter) => rows.filter((r) => Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && '$ne' in v) return r[k] !== v.$ne;
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(r[k]);
    return r[k] === v;
  }));
  const record = (kind, options) => { (options?.session ? log.sessionWrites : log.plainWrites).push(kind); };

  Customer.findOne = (filter) => query(() => { const m = match(filter)[0]; return m ? { ...m } : null; });
  Customer.find = (filter) => query(() => match(filter).map((r) => ({ ...r })));
  Customer.updateMany = async (filter, update, options) => {
    record('clear', options);
    if (log.locks.length && log.lockBeforeClear === null) log.lockBeforeClear = true;
    match(filter).forEach((r) => Object.assign(r, update.$set));
    return {};
  };
  Customer.findOneAndUpdate = (filter, update, options) => query(async () => {
    record('set', options);
    if (failTargetUpdate) throw failTargetUpdate;
    const r = match(filter)[0];
    if (!r) return null;
    Object.assign(r, update.$set);
    return { ...r };
  }, (p) => log.selected.push(p));
  Customer.db.collection = () => ({
    updateOne: async (filter, update, options) => {
      if (update.$inc) { log.locks.push({ id: filter._id, withSession: !!options?.session }); if (log.lockBeforeClear === null) log.lockBeforeClear = false; log.lockBeforeClear = log.sessionWrites.length === 0; }
      return {};
    }
  });
  mongoose.startSession = async () => ({
    withTransaction: async (cb) => {
      if (!transactions) { const e = new Error('Transaction numbers are only allowed on a replica set member or mongos'); e.code = 20; throw e; }
      const snapshot = JSON.parse(JSON.stringify(rows));
      try { await cb(); } catch (e) { rows = snapshot; throw e; } // rollback
    },
    endSession: async () => {}
  });
  const origErr = console.error; console.error = () => {};
  try {
    return await fn({ owners: () => rows.filter((r) => r.matterSubscriptionId === SUB).map((r) => r.customerId), rows: () => rows, log });
  } finally {
    console.error = origErr;
    Customer.findOne = orig.findOne; Customer.find = orig.find; Customer.updateMany = orig.updateMany;
    Customer.findOneAndUpdate = orig.findOneAndUpdate; mongoose.startSession = orig.startSession; Customer.db.collection = orig.dbCollection;
  }
}

async function link(body) {
  const out = {};
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { out.status = this.statusCode; out.body = b; } };
  await linkHandler({ body }, res);
  return out;
}

test('1: relinking SUB-A from CUSTOMER-A to CUSTOMER-B leaves exactly one owner and succeeds', async () => {
  await withFakeDb({}, async (db) => {
    const r = await link({ customerId: 'CUSTOMER-B', subscriptionId: SUB });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.customer.customerId, 'CUSTOMER-B');
    assert.equal(r.body.data.matchedBy, 'manual');
    assert.deepEqual(db.owners(), ['CUSTOMER-B']);
    assert.ok(db.log.selected.includes(MATCH_PROJECTION), 'the (previously undefined) projection is applied');
  });
});

test('2: an unknown target returns 404, the original owner is unchanged and nothing was cleared', async () => {
  await withFakeDb({}, async (db) => {
    const r = await link({ customerId: 'NOPE', subscriptionId: SUB });
    assert.equal(r.status, 404);
    assert.deepEqual(db.owners(), ['CUSTOMER-A']);
    assert.equal(db.log.sessionWrites.length + db.log.plainWrites.length, 0);
  });
});

test('3: an injected failure while setting the target rolls back — the old owner is preserved', async () => {
  await withFakeDb({ failTargetUpdate: new Error('injected target-update failure') }, async (db) => {
    const r = await link({ customerId: 'CUSTOMER-B', subscriptionId: SUB });
    assert.equal(r.status, 500);
    assert.deepEqual(db.owners(), ['CUSTOMER-A']);
  });
});

test('4: both writes and a per-subscription lock bump run inside the transaction (serializes concurrent relinks)', async () => {
  await withFakeDb({}, async (db) => {
    await link({ customerId: 'CUSTOMER-B', subscriptionId: SUB });
    assert.deepEqual(db.log.sessionWrites, ['clear', 'set']);
    assert.equal(db.log.plainWrites.length, 0);
    assert.equal(db.log.locks.length, 1);
    assert.equal(db.log.locks[0].id, SUB);
    assert.equal(db.log.locks[0].withSession, true);
  });
});

test('4b: two relinks of the same subscription one after another end with a single owner (the later one wins)', async () => {
  await withFakeDb({}, async (db) => {
    await link({ customerId: 'CUSTOMER-B', subscriptionId: SUB });
    await link({ customerId: 'CUSTOMER-C', subscriptionId: SUB });
    assert.deepEqual(db.owners(), ['CUSTOMER-C']);
  });
});

test('5: repeating the same successful request is harmless', async () => {
  await withFakeDb({}, async (db) => {
    const first = await link({ customerId: 'CUSTOMER-B', subscriptionId: SUB });
    const second = await link({ customerId: 'CUSTOMER-B', subscriptionId: SUB });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(db.owners(), ['CUSTOMER-B']);
    assert.equal(db.rows().find((r) => r.customerId === 'CUSTOMER-C').matterSubscriptionId, null); // others untouched
  });
});

test('first-time link (no previous owner) works', async () => {
  await withFakeDb({}, async (db) => {
    const r = await link({ customerId: 'CUSTOMER-C', subscriptionId: 'SUB-NEW' });
    assert.equal(r.status, 200);
    assert.equal(db.rows().find((x) => x.customerId === 'CUSTOMER-C').matterSubscriptionId, 'SUB-NEW');
  });
});

test('standalone MongoDB (no transactions): same result, and a failed set restores the previous owner', async () => {
  await withFakeDb({ transactions: false }, async (db) => {
    const r = await link({ customerId: 'CUSTOMER-B', subscriptionId: SUB });
    assert.equal(r.status, 200);
    assert.deepEqual(db.owners(), ['CUSTOMER-B']);
  });
  await withFakeDb({ transactions: false, failTargetUpdate: new Error('boom') }, async (db) => {
    const r = await link({ customerId: 'CUSTOMER-B', subscriptionId: SUB });
    assert.equal(r.status, 500);
    assert.deepEqual(db.owners(), ['CUSTOMER-A']); // restored, not ownerless
  });
});

test('a duplicate-key error from the database becomes a 409, not a 500', async () => {
  const dup = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
  await withFakeDb({ failTargetUpdate: dup }, async (db) => {
    const r = await link({ customerId: 'CUSTOMER-B', subscriptionId: SUB });
    assert.equal(r.status, 409);
    assert.deepEqual(db.owners(), ['CUSTOMER-A']);
  });
});

test('missing fields are still rejected with 400', async () => {
  await withFakeDb({}, async () => {
    assert.equal((await link({ customerId: 'CUSTOMER-B' })).status, 400);
    assert.equal((await link({ subscriptionId: SUB })).status, 400);
  });
});
