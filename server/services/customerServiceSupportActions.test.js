import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ACTION_VERSION,TOPIC_ACTIONS,actionDefinition} from '../config/customerServiceActions.js';
import {validateWorkAction,applyWorkAction} from './customerServiceActions.js';

const families=[['menu_support','menu_corrected'],['account_support','account_fixed']];
const now=new Date('2026-11-10T10:00:00Z');
const reply={_id:'reply',authorType:'staff',text:'The correction was checked and confirmed to the customer'};
const customer={_id:'customer',authorType:'customer',text:'Please withdraw this request'};
const request=(topic,kind='inquiry')=>({classification:topic==='menu_support'?{kind,topic:'tag_menu',subtopic:'inaccurate_description'}:{kind,topic:'tag_account',subtopic:'website_issue'},status:'open',evidenceMessageIds:[],followups:[],exceptions:[]});
const input=(values={})=>({definitionVersion:ACTION_VERSION,...values});
const correction=(outcome)=>input({actionCode:'complete',outcomeCode:outcome,details:{result:'Verified correction recorded against local support reference',customerInformed:true},evidenceMessageId:'reply'});

test('support families and the explicit day-credit outcome preserve all original legacy action contracts',()=>{
 const legacy=Object.fromEntries(Object.entries(TOPIC_ACTIONS).filter(([topic])=>!families.some(([family])=>family===topic)).map(([topic,actions])=>[topic,topic==='delivery_missed'?actions.map(action=>action.code==='complete'?{...action,outcomes:action.outcomes.filter(outcome=>outcome.code!=='day_credit_applied')}:action):actions]));
 assert.equal(Object.keys(legacy).length,17);
 assert.equal(createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),'1ff2905a0573564f3602f63dc8cf576a9a1ba5104aa6d23d8d2b57788aefce00');
 const credit=actionDefinition('delivery_missed','complete').outcomes.filter(outcome=>outcome.code==='day_credit_applied');
 assert.equal(credit.length,1);assert.equal(credit[0].group,'fulfilled');
 assert.deepEqual(credit[0].fields.map(field=>field.id),['deliveryDate','creditReference','customerInformed']);
 assert.ok(credit[0].fields.every(field=>field.required));
 for(const [topic]of families){
  assert.deepEqual(TOPIC_ACTIONS[topic].filter(a=>a.featured).map(a=>a.code),['answer','check','complete']);
  assert.equal(actionDefinition(topic,'team').terminal,false);
 }
});

test('menu and account corrections cannot close without a concrete result, customer notification and supporting evidence',()=>{
 for(const [topic,outcome]of families)for(const kind of ['inquiry','complaint']){
  const r=request(topic,kind),valid=correction(outcome);
  for(const result of [undefined,'','   ',false,{}])assert.throws(()=>validateWorkAction(r,{...valid,details:{...valid.details,result}},[reply]));
  assert.throws(()=>validateWorkAction(r,{...valid,details:{...valid.details,customerInformed:false}},[reply]));
  assert.throws(()=>validateWorkAction(r,{...valid,evidenceMessageId:''},[]),/Select evidence/);
  assert.throws(()=>validateWorkAction(r,{...valid,evidenceMessageId:'uncaptured'},[reply]),/Select evidence/);
  assert.throws(()=>validateWorkAction({...r,followups:[{status:'open'}]},valid,[reply]),/outstanding follow-ups/);
  assert.throws(()=>validateWorkAction({...r,exceptions:[{status:'pending'}]},valid,[reply]),/awaiting approval/);
 }
});

test('supported corrections preserve a concrete recorded outcome and its attributable evidence basis',()=>{
 for(const [topic,outcome]of families){
  for(const source of [{evidenceMessageId:'reply'},{evidenceMessageId:'',evidenceReference:'Support record LOCAL-123, confirmed by the assigned staff member'}]){
   const r=request(topic),command={...correction(outcome),...source};
   applyWorkAction(r,command,validateWorkAction(r,command,[reply]),'staff',now);
   assert.equal(r.status,'resolved');assert.equal(r.resolution.outcomeCode,outcome);assert.equal(r.resolution.outcomeGroup,'fulfilled');
   assert.equal(r.resolution.details.customerInformed,true);assert.ok(r.resolution.details.result);
   assert.equal(r.resolution.basis,source.evidenceMessageId?'linked_evidence':'staff_recorded_reference');
   assert.equal(r.resolution.at,now);assert.equal(r.resolution.actorId,'staff');
  }
 }
});

