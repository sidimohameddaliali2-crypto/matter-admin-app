import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {installArrivalObservations,canonicalArrival} from './customerServiceArrivalObservations.js';

test('arrival evidence uses canonical clocks, retries provider failures and deduplicates concurrent observations',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'matter-arrival-test-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 let release,entered;let nextEntered=new Promise(resolve=>entered=resolve),calls=0;
 const now=Date.now(),source={author_type:'customer',provider_at:new Date(now-5000).toISOString(),captured_at:new Date(now-1000).toISOString(),type:'image'};
 const store={query:async()=>{calls++;if(calls===1){entered();await new Promise(resolve=>release=resolve);}return [source];}};
 const app=express();app.use(express.json());app.set('customerServiceAuth',{authenticate:async()=>({user:{_id:'staff'}})});
 installArrivalObservations(app,{directory,store});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const url='http://127.0.0.1:'+server.address().port+'/api/customer-service/arrival-observations';
 const body={version:1,messageId:'provider-message',scope:'account-channel',providerAt:'1900-01-01',capturedAt:'1900-01-01',visibleAt:new Date(now).toISOString(),observationStartedAt:new Date(now-10000).toISOString()};
 const send=()=>fetch(url,{method:'POST',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body:JSON.stringify(body)});
 const first=send();await nextEntered;
 assert.equal((await send()).status,503);release();assert.equal((await first).status,204);
 assert.equal((await send()).status,204);assert.equal(calls,1);
 const records=(await fs.readFile(path.join(directory,'arrival-observations.private.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(records.length,1);assert.equal(records[0].providerAt,source.provider_at);assert.equal(records[0].capturedAt,source.captured_at);assert.equal(records[0].captureDelayMs,4000);assert.equal(records[0].captureToVisibleMs,1000);assert.equal(records[0].type,'image');
 body.messageId='second';store.query=async()=>{throw Error('temporary unavailable');};assert.equal((await send()).status,503);
 store.query=async()=>[source];assert.equal((await send()).status,204);
});

test('canonical arrival rejects missing, duplicate and noncustomer provider identities',async()=>{
 for(const rows of [[],[{author_type:'staff'}],[{author_type:'customer'},{author_type:'customer'}]])assert.equal(await canonicalArrival({query:async()=>rows},'scope','id'),null);
});
