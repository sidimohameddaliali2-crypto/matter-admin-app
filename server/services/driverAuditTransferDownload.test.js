import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createDriverAuditTransferDownload, TRANSFER_DOWNLOAD_RANGE_BYTES } from './driverAuditTransferDownload.js';
import { createDriverAuditTransferSpacesAdapter } from '../scripts/driverAuditNativeTransfer.js';

const etag = '"fictional-encrypted-object-v1"';
function fixture(bytes = Buffer.from('fictional bounded encrypted bytes'), options = {}) {
  const calls = [], waits = [], bodies = [];
  let active = 0;
  const readRange = async request => {
    calls.push(request); active++;
    let closed = false;
    const body = { async *[Symbol.asyncIterator]() { yield bytes.subarray(request.start, request.end + 1); },
      destroy() { if (!closed) { closed = true; active--; } } };
    bodies.push(body);
    return { Body: body, ContentLength: request.end - request.start + 1,
      ContentRange: `bytes ${request.start}-${request.end}/${bytes.length}`, ETag: etag, VersionId: 'fixture-version',
      $metadata: { httpStatusCode: 206 } };
  };
  const stream = extra => createDriverAuditTransferDownload({ remote: { bytes: bytes.length, etag, versionId: 'fixture-version' },
    readRange, rangeBytes: 7, wait: async (milliseconds, signal) => { signal.throwIfAborted(); waits.push(milliseconds); },
    ...options, ...extra });
  return { bytes, calls, waits, bodies, readRange, stream, active: () => active };
}
const collect = async stream => { const parts = []; try { for await (const part of stream) parts.push(part); }
  finally { await stream.destroy(); } return Buffer.concat(parts); };

test('ranged download fully drains and closes each bounded response before yielding without prefetch', async () => {
  const f = fixture(), stream = f.stream(), parts = [];
  try {
    const first = await stream.next(); parts.push(first.value);
    assert.equal(f.active(), 0); assert.equal(f.calls.length, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 1, 'Mongo persistence must not leave a remote response open or prefetch the next one');
    for await (const bytes of stream) { assert.equal(f.active(), 0); parts.push(bytes); }
    assert.deepEqual(Buffer.concat(parts), f.bytes);
    assert(f.calls.every(call => call.etag === etag && call.versionId === 'fixture-version' && call.end - call.start < 7));
    assert.deepEqual(f.calls.map(call => call.start), [0, 7, 14, 21, 28]);
    assert(TRANSFER_DOWNLOAD_RANGE_BYTES >= 4 * 1024 ** 2 && TRANSFER_DOWNLOAD_RANGE_BYTES <= 8 * 1024 ** 2);
  } finally { await stream.destroy(); }
});

test('a mid-body reset retries only that encrypted range and emits no repeated or partial bytes', async () => {
  const f = fixture(), opened = f.readRange;
  let failed = false;
  const stream = f.stream({ readRange: async request => {
    const response = await opened(request);
    if (request.start === 7 && !failed) { failed = true;
      response.Body[Symbol.asyncIterator] = async function* () {
        yield f.bytes.subarray(request.start, request.start + 2);
        throw Object.assign(Error('fixture socket reset'), { code: 'ECONNRESET' });
      };
    }
    return response;
  } });
  assert.deepEqual(await collect(stream), f.bytes);
  assert.deepEqual(f.calls.map(call => call.start), [0, 7, 7, 14, 21, 28]);
  assert.deepEqual(f.waits, [250]); assert.equal(f.active(), 0);
});

test('a truncated response retries the same range and request failures have bounded backoff and attempts', async t => {
  await t.test('truncated', async () => {
    const f = fixture(), opened = f.readRange; let failed = false;
    const stream = f.stream({ readRange: async request => {
      const response = await opened(request);
      if (!failed) { failed = true; response.Body[Symbol.asyncIterator] = async function* () { yield f.bytes.subarray(0, 2); }; }
      return response;
    } });
    assert.deepEqual(await collect(stream), f.bytes); assert.deepEqual(f.calls.slice(0, 2).map(call => call.start), [0, 0]);
    assert.equal(f.active(), 0);
  });
  await t.test('bounded retries', async () => {
    const f = fixture(); let calls = 0;
    await assert.rejects(collect(f.stream({ readRange: async () => { calls++; throw Object.assign(Error('private remote failure'),
      { $metadata: { httpStatusCode: 503 } }); } })), /range retries exhausted/i);
    assert.equal(calls, 4); assert.deepEqual(f.waits, [250, 500, 1000]);
  });
});

