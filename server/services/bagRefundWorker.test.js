import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../client/public/service-worker.js',import.meta.url),'utf8');
function worker(fetch){
  const handlers={};let cacheReads=0,cacheWrites=0;
  const context={URL,console,fetch,location:{origin:'https://fixture.example'},caches:{match:async()=>{cacheReads++;return {ok:true,stale:true};},open:async()=>{cacheWrites++;return {put:async()=>{}};}},self:{addEventListener:(name,handler)=>handlers[name]=handler}};
  vm.runInNewContext(source,context);
  return {request:(path,method='GET')=>{let promise;handlers.fetch({request:{url:`https://fixture.example${path}`,method},respondWith:value=>promise=value});return promise;},counts:()=>({cacheReads,cacheWrites})};
}
test('refund queue reads use live network evidence and never store financial responses in the worker cache',async()=>{
  let options;const w=worker(async(request,input)=>{options=input;return {ok:true,live:true};});const response=await w.request('/api/bag-refunds');assert.equal(response.live,true);assert.equal(options.cache,'no-store');assert.deepEqual(w.counts(),{cacheReads:0,cacheWrites:0});
});
test('offline refund reads and completion writes fail instead of falling back to cached success or a queue',async()=>{
  const w=worker(async()=>{throw new Error('offline');});await assert.rejects(w.request('/api/bag-refunds'),/offline/);await assert.rejects(w.request('/api/bag-refunds/case/actions','POST'),/offline/);assert.deepEqual(w.counts(),{cacheReads:0,cacheWrites:0});
});
test('internal bag follow-ups never use cached balances or silently queue a staff update while offline',async()=>{
  const w=worker(async()=>{throw new Error('offline');});await assert.rejects(w.request('/api/bag-followups'),/offline/);await assert.rejects(w.request('/api/bag-followups','POST'),/offline/);await assert.rejects(w.request('/api/bag-operations'),/offline/);assert.deepEqual(w.counts(),{cacheReads:0,cacheWrites:0});
});
