import { randomUUID } from 'node:crypto';

const origin = 'https://trhhjfgfmxofxhnzocks.supabase.co';
const basis = 'supabase-http-bytes-v1';
const headerLimit = 64 * 1024;
const maximumBody = 70 * 1024 ** 2;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const check = (condition, message) => { if (!condition) throw Error(message); };
function headerBytes(headers) {
  let count = 2048; // Conservative framing allowance; not a claim about compressed wire headers.
  for (const [key, value] of headers) count += Buffer.byteLength(key) + Buffer.byteLength(value) + 4;
  check(count <= headerLimit, 'Supabase transfer header bound exceeded');
  return count;
}
function bodyBytes(body) {
  if (body === undefined || body === null) return 0;
  check(typeof body === 'string' || body instanceof Uint8Array, 'A bounded Supabase request body is required');
  const size = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
  check(size <= maximumBody, 'Supabase transfer request body bound exceeded');
  return size;
}
function transferQueue() {
  let active = 0;
  const waiting = [];
  return async signal => {
    signal.throwIfAborted();
    if (active >= 4) await new Promise((resolve, reject) => {
      check(waiting.length < 128, 'Supabase transfer queue is full');
      const entry = { resolve: () => { signal.removeEventListener('abort', aborted); resolve(); } };
      const aborted = () => { const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); reject(signal.reason); };
      signal.addEventListener('abort', aborted, { once: true });
      waiting.push(entry);
    });
    else active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) next.resolve();
      else active--;
    };
  };
}
function contentionPause(signal) {
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(done, 100);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  });
}
export function validateDriverAuditTransferUsage(value) {
  check(value?.version === 1 && value.basis === basis, 'Supabase transfer accounting basis differs');
  const result = { version: 1, basis };
  for (const [key, pattern, maximum] of [['month', /^\d{4}-(?:0[1-9]|1[0-2])$/, 8 * 1024 ** 3],
    ['day', /^\d{4}-(?:0[1-9]|1[0-2])-\d{2}$/, 512 * 1024 ** 2]]) {
    const row = value[key];
    check(row && pattern.test(row.period) && ['usedBytes', 'reservedBytes', 'limitBytes'].every(field => integer(row[field]))
      && row.usedBytes + row.reservedBytes <= row.limitBytes && row.limitBytes <= maximum,
    'Supabase transfer counter summary is invalid');
    result[key] = { period: row.period, usedBytes: row.usedBytes, reservedBytes: row.reservedBytes, limitBytes: row.limitBytes };
  }
  for (const key of ['activeReservations', 'uncertainReservations']) {
    // Uncertain counts survive pruning of retry rows, across two retained
    // months. Each admission already consumes at least 8192 bytes of its cap.
    const maximum = key === 'activeReservations' ? 4 : 2 * 8 * 1024 ** 3 / 8192;
    check(integer(value[key]) && value[key] <= maximum, 'Supabase transfer reservation summary is invalid');
    result[key] = value[key];
  }
  check(result.activeReservations <= 4, 'Supabase transfer concurrency differs');
  return result;
}

