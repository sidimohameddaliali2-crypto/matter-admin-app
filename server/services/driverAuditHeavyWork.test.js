import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { withDriverAuditHeavyWork } from './driverAuditHeavyWork.js';

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audit-heavy-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, root: path.join(base, 'admission') };
}

test('heavy source and sync work never overlap and waiting writers run in arrival order', async t => {
  const { root } = await fixture(t);
  const events = [];
  let releaseFirst;
  const held = new Promise(resolve => { releaseFirst = resolve; });
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const first = withDriverAuditHeavyWork({ root, owner: 'source', pollMs: 5 }, async () => {
    events.push('source:start'); started(); await held; events.push('source:end');
  });
  await firstStarted;
  let syncQueued;
  const queued = new Promise(resolve => { syncQueued = resolve; });
  const sync = withDriverAuditHeavyWork({ root, owner: 'sync', pollMs: 5, onWaiting: syncQueued }, async () => {
    events.push('sync:start'); events.push('sync:end');
  });
  await queued;
  const later = withDriverAuditHeavyWork({ root, owner: 'source', pollMs: 5 }, async () => {
    events.push('later-source');
  });
  releaseFirst();
  await Promise.all([first, sync, later]);
  assert.deepEqual(events, ['source:start', 'source:end', 'sync:start', 'sync:end', 'later-source']);
});

test('aborting admission removes only the waiting ticket and leaves the active operation running', async t => {
  const { root } = await fixture(t);
  let finish;
  let started;
  const active = withDriverAuditHeavyWork({ root, owner: 'sync', pollMs: 5 }, async () => {
    started(); await new Promise(resolve => { finish = resolve; });
  });
  await new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  let queued;
  const waiting = withDriverAuditHeavyWork({ root, owner: 'source', pollMs: 5,
    signal: controller.signal, onWaiting: () => queued() }, async () => assert.fail('cancelled work ran'));
  await new Promise(resolve => { queued = resolve; });
  controller.abort();
  await assert.rejects(waiting, { code: 'AUDIT_ADMISSION_CANCELLED' });
  finish();
  await active;
  assert.equal(await withDriverAuditHeavyWork({ root, owner: 'source', pollMs: 5 }, async () => 'next'), 'next');
});

test('process death releases heavy admission and stale waiter state is recovered', async t => {
  const { root, base } = await fixture(t);
  const script = path.join(base, 'holder.mjs');
  const module = fileURLToPath(new URL('./driverAuditHeavyWork.js', import.meta.url));
  await fs.writeFile(script, `import {withDriverAuditHeavyWork} from ${JSON.stringify(module)};await withDriverAuditHeavyWork({root:process.argv[2],owner:'source'},async()=>{process.send('active');await new Promise(()=>setInterval(()=>{},1000));});`);
  const child = fork(script, [root], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(await withDriverAuditHeavyWork({ root, owner: 'sync', pollMs: 5 }, async () => 'recovered'), 'recovered');
});

test('separate processes receive heavy admission in their registered order', async t => {
  const { root, base } = await fixture(t);
  const script = path.join(base, 'queued.mjs');
  const module = fileURLToPath(new URL('./driverAuditHeavyWork.js', import.meta.url));
  await fs.writeFile(script, `import {withDriverAuditHeavyWork} from ${JSON.stringify(module)};let queued=false;await withDriverAuditHeavyWork({root:process.argv[2],owner:process.argv[3],pollMs:5,onWaiting(){if(!queued){queued=true;process.send({queued:true});}}},async()=>{process.send({active:true});await new Promise(r=>setTimeout(r,30));});process.disconnect();`);
  let started;
  let finish;
  const held = withDriverAuditHeavyWork({ root, owner: 'source', pollMs: 5 }, async () => {
    started(); await new Promise(resolve => { finish = resolve; });
  });
  await new Promise(resolve => { started = resolve; });
  const order = [];
  const launch = owner => {
    const child = fork(script, [root, owner], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    t.after(() => child.kill('SIGKILL'));
    const queued = new Promise(resolve => child.on('message', message => {
      if (message.queued) resolve();
      if (message.active) order.push(owner);
    }));
    const exit = new Promise((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(Error('child failed'))));
    return { queued, exit };
  };
  const sync = launch('sync');
  await sync.queued;
  const source = launch('source');
  await source.queued;
  finish();
  await Promise.all([held, sync.exit, source.exit]);
  assert.deepEqual(order, ['sync', 'source']);
});
