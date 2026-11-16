import { createHash } from 'node:crypto';
import { createImmutableEvidenceCache } from './immutable-evidence-cache.mjs';
import { MAX_READER_REQUEST_BYTES, readerTransferMicros } from './reader-budget.mjs';

const maximumObjectBytes = 16 * 1024 * 1024;
const reservationDenied = Symbol('archive reservation denied');

function allowanceUnavailable() {
  return Object.assign(Error('Audit archive reader allowance unavailable'), {
    code: 'AUDIT_BUDGET',
    status: 429,
    readerCapacityDenied: true,
  });
}

// One shared reader accounts only for actual remote reads. Local package reads
// never enter this queue, and verified immutable bytes can be reused in memory.
export function createBudgetedArchiveReader({ transport, budget, requestBytes = 2048, maxConcurrent = 1 }) {
  if (typeof transport?.readObject !== 'function'
    || typeof budget?.reserve !== 'function'
    || typeof budget?.settle !== 'function'
    || !Number.isSafeInteger(requestBytes)
    || requestBytes < 0
    || requestBytes > MAX_READER_REQUEST_BYTES
    || !Number.isSafeInteger(maxConcurrent)
    || maxConcurrent < 1
    || maxConcurrent > 4) {
    throw Error('Budgeted archive reader dependencies required');
  }
  const cache = createImmutableEvidenceCache({ maxBytes: maximumObjectBytes, maxEntries: 64 });
  const queued = [];
  let concurrency = maxConcurrent;
  let active = 0;
  let nextOrder = 0;
  let started = 0;

  async function readRemote(key, maxBytes, signal) {
    signal?.throwIfAborted();
    const began = performance.now();
    const reservation = await budget.reserve({ responseBytes: maxBytes });
    if (!reservation?.allowed) {
      const error = allowanceUnavailable();
      if (reservation?.allowed === false) error[reservationDenied] = true;
      throw error;
    }

    const parts = [];
    const hash = createHash('sha256');
    let size = 0;
    const stream = await transport.readObject(key, { maxBytes, ...(signal ? { signal } : {}) });
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw Error('Audit archive response exceeds bound');
      hash.update(bytes);
      parts.push(bytes);
    }
    if (hash.digest('hex') + '.gz' !== key) throw Error('Audit archive read hash mismatch');

    let settlement;
    try {
      settlement = await budget.settle(reservation, {
        elapsedMs: Math.ceil(performance.now() - began),
        extraMicros: readerTransferMicros({ responseBytes: size, requestBytes }),
        accountingBasis: 'remote-archive-transfer-v1',
      });
    } catch (error) {
      if (error?.status === 503 && error.diagnosticCategory === 'state-contention') throw error;
      throw allowanceUnavailable();
    }
    if (settlement?.settled !== true) throw allowanceUnavailable();
    return { value: Buffer.concat(parts, size), bytes: size };
  }

  function startQueuedReads() {
    while (active < concurrency && queued.length > 0) {
      active++;
      void completeRead(queued.shift());
    }
  }

  async function completeRead(job) {
    const { key, maxBytes, signal, resolve, reject } = job;
    const overlappedAtStart = active > 1;
    const sequence = ++started;
    try {
      resolve(await readRemote(key, maxBytes, signal));
    } catch (error) {
      if (error?.[reservationDenied] && (overlappedAtStart || started !== sequence)) {
        // Temporary holds can deny an admission that fits after settlement.
        // Drain the active reads before a single serial retry in queue order.
        concurrency = 1;
        const later = queued.findIndex(entry => entry.order > job.order);
        queued.splice(later < 0 ? queued.length : later, 0, job);
      } else {
        reject(error);
      }
    } finally {
      active--;
      startQueuedReads();
    }
  }

  function queueRead(key, maxBytes, signal) {
    return new Promise((resolve, reject) => {
      queued.push({ key, maxBytes, signal, resolve, reject, order: nextOrder++ });
      startQueuedReads();
    });
  }

  function waitForRead(pending, signal) {
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
      if (signal.aborted) aborted();
    });
  }

  return {
    remoteReadsBudgeted: true,
    async readObject(key, { maxBytes, signal } = {}) {
      if (!/^[a-f0-9]{64}\.gz$/.test(key)
        || !Number.isSafeInteger(maxBytes)
        || maxBytes < 1
        || maxBytes > maximumObjectBytes) {
        throw Error('Invalid bounded archive read');
      }
      signal?.throwIfAborted();
      // A caller-owned signal cannot cancel another caller's shared read.
      const result = signal
        ? await waitForRead(queueRead(key, maxBytes, signal), signal)
        : { value: await cache.getOrLoad(key + ':' + maxBytes, () => queueRead(key, maxBytes)) };
      return [Buffer.from(result.value)];
    },
  };
}