test('pending checks and team follow-ups remain work and cannot be replaced by a generic answer',()=>{
 for(const [topic]of families)for(const actionCode of ['check','team']){
  const r=request(topic),command=input({actionCode,details:{problem:'The captured menu or account page does not work'},nextAction:'Verify the support result',dueAt:'2026-11-11T06:00:00Z'});
  applyWorkAction(r,command,validateWorkAction(r,command,[]),'staff',now);assert.equal(r.status,'open');assert.equal(r.resolution,undefined);assert.equal(r.nextAction.action,'Verify the support result');
  assert.throws(()=>validateWorkAction(r,input({actionCode:'answer',outcomeCode:'information_provided',details:{noRemainingAction:true},evidenceMessageId:'reply'}),[reply]),/operational action remains/);
  const previous={...r,classification:{...r.classification}};r.history=[{event:'work',after:previous}];r.currentActionCode='followup_other';
  assert.throws(()=>validateWorkAction(r,input({actionCode:'answer',outcomeCode:'information_provided',details:{noRemainingAction:true},evidenceMessageId:'reply'}),[reply]),/operational action remains/);
 }
});

test('an informational answer requires the actual human reply and confirmation that no work remains',()=>{
 for(const [topic]of families){
  const command=input({actionCode:'answer',outcomeCode:'information_provided',details:{noRemainingAction:true},evidenceMessageId:'reply'});
  for(const invalid of [[],[{...reply,authorType:'bot'}],[{...reply,internalNote:true}],[{...reply,display:{automatedReply:true}}]])assert.throws(()=>validateWorkAction(request(topic),command,invalid),/actual human reply/);
  assert.throws(()=>validateWorkAction(request(topic),{...command,details:{noRemainingAction:false}},[reply]));
  const r=request(topic);applyWorkAction(r,command,validateWorkAction(r,command,[reply]),'staff',now);
  assert.equal(r.status,'resolved');assert.equal(r.resolution.outcomeGroup,'information');assert.equal(r.resolution.evidenceMessageId,'reply');
 }
});

test('a refusal needs a decision reference and withdrawal needs a captured customer confirmation',()=>{
 for(const [topic]of families){
  const refused=input({actionCode:'complete',outcomeCode:'not_fulfilled',details:{decisionReference:'Support review declined the requested correction',customerInformed:true},evidenceMessageId:'reply'});
  assert.throws(()=>validateWorkAction(request(topic),{...refused,details:{customerInformed:true}},[reply]));
  const r=request(topic);applyWorkAction(r,refused,validateWorkAction(r,refused,[reply]),'staff',now);assert.equal(r.resolution.outcomeGroup,'not_fulfilled');
  const withdrawn=input({actionCode:'complete',outcomeCode:'withdrawn',details:{customerInformed:true},evidenceMessageId:'reply'});
  assert.throws(()=>validateWorkAction(request(topic),withdrawn,[reply]),/customer message confirming withdrawal/);
  const accepted={...withdrawn,evidenceMessageId:'customer'},w=request(topic);applyWorkAction(w,accepted,validateWorkAction(w,accepted,[customer]),'staff',now);assert.equal(w.resolution.outcomeGroup,'withdrawn');assert.equal(w.resolution.evidenceMessageId,'customer');
 }
});

test('recording support work changes only the issue record and implies no provider call or sent message',()=>{
 const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw Error('Provider execution is not part of action recording');};
 try{
  for(const [topic,outcome]of families){
   const source={status:'open',messages:[{id:'source',text:'Original captured context'}]},before=JSON.stringify(source),r={...request(topic),capturedConversation:source};
   const command=correction(outcome);applyWorkAction(r,command,validateWorkAction(r,command,[reply]),'staff',now);
   assert.equal(JSON.stringify(source),before);assert.equal(r.messagesSent,undefined);assert.equal(r.providerResult,undefined);
  }
  assert.equal(calls,0);
 }finally{globalThis.fetch=originalFetch;}
});
