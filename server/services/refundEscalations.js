import { randomUUID } from 'node:crypto';
import { refundLinkOrigin } from './collectionRefundLinks.js';
import { sendPayload } from './collectionRefundEmail.js';
// Owner-selected recipient, verified in the connected Slack directory.
export const ADRIAN_SLACK_ID = 'U047RL01DD1';
export const JANA_REFUND_EMAIL = 'jana@matternutrition.xyz';
export const REFUND_HOUR_MS = 3600000;
export function pendingRefundAt(record) {
  const value = record.collectionDetails?.collectedAt || record.completedAt;
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}
export function escalationValues(record) {
  const pendingAt = pendingRefundAt(record);
  if (!pendingAt) return [];
  return [['adrian_24h', 24, ADRIAN_SLACK_ID], ['jana_48h', 48, JANA_REFUND_EMAIL]].map(([stage, hours, recipient]) => ({ delivery: record._id, stage, recipient, pendingAt, dueAt: new Date(pendingAt.getTime() + hours * REFUND_HOUR_MS), messageKey: randomUUID(), state: 'queued', attempts: 0 }));
}
const safe = value => String(value || '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
export function escalationText(record, notification) {
  const hours = notification.stage === 'adrian_24h' ? 24 : 48;
  return `Bag deposit refund still pending after ${hours} hours\nCustomer: ${safe(record.customerName)} (${safe(record.customerId)})\nDeposit: AED 155\nCollection completed: ${notification.pendingAt.toISOString()}\nPlease follow up with Accounts. Staff refund tracker: ${refundLinkOrigin()}/collections#collection-refunds`;
}
export async function refundSlackReadiness(fetcher = fetch) {
  if (process.env.ENABLE_SLACK_NOTIFICATIONS === '0' || !process.env.SLACK_BOT_TOKEN?.trim()) return { ready: false, code: 'slack_missing_or_paused' };
  const response = await fetcher('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN.trim()}` }, signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  const scopes = response.headers.get('x-oauth-scopes')?.split(',').map(x => x.trim()) || [];
  if (!response.ok || body.ok !== true) return { ready: false, code: 'slack_not_authorized' };
  return { ready: scopes.includes('chat:write') || scopes.includes('chat:write:bot'), code: scopes.includes('chat:write') || scopes.includes('chat:write:bot') ? 'ready' : 'slack_chat_write_required' };
}
export async function sendAdrianEscalation(record, notification, fetcher = fetch) {
  if (process.env.ENABLE_SLACK_NOTIFICATIONS === '0' || !process.env.SLACK_BOT_TOKEN?.trim()) throw Object.assign(new Error('Slack unavailable'), { code: 'slack_missing_or_paused', definitelyNotSent: true });
  const response = await fetcher('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN.trim()}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ channel: ADRIAN_SLACK_ID, text: escalationText(record, notification), mrkdwn: false, unfurl_links: false, unfurl_media: false, client_msg_id: notification.messageKey }) });
  const body = await response.json();
  if (!response.ok || body.ok !== true) throw Object.assign(new Error('Slack did not accept the reminder'), { code: ['missing_scope', 'invalid_auth', 'channel_not_found', 'not_authed', 'account_inactive'].includes(body.error) ? `slack_${body.error}` : 'slack_rejected', definitelyNotSent: response.ok || response.status === 429 });
  return { messageId: body.ts };
}
export async function sendJanaEscalation(record, notification, fetcher = fetch) {
  if (!process.env.BREVO_API_KEY?.trim()) throw Object.assign(new Error('Email unavailable'), { code: 'brevo_missing_configuration', definitelyNotSent: true });
  return sendPayload({
    sender: { email: process.env.BREVO_SENDER_EMAIL?.trim() || 'noreply@matternutrition.xyz', name: process.env.BREVO_SENDER_NAME?.trim() || 'MATTER Accounts' },
    to: [{ email: JANA_REFUND_EMAIL, name: 'Jana' }], subject: `48-hour escalation — bag refund pending — ${String(record.customerName || 'Customer').replace(/[\r\n]/g, ' ').slice(0, 100)}`,
    headers: { idempotencyKey: notification.messageKey }, tags: ['collection-refund-48h'], textContent: escalationText(record, notification)
  }, fetcher);
}
