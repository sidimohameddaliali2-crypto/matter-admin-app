import { sendAndLogSlack } from './slackNotifier.js';

// Owner (2026-10-26): partner orders go to #event-matter. The ID was
// resolved through Slack; an environment override supports another workspace.
const ORDER_CHANNEL_ID = 'C0AV8KHGWKC';
const escapeSlack = (value, limit = 200) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, limit)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (value) => Number(value || 0).toFixed(2);

export function buildPartnerOrderSlackText({ partner, order, lines, totalAmount, adminUrl }) {
  const date = new Date(order.deliveryDate).toLocaleDateString('en-GB', {
    timeZone: 'Asia/Dubai', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
  });
  const text = [
    '*New partner order*',
    `*Partner:* ${escapeSlack(partner.businessName)}`,
    `*Order:* PO-${String(order._id).slice(-4).toUpperCase()} (${escapeSlack(order._id)})`,
    `*Delivery:* ${date}`,
    `*Window:* ${escapeSlack(order.deliveryTime || 'Not specified')}`,
    '*Items:*',
    ...lines.slice(0, 50).map(l => `• ${l.quantity} × ${escapeSlack(l.itemName)} — AED ${money(l.lineTotal)}`),
    ...(lines.length > 50 ? [`…and ${lines.length - 50} more items. View the full order in admin.`] : []),
    `*Total:* AED ${money(totalAmount)}`,
    ...(order.notes ? [`*Notes:* ${escapeSlack(order.notes, 500)}`] : []),
    ...(adminUrl ? [`<${adminUrl}|Open admin Orders>`] : []),
  ];
  return text.join('\n');
}

export async function sendNewPartnerOrderSlack(notification) {
  // Never let this alert fall through to an unrelated bag/location webhook.
  if (process.env.ENABLE_SLACK_NOTIFICATIONS === '0') return { ok: false, skipped: true };
  const channelId = process.env.SLACK_PARTNER_ORDERS_CHANNEL_ID || ORDER_CHANNEL_ID;
  const webhookEnvKey = process.env.SLACK_PARTNER_ORDERS_WEBHOOK_URL ? 'SLACK_PARTNER_ORDERS_WEBHOOK_URL' : 'SLACK_EVENTS_WEBHOOK_URL';
  if (!process.env.SLACK_BOT_TOKEN && !process.env[webhookEnvKey]) return { ok: false, skipped: true };
  const base = process.env.FRONTEND_URL || process.env.CLIENT_URL;
  let adminUrl;
  try {
    const url = new URL('/admin/partners', base);
    if (['https:', 'http:'].includes(url.protocol)) adminUrl = url.href;
  } catch { /* The alert still contains the full order ID when no public URL is set. */ }
  const text = buildPartnerOrderSlackText({ ...notification, adminUrl });
  return sendAndLogSlack({
    type: 'partner_order', text, channelId, webhookEnvKey,
    // The events webhook already has posting permission; the existing bot
    // token may lack chat:write, so it must not mask a working webhook.
    preferWebhook: !!process.env[webhookEnvKey],
    meta: { partnerId: notification.partner._id, partnerOrderId: notification.order._id },
  });
}
