import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import {once} from 'node:events';
import {installLocalReadPreview,readOnlyPreviewStore} from './customerServiceLocalReadPreview.js';

const id='aaaaaaaaaaaaaaaaaaaaaaaa';
const identity={user:{_id:id,isActive:true,role:'viewer',profile:{firstName:'Local preview'},permissions:{customerService:true},permissionsConfigured:true,serviceOnly:true,localPreview:true},profile:{userId:id,enabled:true,mode:'supervisor',displayName:'Existing scope',grants:[]}};
test('no-login preview cannot activate by default or on a non-loopback origin',async()=>{
 for(const options of [{enabled:false,origin:'http://127.0.0.1:51033'},{enabled:true,origin:'http://0.0.0.0:51033'},{enabled:true,origin:'https://example.invalid'},{enabled:true,origin:'http://127.0.0.1.evil.invalid'}])await assert.rejects(installLocalReadPreview(express(),{...options,identity}),/loopback/);
});
test('loopback preview opens directly and permits only reads and an ephemeral reporting session',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'matter-local-read-preview-'));fs.mkdirSync(path.join(root,'client/build'),{recursive:true});fs.writeFileSync(path.join(root,'client/build/index.html'),'<!doctype html><head></head><div id="root"></div>');
 const app=express(),server=app.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;let mutations=0,sessions=0;
 const rawStatus=(route,headers)=>new Promise((resolve,reject)=>{const req=http.get(origin+route,{headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);});
 try{
  await installLocalReadPreview(app,{enabled:true,origin,root,identity});app.post('/api/staff-reporting/session',(req,res)=>{sessions++;res.json({frame:'/api/staff-reporting/'});});app.all('/api/write',(req,res)=>{mutations++;res.sendStatus(200);});
  let response=await fetch(origin+'/local-review',{redirect:'manual'});assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/customer-service/chats?period=all');
  response=await fetch(origin+'/customer-service/chats');const html=await response.text();assert.equal(response.status,200);assert.match(html,/localStorage.setItem\('token','cs-preview.read-only'\)/);assert.match(html,/localPreview/);assert.doesNotMatch(html,/type="password"/);assert.match(response.headers.get('cache-control'),/no-store/);
  const me=await fetch(origin+'/api/auth/me').then(r=>r.json());assert.equal(me.data.user.localPreview,true);const access=await fetch(origin+'/api/customer-service/me').then(r=>r.json());assert.equal(access.data.capabilities.previewReadOnly,true);
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await fetch(origin+'/api/write',{method})).status,403);assert.equal(mutations,0);
  assert.equal((await fetch(origin+'/api/staff-reporting/session',{method:'POST'})).status,200);assert.equal(sessions,1);
  assert.equal(await rawStatus('/api/auth/me',{host:'evil.invalid'}),403);
  assert.equal((await fetch(origin+'/api/auth/me',{headers:{origin:'https://evil.invalid'}})).status,403);
  assert.equal((await fetch(origin+'/api/auth/me',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await fetch(origin+'/api/staff-reporting/session',{method:'POST',headers:{origin:'https://evil.invalid'}})).status,403);assert.equal(sessions,1);
  assert.equal(await rawStatus('/local-review',{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}),302);
  assert.equal(await rawStatus('/api/auth/me',{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}),403);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true});}
});
test('read preview also refuses database transactions, staging and commits',async()=>{
 let reads=0,writes=0;const original={query:async(sql,options)=>{assert.equal(options.write,false);reads++;return 1;},transaction:async()=>{writes++;},stage:async()=>{writes++;},commit:async()=>{writes++;}};
 const store=readOnlyPreviewStore(original);assert.equal(await store.query('SELECT 1'),1);assert.throws(()=>store.query('UPDATE data',{write:true}),/only reads/);for(const name of ['transaction','stage','commit'])await assert.rejects(store[name](()=>{writes++;}),/only reads/);assert.equal(reads,1);assert.equal(writes,0);
});
