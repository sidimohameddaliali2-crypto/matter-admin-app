import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import SlackLog from '../models/SlackLog.js';
import { buildPartnerOrderSlackText, sendNewPartnerOrderSlack } from './partnerOrderSlack.js';

const notification = {
  partner: { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', businessName: 'Fixture Partner' },
  order: { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', deliveryDate: '2026-10-31T00:00:00Z', deliveryTime: 'Morning 7–10am', notes: 'Leave with reception' },
  lines: [{ itemName: 'Chicken Bowl', quantity: 3, unitPrice: 20, lineTotal: 60 }],
  totalAmount: 60,
};
function setup(t) {
  const keys = ['ENABLE_SLACK_NOTIFICATIONS', 'SLACK_BOT_TOKEN', 'SLACK_PARTNER_ORDERS_CHANNEL_ID', 'SLACK_PARTNER_ORDERS_WEBHOOK_URL', 'SLACK_EVENTS_WEBHOOK_URL', 'FRONTEND_URL', 'CLIENT_URL'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  keys.forEach(key => delete process.env[key]);
  t.after(() => keys.forEach(key => before[key] === undefined ? delete process.env[key] : process.env[key] = before[key]));
  process.env.ENABLE_SLACK_NOTIFICATIONS = '1';
  process.env.SLACK_BOT_TOKEN = 'fixture-token';
  process.env.FRONTEND_URL = 'https://delivery.example.invalid';
  const requests = [], logs = [];
  t.mock.method(axios, 'post', async (...args) => { requests.push(args); return { status: 200, data: { ok: true, channel: 'C0AV8KHGWKC', ts: '1.000001' } }; });
  t.mock.method(SlackLog, 'create', async log => { logs.push(log); });
  return { requests, logs };
}

test('order alert includes the delivery, items, prices, notes and admin link', () => {
  const text = buildPartnerOrderSlackText({ ...notification, adminUrl: 'https://delivery.example.invalid/admin/partners' });
  for (const expected of ['Fixture Partner', 'Sat, 31 Oct 2026', 'Morning 7–10am', '3 × Chicken Bowl', 'Total:* AED 60.00', 'Leave with reception', '/admin/partners']) assert.ok(text.includes(expected), expected);
});

test('partner-provided text cannot insert Slack mention or link markup', () => {
  const text = buildPartnerOrderSlackText({ ...notification, partner: { businessName: '<!channel> & <https://bad.invalid|click>' } });
  assert.ok(text.includes('&lt;!channel&gt; &amp; &lt;https://bad.invalid|click&gt;'));
  assert.ok(!text.includes('<!channel>'));
});

test('new orders target event-matter and log the partner and order IDs', async t => {
  const f = setup(t);
  const result = await sendNewPartnerOrderSlack(notification);
  assert.equal(result.ok, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0][0], 'https://slack.com/api/chat.postMessage');
  assert.equal(f.requests[0][1].channel, 'C0AV8KHGWKC');
  assert.ok(f.requests[0][1].text.includes('https://delivery.example.invalid/admin/partners'));
  assert.equal(f.logs[0].type, 'partner_order');
  assert.equal(f.logs[0].partnerOrderId, notification.order._id);
  assert.equal(f.logs[0].partnerId, notification.partner._id);
});

test('the existing events webhook works when no bot token is configured', async t => {
  const f = setup(t);
  delete process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_EVENTS_WEBHOOK_URL = 'https://hooks.slack.invalid/fixture';
  assert.equal((await sendNewPartnerOrderSlack(notification)).ok, true);
  assert.equal(f.requests[0][0], 'https://hooks.slack.invalid/fixture');
});

test('the events webhook is preferred over a bot token that lacks posting scope', async t => {
  const f = setup(t);
  process.env.SLACK_EVENTS_WEBHOOK_URL = 'https://hooks.slack.invalid/fixture';
  axios.post.mock.mockImplementation(async (url, payload) => {
    f.requests.push([url, payload]);
    assert.equal(url, 'https://hooks.slack.invalid/fixture');
    return { status: 200, data: 'ok' };
  });
  assert.equal((await sendNewPartnerOrderSlack(notification)).ok, true);
  assert.equal(f.requests.length, 1);
});

test('disabled or unconfigured order alerts never fall through to a bag webhook', async t => {
  const f = setup(t);
  process.env.ENABLE_SLACK_NOTIFICATIONS = '0';
  assert.equal((await sendNewPartnerOrderSlack(notification)).skipped, true);
  process.env.ENABLE_SLACK_NOTIFICATIONS = '1';
  delete process.env.SLACK_BOT_TOKEN;
  assert.equal((await sendNewPartnerOrderSlack(notification)).skipped, true);
  assert.equal(f.requests.length, 0);
});

test('Slack rejections and timeouts are logged and returned as failures', async t => {
  const f = setup(t);
  axios.post.mock.mockImplementation(async () => ({ status: 200, data: { ok: false, error: 'not_in_channel' } }));
  assert.equal((await sendNewPartnerOrderSlack(notification)).error, 'not_in_channel');
  axios.post.mock.mockImplementation(async () => { throw new Error('Fixture timeout'); });
  assert.equal((await sendNewPartnerOrderSlack(notification)).ok, false);
  assert.equal(f.logs.length, 2);
});
