import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedMap } from './boundedMap.js';

test('a slow first request does not block the next batch, request limit and result order stay identical', async () => {
  const started=[],releases=new Map();let active=0,peak=0;
  const work=boundedMap([0,1,2,3,4],2,async value=>{
    started.push(value);peak=Math.max(peak,++active);
    await new Promise(resolve=>releases.set(value,resolve));active--;return value*2;
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started,[0,1]);
  releases.get(1)();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started,[0,1,2],'old fixed batches would still be waiting for request 0');
  for(const id of [2,3,4]){releases.get(id)();await new Promise(resolve=>setImmediate(resolve));}
  releases.get(0)();assert.deepEqual(await work,[0,2,4,6,8]);assert.equal(peak,2);
});
