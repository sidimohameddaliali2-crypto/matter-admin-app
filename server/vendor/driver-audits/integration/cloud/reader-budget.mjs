import {WORKER_BUDGET_DEFAULTS} from './worker-budget.mjs';
// Vercel's published regional maxima for fast data + origin transfer: $0.35 + $0.43 per GB.
// Combined reader + worker envelope remains $24, within the approved $25 limit.
export const READER_BUDGET_POLICY=Object.freeze({...WORKER_BUDGET_DEFAULTS,monthlyMicros:12_000_000,reservationMicros:150_000});
export const MAX_READER_BODY_BYTES=128*1024*1024,MAX_READER_REQUEST_BYTES=1024*1024,MAX_READER_HEADER_BYTES=64*1024;
export function readerTransferMicros({responseBytes,requestBytes}){if(!Number.isSafeInteger(responseBytes)||responseBytes<0||responseBytes>MAX_READER_BODY_BYTES||!Number.isSafeInteger(requestBytes)||requestBytes<0||requestBytes>MAX_READER_REQUEST_BYTES)throw Error('Reader transfer exceeds bound');return Math.ceil((responseBytes+requestBytes+2*MAX_READER_HEADER_BYTES+4096)*780_000/1_000_000_000);}
