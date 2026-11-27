import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Delivery from '../models/Delivery.js';
import BagRefundCase from '../models/BagRefundCase.js';
import Link from '../models/CollectionRefundLink.js';
import router from '../routes/collectionRefundLinks.js';
import { newRefundLink, deriveRefundToken, hashRefundToken, accountsRefundUpdate, refundEmailStatus, resolveRefundLink, enqueueRefundLink } from './collectionRefundLinks.js';
import { refundEmailPayload, sendRefundEmail, refundEmailConfiguration, demoRefundEmailPayload, sendDemoRefundEmail } from './collectionRefundEmail.js';
import { runCollectionRefundEmailsOnce } from '../jobs/collectionRefundEmails.js';
const env = { JWT_SECRET: process.env.JWT_SECRET, BREVO_API_KEY: process.env.BREVO_API_KEY, PUBLIC_APP_URL: process.env.PUBLIC_APP_URL, COLLECTION_REFUND_EMAILS_ENABLED: process.env.COLLECTION_REFUND_EMAILS_ENABLED };
const record = { _id:'507f1f77bcf86cd799439011',customerId:'C001',customerName:'Sara <script>',type:'Collection',status:'collected',collectionRequest:{refundRequestedAfterCollection:true},collectionDetails:{collectedAt:'2026-11-27T08:00:00Z'} };
test('demo email contains only example instructions and a non-capability demo URL to fixed Accounts recipient', async () => {
  process.env.PUBLIC_APP_URL = 'https://matterapp.online';
  const key = '720c802c-2f40-4b18-a92b-b4099bd6438a', payload = demoRefundEmailPayload(key);
  assert.deepEqual(payload.to, [{ email: 'accounts@matternutrition.xyz', name: 'MATTER Accounts' }]);
  assert.match(payload.subject, /DEMO ONLY/); assert.match(payload.textContent, /No payment or real refund will change/);
  assert.match(payload.htmlContent, /https:\/\/matterapp.online\/refund\/complete\?demo=1/);
  assert.equal(payload.headers.idempotencyKey, key); assert.ok(!payload.htmlContent.includes('/complete#'));
  mock.method(Delivery, 'findOne', () => assert.fail('Demo must not read live refunds'));
  mock.method(Delivery, 'findOneAndUpdate', () => assert.fail('Demo must not update live refunds'));
  mock.method(Link, 'create', () => assert.fail('Demo must not create a real link'));
  const result = await sendDemoRefundEmail(key, async (url, options) => {
    assert.equal(url, 'https://api.brevo.com/v3/smtp/email'); assert.deepEqual(JSON.parse(options.body), payload);
    return { ok: true, json: async () => ({ messageId: 'demo-fixture-id' }) };
  });
  assert.equal(result.messageId, 'demo-fixture-id');
});
beforeEach(()=>{process.env.JWT_SECRET='fixture-secret-for-refund-links-only';process.env.BREVO_API_KEY='fixture';process.env.PUBLIC_APP_URL='https://matterapp.online';delete process.env.COLLECTION_REFUND_EMAILS_ENABLED;});
afterEach(()=>{mock.restoreAll();for(const [key,value] of Object.entries(env)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
function stubToken(link = {}) {
  const values=newRefundLink(record._id);
  mock.method(Link,'findOne',()=>({lean:async()=>({_id:'link',...values,...link})}));
  mock.method(Delivery,'findOne',()=>({lean:async()=>structuredClone(record)}));
  mock.method(Delivery,'exists',async()=>false);mock.method(BagRefundCase,'exists',async()=>false);
  return deriveRefundToken(values.tokenNonce);
}
async function invoke(path, body) {
  const handler=router.stack.find(layer=>layer.route?.path===path).route.stack[0].handle;
  const res={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler({body,app:{get:()=>null}},res);return res;
}
test('links are distinct opaque capabilities, stored as hashes, limited to a week and absent from staff status',()=>{
  const first=newRefundLink(record._id),second=newRefundLink(record._id),token=deriveRefundToken(first.tokenNonce);
  assert.match(token,/^[A-Za-z0-9_-]{43}$/);assert.equal(hashRefundToken(token),first.tokenHash);assert.notEqual(first.tokenHash,second.tokenHash);
  assert.equal(first.token,undefined);assert.equal(first.expiresAt-new Date(first.nextAttemptAt),7*86400000);
  assert.equal(JSON.stringify(refundEmailStatus(first)).includes(first.tokenHash),false);
  assert.equal(JSON.stringify(refundEmailStatus(first)).includes(first.tokenNonce),false);
});
test('emails go only to Accounts, escape customer HTML and put the capability in the URL fragment',()=>{
  const link=newRefundLink(record._id),payload=refundEmailPayload(record,link);
  assert.deepEqual(payload.to,[{email:'accounts@matternutrition.xyz',name:'MATTER Accounts'}]);
  assert.ok(payload.htmlContent.includes('Sara &lt;script&gt;'));assert.ok(!payload.htmlContent.includes('Sara <script>'));
  assert.ok(payload.htmlContent.includes('/refund/complete#'));assert.ok(!payload.htmlContent.includes('?token='));
  assert.equal(payload.headers.idempotencyKey,link.messageKey);
});
test('Brevo accepts the message once and duplicate-idempotency responses are safe acknowledgements',async()=>{
  const link=newRefundLink(record._id);let request;
  const result=await sendRefundEmail(record,link,async(url,options)=>{request={url,options};return{ok:true,json:async()=>({messageId:'fixture-message'})};});
  assert.equal(result.messageId,'fixture-message');assert.equal(request.url,'https://api.brevo.com/v3/smtp/email');
  assert.equal(JSON.parse(request.options.body).headers.idempotencyKey,link.messageKey);
  assert.deepEqual(await sendRefundEmail(record,link,async()=>({ok:false,status:400,json:async()=>({code:'duplicate_parameter'})})),{duplicate:true});
});
test('invalid and expired tokens do not expose collection data',async()=>{
  const query=mock.method(Link,'findOne',()=>assert.fail('must not query malformed token'));
  await assert.rejects(resolveRefundLink('BAG-A0001'),/invalid/);assert.equal(query.mock.callCount(),0);
  mock.restoreAll();const token=stubToken({expiresAt:new Date(0)});
  await assert.rejects(resolveRefundLink(token),error=>error.statusCode===410);
});
test('public view is restricted to the token record and returns no contact details or staff permissions',async()=>{
  const token=stubToken();const res=await invoke('/view',{token,deliveryId:'other'});
  assert.equal(res.code,200);assert.equal(res.body.data.customerId,'C001');assert.equal(res.body.data.amount,155);
  assert.equal(res.body.data.address,undefined);assert.equal(res.body.data.collectionRefund,undefined);assert.equal(res.body.data.token,undefined);
});
test('Accounts completion requires payment confirmation and a transaction reference and audits the mailbox honestly',()=>{
  const input={confirmed:true,reference:'BANK-123',version:0,eventId:'accounts-fixture-001'};
  assert.throws(()=>accountsRefundUpdate(record,{...input,confirmed:false}),/Confirm/);
  assert.throws(()=>accountsRefundUpdate(record,{...input,reference:'  '}),/reference/);
  const update=accountsRefundUpdate(record,input);
  assert.equal(update.$set['collectionRefund.status'],'refunded');assert.equal(update.$unset['collectionRefund.updatedBy'],1);
  assert.equal(update.$push['collectionRefund.history'].actorEmail,'accounts@matternutrition.xyz');assert.equal(update.$push['collectionRefund.history'].actorType,'accounts_email_link');
  assert.equal(update.$push['collectionRefund.history'].actor,undefined);
});
test('public completion uses the token collection, optimistic version and existing one-deposit guard',async()=>{
  const token=stubToken();let captured;
  mock.method(Delivery,'findOneAndUpdate',async(filter,update)=>{captured={filter,update};return record;});mock.method(Link,'updateOne',async()=>({}));
  const res=await invoke('/complete',{token,deliveryId:'forged',confirmed:true,reference:'BANK-123',version:0,eventId:'accounts-fixture-001'});
  assert.equal(res.code,200);assert.equal(captured.filter._id,record._id);assert.deepEqual(captured.filter['collectionRefund.status'],{$ne:'refunded'});
  assert.deepEqual(captured.filter['collectionRefund.version'],{$in:[null,0]});assert.equal(captured.update.$set['collectionRefund.depositKey'],'C001');
});
test('a refund recorded in Bag Operations blocks public completion without a write',async()=>{
  const token=stubToken();mock.restoreAll();stubToken();mock.method(BagRefundCase,'exists',async()=>({_id:'paid'}));
  const write=mock.method(Delivery,'findOneAndUpdate',()=>assert.fail('must not write'));
  const res=await invoke('/complete',{token,confirmed:true,reference:'BANK-123',version:0,eventId:'accounts-fixture-001'});
  assert.equal(res.code,409);assert.equal(write.mock.callCount(),0);
});
test('a stale version cannot overwrite a concurrent update',async()=>{
  const token=stubToken();const write=mock.method(Delivery,'findOneAndUpdate',async()=>null);
  const res=await invoke('/complete',{token,confirmed:true,reference:'BANK-123',version:0,eventId:'accounts-fixture-001'});
  assert.equal(res.code,409);assert.equal(write.mock.callCount(),1);
});
test('already-completed links are read-only on retry',async()=>{
  const token=stubToken();Delivery.findOne=()=>({lean:async()=>({...record,collectionRefund:{status:'refunded',reference:'BANK-OLD'}})});
  mock.method(Delivery,'findOneAndUpdate',()=>assert.fail('must not overwrite'));
  const res=await invoke('/complete',{token,reference:'DIFFERENT'});assert.equal(res.code,200);assert.equal(res.body.alreadyCompleted,true);
});
function stubJob(link) {
  mock.method(Link,'init',async()=>{});mock.method(Link,'distinct',async()=>[]);
  mock.method(Delivery,'find',()=>({select(){return this;},sort(){return this;},limit(){return this;},lean:async()=>[]}));
  let claimed=false;mock.method(Link,'findOneAndUpdate',()=>({select(){return this;},lean:async()=>claimed?null:(claimed=true,link)}));
  mock.method(Delivery,'findOne',()=>({select:()=>({lean:async()=>record})}));
  mock.method(Delivery,'exists',async()=>false);mock.method(BagRefundCase,'exists',async()=>false);
  return mock.method(Link,'updateOne',async()=>({}));
}
test('the worker leases a notification and records Brevo acceptance',async()=>{
  const now=new Date(),link={...newRefundLink(record._id),_id:'link',attempts:1,leaseUntil:new Date(now.getTime()+120000)};
  const writes=stubJob(link);let sends=0;
  await runCollectionRefundEmailsOnce({now,send:async()=>{sends++;return{messageId:'fixture-mail'};}});
  assert.equal(sends,1);assert.ok(writes.mock.calls.some(c=>c.arguments[1].$set.state==='sent'));
});
test('timeouts retain the same link for a safe retry, and old uncertain sends require human review',async()=>{
  const now=new Date(),link={...newRefundLink(record._id),_id:'link',attempts:2,firstAttemptAt:new Date(now.getTime()-60000),leaseUntil:now};
  let writes=stubJob(link);
  await runCollectionRefundEmailsOnce({now,send:async()=>{throw Object.assign(new Error('timeout'),{code:23});}});
  assert.ok(writes.mock.calls.some(c=>c.arguments[1].$set.state==='uncertain'));
  mock.restoreAll();writes=stubJob({...link,firstAttemptAt:new Date(now.getTime()-25*60000)});
  await runCollectionRefundEmailsOnce({now,send:async()=>assert.fail('must not resend beyond provider dedupe window')});
  assert.ok(writes.mock.calls.some(c=>c.arguments[1].$set.state==='needs_review'));
});
test('disabled email never sends or queries the notification store',async()=>{
  process.env.COLLECTION_REFUND_EMAILS_ENABLED='false';mock.method(Link,'init',()=>assert.fail('must not initialize'));
  await runCollectionRefundEmailsOnce({send:async()=>assert.fail('must not send')});
});
test('automatic enqueue is insert-only and cannot rotate an already sent link',async()=>{
  mock.method(Link,'init',async()=>{});mock.method(Delivery,'exists',async()=>false);mock.method(BagRefundCase,'exists',async()=>false);let update;
  mock.method(Link,'findOneAndUpdate',async(_filter,change)=>{update=change;return{state:'sent'};});
  const result=await enqueueRefundLink(record);assert.equal(result.state,'sent');assert.ok(update.$setOnInsert);assert.equal(update.$set,undefined);
});
test('configuration checks distinguish an IP restriction from an active verified sender without exposing provider data',async()=>{
  const blocked=await refundEmailConfiguration(async()=>({ok:false,status:401,json:async()=>({message:'IP address is not recognized'})}));
  assert.deepEqual(blocked,{ready:false,code:'brevo_ip_restriction'});
  const active=await refundEmailConfiguration(async()=>({ok:true,json:async()=>({senders:[{email:process.env.BREVO_SENDER_EMAIL||'noreply@matternutrition.xyz',active:true}],secret:'not-returned'})}));
  assert.deepEqual(active,{ready:true,code:'ready'});
});
test('replacement link generation revokes the old capability and preserves an audit event',async()=>{
  mock.method(Link,'init',async()=>{});mock.method(Delivery,'exists',async()=>false);mock.method(BagRefundCase,'exists',async()=>false);
  const old=newRefundLink(record._id),updatedAt=new Date(Date.now()-120000);
  mock.method(Link,'findOne',async()=>({...old,state:'sent',updatedAt}));let captured;
  mock.method(Link,'findOneAndUpdate',async(filter,update)=>{captured={filter,update};return update.$set;});
  await enqueueRefundLink(record,{resend:true,actorName:'Manager'});
  assert.notEqual(captured.update.$set.tokenHash,old.tokenHash);assert.notEqual(captured.update.$set.messageKey,old.messageKey);
  assert.equal(captured.filter.updatedAt,updatedAt);assert.equal(captured.update.$push.events.actorName,'Manager');
});
