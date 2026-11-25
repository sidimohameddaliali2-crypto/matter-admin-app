import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffApi } from './api-handoff.mjs';

const candidate = { releaseId: 'new', role: 'web', port: 35001 };
const previous = { releaseId: 'old', role: 'web', port: 35000 };
function fixture(failure) {
  const calls = [];
  const ops = Object.fromEntries(['recordPending','start','ready','switchTraffic','publicReady','publishWebsite','commit','discard','restoreTraffic','rollbackWebsite','clearPending','retire','retirementResult'].map(name => [name, async (...args) => {
    calls.push({ name, args });
    if (failure?.(name, calls)) throw Error(name + ' failed');
    if (name === 'switchTraffic') return { drainToken: previous.port };
    if (name === 'publishWebsite') return { changed: true };
  }]));
  return { calls, ops, names: () => calls.map(call => call.name) };
}
test('candidate readiness and public verification precede publication; retirement follows durable commit', async () => {
  const fake = fixture(); await handoffApi({ candidate, previous, ops: fake.ops });
  assert.deepEqual(fake.names(), ['recordPending','start','ready','switchTraffic','publicReady','publishWebsite','commit','clearPending','retire','retirementResult']);
});
test('bad candidate never receives traffic; public failure restores verified old traffic before deleting candidate', async () => {
  const unready = fixture(name => name === 'ready');
  await assert.rejects(handoffApi({ candidate, previous, ops: unready.ops }), /ready failed/);
  assert.equal(unready.names().includes('switchTraffic'), false);
  const bad = fixture((name, calls) => name === 'publicReady' && calls.filter(call => call.name === name).length === 1);
  await assert.rejects(handoffApi({ candidate, previous, ops: bad.ops }), /publicReady failed/);
  assert.ok(bad.names().indexOf('restoreTraffic') < bad.names().indexOf('discard'));
  assert.equal(bad.names().includes('retire'), false);
});
test('uncertain switch/rollback retains both releases and pending evidence', async () => {
  const fake = fixture(name => ['switchTraffic','restoreTraffic'].includes(name));
  await assert.rejects(handoffApi({ candidate, previous, ops: fake.ops }), /operator attention/);
  assert.equal(fake.names().includes('discard'), false);
  assert.equal(fake.names().includes('clearPending'), false);
});
test('failed durable commit rolls the website back; drain timeout never kills old requests', async () => {
  const bad = fixture(name => name === 'commit');
  await assert.rejects(handoffApi({ candidate, previous, ops: bad.ops }), /commit failed/);
  assert.ok(bad.names().indexOf('rollbackWebsite') < bad.names().indexOf('restoreTraffic'));
  const slow = fixture(name => name === 'retire');
  assert.equal((await handoffApi({ candidate, previous, ops: slow.ops })).retirementPending, true);
  assert.equal(slow.names().includes('discard'), false);
});
test('the legacy job owner is never retired or restarted by a successful web handoff', async () => {
  const fake = fixture(); await handoffApi({ candidate, previous: { role: 'jobs', port: 5000 }, ops: fake.ops });
  assert.equal(fake.names().includes('retire'), false);
  assert.deepEqual(fake.calls.filter(call => call.name === 'start').map(call => call.args[0]), [candidate]);
});
