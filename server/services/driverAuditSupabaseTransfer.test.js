import assert from 'node:assert/strict';
import test from 'node:test';
import { createDriverAuditSupabaseTransfer, validateDriverAuditTransferUsage } from './driverAuditSupabaseTransfer.js';

const id = 'd36147eb-31bb-41d3-8bf2-408da4b098b8';
const origin = 'https://trhhjfgfmxofxhnzocks.supabase.co';
const basis = 'supabase-http-bytes-v1';
const url = origin + '/rest/v1/rpc/matter_hosted_state_read';
function fixture({ allowed = true, fetchImpl = async () => new Response('retained'), failSettle = false } = {}) {
  const calls = [], network = [];
  const transfer = createDriverAuditSupabaseTransfer({ requestId: () => id,
    async controlRpc(name, args) {
      calls.push({ name, args });
      if (name.endsWith('_reserve')) return { version: 1, basis, allowed, id: args.p_id, period: '2026-11',
        requestBytes: args.p_request_bytes, responseBytes: args.p_response_bytes, ...(!allowed ? { reason: 'monthly-limit' } : {}) };
      if (name.endsWith('_settle')) {
        if (failSettle) throw Error('Counter could not confirm settlement');
        return { version: 1, basis, settled: true, replayed: false, period: '2026-11',
          chargedRequestBytes: args.p_request_bytes, chargedResponseBytes: args.p_response_bytes };
      }
      return { version: 1, basis, month: { period: '2026-11', usedBytes: 12, reservedBytes: 0, limitBytes: 8 * 1024 ** 3 },
        day: { period: '2026-11-17', usedBytes: 12, reservedBytes: 0, limitBytes: 512 * 1024 ** 2 },
        activeReservations: 0, uncertainReservations: 0 };
    },
    async fetchImpl(...args) { network.push(args); return fetchImpl(...args); },
  });
  return { transfer, calls, network, fetch: transfer.wrapFetch({ maxResponseBytes: 1024 }) };
}

test('reserve precedes HTTP and EOF settles measured bytes including header allowances', async () => {
  const f = fixture();
  const response = await f.fetch(url, { method: 'POST', headers: { apikey: 'fixture-only' }, body: '{"p_key":"collector-state"}' });
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].name, /_reserve$/);
  assert.equal(await response.text(), 'retained');
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].name, /_settle$/);
  assert.equal(f.calls[1].args.p_id, id);
  assert.equal(f.calls[1].args.p_request_bytes, f.calls[0].args.p_request_bytes);
  assert.ok(f.calls[1].args.p_response_bytes >= Buffer.byteLength('retained'));
  assert.ok(f.calls[1].args.p_response_bytes < f.calls[0].args.p_response_bytes);
  assert.equal(f.network[0][1].redirect, 'error');
});

test('denied bytes cannot start a network request', async () => {
  const f = fixture({ allowed: false });
  await assert.rejects(f.fetch(url, { method: 'POST', body: '{}' }), error => error.code === 'AUDIT_TRANSFER_LIMIT');
  assert.equal(f.network.length, 0);
  assert.equal(f.calls.length, 1);
});

test('uncertain HTTP failure keeps its full reservation and never invents a refund', async () => {
  const f = fixture({ fetchImpl: async () => { throw Error('Disconnected'); } });
  await assert.rejects(f.fetch(url, { method: 'POST', body: '{}' }), /Disconnected/);
  assert.equal(f.calls.length, 1);
});

test('a truncated body keeps the pessimistic charge', async () => {
  let count = 0;
  const f = fixture({ fetchImpl: async () => new Response(new ReadableStream({ pull(controller) {
    if (++count === 1) controller.enqueue(Buffer.from('partial')); else controller.error(Error('Truncated'));
  } })) });
  await assert.rejects((await f.fetch(url, { method: 'POST', body: '{}' })).text(), /Truncated/);
  assert.equal(f.calls.length, 1);
});

test('cancellation closes the remote body and preserves the uncertain byte allowance', async () => {
  let cancelled = false;
  const f = fixture({ fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from('partial')); },
    cancel() { cancelled = true; } })) });
  const response = await f.fetch(url, { method: 'POST', body: '{}' });
  await response.body.cancel();
  assert.equal(cancelled, true);
  assert.equal(f.calls.length, 1);
});

test('the upper body bound stops an oversized response before settlement', async () => {
  const f = fixture({ fetchImpl: async () => new Response(Buffer.alloc(1025)) });
  await assert.rejects((await f.fetch(url, { method: 'POST', body: '{}' })).arrayBuffer(), /bound/i);
  assert.equal(f.calls.length, 1);
});

test('a failed settlement cannot become a successfully consumed archive response', async () => {
  const f = fixture({ failSettle: true });
  await assert.rejects((await f.fetch(url, { method: 'POST', body: '{}' })).text(), /settlement/i);
});

test('HTTP errors still count real transferred bytes', async () => {
  const f = fixture({ fetchImpl: async () => new Response('{"code":"fixture"}', { status: 503 }) });
  const response = await f.fetch(url, { method: 'POST', body: '{}' });
  assert.equal(response.status, 503);
  await response.text();
  assert.match(f.calls.at(-1).name, /_settle$/);
});

test('foreign URLs, credentials in URLs and unbounded bodies fail before admission', async () => {
  const f = fixture();
  for (const input of ['https://example.invalid/rest/v1/rpc/matter_hosted_state_read',
    origin + '/auth/v1/user', 'https://u:p@trhhjfgfmxofxhnzocks.supabase.co/rest/v1/rpc/matter_hosted_state_read']) {
    await assert.rejects(f.fetch(input, { method: 'POST', body: '{}' }), /destination/i);
  }
  await assert.rejects(f.fetch(url, { method: 'POST', body: new ReadableStream() }), /body/i);
  assert.equal(f.calls.length, 0);
  assert.equal(f.network.length, 0);
});

test('usage exposes the bounded counter summary without fetching archive bytes', async () => {
  const f = fixture();
  const usage = await f.transfer.readTransferUsage();
  assert.equal(usage.basis, basis);
  assert.equal(usage.month.limitBytes, 8 * 1024 ** 3);
  assert.equal(usage.day.limitBytes, 512 * 1024 ** 2);
  assert.equal(f.network.length, 0);
});

test('parallel callers queue behind four physical HTTP admissions', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 12 }, async () => (await f.fetch(url, { method: 'POST', body: '{}' })).text()));
  let active = 0, maximum = 0;
  for (const call of f.calls) {
    if (call.name.endsWith('_reserve')) maximum = Math.max(maximum, ++active);
    if (call.name.endsWith('_settle')) active--;
  }
  assert.equal(active, 0);
  assert.ok(maximum <= 4);
});

test('retained uncertainty counts can outlive the bounded retry rows', async () => {
  const f = fixture(), usage = await f.transfer.readTransferUsage();
  usage.uncertainReservations = 4097;
  assert.equal(validateDriverAuditTransferUsage(usage).uncertainReservations, 4097);
  usage.activeReservations = 5;
  assert.throws(() => validateDriverAuditTransferUsage(usage), /reservation|concurrency/);
});
