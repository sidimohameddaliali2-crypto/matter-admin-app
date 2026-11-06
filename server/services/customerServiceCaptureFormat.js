import { createHmac, timingSafeEqual } from 'node:crypto';

const bounded = (v, max, label) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`Invalid ${label}`);
  return v.trim();
};
export function normalizeServiceMessage(raw, { source = 'gallabox_export', scope } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Message must be an object');
  const externalMessageId = bounded(raw.externalMessageId, 180, 'message ID');
  const externalConversationId = bounded(raw.externalConversationId, 180, 'conversation ID');
  const timestamp = String(raw.sentAt || '');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) throw new Error('Message timestamp requires ISO date and timezone');
  const [year,month,day]=timestamp.slice(0,10).split('-').map(Number);
  const calendar=new Date(Date.UTC(year,month-1,day));
  if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day) throw new Error('Invalid calendar timestamp');
  if (raw.text != null && (typeof raw.text !== 'string' || raw.text.length > 20000)) throw new Error('Message text exceeds 20000 characters');
  const type = ['text','audio','image','video','document','location','other'].includes(raw.type) ? raw.type : 'other';
  return {
    source: bounded(source, 80, 'source'), scope: bounded(scope, 120, 'scope'), externalMessageId, externalConversationId,
    customerId: typeof raw.customerId === 'string' ? raw.customerId.trim().slice(0,160) : '',
    customerName: typeof raw.customerName === 'string' ? raw.customerName.trim().slice(0,200) : '',
    externalAuthorId: typeof raw.externalAuthorId === 'string' ? raw.externalAuthorId.slice(0,180) : '',
    authorId: null, authorName: typeof raw.authorName === 'string' ? raw.authorName.slice(0,200) : '',
    authorType: ['staff','customer','bot','system'].includes(raw.authorType) ? raw.authorType : 'unknown',
    sentAt: new Date(timestamp), type, text: raw.text || '',
    mediaState: type === 'text' ? 'not_applicable' : 'unavailable',
    sourceRow: typeof raw.sourceRow === 'number' ? raw.sourceRow : null,
  };
}
export function safeSheetText(v) {
  const text = String(v ?? '');
  return /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
}
export function verifyCaptureSignature(raw, signature, secret) {
  if (!Buffer.isBuffer(raw) || !secret || typeof signature !== 'string') return false;
  const expected = createHmac('sha256', secret).update(raw).digest('base64');
  const actual = Buffer.from(signature); const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
export function captureRange({ from, to } = {}) {
  if (!from && !to) return {};
  const parse = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('Invalid date range');
    const date = new Date(`${value}T00:00:00+04:00`);
    if (!Number.isFinite(+date) || new Date(+date+14400000).toISOString().slice(0,10) !== value) throw new Error('Invalid date range');
    return date;
  };
  const start = parse(from); const end = new Date(+parse(to) + 86400000);
  if (+start >= +end) throw new Error('Invalid date range');
  return { from: start, to: end };
}
