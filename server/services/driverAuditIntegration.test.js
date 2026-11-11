import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createDriverAuditIntegration} from './driverAuditIntegration.js';

test('an active audit serves status and review writes during a slow import, then reports failure without losing the report',async t=>{
 let release,reads=0,polls=0,now=100000;
 const held=new Promise(resolve=>release=resolve);
 const env={DRIVER_AUDIT_ENABLED:'1',DRIVER_AUDIT_IMPORT_ENABLED:'1'};
 const coordinator=async(req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({savedReport:true,method:req.method}));};
 coordinator.status=()=>({status:'ready',active:{generation:'a'.repeat(64)}});
 coordinator.poll=async()=>{polls++;};
 const handler=createDriverAuditIntegration({env,dependencies:{clock:()=>now,auth:{authenticate:async()=>({})},state:{read:async()=>{reads++;await held;throw Error('source unavailable');}},archive:{readObject:async()=>{throw Error('must not read');}},store:{},budget:{reserve:async()=>({allowed:true}),settle:async()=>({settled:true})},createCoordinator:()=>coordinator}});
 const server=createServer((req,res)=>handler(req,res,()=>{res.writeHead(404);res.end();}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{release();await new Promise(resolve=>server.close(resolve));});
 env.DRIVER_AUDIT_ORIGIN='http://127.0.0.1:'+server.address().port;
 const call=(path,method='GET')=>fetch(env.DRIVER_AUDIT_ORIGIN+path,{method,signal:AbortSignal.timeout(2000)});
 const status=await call('/api/reporting/status');assert.equal(status.status,200);assert.equal(status.headers.get('x-audit-import-status'),'checking');assert.equal(reads,1);
 const saved=await call('/api/reporting/reviews','POST');assert.deepEqual(await saved.json(),{savedReport:true,method:'POST'});assert.equal(reads,1);assert.equal(polls,0);
 assert.equal((await call('/api/reporting/status')).status,200);assert.equal(reads,1);
 release();for(let i=0;i<100&&!polls;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(polls>=1);
 const failed=await call('/api/reporting/status');assert.equal(failed.status,200);assert.equal(failed.headers.get('x-audit-import-status'),'failed');assert.equal((await failed.json()).savedReport,true);assert.equal(reads,1);
 now+=61000;await call('/api/reporting/photo/image');await call('/api/reporting/reviews','POST');assert.equal(reads,1,'assets and review writes do not start transfers');
 await call('/api/reporting/status');assert.equal(reads,2,'next due status check retries');
});
