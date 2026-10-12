// Issue #4: customer uploads must never change an existing customerId.
// Runs the real route handlers with the Mongoose statics stubbed (no DB), plus
// unit tests of the pure classifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import Customer from '../models/Customer.js';
import Delivery from '../models/Delivery.js';
import customersRouter from './customers.js';
import { classifyUploadRow } from '../services/customerUploadIdentity.js';

const A = { _id: 'oid-a', customerId: 'CUSTOMER-A', email: 'a@example.com' };
const B = { _id: 'oid-b', customerId: 'CUSTOMER-B', email: 'b@example.com' };

const handlerFor = (path, method) => {
  const layer = customersRouter.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const uploadBulk = handlerFor('/upload-bulk', 'post');
const uploadEmails = handlerFor('/upload-emails', 'post');
const renameId = handlerFor('/:oldCustomerId/rename-id', 'patch');

// Customer/Delivery stubs over a tiny in-memory "database" of Customer docs.
async function withDb(customers, fn) {
  const calls = { bulkOps: [], saved: [], deliveryWrites: 0, customerCreated: [] };
  const orig = {
    find: Customer.find, findOne: Customer.findOne, bulkWrite: Customer.bulkWrite,
    dUpdateMany: Delivery.updateMany, dUpdateOne: Delivery.updateOne
  };
  const inMemory = customers.map((c) => ({ ...c }));
  const chain = (rows) => {
    const q = { collation: () => q, select: () => q, lean: async () => rows, then: (res, rej) => Promise.resolve(rows).then(res, rej) };
    return q;
  };
  Customer.find = (filter) => {
    let rows = [];
    if (filter.customerId?.$in) rows = inMemory.filter((c) => filter.customerId.$in.includes(c.customerId));
    if (filter.email?.$in) rows = inMemory.filter((c) => filter.email.$in.some((e) => e.toLowerCase() === String(c.email).toLowerCase()));
    return chain(rows);
  };
  Customer.findOne = async (filter) => {
    let doc = null;
    if (filter.customerId) doc = inMemory.find((c) => c.customerId === filter.customerId);
    if (filter.email instanceof RegExp) doc = inMemory.find((c) => filter.email.test(c.email));
    if (!doc) return null;
    return { ...doc, async save() { calls.saved.push({ ...this }); } };
  };
  Customer.bulkWrite = async (ops) => { calls.bulkOps.push(...ops); return { upsertedCount: ops.filter((o) => o.updateOne.upsert).length, modifiedCount: 0, matchedCount: 0 }; };
  Delivery.updateMany = async () => { calls.deliveryWrites += 1; return {}; };
  Delivery.updateOne = async () => { calls.deliveryWrites += 1; return {}; };
  const origErr = console.error;
  console.error = () => {};
  try {
    return await fn(calls);
  } finally {
    console.error = origErr;
    Customer.find = orig.find; Customer.findOne = orig.findOne; Customer.bulkWrite = orig.bulkWrite;
    Delivery.updateMany = orig.dUpdateMany; Delivery.updateOne = orig.dUpdateOne;
  }
}

async function call(handler, body, params = {}) {
  const out = {};
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { out.status = this.statusCode; out.body = b; } };
  await handler({ body, params, user: { _id: 'u1' } }, res);
  return out;
}

const bulkRow = (o) => ({ name: 'Test Person', mealPlan: 'Standard', noOfMeals: 1, ...o });

// ---------- pure rules ----------
test('classifier: nothing exists -> create', () => {
  assert.equal(classifyUploadRow({ customerId: 'X' }, {}).action, 'create');
});
test('classifier: same customer by id and email -> ordinary update', () => {
  assert.equal(classifyUploadRow({ customerId: 'CUSTOMER-A' }, { byEmail: A, byId: A }).action, 'update');
});
test('classifier: email of A + id of B -> conflict, never a merge', () => {
  const r = classifyUploadRow({ customerId: 'CUSTOMER-B' }, { byEmail: A, byId: B });
  assert.equal(r.action, 'conflict');
  assert.equal(r.existingCustomerId, 'CUSTOMER-A');
  assert.equal(r.otherCustomerId, 'CUSTOMER-B');
});
test('classifier: existing email + a NEW id -> conflict (flagged, not renamed)', () => {
  const r = classifyUploadRow({ customerId: 'CUSTOMER-NEW' }, { byEmail: A, byId: null });
  assert.equal(r.action, 'conflict');
  assert.match(r.reason, /CUSTOMER-A/);
});
test('classifier: a generated id (legacy emails-only list) just matches by email', () => {
  assert.equal(classifyUploadRow({ customerId: 'a_example_com', idGenerated: true }, { byEmail: A, byId: null }).action, 'update');
});

// ---------- acceptance tests against the real handlers ----------
test('upload-bulk 1: existing email + new ID is flagged, nothing is written, IDs unchanged', async () => {
  await withDb([A], async (calls) => {
    const r = await call(uploadBulk, { customers: [bulkRow({ customerId: 'CUSTOMER-NEW', email: 'A@Example.com' })] });
    assert.equal(r.status, 200);
    assert.equal(r.body.conflicts.length, 1);
    assert.equal(r.body.conflicts[0].existingCustomerId, 'CUSTOMER-A');
    assert.equal(r.body.skipped, 1);
    assert.equal(calls.bulkOps.length, 0); // no customer mutated at all
    assert.equal(calls.deliveryWrites, 0);
  });
});