test('wrong range identities, ignored ranges and oversized bodies fail closed without retrying', async t => {
  for (const reason of ['status', 'range-start', 'range-end', 'range-total', 'length', 'etag', 'weak-etag',
    'version', 'missing-version', 'body', 'oversized', 'precondition']) await t.test(reason, async () => {
    const f = fixture(), opened = f.readRange;
    await assert.rejects(collect(f.stream({ readRange: async request => {
      if (reason === 'precondition') { f.calls.push(request); throw Object.assign(Error('fixture identity changed'), { $metadata: { httpStatusCode: 412 } }); }
      const response = await opened(request);
      if (reason === 'status') response.$metadata.httpStatusCode = 200;
      if (reason === 'range-start') response.ContentRange = `bytes 1-${request.end}/${f.bytes.length}`;
      if (reason === 'range-end') response.ContentRange = `bytes 0-${request.end + 1}/${f.bytes.length}`;
      if (reason === 'range-total') response.ContentRange = `bytes 0-${request.end}/${f.bytes.length + 1}`;
      if (reason === 'length') response.ContentLength++;
      if (reason === 'etag') response.ETag = '"different"';
      if (reason === 'weak-etag') response.ETag = 'W/' + etag;
      if (reason === 'version') response.VersionId = 'different-version';
      if (reason === 'missing-version') delete response.VersionId;
      if (reason === 'body') response.Body[Symbol.asyncIterator] = undefined;
      if (reason === 'oversized') response.Body[Symbol.asyncIterator] = async function* () { yield Buffer.alloc(request.end - request.start + 2); };
      return response;
    } })));
    assert.equal(f.calls.length, 1); assert.deepEqual(f.waits, []); assert.equal(f.active(), 0);
  });
});

test('abort, per-range timeout and whole-download deadline close bodies and cannot yield partial ciphertext', async t => {
  await t.test('caller abort', async () => {
    const f = fixture(), controller = new AbortController(), opened = f.readRange;
    const stream = f.stream({ signal: controller.signal, readRange: async request => {
      const response = await opened(request);
      response.Body[Symbol.asyncIterator] = async function* () { yield Buffer.from('x'); controller.abort(Error('fixture cancelled'));
        await new Promise(() => {}); };
      return response;
    } });
    await assert.rejects(collect(stream), /fixture cancelled/); assert.equal(f.calls.length, 1); assert.equal(f.active(), 0);
  });
  await t.test('range timeout', async () => {
    const f = fixture(), opened = f.readRange;
    const stream = f.stream({ rangeTimeoutMs: 10, maxAttempts: 2, readRange: async request => {
      const response = await opened(request); response.Body[Symbol.asyncIterator] = async function* () { await new Promise(() => {}); };
      return response;
    } });
    await assert.rejects(collect(stream), /range retries exhausted/i); assert.equal(f.calls.length, 2); assert.equal(f.active(), 0);
  });
  await t.test('deadline during storage pause', async () => {
    const f = fixture(), stream = f.stream({ maxDurationMs: 10 });
    await stream.next(); assert.equal(f.active(), 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(stream.next(), /deadline/i); await stream.destroy(); assert.equal(f.calls.length, 1);
  });
  await t.test('abort before first request', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort(Error('fixture cancelled'));
    await assert.rejects(collect(f.stream({ signal: controller.signal })), /fixture cancelled/); assert.equal(f.calls.length, 0);
  });
  await t.test('abort during backoff', async () => {
    const f = fixture(), controller = new AbortController(); let calls = 0;
    const stream = f.stream({ signal: controller.signal,
      readRange: async () => { calls++; throw Object.assign(Error('fixture reset'), { code: 'ECONNRESET' }); },
      wait: async (_, current) => { controller.abort(Error('fixture cancelled during backoff')); current.throwIfAborted(); } });
    await assert.rejects(collect(stream), /fixture cancelled during backoff/); assert.equal(calls, 1);
  });
  await t.test('deadline during body read', async () => {
    const f = fixture(), opened = f.readRange;
    const stream = f.stream({ maxDurationMs: 10, rangeTimeoutMs: 100, readRange: async request => {
      const response = await opened(request); response.Body[Symbol.asyncIterator] = async function* () { await new Promise(() => {}); };
      return response;
    } });
    await assert.rejects(collect(stream), /deadline/i); assert.equal(f.calls.length, 1); assert.equal(f.active(), 0);
  });
});

