import { setTimeout as delay } from 'node:timers/promises';
import { TRANSFER_MAX_BYTES } from './driverAuditTransferCodec.js';

export const TRANSFER_DOWNLOAD_RANGE_BYTES = 8 * 1024 * 1024;
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = message => Object.assign(Error(message), { transferDownloadGuard: true });
const transient = error => error?.transferDownloadRetryable === true
  || ['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)
  || ['TimeoutError', 'RequestTimeout', 'RequestTimeoutException', 'NetworkingError'].includes(error?.name)
  || [429, 500, 502, 503, 504].includes(error?.$metadata?.httpStatusCode);

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

// Pull-only iteration is intentional. Each response is fully drained and closed
// before yielding, so slow authenticated-frame storage never holds an HTTP GET
// open. A retry discards only one bounded, not-yet-yielded encrypted range.
export function createDriverAuditTransferDownload({ remote, readRange, signal,
  rangeBytes = TRANSFER_DOWNLOAD_RANGE_BYTES, maxAttempts = 4, rangeTimeoutMs = 60000,
  maxDurationMs = 50 * 60 * 1000, wait = (milliseconds, currentSignal) => delay(milliseconds, undefined, { signal: currentSignal }) }) {
  const bytes = remote?.bytes, etag = remote?.etag, versionId = remote?.versionId;
  if (!positive(bytes) || bytes > TRANSFER_MAX_BYTES + 32 * 1024 * 1024
    || typeof etag !== 'string' || !/^"[\x21\x23-\x7e]{1,1024}"$/.test(etag)
    || versionId !== undefined && (typeof versionId !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(versionId))
    || typeof readRange !== 'function' || typeof wait !== 'function'
    || !positive(rangeBytes) || rangeBytes > TRANSFER_DOWNLOAD_RANGE_BYTES
    || !positive(maxAttempts) || maxAttempts > 5 || !positive(rangeTimeoutMs) || rangeTimeoutMs > 120000
    || !positive(maxDurationMs) || maxDurationMs > 55 * 60 * 1000) throw fail('A bounded encrypted source identity is required');
  const destroyed = new AbortController(), deadline = new AbortController();
  const currentSignal = AbortSignal.any([destroyed.signal, deadline.signal, ...(signal ? [signal] : [])]);
  async function read(start, end) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      currentSignal.throwIfAborted();
      const timeout = new AbortController(), attemptSignal = AbortSignal.any([currentSignal, timeout.signal]);
      const timer = setTimeout(() => timeout.abort(fail('Encrypted transfer range timed out')), rangeTimeoutMs);
      let response;
      try {
        const pending = Promise.resolve().then(() => {
          attemptSignal.throwIfAborted(); return readRange({ start, end, etag, versionId, signal: attemptSignal });
        }).then(value => {
          if (attemptSignal.aborted) { value?.Body?.destroy?.(); attemptSignal.throwIfAborted(); }
          return value;
        });
        response = await abortable(pending, attemptSignal);
        const length = end - start + 1;
        if (response?.$metadata?.httpStatusCode !== 206 || response.ContentLength !== length
          || response.ContentRange !== `bytes ${start}-${end}/${bytes}` || response.ETag !== etag
          || versionId !== undefined && response.VersionId !== versionId
          || typeof response.Body?.[Symbol.asyncIterator] !== 'function') throw fail('Encrypted transfer range identity differs');
        const result = Buffer.allocUnsafe(length), iterator = response.Body[Symbol.asyncIterator]();
        let size = 0;
        for (;;) {
          const next = await abortable(iterator.next(), attemptSignal);
          if (next.done) break;
          if (!(next.value instanceof Uint8Array) || next.value.byteLength > length - size) {
            throw fail('Encrypted transfer range exceeds its declared size');
          }
          result.set(next.value, size); size += next.value.byteLength;
        }
        attemptSignal.throwIfAborted();
        if (size !== length) throw Object.assign(fail('Encrypted transfer range is truncated'), { transferDownloadRetryable: true });
        return result;
      } catch (error) {
        currentSignal.throwIfAborted();
        if (!timeout.signal.aborted && !transient(error)) throw error;
        if (attempt === maxAttempts) throw fail('Encrypted transfer range retries exhausted');
      } finally { clearTimeout(timer); response?.Body?.destroy?.(); }
      await wait(Math.min(250 * 2 ** (attempt - 1), 2000), currentSignal);
    }
  }
  const iterator = (async function* () {
    const timer = setTimeout(() => deadline.abort(fail('Encrypted transfer download deadline exceeded')), maxDurationMs);
    try {
      for (let start = 0; start < bytes; start += rangeBytes) {
        currentSignal.throwIfAborted();
        yield await read(start, Math.min(bytes - 1, start + rangeBytes - 1));
      }
      currentSignal.throwIfAborted();
    } finally { clearTimeout(timer); }
  })();
  Object.defineProperty(iterator, 'signal', { value: currentSignal });
  iterator.destroy = async () => { destroyed.abort(fail('Encrypted transfer download closed')); await iterator.return(); };
  return iterator;
}
