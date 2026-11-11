import test from 'node:test';
import assert from 'node:assert/strict';
import {REQUEST_TOPIC_TAGS,requestWorkflowTopic} from '../config/customerServiceTopicTags.js';

const labels=['Delivery Issues','Bags & Collections','Meal Accuracy','Damaged Food & Packaging','Food Quality','Food Safety & Allergies','Plan & Subscription','Menu & Meal Selection','Payments & Refunds','Website & Account'];
const topic=id=>REQUEST_TOPIC_TAGS.find(value=>value.id===id);
const workflow=(id,subtopic,extra={})=>requestWorkflowTopic({kind:'complaint',topic:id,subtopic,...extra});
const invalid=fn=>assert.throws(fn,error=>error.statusCode===400);

test('the screenshot taxonomy has exactly 10 immutable Topic tags and 50 uniquely scoped Includes reasons',()=>{
 assert.deepEqual(REQUEST_TOPIC_TAGS.map(t=>t.label),labels);
 assert.deepEqual(REQUEST_TOPIC_TAGS.map(t=>t.id),['tag_delivery','tag_bags','tag_meal_accuracy','tag_damage','tag_food_quality','tag_food_safety','tag_plan','tag_menu','tag_payments','tag_account']);
 assert.deepEqual(REQUEST_TOPIC_TAGS.map(t=>t.includes.length),[7,4,5,4,3,5,6,4,7,5]);
 assert.equal(REQUEST_TOPIC_TAGS.flatMap(t=>t.includes).length,50);assert.equal(Object.isFrozen(REQUEST_TOPIC_TAGS),true);
 for(const tag of REQUEST_TOPIC_TAGS){
  assert.equal(Object.isFrozen(tag),true);assert.equal(Object.isFrozen(tag.includes),true);assert.ok(tag.group);
  assert.equal(new Set(tag.includes.map(reason=>reason.id)).size,tag.includes.length);
  for(const reason of tag.includes){assert.match(reason.id,/^[a-z]+(?:_[a-z]+)*$/);assert.equal(Object.isFrozen(reason),true);assert.ok(reason.label);}
 }
 assert.equal(topic('tag_food_safety').includes.find(r=>r.id==='foreign_object').label,'Foreign Object - (Plastic, Metal, Hair, etc.)');
 assert.equal(topic('tag_payments').includes.find(r=>r.id==='auto_recurring_payment').label,'Auto/Recurring Payment');
});

test('all reasons select their trusted action family for Complaint and Inquiry without trusting caller fields',()=>{
 for(const kind of ['complaint','inquiry'])for(const tag of REQUEST_TOPIC_TAGS)for(const reason of tag.includes){
  const classification={kind,topic:tag.id,subtopic:reason.id,workflowTopic:'caller_invented_family'};
  assert.equal(requestWorkflowTopic(classification),reason.workflowTopic);
  assert.equal(classification.workflowTopic,'caller_invented_family');assert.equal(classification.topic,tag.id);assert.equal(classification.subtopic,reason.id);
 }
});

test('delivery routing retains address handling and sensitive temperature review',()=>{
 for(const id of ['late_delivery','missed_delivery','early_delivery','tracking_issue'])assert.equal(workflow('tag_delivery',id),'delivery_missed');
 for(const id of ['wrong_address','instructions_not_followed'])assert.equal(workflow('tag_delivery',id),'delivery_instructions');
 assert.equal(workflow('tag_delivery','temperature'),'food_quality');
});

test('bag, meal-accuracy and food-review reasons preserve their approved workflow and sensitive family',()=>{
 for(const reason of topic('tag_bags').includes)assert.equal(workflow('tag_bags',reason.id),'bag_collection');
 for(const reason of topic('tag_meal_accuracy').includes)assert.equal(workflow('tag_meal_accuracy',reason.id),'meal_selection');
 for(const id of ['tag_damage','tag_food_quality','tag_food_safety'])for(const reason of topic(id).includes)assert.equal(workflow(id,reason.id),'food_quality');
});

test('plan, menu, payment and account reasons use their exact action families',()=>{
 const plan={plan_renewal:'renewal',plan_change:'plan_change',subscription_pause:'pause',cancellation:'refund',billing_issue:'billing',dietary_preferences_exclusions:'exclusions'};
 for(const [id,expected]of Object.entries(plan))assert.equal(workflow('tag_plan',id),expected);
 assert.equal(workflow('tag_menu','meal_selection'),'meal_selection');assert.equal(workflow('tag_menu','menu_variety'),'feedback');
 for(const id of ['inaccurate_description','photos'])assert.equal(workflow('tag_menu',id),'menu_support');
 for(const reason of topic('tag_payments').includes)assert.equal(workflow('tag_payments',reason.id),['refund_status','refund_not_received'].includes(reason.id)?'refund':'billing');
 for(const reason of topic('tag_account').includes)assert.equal(workflow('tag_account',reason.id),'account_support');
});

test('new tags require an exact Includes reason belonging to that tag',()=>{
 for(const tag of REQUEST_TOPIC_TAGS){
  for(const subtopic of [undefined,null,'','unknown_reason',{},[]])invalid(()=>workflow(tag.id,subtopic));
  invalid(()=>workflow(tag.id,tag.includes[0].label));
 }
 invalid(()=>workflow('tag_delivery','refund_status'));invalid(()=>workflow('tag_payments','late_delivery'));
 invalid(()=>requestWorkflowTopic({topic:'tag_account',workflowTopic:'account_support'}));
});

test('retained legacy topic IDs remain valid without inventing new tag classifications',()=>{
 const legacy=['renewal','plan_change','pause','refund','meal_selection','delivery_missed','delivery_instructions','bag_collection','food_quality','exclusions','nutrition','discount','new_lead','returning_lead','billing','feedback','other'];
 for(const id of legacy){const classification={kind:'inquiry',topic:id,workflowTopic:'untrusted'};assert.equal(requestWorkflowTopic(classification),id);assert.deepEqual(classification,{kind:'inquiry',topic:id,workflowTopic:'untrusted'});}
 for(const id of ['menu_support','account_support','delivery','tag_unknown',0,{},[]])invalid(()=>requestWorkflowTopic({topic:id}));
});

test('blank records and excluded non-customer classifications have no operational action family',()=>{
 for(const value of [undefined,null,{}, {topic:undefined},{topic:null},{topic:''}])assert.equal(requestWorkflowTopic(value),null);
 for(const kind of ['spam','vendor','non_customer'])assert.equal(requestWorkflowTopic({kind,topic:'untrusted_topic',workflowTopic:'refund'}),null);
});
