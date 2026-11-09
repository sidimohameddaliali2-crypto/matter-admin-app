import {sanitizeNativeContent} from './customerServiceNativeContext.js';
import { sanitizeServiceMedia } from './customerServiceMedia.js';
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
  const externalContactId = source==='gallabox' ? raw.sourceMetadata?.externalContactId : undefined;
  if(externalContactId!==undefined && (typeof externalContactId!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(externalContactId)))throw new Error('Invalid native contact ID');
  const nativeEvent=source==='gallabox'&&raw.sourceMetadata?.nativeEvent?.kind==='internal_note'&&raw.sourceMetadata.nativeEvent.timestampBasis==='createdAt'?{kind:'internal_note',timestampBasis:'createdAt'}:null;
  const event=source==='gallabox'&&raw.authorType==='system'?raw.sourceMetadata?.systemEvent:null;
  const systemEvent=event?Object.fromEntries(['action','actorType','trigger'].filter(k=>typeof event[k]==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(event[k])).map(k=>[k,event[k]])):null;
  if(systemEvent)for(const k of ['actorName','assigneeName'])if(typeof event[k]==='string')systemEvent[k]=event[k].slice(0,200);
  const reply=source==='gallabox'?raw.sourceMetadata?.replyContext:null;
  const replyContext=reply&&typeof reply.messageId==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(reply.messageId)?{messageId:reply.messageId,type:typeof reply.type==='string'?reply.type.slice(0,30):'',text:typeof reply.text==='string'?reply.text.slice(0,20000):''}:null;
  const pin=source==='gallabox'&&type==='location'?raw.sourceMetadata?.location:null;
  const location=pin&&typeof pin.latitude==='number'&&typeof pin.longitude==='number'&&Number.isFinite(pin.latitude)&&Number.isFinite(pin.longitude)&&Math.abs(pin.latitude)<=90&&Math.abs(pin.longitude)<=180?{latitude:pin.latitude,longitude:pin.longitude,...(typeof pin.name==='string'?{name:pin.name.slice(0,200)}:{}),...(typeof pin.address==='string'?{address:pin.address.slice(0,1000)}:{})}:null;
  const nativeContent=source==='gallabox'?sanitizeNativeContent(raw.sourceMetadata?.nativeContent):null;
  const direction=source==='gallabox'&&['incoming','outgoing'].includes(raw.sourceMetadata?.direction)?raw.sourceMetadata.direction:null;
  const nativeMessageId=source==='gallabox'&&typeof raw.sourceMetadata?.nativeMessageId==='string'?raw.sourceMetadata.nativeMessageId.slice(0,300):null;
  const history = sanitizeHistoryProvenance(raw.sourceMetadata?.history, source);
  const media = sanitizeServiceMedia(raw.sourceMetadata?.media, {source,scope,type});
  return {
    source: bounded(source, 80, 'source'), scope: bounded(scope, 120, 'scope'), externalMessageId, externalConversationId,
    customerId: typeof raw.customerId === 'string' ? raw.customerId.trim().slice(0,160) : '',
    customerName: typeof raw.customerName === 'string' ? raw.customerName.trim().slice(0,200) : '',
    externalAuthorId: typeof raw.externalAuthorId === 'string' ? raw.externalAuthorId.slice(0,180) : '',
    authorId: null, authorName: typeof raw.authorName === 'string' ? raw.authorName.slice(0,200) : '',
    internalNote: Boolean(nativeEvent),
    authorType: ['staff','customer','bot','system'].includes(raw.authorType) ? raw.authorType : 'unknown',
    sentAt: new Date(timestamp), type, text: raw.text || '',
    mediaState: type === 'text' ? 'not_applicable' : media ? 'available' : 'unavailable',
    ...((media || history || externalContactId || nativeEvent || systemEvent || replyContext || location || nativeContent || direction || nativeMessageId) ? {sourceMetadata:{...(nativeContent?{nativeContent}:{}),...(direction?{direction}:{}),...(nativeMessageId?{nativeMessageId}:{}),...(location?{location}:{}),...(replyContext?{replyContext}:{}),...(systemEvent?{systemEvent}:{}),...(nativeEvent?{nativeEvent}:{}),...(externalContactId?{externalContactId}:{}),...(media?{media}:{}),...(history?{history}:{})}} : {}),
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

export function sanitizeHistoryProvenance(value, source) {
  if (source !== 'gallabox_history' || !value || typeof value !== 'object') return null;
  if (!/^[a-f0-9]{64}$/.test(value.workbookSha256 || '') || !/^[A-Z]{1,4}[1-9][0-9]{0,6}$/.test(value.cell || '')) throw new Error('Invalid historical provenance');
  const result={workbookSha256:value.workbookSha256,cell:value.cell};
  for (const [key,limit] of [['sheet',100],['sourceWorkbook',300],['sourceSheet',100],['sourceStatus',80]]) {
    if (typeof value[key] !== 'string' || value[key].length > limit || /[\r\n\0]/.test(value[key])) throw new Error('Invalid historical provenance');
    result[key]=value[key];
  }
  if (!Number.isSafeInteger(value.sourceRow) || value.sourceRow < 1) throw new Error('Invalid historical provenance');
  result.sourceRow=value.sourceRow;
  return result;
}
