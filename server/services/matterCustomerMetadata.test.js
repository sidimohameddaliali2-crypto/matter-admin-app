import { test } from 'node:test';
import assert from 'node:assert/strict';
import Customer from '../models/Customer.js';
import { captureCustomerMetadata, findCustomerMetadataRow, readCustomerMetadataRows, createCustomerMetadataRefresh } from './matterCustomerMetadata.js';

const at = new Date('2026-11-23T08:00:00Z');
const row = (extra = {}) => ({ subscription_id: 101, customer_id: 20, customer_type: 'returning', customer_tags: [{ id: 7, name: 'Ambassador', color: '#46A758' }],
  updated_at: '2026-11-22T10:00:00Z', upcoming_plan: { subscription_id: 102, customer_id: 20, subscription_status: 'scheduled',
    starting_date: '2026-11-24', plan: { name: 'Thrive' }, updated_at: '2026-11-23T07:00:00Z' }, ...extra });
const apiFor = rows => ({ listSubscriptions: async () => ({ data: rows, meta: { total_pages: 1, total_records: rows.length } }) });

test('captures the two source dates separately, with type and named tags, and persists through the customer schema', () => {
  const metadata = captureCustomerMetadata(row(), {}, at);
  assert.equal(metadata.updated_at.toISOString(), '2026-11-22T10:00:00.000Z');
  assert.equal(metadata.upcoming_plan.starting_date, '2026-11-24');
  assert.equal(metadata.upcoming_plan.plan.name, 'Thrive');
  const doc = new Customer({ customerId: 'synthetic', matterMetadata: metadata });
  assert.equal(doc.validateSync(), undefined);
  assert.deepEqual(doc.toObject().matterMetadata, metadata);
});

test('absent data remains unknown and explicit null/empty values clear saved labels', () => {
  const old = captureCustomerMetadata(row(), {}, at);
  const missing = { subscription_id: 101, customer_id: 20, updated_at: row().updated_at };
  assert.equal(captureCustomerMetadata(missing).upcoming_plan, undefined);
  assert.equal(captureCustomerMetadata(missing, old).upcoming_plan.plan.name, 'Thrive');
  const cleared = captureCustomerMetadata(row({ upcoming_plan: null, customer_type: null, customer_tags: [] }), old);
  assert.equal(cleared.upcoming_plan, null);
  assert.equal(cleared.customer_type, null);
  assert.deepEqual(cleared.customer_tags, []);
  assert.throws(() => captureCustomerMetadata(row({ upcoming_plan: { subscription_id: 102, customer_id: 99 } })), /identity/);
});

test('permanent customer identity wins, ambiguity is retained, and names/emails never select customers', () => {
  assert.equal(findCustomerMetadataRow({ matterCustomerId: '20', matterSubscriptionId: 'old' }, [row()]).subscription_id, 101);
  assert.equal(findCustomerMetadataRow({ matterCustomerId: '99', matterSubscriptionId: '101' }, [row()]), null);
  assert.equal(findCustomerMetadataRow({ matterSubscriptionId: '101' }, [row()]).customer_id, 20);
  assert.equal(findCustomerMetadataRow({ matterCustomerId: '20' }, [row(), row({ subscription_id: 103 })]), null);
  assert.equal(findCustomerMetadataRow({ email: 'same@example.test' }, [row({ email: 'same@example.test' })]), null);
});

test('reads every page and rejects inconsistent totals, duplicate IDs and failed pages', async () => {
  const calls = [];
  const api = { listSubscriptions: async ({ page }) => { calls.push(page); return { data: [row({ subscription_id: page })], meta: { total_pages: 2, total_records: 2 } }; } };
  assert.equal((await readCustomerMetadataRows(api)).length, 2);
  assert.deepEqual(calls, [1, 2]);
  await assert.rejects(readCustomerMetadataRows(apiFor([row(), row()])), /duplicate/);
  await assert.rejects(readCustomerMetadataRows({ listSubscriptions: async () => ({ data: [row()], meta: { total_pages: 1, total_records: 2 } }) }), /incomplete/);
  await assert.rejects(readCustomerMetadataRows({ listSubscriptions: async () => { throw new Error('offline'); } }), /offline/);
});

