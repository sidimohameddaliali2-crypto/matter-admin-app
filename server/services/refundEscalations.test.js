import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Notice from '../models/RefundEscalation.js';
import Delivery from '../models/Delivery.js';
import BagRefundCase from '../models/BagRefundCase.js';
import { escalationValues, pendingRefundAt, sendAdrianEscalation, sendJanaEscalation, ADRIAN_SLACK_ID, JANA_REFUND_EMAIL } from './refundEscalations.js';
import { runRefundEscalationsOnce } from '../jobs/refundEscalations.js';
const env = { ...process.env };
beforeEach(() => { process.env.SLACK_BOT_TOKEN = 'fixture'; process.env.BREVO_API_KEY = 'fixture'; delete process.env.ENABLE_SLACK_NOTIFICATIONS; delete process.env.COLLECTION_REFUND_ESCALATIONS_ENABLED; });
afterEach(() => { mock.restoreAll(); for (const key of ['SLACK_BOT_TOKEN', 'BREVO_API_KEY', 'ENABLE_SLACK_NOTIFICATIONS', 'COLLECTION_REFUND_ESCALATIONS_ENABLED']) if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; });
const now = new Date('2026-11-27T10:00:00Z');
const record = { _id: '507f1f77bcf86cd799439011', customerId: 'C001', customerName: 'Sara', collectionDetails: { collectedAt: new Date(now - 49 * 3600000) } };
test('24h and 48h deadlines start at collection, do not reset for ownership updates and missing clocks are not invented', () => {
  const values = escalationValues({ ...record, updatedAt: now, collectionRefund: { updatedAt: now } });
  assert.equal(values[0].dueAt - values[0].pendingAt, 24 * 3600000); assert.equal(values[1].dueAt - values[1].pendingAt, 48 * 3600000);
  assert.equal(values[0].recipient, ADRIAN_SLACK_ID); assert.equal(values[1].recipient, JANA_REFUND_EMAIL);
  assert.deepEqual(escalationValues({}), []); assert.equal(pendingRefundAt({ completedAt: 'bad' }), null);
});
test('Slack targets only Adrian and Jana email has pending case facts without a no-login capability', async () => {
  const values = escalationValues(record); let sent;
  await sendAdrianEscalation(record, values[0], async (url, options) => { sent = JSON.parse(options.body); assert.equal(url, 'https://slack.com/api/chat.postMessage'); return { ok: true, json: async () => ({ ok: true, ts: 'fixture' }) }; });
  assert.equal(sent.channel, 'U047RL01DD1'); assert.equal(sent.client_msg_id, values[0].messageKey); assert.equal(sent.unfurl_links, false);
  await sendJanaEscalation(record, values[1], async (url, options) => { sent = JSON.parse(options.body); return { ok: true, json: async () => ({ messageId: 'fixture' }) }; });
  assert.equal(sent.to[0].email, 'jana@matternutrition.xyz'); assert.match(sent.textContent, /48 hours/); assert.match(sent.textContent, /C001/); assert.ok(!sent.textContent.includes('/refund/portal#'));
});
const chain = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => value });
function stub(notice, paid = false) {
  mock.method(Notice, 'init', async () => {}); mock.method(Notice, 'distinct', async () => []);
  mock.method(Delivery, 'distinct', async () => []); mock.method(BagRefundCase, 'distinct', async () => []);
  mock.method(Delivery, 'find', () => chain([])); mock.method(Delivery, 'findOne', () => chain(record));
  mock.method(Delivery, 'exists', async () => paid); mock.method(BagRefundCase, 'exists', async () => false);
  let claimed = false;
  const claim = mock.method(Notice, 'findOneAndUpdate', () => chain(claimed ? null : (claimed = true, notice)));
  const writes = mock.method(Notice, 'updateOne', async () => ({})); return { claim, writes };
}
test('worker claims with a durable lease and due guard, records acceptance and cancels paid cases', async () => {
  const notice = { ...escalationValues(record)[0], _id: 'notice', leaseUntil: now };
  let { claim, writes } = stub(notice); let calls = 0;
  await runRefundEscalationsOnce({ now, slack: async () => { calls++; return { messageId: 'accepted' }; } });
  assert.equal(calls, 1); assert.deepEqual(claim.mock.calls[0].arguments[0].dueAt, { $lte: now });
  assert.ok(writes.mock.calls.some(call => call.arguments[1].$set.state === 'sent'));
  mock.restoreAll(); ({ writes } = stub(notice, true));
  await runRefundEscalationsOnce({ now, slack: async () => assert.fail('Paid cases must not notify') });
  assert.ok(writes.mock.calls.some(call => call.arguments[1].$set.state === 'cancelled'));
});
test('uncertain Slack sends do not repeat, and Brevo retries stop before its dedupe window expires', async () => {
  let { writes } = stub({ ...escalationValues(record)[0], _id: 'notice', leaseUntil: now });
  await runRefundEscalationsOnce({ now, slack: async () => { throw new Error('timeout'); } });
  assert.ok(writes.mock.calls.some(call => call.arguments[1].$set.state === 'needs_review'));
  mock.restoreAll(); ({ writes } = stub({ ...escalationValues(record)[1], _id: 'notice', leaseUntil: now, firstAttemptAt: new Date(now - 21 * 60000) }));
  await runRefundEscalationsOnce({ now, email: async () => assert.fail('Expired dedupe window') });
  assert.ok(writes.mock.calls.some(call => call.arguments[1].$set.state === 'needs_review'));
});
test('unconfigured Slack safely defers without pretending to have sent or blocking Jana', async () => {
  delete process.env.SLACK_BOT_TOKEN;
  const { writes } = stub({ ...escalationValues(record)[0], _id: 'notice', leaseUntil: now });
  await runRefundEscalationsOnce({ now });
  const update = writes.mock.calls.find(call => call.arguments[1].$set.state === 'queued').arguments[1].$set;
  assert.equal(update.firstAttemptAt, null); assert.equal(update.errorCode, 'slack_missing_or_paused'); assert.ok(update.nextAttemptAt > now);
});
