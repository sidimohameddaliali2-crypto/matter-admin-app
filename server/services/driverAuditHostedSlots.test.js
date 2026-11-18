import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDriverAuditHostedSlots } from './driverAuditHostedSlots.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const main = '2026-11-18T06:30:00.000Z', noon = '2026-11-18T08:00:00.000Z';
const request = { scheduledAt: main, enrolledAt: '2026-11-17T08:15:00.000Z',
  syncConfigSha256: sha('sync'), sourceConfigSha256: sha('source') };

function fakeStore({ lostAck = false } = {}) {
  let row = { revision: 0, body: null };
  const commits = [];
  const state = {
    read: async () => ({ ...row }),
    async compareAndSwap({ expectedRevision, body, eventId }) {
      if (expectedRevision !== row.revision) throw new Error('Concurrent slot claim');
      row = { revision: expectedRevision + 1, body };
      commits.push(eventId);
      if (lostAck) throw Error('Worker connection ended after commit');
      return { body_text: body, body_sha256: sha(body) };
    },
  };
  return { state, commits };
}

test('two independent cloud invocations admit only one source run for the same slot', async () => {
  const { state, commits } = fakeStore(), clock = () => Date.parse(main) + 60000;
  const one = createDriverAuditHostedSlots({ state, clock });
  const two = createDriverAuditHostedSlots({ state, clock });
  assert.deepEqual((await Promise.all([one.claim(request), two.claim(request)])).sort(), [false, true]);
  assert.equal(commits.length, 1);
});

test('lost acknowledgement is recovered and a fresh runner can only claim the next slot', async () => {
  const { state, commits } = fakeStore({ lostAck: true });
  let now = Date.parse(main) + 15000;
  const clock = () => now, worker = createDriverAuditHostedSlots({ state, clock });
  assert.equal(await worker.claim(request), true);
  const retry = createDriverAuditHostedSlots({ state, clock });
  assert.equal(await retry.claim(request), false);
  now = Date.parse(noon) + 15000;
  assert.equal(await retry.claim({ ...request, scheduledAt: noon }), true);
  assert.equal(await worker.claim(request), false);
  assert.equal(commits.length, 2);
});

test('a caller cannot claim an elapsed enrollment, a different hour or a future slot', async () => {
  const { state, commits } = fakeStore(), clock = () => Date.parse(main);
  const worker = createDriverAuditHostedSlots({ state, clock });
  for (const candidate of [{ ...request, enrolledAt: '2026-11-18T06:30:01.000Z' },
    { ...request, scheduledAt: '2026-11-18T06:29:00.000Z' }, { ...request, scheduledAt: noon }]) {
    await assert.rejects(worker.claim(candidate), /slot is unavailable/);
  }
  assert.deepEqual(commits, []);
});
