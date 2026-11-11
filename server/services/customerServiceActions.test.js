import test from 'node:test';
import assert from 'node:assert/strict';
import {ACTION_VERSION,TOPIC_ACTIONS} from '../config/customerServiceActions.js';
import {REQUEST_TOPICS} from '../config/customerServiceRequests.js';
import {validateWorkAction,applyWorkAction} from './customerServiceActions.js';
const reply={_id:'reply',authorType:'staff',text:'Actual answer',externalAuthorId:'staff'};
const classificationFor=(topic,kind='inquiry')=>topic==='account_support'?{kind,topic:'tag_account',subtopic:'website_issue'}:topic==='menu_support'?{kind,topic:'tag_menu',subtopic:'inaccurate_description'}:{kind,topic};
const customer={_id:'customer',authorType:'customer',text:'I withdraw this request'};
test('customer promise and internal next check persist independently through repeated updates',()=>{
 const r={classification:{topic:'delivery_missed'},evidenceMessageIds:[]};
 const input={definitionVersion:ACTION_VERSION,actionCode:'followup_other',details:{},nextAction:'Check Delivery',waitingOn:'Delivery',dueAt:'2026-11-11T06:00Z',customerUpdateDueAt:'2026-11-11T06:30Z'};
 applyWorkAction(r,input,validateWorkAction(r,input,[]),'actor',new Date());
 assert.equal(r.status,'waiting');assert.equal(new Date(r.nextAction.dueAt).toISOString(),'2026-11-11T06:00:00.000Z');assert.equal(new Date(r.customerUpdateDueAt).toISOString(),'2026-11-11T06:30:00.000Z');
 const {customerUpdateDueAt,...withoutPromise}=input;
 applyWorkAction(r,withoutPromise,validateWorkAction(r,withoutPromise,[]),'actor',new Date());
 assert.equal(new Date(r.customerUpdateDueAt).toISOString(),'2026-11-11T06:30:00.000Z');
 assert.throws(()=>validateWorkAction(r,{...input,customerUpdateDueAt:'not a time'},[]));
 applyWorkAction(r,{...input,customerUpdateDueAt:null},validateWorkAction(r,{...input,customerUpdateDueAt:null},[]),'actor',new Date());assert.equal(r.customerUpdateDueAt,null);
});
function validFields(fields){return Object.fromEntries(fields.map(f=>[f.id,f.type==='checkbox'?true:f.type==='number'?120:f.type==='date'?'2026-11-10':'Attributable fixture value']));}
test('all legacy and newly supported action families validate every conditional outcome',()=>{
 assert.deepEqual(Object.keys(TOPIC_ACTIONS).sort(),[...REQUEST_TOPICS.map(t=>t.id),'menu_support','account_support'].sort());
 for(const [topic,actions]of Object.entries(TOPIC_ACTIONS)){
  assert.equal(new Set(actions.map(a=>a.code)).size,actions.length);
  for(const action of actions){
   for(const outcome of action.outcomes||[null]){
    const r={classification:classificationFor(topic),followups:[],exceptions:[],evidenceMessageIds:[]};
    const input={definitionVersion:ACTION_VERSION,actionCode:action.code,outcomeCode:outcome?.code,details:validFields([...(action.fields||[]),...(outcome?.fields||[])]),nextAction:'Check the actual change',dueAt:'2026-11-10T06:00Z',evidenceMessageId:outcome?.group==='withdrawn'?'customer':'reply'};
    const result=validateWorkAction(r,input,[reply,customer]);applyWorkAction(r,input,result,'actor',new Date());
    assert.equal(r.status,action.terminal?'resolved':'open');assert.equal(r.workflowDefinitionVersion,ACTION_VERSION);
    if(outcome){assert.equal(r.resolution.outcomeCode,outcome.code);assert.equal(r.resolution.outcomeGroup,outcome.group);}
    for(const f of [...(action.fields||[]),...(outcome?.fields||[])].filter(f=>f.required))assert.throws(()=>validateWorkAction({classification:r.classification}, {...input,details:{...input.details,[f.id]:undefined}},[reply,customer]),undefined,topic+'/'+action.code+'/'+f.id);
   }
  }
 }
});
test('human reply excludes automation and internal notes; withdrawal requires customer source',()=>{
 const r={classification:{kind:'inquiry',topic:'nutrition'}};
 const input={definitionVersion:ACTION_VERSION,actionCode:'answer',outcomeCode:'information_provided',details:{noRemainingAction:true},evidenceMessageId:'reply'};
 for(const bad of [{...reply,authorType:'bot'},{...reply,internalNote:true},{...reply,display:{automatedReply:true}}])assert.throws(()=>validateWorkAction(r,input,[bad]));
 assert.throws(()=>validateWorkAction({classification:{kind:'inquiry',topic:'pause'}},{...input,actionCode:'complete',outcomeCode:'withdrawn',details:{customerInformed:true}},[reply]));
});
test('pending operational pause cannot be satisfied by answer, or bypass followup/approval checks',()=>{
 const r={classification:{kind:'inquiry',topic:'pause'},currentActionCode:'check'};
 assert.throws(()=>validateWorkAction(r,{definitionVersion:ACTION_VERSION,actionCode:'answer',outcomeCode:'information_provided',details:{noRemainingAction:true},evidenceMessageId:'reply'},[reply]));
 const input={definitionVersion:ACTION_VERSION,actionCode:'complete',outcomeCode:'dates_changed',details:{appliedDates:'Tuesday',requestedDatesChanged:true,customerInformed:true},evidenceReference:'Confirmed operational record'};
 assert.throws(()=>validateWorkAction({...r,followups:[{status:'open'}]},input,[]));assert.throws(()=>validateWorkAction({...r,exceptions:[{status:'pending'}]},input,[]));
});
test('generic followups and later topic changes cannot erase unfinished operational work',()=>{
 const operational={classification:{kind:'inquiry',topic:'pause'},currentActionCode:'check',status:'open'};
 const generic={...operational,currentActionCode:'followup_other'};
 const history=[{event:'work',after:operational},{event:'work',after:generic}];
 const input={definitionVersion:ACTION_VERSION,actionCode:'answer',outcomeCode:'information_provided',details:{noRemainingAction:true},evidenceMessageId:'reply'};
 assert.throws(()=>validateWorkAction({...generic,history},input,[reply]),/operational action remains/);
 const corrected={...generic,classification:{kind:'inquiry',topic:'nutrition'},history};
 assert.throws(()=>validateWorkAction(corrected,input,[reply]),/operational action remains/);
 const specialist={...corrected,currentActionCode:'specialist'};
 assert.throws(()=>validateWorkAction({...specialist,history:[...history,{event:'work',after:specialist}]},{...input,actionCode:'specialist_answer',outcomeCode:'specialist_answered',details:{informationSource:'Approved source',noRemainingAction:true}},[reply]),/operational action remains/);
});
test('a prior recorded completion ends its operational interval before reopening',()=>{
 const old={classification:{kind:'inquiry',topic:'pause'},currentActionCode:'check',status:'open'};
 const closed={...old,currentActionCode:'complete',status:'resolved'};
 const reopened={...old,currentActionCode:'followup_other',history:[{event:'work',after:old},{event:'work',after:closed},{event:'work',after:{...old,currentActionCode:'followup_other'}}]};
 assert.doesNotThrow(()=>validateWorkAction(reopened,{definitionVersion:ACTION_VERSION,actionCode:'answer',outcomeCode:'information_provided',details:{noRemainingAction:true},evidenceMessageId:'reply'},[reply]));
});
test('unknown definition/action/outcome and malformed values fail closed',()=>{
 const r={classification:{topic:'refund'}};
 const input={definitionVersion:ACTION_VERSION,actionCode:'refund',outcomeCode:'refund_processed',details:{amount:120,currency:'AED',transactionReference:'ref',refundAuthorized:true,refundProcessed:true,customerInformed:true},evidenceReference:'finance record'};
 for(const patch of [{definitionVersion:'old'},{actionCode:'answer',outcomeCode:'refund_processed'},{outcomeCode:'invented'},{details:{...input.details,amount:-5}},{evidenceReference:''}])assert.throws(()=>validateWorkAction(r,{...input,...patch},[]));
});
test('followup updates the same displayed obligation rather than creating a duplicate',()=>{
 const r={classification:{topic:'refund'},followups:[{id:'existing',action:'Old check',dueAt:'2026-11-10T05:00Z',status:'open',responsibleId:'owner'}]};
 const input={definitionVersion:ACTION_VERSION,actionCode:'approval_check',details:{},nextAction:'Check with Finance',dueAt:'2026-11-10T08:00Z',waitingOn:'Finance'};
 const result=validateWorkAction(r,input,[]);applyWorkAction(r,input,result,'actor',new Date());
 assert.equal(r.followups.length,1);assert.equal(r.followups[0].id,'existing');assert.equal(r.followups[0].action,'Check with Finance');assert.equal(r.status,'waiting');assert.equal(r.resolution,undefined);
});
test('every conditional field rejects malformed values for both classifications',()=>{
 for(const kind of ['complaint','inquiry'])for(const [topic,actions]of Object.entries(TOPIC_ACTIONS))for(const action of actions)for(const outcome of action.outcomes||[null]){
  const fields=[...(action.fields||[]),...(outcome?.fields||[])];
  const input={definitionVersion:ACTION_VERSION,actionCode:action.code,outcomeCode:outcome?.code,details:validFields(fields),nextAction:'Check the actual change',dueAt:'2026-11-10T06:00Z',evidenceMessageId:outcome?.group==='withdrawn'?'customer':'reply'};
  for(const f of fields){
   const invalid=f.type==='checkbox'?[false,'true',1]:f.type==='number'?[-1,'not a number',true,[],{},'   ']:f.type==='date'?['2026-02-30','2026-13-01','tomorrow',true]:['   ',true,{},'x'.repeat(2001)];
   for(const value of invalid)assert.throws(()=>validateWorkAction({classification:classificationFor(topic,kind)},{...input,details:{...input.details,[f.id]:value}},[reply,customer]),undefined,[kind,topic,action.code,outcome?.code,f.id,JSON.stringify(value)].join('/'));
  }
 }
});