test('invalid source identities or unbounded download settings never open a request', () => {
  const f = fixture();
  for (const extra of [{ remote: { bytes: 1 } }, { remote: { bytes: 1, etag: 'W/' + etag } },
    { remote: { bytes: 0, etag } }, { remote: { bytes: 3 * 1024 ** 3, etag } },
    { remote: { bytes: 1, etag, versionId: 'private\nheader' } }, { rangeBytes: 9 * 1024 ** 2 }, { rangeBytes: 0 },
    { maxAttempts: 100 }, { maxDurationMs: 0 }, { rangeTimeoutMs: 0 }]) assert.throws(() => f.stream(extra));
  assert.equal(f.calls.length, 0);
});

test('a synchronous cancellation still observes a later iterator rejection without terminating the process', () => {
  const script = `import {createDriverAuditTransferDownload} from ${JSON.stringify(new URL('./driverAuditTransferDownload.js', import.meta.url).href)};
    const controller = new AbortController(); let closed = false;
    const stream = createDriverAuditTransferDownload({remote:{bytes:3,etag:'"fixture"'},signal:controller.signal,
      readRange:async()=>({ContentLength:3,ContentRange:'bytes 0-2/3',ETag:'"fixture"',$metadata:{httpStatusCode:206},
        Body:{[Symbol.asyncIterator](){return {next(){controller.abort(Error('fixture cancelled'));
          return Promise.reject(Error('fixture late iterator failure'));}};},destroy(){closed=true;}}})});
    try {await stream.next();throw Error('cancellation was not observed');}
    catch(error){if(error.message!=='fixture cancelled')throw error;}
    await stream.destroy();await new Promise(resolve=>setImmediate(resolve));
    if(!closed)throw Error('response was not closed');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { timeout: 5000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('the real Spaces adapter signs only the session object and pins every range to its authenticated HEAD identity', async () => {
  const bytes = Buffer.from('fictional private encrypted transfer'), calls = [], sessionId = '00000000-0000-4000-8000-000000000022';
  let closed = false;
  const client = { async send(command, options) {
    calls.push({ name: command.constructor.name, input: command.input, options });
    if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: bytes.length, ETag: etag, VersionId: 'fixture-version' };
    assert.equal(command.constructor.name, 'GetObjectCommand');
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(command.input.Range);
    assert.equal(command.input.IfMatch, etag); assert.equal(command.input.VersionId, 'fixture-version');
    assert(options.abortSignal instanceof AbortSignal);
    return { Body: { async *[Symbol.asyncIterator]() { yield bytes.subarray(Number(start), Number(end) + 1); }, destroy() {} },
      ContentLength: Number(end) - Number(start) + 1, ContentRange: `bytes ${start}-${end}/${bytes.length}`,
      ETag: etag, VersionId: 'fixture-version', $metadata: { httpStatusCode: 206 } };
  }, destroy() { closed = true; } };
  const adapter = createDriverAuditTransferSpacesAdapter({ SPACES_KEY: 'fictional', SPACES_SECRET: 'fictional', SPACES_BUCKET: 'fictional-private' }, { client });
  const remote = await adapter.head(sessionId);
  assert.deepEqual(remote, { bytes: bytes.length, etag, versionId: 'fixture-version' });
  assert.deepEqual(await collect(await adapter.read(sessionId, undefined, remote)), bytes);
  assert(calls.every(call => call.input.Bucket === 'fictional-private' && call.input.Key === '_driver_report_migration/' + sessionId + '/transfer.enc'));
  assert.deepEqual(calls.map(call => call.name), ['HeadObjectCommand', 'GetObjectCommand']);
  adapter.close(); assert.equal(closed, true);
});
