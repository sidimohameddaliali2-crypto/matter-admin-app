// Repeatable integration rehearsal against the explicitly fictional localhost.
// Appends a new practice case; never deletes or resets previous practice runs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const base='http://127.0.0.1:'+Number(process.env.CUSTOMER_SERVICE_PREVIEW_PORT||51160);
const manifest=JSON.parse(await fs.readFile(new URL('../../work/action-flow/fixture.private.json',import.meta.url),'utf8'));
assert.equal(manifest.fictional,true);assert.match(manifest.database,/^gallabox_action_preview_[a-f0-9]{32}$/);
async function session(path){const html=await fetch(base+path).then(r=>r.text());const match=html.match(/localStorage\.setItem\(["']token["'],("[^"\n]+")\)/);assert.ok(match,'Local fictional session is required');return JSON.parse(match[1]);}
const token=await session('/local-review');
async function call(path,{body,actor=token,status=200,headers={}}={}){
 const response=await fetch(base+'/api/customer-service'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+actor,'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
 const result=await response.json();assert.equal(response.status,status,result.message||path);return result.data??result;
}
assert.equal((await call('/me')).capabilities.sidebarSandbox,true,'Stop before writes outside the QA sandbox');
const appSession=await fetch(base+'/api/auth/me',{headers:{authorization:'Bearer '+token}}).then(response=>response.json());
assert.equal(appSession.data?.user?.permissions?.customer_service,true,'Fixture must use the destination app’s actual page-permission key');
const catalog=await call('/sandbox/state');assert.equal(catalog.topics.length,10);assert.equal(catalog.topics.flatMap(t=>t.includes).length,50);
await call('/sandbox/cases',{body:{topic:'tag_delivery',detail:'missed_delivery'},actor:'invalid',status:401});
await call('/sandbox/cases',{body:{topic:'tag_delivery',detail:'missed_delivery'},headers:{origin:'https://unrelated.invalid'},status:403});
const created=await call('/sandbox/cases',{body:{topic:'tag_delivery',detail:'missed_delivery'}}),cid=created.conversationId;
const {practice}=await call('/sandbox/state?conversationId='+cid),definitions=await call('/requests/definitions');
assert.equal(practice.customer_context.source,'qa_fixture');assert.equal(practice.customer_context.subscriptions[0].planName,'Sample 2-meal plan');
const priorId=practice.customer_context.previousRequests[0].conversationId;
assert.equal((await call('/sandbox/state?conversationId='+cid)).practice.customer_context.previousRequests[0].conversationId,priorId,'Reading context must not create duplicate history');
const priorConversation=await call('/conversations/'+priorId),priorRequests=await call('/requests?queue=conversation&conversationId='+priorId);
assert.equal(priorConversation.conversation.providerInbox.status,'resolved');assert.ok(priorConversation.messages.some(m=>m.authorType==='staff'&&m.text.includes('QA-BAG-')));assert.equal(priorRequests.requests[0].status,'resolved');assert.equal(priorRequests.requests[0].resolution.outcomeCode,'collection_completed');assert.equal(priorRequests.requests[0].history.length,2);
const check=new Date(Date.now()+86400000).toISOString(),promise=new Date(Date.now()+88200000).toISOString();
const create={requestId:randomUUID(),issueKey:randomUUID(),definitionVersion:definitions.actionVersion,conversationId:cid,classification:{kind:'complaint',topic:'tag_delivery',subtopic:'missed_delivery'},ownerId:manifest.users.staff,title:'QA API rehearsal · missed delivery',actionCode:'check',details:{reference:practice.order_reference,deliveryDate:practice.delivery_date},nextAction:'Check with Delivery',dueAt:check};
let issue=await call('/work-items',{body:create});const initial=issue;
issue=await call('/requests/'+issue._id+'/commands',{body:{requestId:randomUUID(),operation:'work',version:issue.version,definitionVersion:definitions.actionVersion,actionCode:'followup_other',details:{},nextAction:'Confirm the remedy',waitingOn:'Delivery',dueAt:check,customerUpdateDueAt:promise}});
assert.equal(issue.status,'waiting');assert.equal(new Date(issue.customerUpdateDueAt).toISOString(),promise);assert.equal(new Date(issue.nextAction.dueAt).toISOString(),check);
const update={requestId:randomUUID(),operation:'work',version:initial.version,definitionVersion:definitions.actionVersion,actionCode:'followup_other',details:{},nextAction:'Stale update',dueAt:check};
await call('/requests/'+issue._id+'/commands',{body:update,status:409});
const other=await session('/test/session/adrian');await call('/requests/'+issue._id+'/commands',{body:{...update,requestId:randomUUID(),version:issue.version},actor:other,status:403});
const close={requestId:randomUUID(),operation:'work',version:issue.version,definitionVersion:definitions.actionVersion,actionCode:'complete',outcomeCode:'day_credit_applied',details:{deliveryDate:practice.delivery_date,creditReference:'QA-CREDIT-'+cid.slice(-6).toUpperCase(),customerInformed:true},evidenceReference:'Unverified claim'};
await call('/requests/'+issue._id+'/commands',{body:close,status:400});
const event=kind=>call('/sandbox/events',{body:{conversationId:cid,kind}});
const ack=await event('delivery_acknowledged');assert.equal((await event('delivery_acknowledged')).id,ack.id);
const credit=await event('credit_posted');assert.equal((await event('credit_posted')).id,credit.id);
await call('/requests/'+issue._id+'/commands',{body:close,status:400});
const reply=await event('customer_updated');
close.evidenceMessageId=reply.body.messageId;close.evidenceReference=credit.body.reference;
issue=await call('/requests/'+issue._id+'/commands',{body:close});assert.equal(issue.status,'resolved');assert.equal(issue.resolution.outcomeCode,'day_credit_applied');
assert.equal((await call('/requests/'+issue._id+'/commands',{body:close})).version,issue.version,'A retry must not duplicate closure');
const saved=(await call('/requests?queue=conversation&conversationId='+cid)).requests.find(r=>r._id===issue._id);assert.equal(saved.status,'resolved');assert.equal(new Date(saved.customerUpdateDueAt).toISOString(),promise);
const sibling=await call('/work-items',{body:{...create,requestId:randomUUID(),issueKey:randomUUID(),title:'QA API rehearsal · second issue'}});
const all=(await call('/requests?queue=conversation&conversationId='+cid)).requests;assert.equal(all.length,2);assert.equal(all.find(r=>r._id===issue._id).status,'resolved');assert.equal(all.find(r=>r._id===sibling._id).status,'open');
const followup=await event('customer_followup');
const reopened=await call('/requests/'+issue._id+'/commands',{body:{requestId:randomUUID(),operation:'work',version:issue.version,definitionVersion:definitions.actionVersion,reopen:true,reopenReason:'The customer has a further question',reopenMessageId:followup.body.messageId,actionCode:'followup_other',details:{},nextAction:'Review the customer follow-up',dueAt:check}});
assert.equal(reopened.status,'open');assert.ok(reopened.history.some(h=>h.after?.status==='resolved'));assert.equal(reopened.resolution.outcomeCode,'day_credit_applied');
const conversation=await call('/conversations/'+cid);assert.equal(conversation.conversation.providerInbox.status,'open');
console.log(JSON.stringify({result:'passed',conversationId:cid,checks:['10 topics / 50 details','visible fictional customer / plan / linked previous conversation and resolved issue','local auth and cross-origin denials','create / follow up / promise persistence','stale edit rejected','other staff edit denied','premature closure rejected','idempotent operational simulations','evidenced closure / retry / readback','independent sibling issue','reopening retains prior outcome','provider chat state preserved']},null,2));
