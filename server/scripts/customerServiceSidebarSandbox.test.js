import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePracticeCompletion} from './customerServiceSidebarSandbox.js';
import {PRACTICE_REQUESTS} from './customerServicePracticeRequests.js';
import {REQUEST_TOPIC_TAGS} from '../config/customerServiceTopicTags.js';
test('every current topic detail has matching fictional request text',()=>{
 assert.deepEqual(Object.keys(PRACTICE_REQUESTS).sort(),REQUEST_TOPIC_TAGS.flatMap(t=>t.includes.map(d=>d.id)).sort());
 assert.equal(new Set(Object.values(PRACTICE_REQUESTS)).size,50);
});
const practice={id:'case',topic:'tag_delivery',detail:'missed_delivery',delivery_date:'2026-11-10'};
const input={outcomeCode:'day_credit_applied',details:{creditReference:'QA-CREDIT-ABC',deliveryDate:'2026-11-10'},evidenceMessageId:'reply'};
const events=[{kind:'credit_posted',created_at:'2026-11-10T09:00Z',body:{reference:'QA-CREDIT-ABC'}},{kind:'customer_updated',body:{messageId:'reply'}}];
const messages=[{_id:'reply',authorType:'staff',sentAt:'2026-11-10T09:01Z',sourceMetadata:{qaEvent:'customer_updated'}}];
const valid={input,practice,events,messages};
test('linked credit closure needs an actual posted QA ledger event',()=>{
 assert.doesNotThrow(()=>validatePracticeCompletion(valid));
 assert.throws(()=>validatePracticeCompletion({...valid,events:[]}),/not posted/);
 assert.throws(()=>validatePracticeCompletion({...valid,input:{...input,details:{...input.details,creditReference:'unverified assertion'}}}),/reference must match/);
});
test('a different case, service date or intake reason cannot claim this credit',()=>{
 assert.throws(()=>validatePracticeCompletion({...valid,practice:null}),/Missed Delivery/);
 assert.throws(()=>validatePracticeCompletion({...valid,practice:{...practice,detail:'late_delivery'}}),/Missed Delivery/);
 assert.throws(()=>validatePracticeCompletion({...valid,input:{...input,details:{...input.details,deliveryDate:'2026-11-11'}}}),/delivery date/);
});
test('an earlier promise, missing reply or unlinked event is not completion proof',()=>{
 assert.throws(()=>validatePracticeCompletion({...valid,messages:[]}),/Link the simulated staff reply/);
 assert.throws(()=>validatePracticeCompletion({...valid,messages:[{...messages[0],sentAt:'2026-11-10T08:59Z'}]}),/earlier promise/);
 assert.throws(()=>validatePracticeCompletion({...valid,events:events.slice(0,1)}),/Link the simulated/);
 assert.throws(()=>validatePracticeCompletion({...valid,messages:[{...messages[0],authorType:'customer'}]}),/Link the simulated/);
});
