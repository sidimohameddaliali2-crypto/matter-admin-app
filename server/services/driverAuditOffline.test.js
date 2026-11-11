import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function worker(){
 const listeners={},origin='https://app.example.invalid',removed=[],network=[],entries=new Map();let writes=0;
 const cache={keys:async()=>[...entries.keys()].map(path=>new Request(origin+path)),delete:async request=>{removed.push(new URL(request.url).pathname);return entries.delete(new URL(request.url).pathname);},put:async(request,response)=>{writes++;entries.set(new URL(request.url).pathname,await response.text());}};
 const context={URL,Request,Response,console:{log(){},error(){}},location:{origin},self:{addEventListener:(name,fn)=>listeners[name]=fn,clients:{claim:async()=>{}},skipWaiting:async()=>{}},caches:{keys:async()=>['delivery-tracker-v5-bag-reminders'],open:async()=>cache,match:async request=>{const value=entries.get(new URL(request.url).pathname);return value===undefined?undefined:new Response(value);},delete:async()=>{throw Error('Must not delete operational cache');}},fetch:async request=>{network.push(request.url);return new Response('network');}};
 vm.runInNewContext(fs.readFileSync(new URL('../../client/public/service-worker.js',import.meta.url),'utf8'),context);
 return {listeners,origin,removed,network,entries,get writes(){return writes;}};
}
test('driver audit data and document bypass offline interception, while operational API caching remains',async()=>{
 const w=worker();for(const path of ['/driver-audit-view?tab=mirror','/api/driver-audits/session','/api/session','/api/session/refresh','/api/reporting/status','/api/reporting/photo/image','/report-data/snapshot-a.json','/report-assets/font.woff2']){
  for(const method of ['GET','POST'])w.listeners.fetch({request:new Request(w.origin+path,{method}),respondWith(){assert.fail('An audit request must not use offline responses');}});
 }
 assert.equal(w.network.length,0);assert.equal(w.writes,0);
 let response;w.listeners.fetch({request:new Request(w.origin+'/api/deliveries'),respondWith:promise=>{response=promise;}});assert.equal(await (await response).text(),'network');await new Promise(r=>setImmediate(r));assert.equal(w.writes,1);assert.equal(w.entries.get('/api/deliveries'),'network');
});
test('worker activation removes only prior cached audits and preserves offline delivery data',async()=>{
 const w=worker();for(const path of ['/api/reporting/status','/report-data/snapshot-a.json','/driver-audit-view','/api/deliveries','/driver-mobile','/static/js/app.js'])w.entries.set(path,'saved');
 let activation;w.listeners.activate({waitUntil:promise=>{activation=promise;}});await activation;
 assert.deepEqual(w.removed.sort(),['/api/reporting/status','/driver-audit-view','/report-data/snapshot-a.json']);assert.deepEqual([...w.entries.keys()].sort(),['/api/deliveries','/driver-mobile','/static/js/app.js']);
});
