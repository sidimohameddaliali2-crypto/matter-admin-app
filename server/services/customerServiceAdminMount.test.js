import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountCustomerServiceInAdmin} from './customerServiceAdminMount.js';

for(const storage of [undefined,'mongodb','supabase'])test('CS configuration failure leaves existing app routes available: '+storage,async()=>{
 const app=express();let starts=0;
 const runtime=mountCustomerServiceInAdmin({app,env:{CUSTOMER_SERVICE_STORAGE:storage},start:async()=>{starts++;throw Error('Isolated unavailable connection');}});
 app.get('/api/auth/me',(req,res)=>res.json({existingLogin:true}));
 app.get('/api/deliveries',(req,res)=>res.json({existingOperations:true}));
 await runtime.ready;assert.equal(starts,storage==='supabase'?1:0);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  for(const path of ['/api/customer-service/me','/api/customer-service/work-items','/api/customer-service-capture/webhook']){
   const response=await fetch(base+path);assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');
  }
  assert.deepEqual(await fetch(base+'/api/auth/me').then(response=>response.json()),{existingLogin:true});
  assert.deepEqual(await fetch(base+'/api/deliveries').then(response=>response.json()),{existingOperations:true});
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('the destination never mounts a second source-capture writer',async()=>{
 const app=express();const runtime=mountCustomerServiceInAdmin({app,env:{CUSTOMER_SERVICE_STORAGE:'supabase'},start:async()=>({hosted:true})});await runtime.ready;
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/api/customer-service-capture/normalized',{method:'POST'})).status,404);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