// Meter the actual HTTP transport below the immutable disk cache. The control
// RPC is intentionally unwrapped: its bounded reserve/settle overhead is charged
// by the database policy, without recursively creating accounting requests.
export function createDriverAuditSupabaseTransfer({ controlRpc, fetchImpl = fetch, requestId = randomUUID } = {}) {
  check(typeof controlRpc === 'function' && typeof fetchImpl === 'function' && typeof requestId === 'function',
    'Supabase transfer dependencies are required');
  const acquire = transferQueue();
  return Object.freeze({
    async readTransferUsage() {
      return validateDriverAuditTransferUsage(await controlRpc('matter_hosted_app_read_egress_read', {}));
    },
    wrapFetch({ maxResponseBytes = maximumBody } = {}) {
      check(Number.isSafeInteger(maxResponseBytes) && maxResponseBytes >= 1 && maxResponseBytes <= maximumBody,
        'Supabase transfer response bound is invalid');
      return async (input, options = {}) => {
        let destination;
        try { destination = new URL(input); } catch { throw Error('Supabase transfer destination differs'); }
        check(destination.origin === origin && !destination.username && !destination.password && !destination.hash
          && (/^\/rest\/v1\/rpc\/matter_hosted_[a-z_]+$/.test(destination.pathname)
            || destination.pathname.startsWith('/storage/v1/')),
        'Supabase transfer destination differs');
        const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
        signal.throwIfAborted();
        const headers = new Headers(options.headers), requestBytes = bodyBytes(options.body) + headerBytes(headers)
          + Buffer.byteLength(destination.pathname + destination.search) + Buffer.byteLength(options.method || 'GET');
        const responseBound = maxResponseBytes + headerLimit, id = requestId();
        check(typeof id === 'string' && uuid.test(id), 'Supabase transfer request identity is invalid');
        const release = await acquire(signal);
        let streamed = false, response;
        try {
        signal.throwIfAborted();
        let reservation;
        for (let attempt = 0; attempt < 32; attempt++) {
          reservation = await controlRpc('matter_hosted_app_read_egress_reserve', {
            p_id: id, p_request_bytes: requestBytes, p_response_bytes: responseBound,
          });
          if (reservation?.allowed !== false || reservation.reason !== 'concurrency-limit' || attempt === 31) break;
          await contentionPause(signal);
        }
        check(reservation?.version === 1 && reservation.basis === basis && typeof reservation.allowed === 'boolean',
          'Supabase transfer reservation is invalid');
        if (!reservation.allowed) throw Object.assign(Error('The bounded Supabase read allowance is unavailable'),
          { code: 'AUDIT_TRANSFER_LIMIT', status: 429, readerCapacityDenied: true });
        check(reservation.id === id && /^\d{4}-\d{2}$/.test(reservation.period)
          && reservation.requestBytes === requestBytes && reservation.responseBytes === responseBound,
        'Supabase transfer reservation differs');
        // A rejected request, cancellation, truncation or failed settlement keeps
        // the full admitted bound. No timeout guesses that bytes were not sent.
        response = await fetchImpl(destination.href, { ...options, headers, redirect: 'error', signal });
        check(!response.redirected, 'Supabase transfer destination redirected');
        const responseHeaders = headerBytes(response.headers);
        const contentLength = response.headers.get('content-length');
        check(contentLength === null || /^\d+$/.test(contentLength) && Number(contentLength) <= maxResponseBytes,
          'Supabase transfer response body bound exceeded');
        let received = 0;
        const settle = async () => {
          const result = await controlRpc('matter_hosted_app_read_egress_settle', {
            p_id: id, p_request_bytes: requestBytes, p_response_bytes: responseHeaders + received,
          });
          check(result?.version === 1 && result.basis === basis && result.settled === true
            && result.period === reservation.period && result.chargedRequestBytes === requestBytes
            && result.chargedResponseBytes === responseHeaders + received,
          'Supabase transfer settlement differs');
        };
        if (!response.body) { await settle(); return response; }
        const reader = response.body.getReader();
        let ended = false, cancelled = false, streamController;
        const finish = () => { signal.removeEventListener('abort', aborted); release(); };
        const aborted = () => {
          if (ended) return;
          ended = true;
          cancelled = true;
          void reader.cancel(signal.reason).catch(() => {}).finally(() => { reader.releaseLock(); finish(); });
          streamController?.error(signal.reason);
        };
        const stream = new ReadableStream({
          start(controller) { streamController = controller; },
          async pull(controller) {
            try {
              const next = await reader.read();
              if (cancelled) return;
              if (next.done) {
                ended = true;
                await settle();
                reader.releaseLock();
                finish();
                if (!cancelled) controller.close();
              } else {
                check(next.value instanceof Uint8Array, 'Supabase transfer response body is invalid');
                received += next.value.byteLength;
                check(received <= maxResponseBytes, 'Supabase transfer response body bound exceeded');
                controller.enqueue(next.value);
              }
            } catch (error) {
              ended = true;
              await reader.cancel().catch(() => {});
              reader.releaseLock();
              finish();
              if (!cancelled) controller.error(error);
            }
          },
          async cancel(reason) {
            cancelled = true;
            if (!ended) { ended = true; await reader.cancel(reason); reader.releaseLock(); }
            finish();
          },
        });
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
        const wrapped = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
        streamed = true;
        return wrapped;
        } finally {
          if (!streamed) {
            if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
            release();
          }
        }
      };
    },
  });
}
