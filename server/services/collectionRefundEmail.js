import { ACCOUNTS_EMAIL, deriveRefundToken, hashRefundToken, refundLinkOrigin } from './collectionRefundLinks.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export async function refundEmailConfiguration(fetcher = fetch) {
  if (!process.env.BREVO_API_KEY?.trim()) return { ready: false, code: 'missing_configuration' };
  const response = await fetcher('https://api.brevo.com/v3/senders', { headers: { 'api-key': process.env.BREVO_API_KEY.trim(), accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { ready: false, code: response.status === 401 || response.status === 403 ? /\bip\b|ip address/i.test(data.message || '') ? 'brevo_ip_restriction' : 'brevo_not_authorized' : 'brevo_unavailable' };
  const sender = (process.env.BREVO_SENDER_EMAIL || 'noreply@matternutrition.xyz').trim().toLowerCase();
  const active = data.senders?.some(item => item.email?.toLowerCase() === sender && item.active === true);
  return { ready: active === true, code: active ? 'ready' : 'sender_not_verified' };
}
export function refundEmailPayload(record, link) {
  const token = deriveRefundToken(link.tokenNonce);
  if (hashRefundToken(token) !== link.tokenHash) throw Object.assign(new Error('Refund link key changed.'), { code: 'key_changed' });
  const url = `${refundLinkOrigin()}/refund/complete#${token}`;
  const name = String(record.customerName || 'Customer');
  const collected = record.collectionDetails?.collectedAt || record.completedAt;
  const date = collected ? new Date(collected).toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai' }) : 'See collection record';
  const expiry = new Date(link.expiresAt).toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai' });
  return {
    sender: { email: process.env.BREVO_SENDER_EMAIL?.trim() || 'noreply@matternutrition.xyz', name: process.env.BREVO_SENDER_NAME?.trim() || 'MATTER Accounts' },
    to: [{ email: ACCOUNTS_EMAIL, name: 'MATTER Accounts' }],
    subject: `Bag deposit refund pending - ${name.replace(/[\r\n]/g, ' ').slice(0, 120)}`,
    headers: { idempotencyKey: link.messageKey }, tags: ['collection-refund'],
    htmlContent: `<div style="font-family:Arial,sans-serif;max-width:600px;color:#12213b"><h1 style="font-size:24px">Bag deposit refund pending</h1><p>The bag collection is complete. Please arrange the AED 155 deposit refund and record the transaction reference.</p><p><strong>Customer:</strong> ${escape(name)}<br><strong>Customer ID:</strong> ${escape(record.customerId)}<br><strong>Collected:</strong> ${escape(date)}</p><p><a href="${escape(url)}" style="display:inline-block;background:#c4ef81;color:#12213b;padding:14px 20px;text-decoration:none;border-radius:8px;font-weight:bold">Update this refund</a></p><p>No staff login is required. This private link only updates this customer's collection refund. It expires on ${escape(expiry)} (Dubai). Keep this email within Accounts.</p><p>Opening the link does not mark the refund Done. Enter the transaction reference and confirm only after the payment has been made.</p></div>`,
    textContent: `Bag deposit refund pending\nCustomer: ${name}\nCustomer ID: ${record.customerId}\nDeposit: AED 155\nCollected: ${date}\n\nUpdate this refund (no staff login): ${url}\n\nEnter the transaction reference after payment. Link expires ${expiry} (Dubai). Keep this link within Accounts.`
  };
}
export async function sendRefundEmail(record, link, fetcher = fetch) {
  const response = await fetcher('https://api.brevo.com/v3/smtp/email', { method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'api-key': process.env.BREVO_API_KEY?.trim(), accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(refundEmailPayload(record, link)) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.code === 'duplicate_parameter') return { duplicate: true };
    throw Object.assign(new Error('Brevo did not accept the email.'), { code: `brevo_${response.status}`, retryable: response.status === 429 || response.status >= 500 });
  }
  return { messageId: typeof data.messageId === 'string' ? data.messageId : undefined };
}
