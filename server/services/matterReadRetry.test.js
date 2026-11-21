import test from 'node:test';
import assert from 'node:assert/strict';
import { readMatterGet } from './matterReadRetry.js';
import matter from './matterApiService.js';

for (const failure of [{ code: 'ECONNABORTED' }, { code: 'ETIMEDOUT' }, { code: 'ECONNRESET' }, { code: 'EAI_AGAIN' },
  { response: { status: 502 } }, { response: { status: 503 } }, { response: { status: 504 } }, { response: { status: 429, headers: { 'retry-after': '1' } } }]) {
  test(`transient subscription read retries once: ${JSON.stringify(failure)}`, async () => {
    let calls = 0; const waits = [], response = { data: { data: [{ subscription_id: 1 }] } };
    const config = { params: { page: 2 } };
    const result = await readMatterGet({ get: async (url, options) => {
      assert.equal(url, '/subscriptions'); assert.equal(options.timeout, 30000); assert.deepEqual(options.params, config.params);
      if (++calls === 1) throw failure; return response;
    } }, '/subscriptions', config, { sleep: async ms => waits.push(ms) });
    assert.equal(result, response); assert.equal(calls, 2); assert.equal(waits.length, 1);
    assert.equal(waits[0], failure.response?.status === 429 ? 1000 : 500);
    assert.deepEqual(config, { params: { page: 2 } });
  });
}

test('repeated timeout stops after two attempts, preserving the original error', async () => {
  const error = Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' }); let calls = 0;
  await assert.rejects(readMatterGet({ get: async () => { calls++; throw error; } }, '/subscriptions/1', {}, { sleep: async () => {} }), value => value === error);
  assert.equal(calls, 2);
});

for (const failure of [{ response: { status: 401 } }, { response: { status: 403 } }, { response: { status: 404 } },
  { response: { status: 429, headers: { 'retry-after': '60' } } }, { code: 'ERR_CANCELED' }]) {
  test(`permanent errors and long rate limits are not retried: ${JSON.stringify(failure)}`, async () => {
    let calls = 0;
    await assert.rejects(readMatterGet({ get: async () => { calls++; throw failure; } }, '/subscriptions', {}, { sleep: () => assert.fail('No retry') }), value => value === failure);
    assert.equal(calls, 1);
  });
}

test('subscription list and detail use the bounded read timeout; pause writes stay single-attempt', async t => {
  const reads = [], writes = [];
  const error = Object.assign(new Error('Write timeout'), { code: 'ETIMEDOUT' });
  t.mock.method(matter, 'client', () => ({
    get: async (path, config) => { reads.push({ path, config }); return { data: { data: [] } }; },
    post: async (...args) => { writes.push(args); throw error; },
  }));
  await matter.listSubscriptions({ page: 2, pageSize: 50 }); await matter.getSubscription(123);
  assert.deepEqual(reads.map(read => read.config.timeout), [30000, 30000]);
  assert.equal(reads[0].config.params.page, 2);
  await assert.rejects(matter.createSubscriptionPause(123, { pausedDays: ['2026-11-23'], chosenDays: ['2026-11-24'], reason: 'Fixture only' }), value => value === error);
  assert.equal(writes.length, 1);
});
