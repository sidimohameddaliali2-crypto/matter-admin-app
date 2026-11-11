import test from 'node:test';
import assert from 'node:assert/strict';
import {gallaboxInboxState,currentProviderInbox,inboxFilters} from './customerServiceProviderInbox.js';
import {createCloudInboxReader} from './customerServiceCloudInbox.js';
test('provider assignment and resolution are independent; unsupported records remain unknown',()=>{
 assert.deepEqual([gallaboxInboxState({id:'a',status:'OPEN'}).status,gallaboxInboxState({id:'a',status:'OPEN'}).assignment],['open','unassigned']);
 const assigned=gallaboxInboxState({id:'a',status:'OPEN',assigneeId:'staff',assigneeType:'user',user:{id:'staff',name:'Fictional staff'}});
 assert.equal(assigned.status,'open');assert.equal(assigned.assignment,'assigned');assert.equal(assigned.assigneeName,'Fictional staff');
 assert.equal(gallaboxInboxState({status:'CLOSE',assigneeId:'staff'}).status,'resolved');
 assert.equal(gallaboxInboxState({}).assignment,'unknown');assert.equal(gallaboxInboxState({status:'OTHER'}).status,'unknown');
 assert.equal(gallaboxInboxState({status:'OPEN',assigneeId:'staff',user:{id:'other',name:'Wrong'}}).assigneeName,null);
});
test('reopening and removing assignment replace the current source state without consulting automated replies or reviews',()=>{
 const old={sourceMetadata:{providerInbox:{...gallaboxInboxState({id:'old',status:'CLOSE',assigneeId:'staff'}),observedAt:'2026-11-07T01:00:00Z'}}};
 const latest={sourceMetadata:{providerInbox:{...gallaboxInboxState({id:'new',status:'OPEN'}),observedAt:'2026-11-08T01:00:00Z'}}};
 assert.equal(currentProviderInbox([latest,old]).status,'open');assert.equal(currentProviderInbox([old,latest]).assignment,'unassigned');
 assert.deepEqual(currentProviderInbox([{}]),{status:'unknown',assignment:'unknown'});
});
test('active queues ignore date restrictions but resolved history retains them; filters are validated',()=>{
 assert.equal(inboxFilters({status:'open'}).backlog,true);assert.equal(inboxFilters({assignment:'unassigned',status:'resolved'}).backlog,true);
 assert.equal(inboxFilters({status:'resolved'}).backlog,false);assert.throws(()=>inboxFilters({assignment:"unassigned' OR TRUE"}));
});
test('cloud query applies independent queues before pagination and keeps older backlog visible',async()=>{
 let sql='';const reader=createCloudInboxReader({query:async query=>{sql=query;return {blind:[],groups:[],issues:[],last:[]}}});
 const args={actor:{_id:'aaaaaaaaaaaaaaaaaaaaaaaa',role:'super_admin',isActive:true},profile:{active:true,role:'supervisor'},filters:{status:'open',assignment:'unassigned',from:'2026-11-08',to:'2026-11-08'}};
 // Capability fields are deliberately the same ones used by the real staff gate.
 args.profile={enabled:true,mode:'supervisor',userId:args.actor._id};
 await reader.list(args);
 assert.match(sql,/providerInbox,status/);assert.match(sql,/providerInbox,assignment/);assert.doesNotMatch(sql,/timestamptz>=/);
 await reader.list({...args,filters:{status:'resolved',from:'2026-11-08'}});assert.match(sql,/timestamptz>=/);
});
test('Mine validates an explicit scoped staff identity and does not accept name matching',async()=>{
 const {verifiedScopedProviderAuthors}=await import('./customerServiceProviderInbox.js');const actor={_id:'staff'};
 assert.deepEqual(verifiedScopedProviderAuthors(actor,{userId:'other',enabled:true,externalAuthorIds:['gallabox:account:channel:user']}),[]);
 assert.deepEqual(verifiedScopedProviderAuthors(actor,{userId:'staff',enabled:true,displayName:'Matching name',externalAuthorIds:['unscoped','gallabox:account:channel:user']}),['gallabox:account:channel:user']);
 assert.equal(inboxFilters({status:'open',assignment:'mine'}).backlog,true);
});
