import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Digest from '../models/RefundDailyDigest.js';
import Link from '../models/CollectionRefundLink.js';
import Escalation from '../models/RefundEscalation.js';
import Delivery from '../models/Delivery.js';
import BagRefundCase from '../models/BagRefundCase.js';
import { digestDay, digestHourReady, loadRefundDigest, sendDailyRefundDigest, sendRefundDigestPayload } from './refundDailyDigests.js';
const saved = { BREVO_API_KEY: process.env.BREVO_API_KEY, COLLECTION_REFUND_EMAILS_ENABLED: process.env.COLLECTION_REFUND_EMAILS_ENABLED, COLLECTION_REFUND_ESCALATIONS_ENABLED: process.env.COLLECTION_REFUND_ESCALATIONS_ENABLED };
beforeEach(() => { process.env.BREVO_API_KEY = 'fixture'; delete process.env.COLLECTION_REFUND_EMAILS_ENABLED; delete process.env.COLLECTION_REFUND_ESCALATIONS_ENABLED; });
afterEach(() => { mock.restoreAll(); for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
const now = new Date('2026-11-27T11:00:00Z');
const facts = { total: 4, rows: [{ customerId: 'C001', customerName: 'Sara', completedAt: new Date(now - 50 * 3600000) }] };
function store({ legacy = false } = {}) {
  const entries = new Map();
  const key = value => `${value.kind}:${value.dateKey}`;
  mock.method(Digest, 'init', async () => {}); mock.method(Link, 'exists', async () => legacy); mock.method(Escalation, 'exists', async () => legacy);
  mock.method(Digest, 'updateOne', async (filter, update) => {
    if (update.$setOnInsert && !entries.has(key(filter))) entries.set(key(filter), { ...update.$setOnInsert, _id: key(filter) });
    if (update.$set) { const entry = [...entries.values()].find(item => item._id === filter._id); if (entry) Object.assign(entry, update.$set); }
    return {};
  });
  mock.method(Digest, 'findOne', filter => ({ lean: async () => structuredClone(entries.get(key(filter))) }));
  mock.method(Digest, 'findOneAndUpdate', (filter, update) => ({ lean: async () => {
    const entry = entries.get(key(filter));
    if (!entry || !filter.state.$in.includes(entry.state) || entry.leaseUntil > now || entry.nextAttemptAt > now) return null;
    Object.assign(entry, update.$set); return structuredClone(entry);
  } }));
  return entries;
}
test('daily quota uses Dubai dates and automated summaries start from 09:00 Dubai', () => {
  assert.equal(digestDay(new Date('2026-11-27T20:01:00Z')), '2026-11-28');
  assert.equal(digestHourReady(new Date('2026-11-27T04:59:00Z')), false); assert.equal(digestHourReady(new Date('2026-11-27T05:00:00Z')), true);
});
test('concurrent manual/automatic sends and repeated clicks share one daily message per recipient', async () => {
  store(); const sent = [];
  const options = { kind: 'accounts', now, load: async () => facts, send: async (kind, value, messageKey) => { sent.push({ kind, messageKey }); return { messageId: 'accepted' }; } };
  await Promise.all([sendDailyRefundDigest(options), sendDailyRefundDigest({ ...options, manual: true })]);
  assert.equal(sent.length, 1); assert.equal((await sendDailyRefundDigest(options)).alreadySent, true); assert.equal(sent.length, 1);
  await sendDailyRefundDigest({ ...options, kind: 'jana' }); assert.equal(sent.length, 2); assert.deepEqual(sent.map(item => item.kind), ['accounts', 'jana']);
  await sendDailyRefundDigest({ ...options, now: new Date(now.getTime() + 86400000) }); assert.equal(sent.length, 3);
});
test('no pending records means no automated email, but an explicit empty-queue portal invitation consumes the daily slot', async () => {
  store(); let sent = 0;
  const options = { kind: 'accounts', now, load: async () => ({ total: 0, rows: [] }), send: async () => { sent++; return { messageId: 'accepted' }; } };
  assert.equal((await sendDailyRefundDigest(options)).skipped, true); assert.equal(sent, 0);
  assert.equal((await sendDailyRefundDigest({ ...options, manual: true })).accepted, true); assert.equal(sent, 1);
  assert.equal((await sendDailyRefundDigest({ ...options, manual: true })).alreadySent, true);
});
test('Jana digest filters 48-hour pending clocks and excludes customers already paid in either ledger', async () => {
  let filter;
  mock.method(Delivery, 'distinct', async () => ['C-PAID']); mock.method(BagRefundCase, 'distinct', async () => ['C-BAG-PAID']);
  mock.method(Delivery, 'countDocuments', async query => { filter = query; return 1; });
  mock.method(Delivery, 'find', () => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => facts.rows }));
  await loadRefundDigest('jana', now);
  assert.deepEqual(filter.customerId.$nin, ['C-PAID', 'C-BAG-PAID']);
  assert.equal(now - filter.$or[0]['collectionDetails.collectedAt'].$lte, 48 * 3600000);
  assert.equal(filter.$or[1]['collectionDetails.collectedAt'], null);
});
test('uncertain Brevo sends retain their daily key and stop retrying after 20 minutes', async () => {
  const entries = store(); let sent = 0;
  const options = { kind: 'accounts', now, load: async () => facts, send: async () => { sent++; throw new Error('timeout'); } };
  await sendDailyRefundDigest(options);
  const entry = [...entries.values()][0]; const messageKey = entry.messageKey;
  assert.equal(entry.state, 'uncertain');
  entry.firstAttemptAt = new Date(now - 21 * 60000); entry.nextAttemptAt = null;
  assert.equal((await sendDailyRefundDigest(options)).needsReview, true); assert.equal(sent, 1); assert.equal(entry.messageKey, messageKey);
});
test('legacy same-day acceptance suppresses a second email during the sender transition', async () => {
  store({ legacy: true });
  const result = await sendDailyRefundDigest({ kind: 'accounts', now, manual: true, load: async () => facts, send: async () => assert.fail('Daily limit already used') });
  assert.equal(result.alreadySent, true);
});
test('Jana receives one summary containing all overdue sample rows and total count', async () => {
  let payload;
  mock.method(globalThis, 'fetch', async (url, options) => { payload = JSON.parse(options.body); return { ok: true, json: async () => ({ messageId: 'daily-fixture' }) }; });
  await sendRefundDigestPayload('jana', { total: 2, rows: [facts.rows[0], { ...facts.rows[0], customerId: 'C002', customerName: 'Omar' }] }, 'fixture-daily-key');
  assert.equal(payload.to.length, 1); assert.equal(payload.to[0].email, 'jana@matternutrition.xyz');
  assert.match(payload.subject, /2 bag refunds/); assert.match(payload.textContent, /C001/); assert.match(payload.textContent, /C002/);
  assert.equal(payload.headers.idempotencyKey, 'fixture-daily-key'); assert.ok(!payload.textContent.includes('/refund/portal#'));
});