test('refresh only writes changed verified labels and fences concurrent refreshes and relinking', async () => {
  const old = captureCustomerMetadata(row({ customer_type: 'new' }), {}, new Date('2026-11-22'));
  const doc = { _id: 'internal', matterCustomerId: '20', matterSubscriptionId: '101', matterMetadata: old };
  const writes = [];
  const customers = { find: () => ({ select: () => ({ lean: async () => [doc] }) }), updateOne: async (filter, update) => { writes.push({ filter, update }); return { modifiedCount: 1 }; } };
  const refresh = createCustomerMetadataRefresh({ api: apiFor([row()]), customers, clock: () => at });
  assert.equal((await refresh()).updated, 1);
  assert.equal(writes[0].filter.matterCustomerId, '20');
  assert.equal(writes[0].filter.matterSubscriptionId, '101');
  assert.deepEqual(writes[0].filter.$and[0].$or[1], { 'matterMetadata.fetchedAt': { $lt: at } });
  assert.equal(Object.keys(writes[0].update.$set).join(), 'matterMetadata');
  doc.matterMetadata = writes[0].update.$set.matterMetadata;
  assert.equal((await refresh()).updated, 0);
  assert.equal(writes.length, 1);
  doc.matterMetadata.updated_at = new Date('2026-11-24');
  assert.equal((await refresh()).updated, 0);
  assert.equal(writes.length, 1);
  // A renewed subscription can have been bought before the old record's last
  // update; its independent timestamp must not prevent the new labels loading.
  const renewed = row({ subscription_id: 103, updated_at: '2026-11-20T10:00:00Z', upcoming_plan: null });
  const next = createCustomerMetadataRefresh({ api: apiFor([renewed]), customers, clock: () => new Date('2026-11-25') });
  assert.equal((await next()).updated, 1);
  assert.equal(writes[1].update.$set.matterMetadata.subscription_id, '103');
});

test('nested upcoming plan changes are captured even if parent updated_at is unchanged; failures preserve saved data', async () => {
  let writes = 0;
  const old = captureCustomerMetadata(row(), {}, new Date('2026-11-22'));
  const customers = { find: () => ({ select: () => ({ lean: async () => [{ _id: 'internal', matterCustomerId: '20', matterMetadata: old }] }) }),
    updateOne: async () => { writes++; return { modifiedCount: 1 }; } };
  await createCustomerMetadataRefresh({ api: apiFor([row({ upcoming_plan: null })]), customers, clock: () => at })();
  assert.equal(writes, 1);
  await assert.rejects(createCustomerMetadataRefresh({ api: apiFor([row({ updated_at: 'bad' })]), customers })());
  assert.equal(writes, 1);
});

test('HTTP refresh requires customers permission and an authorized staff role; customer reads retain captured fields', async t => {
  const [{ default: express }, { default: jwt }, { default: User }, { default: api }, { default: router }] = await Promise.all([
    import('express'), import('jsonwebtoken'), import('../models/User.js'), import('./matterApiService.js'), import('../routes/customers.js'),
  ]);
  const secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'synthetic-metadata-test-key';
  t.after(() => { if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; });
  let staff = { _id: 'staff', role: 'dispatcher', isActive: true, permissionsConfigured: true, permissions: { customers: true } };
  t.mock.method(User, 'findById', () => ({ select: async () => staff }));
  let vendorCalls = 0;
  t.mock.method(api, 'listSubscriptions', async () => { vendorCalls++; return { data: [row()], meta: { total_pages: 1, total_records: 1 } }; });
  const saved = { customerId: 'synthetic', matterCustomerId: '20', matterMetadata: captureCustomerMetadata(row(), {}, at) };
  t.mock.method(Customer, 'find', () => ({ select: fields => {
    assert.match(fields, /matterMetadata/);
    return { lean: async () => [], sort: () => ({ limit: async () => [saved] }) };
  } }));
  const app = express();
  app.use('/api/customers', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}/api/customers`;
  const headers = { Authorization: `Bearer ${jwt.sign({ id: 'staff' }, process.env.JWT_SECRET)}` };
  assert.equal((await fetch(`${origin}/matter-metadata/refresh`, { method: 'POST' })).status, 401);
  staff = { ...staff, role: 'driver' };
  assert.equal((await fetch(`${origin}/matter-metadata/refresh`, { method: 'POST', headers })).status, 403);
  staff = { ...staff, role: 'dispatcher', permissions: { customers: false } };
  assert.equal((await fetch(`${origin}/matter-metadata/refresh`, { method: 'POST', headers })).status, 403);
  assert.equal(vendorCalls, 0);
  staff = { ...staff, permissions: { customers: true } };
  assert.equal((await fetch(`${origin}/matter-metadata/refresh`, { method: 'POST', headers })).status, 200);
  assert.equal(vendorCalls, 1);
  const response = await fetch(origin, { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].matterMetadata.customer_type, 'returning');
});
