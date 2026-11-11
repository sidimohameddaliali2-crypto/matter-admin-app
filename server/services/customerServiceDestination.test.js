import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
import {startCustomerServiceDestination,installCustomerServiceDestination} from './customerServiceDestination.js';
import {cloudInbox,configureCloudInbox} from './customerServiceCloudStore.js';
const readyIndex={gallabox_request_origin_issue:{valid:true,unique:true,attributes:2,keys:["body ->> 'originMessageId'::text","COALESCE(body ->> 'originIssueKey'::text,'primary'::text)"],predicate:"kind = 'servicerequests'::text"}};

test('destination integration is opt-in and never installs another login',async()=>{
 const app=express();let reads=0;
 assert.equal(await startCustomerServiceDestination({app,env:{},store:{head(){reads++;}}}),null);
 assert.equal(reads,0);assert.equal(app.get('customerServiceAuth'),undefined);
});
test('destination verifies writers and issue protection before exposing the workflow',async()=>{
 for(const [head,control,ready]of [[null,{},false],[{origin:'fixture'},{writer_mode:'local',workflow_mode:'cloud'},true],[{origin:'fixture'},{writer_mode:'cloud',workflow_mode:'local'},true],[{origin:'fixture'},{writer_mode:'cloud',workflow_mode:'cloud'},false]]){
  const app=express(),previous={fixture:true};configureCloudInbox(previous);
  const store={head:async()=>head,query:async sql=>sql.includes('worker_control')?control:ready?readyIndex:{}};
  await assert.rejects(startCustomerServiceDestination({app,env:{CUSTOMER_SERVICE_STORAGE:'supabase'},store}));
  assert.equal(cloudInbox(),previous);assert.equal(app.get('customerServiceAuth'),undefined);
 }
 configureCloudInbox(null);
});
test('destination consumes canonical storage without a local capture/cache publisher',async()=>{
 const app=express(),queries=[];
 const store={head:async()=>({origin:'existing-archive'}),query:async sql=>{queries.push(sql);return sql.includes('worker_control')?{writer_mode:'cloud',workflow_mode:'cloud'}:readyIndex;}};
 const runtime=await startCustomerServiceDestination({app,env:{CUSTOMER_SERVICE_STORAGE:'supabase'},store});
 assert.equal(runtime.hosted,true);assert.equal(cloudInbox().workflow,true);assert.equal(cloudInbox().publisher,undefined);
 assert.equal(queries.length,2);assert.ok(queries.every(q=>q.startsWith('SELECT')));assert.equal(app._router,undefined);
 await runtime.stop();assert.equal(cloudInbox(),null);assert.equal(app.get('customerServiceAuth'),null);
});
test('unset destination storage does not mount route barriers or initialize another runtime',async()=>{
 const app=express();let starts=0;
 assert.equal(installCustomerServiceDestination({app,env:{},start:async()=>{starts++;}}),null);
 assert.equal(starts,0);assert.equal(app._router,undefined);
});
async function serve(app,operation){
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{return await operation('http://127.0.0.1:'+server.address().port);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('pending customer-service startup never holds unrelated app routes and opens only after verification',async()=>{
 const app=express();let finish;
 const startup=installCustomerServiceDestination({app,env:{CUSTOMER_SERVICE_STORAGE:'supabase'},start:()=>new Promise(resolve=>{finish=resolve;})});
 app.get('/api/auth/me',(req,res)=>res.json({originalLogin:true}));app.get('/api/customer-service/me',(req,res)=>res.json({verified:true}));
 await serve(app,async url=>{
  assert.equal((await fetch(url+'/api/auth/me')).status,200);assert.equal((await fetch(url+'/api/customer-service/me')).status,503);
  finish({hosted:true});await startup.ready;
  assert.equal((await fetch(url+'/api/customer-service/me')).status,200);assert.deepEqual(await(await fetch(url+'/api/auth/me')).json(),{originalLogin:true});
 });
});
test('failed customer-service startup stays closed without enabling legacy collectors or blocking existing login',async()=>{
 const app=express();let failures=0;
 const startup=installCustomerServiceDestination({app,env:{CUSTOMER_SERVICE_STORAGE:'supabase'},start:async()=>{throw Error('Local isolated outage');},onError:()=>{failures++;}});
 app.get('/api/auth/me',(req,res)=>res.sendStatus(200));app.get('/api/customer-service/me',(req,res)=>res.sendStatus(200));app.post('/api/customer-service-capture/webhook',(req,res)=>res.sendStatus(200));
 assert.equal(await startup.ready,null);assert.equal(startup.hosted,true);assert.equal(failures,1);
 await serve(app,async url=>{
  assert.equal((await fetch(url+'/api/auth/me')).status,200);assert.equal((await fetch(url+'/api/customer-service/me')).status,503);assert.equal((await fetch(url+'/api/customer-service-capture/webhook',{method:'POST'})).status,503);
 });
});