test('upload-bulk 2: email of A + id of B -> no merge, no mutation of either', async () => {
  await withDb([A, B], async (calls) => {
    const r = await call(uploadBulk, { customers: [bulkRow({ customerId: 'CUSTOMER-B', email: 'a@example.com' })] });
    assert.equal(r.body.conflicts.length, 1);
    assert.equal(r.body.conflicts[0].existingCustomerId, 'CUSTOMER-A');
    assert.equal(r.body.conflicts[0].otherCustomerId, 'CUSTOMER-B');
    assert.equal(calls.bulkOps.length, 0);
  });
});

test('upload-bulk 3: an ordinary update with the same ID succeeds and never writes customerId', async () => {
  await withDb([A], async (calls) => {
    const r = await call(uploadBulk, { customers: [bulkRow({ customerId: 'CUSTOMER-A', email: 'a@example.com', phone: '123' })] });
    assert.equal(r.body.conflicts, undefined);
    assert.equal(calls.bulkOps.length, 1);
    const op = calls.bulkOps[0].updateOne;
    assert.deepEqual(op.filter, { customerId: 'CUSTOMER-A' });
    assert.ok(!('upsert' in op) || op.upsert !== true);
    assert.ok(!('customerId' in op.update.$set), 'the ID is never part of the update');
    assert.equal(op.update.$set.phone, '123');
  });
});

test('upload-bulk: a brand-new customer is created; a duplicate row for it later in the file is an update, not a second create', async () => {
  await withDb([], async (calls) => {
    const r = await call(uploadBulk, { customers: [
      bulkRow({ customerId: 'NEW-1', email: 'n@example.com' }),
      bulkRow({ customerId: 'NEW-1', email: 'n@example.com', phone: '9' })
    ] });
    assert.equal(r.body.conflicts, undefined);
    assert.equal(calls.bulkOps.filter((o) => o.updateOne.upsert).length, 1);
    assert.equal(calls.bulkOps.length, 2);
  });
});

test('upload-bulk 5: a failed/conflicting upload cannot orphan delivery history (no delivery or customer write)', async () => {
  await withDb([A, B], async (calls) => {
    await call(uploadBulk, { customers: [
      bulkRow({ customerId: 'CUSTOMER-B', email: 'a@example.com' }),
      bulkRow({ customerId: 'RENAMED-A', email: 'a@example.com' })
    ] });
    assert.equal(calls.bulkOps.length, 0);
    assert.equal(calls.deliveryWrites, 0);
  });
});

test('upload-emails: existing email + new ID is flagged and not renamed; same-ID update keeps the ID', async () => {
  await withDb([A], async (calls) => {
    const r = await call(uploadEmails, { customers: [
      { customerId: 'CUSTOMER-NEW', name: 'Alice Doe', email: 'a@example.com' },
      { customerId: 'CUSTOMER-A', name: 'Alice Doe', email: 'a@example.com' }
    ] });
    assert.equal(r.body.conflicts.length, 1);
    assert.equal(r.body.updated, 1);
    assert.equal(calls.saved.length, 1);
    assert.equal(calls.saved[0].customerId, 'CUSTOMER-A'); // never overwritten
  });
});

test('upload-emails: the legacy emails-only list matches the person by email and does not rename them', async () => {
  await withDb([A], async (calls) => {
    const r = await call(uploadEmails, { emails: ['a@example.com'] });
    assert.equal(r.body.conflicts, undefined);
    assert.equal(r.body.updated, 1);
    assert.equal(calls.saved[0].customerId, 'CUSTOMER-A'); // not the generated "a_example_com"
  });
});

test('rename-id (the audited route) cascades and logs before/after', async () => {
  const origFindOne = Customer.findOne;
  const origInfo = console.info;
  const logs = [];
  const doc = { _id: 'oid-a', customerId: 'CUSTOMER-A', async save() {} };
  let lookups = 0;
  Customer.findOne = (filter) => {
    lookups += 1;
    if (filter._id) return { select: async () => null }; // no clash
    return Promise.resolve(doc);
  };
  console.info = (...a) => logs.push(a);
  try {
    // The 9 cascade models run real updateMany against Mongo; stub them out.
    const models = (await Promise.all([
      import('../models/Delivery.js'), import('../models/DeliveryChange.js'), import('../models/DeliveryIssue.js'),
      import('../models/BagNote.js'), import('../models/Bag.js'), import('../models/Communication.js'),
      import('../models/FlaggedAlert.js'), import('../models/SlackLog.js'), import('../models/MenuSelectionRecord.js')
    ])).map((m) => m.default);
    const origs = models.map((m) => m.updateMany);
    models.forEach((m) => { m.updateMany = async () => ({ modifiedCount: 2 }); });
    let r;
    try {
      r = await call(renameId, { newCustomerId: 'CUSTOMER-A2' }, { oldCustomerId: 'CUSTOMER-A' });
    } finally {
      models.forEach((m, i) => { m.updateMany = origs[i]; });
    }
    assert.equal(r.body.success, true);
    assert.equal(r.body.cascaded.deliveries, 2);
    const entry = JSON.parse(logs.find((l) => l[0] === '[customer-id-rename]')[1]);
    assert.equal(entry.from, 'CUSTOMER-A');
    assert.equal(entry.to, 'CUSTOMER-A2');
    assert.equal(entry.by, 'u1');
  } finally {
    Customer.findOne = origFindOne;
    console.info = origInfo;
  }
});
