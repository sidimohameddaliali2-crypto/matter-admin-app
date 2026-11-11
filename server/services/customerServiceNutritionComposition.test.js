import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('./customerServiceNutritionComposition.js').catch(()=>({}));
const combine=(...args)=>{assert.equal(typeof module.combineNutritionAndMatterDirectories,'function');return module.combineNutritionAndMatterDirectories(...args);};
const at='2026-11-06T00:00:00.000Z';
const customer=id=>({customerId:`matter:${id}`,matterCustomerId:String(id),name:`Person ${id}`,email:'shared@example.test',phone:'',profileObservations:[{name:`Person ${id}`,email:'shared@example.test',phone:''}],subscriptions:[],hasActiveSubscription:false});
const nutrition=rows=>({customers:rows,report:{sourceCustomerTotal:rows.length,uniqueCustomers:rows.length,reconciled:true,fullCustomerDirectory:true,fullAdminCustomerDirectory:true,observedAt:at}});
const api=rows=>({customers:rows,report:{uniqueCustomers:rows.length,sourceSubscriptionTotal:rows.reduce((n,c)=>n+c.subscriptions.length,0),sourcePagesExhausted:true,observedAt:at}});
test('full admin population includes 2208 customers while retaining 394 subscription customers',()=>{
 const n=nutrition(Array.from({length:2208},(_,i)=>customer(i+1)));
 const a=api(Array.from({length:394},(_,i)=>({...customer(i+1),subscriptions:[{id:String(i+1),status:'paused'}]})));
 const r=combine(n,a,{observedAt:at});assert.equal(r.customers.length,2208);assert.equal(r.report.sourceSubscriptionTotal,394);assert.equal(r.report.fullCustomerDirectory,true);assert.equal(r.report.nutritionRead.sourceCustomerTotal,2208);assert.equal(r.report.apiRead.uniqueCustomers,394);assert.equal(r.report.atomicSnapshot,false);
 assert.equal(r.customers[0].subscriptions[0].status,'paused');assert.equal(r.customers[1000].subscriptionCoverage,'no_returned_api_subscriptions');assert.equal(r.customers[1000].hasActiveSubscription,false);
});
test('preserves conflicting profiles and both admin phone observations without name/email merging',()=>{
 const n=nutrition([{...customer(1),phone:'0501111111',telephone:'0501111111',whatsappNumber:'+971502222222',profileObservations:[{name:'New name',email:'new@example.test',phone:'0501111111'},{name:'New name',email:'new@example.test',phone:'+971502222222'}]},customer(2)]);
 const a=api([{...customer(1),phone:'+971503333333',profileObservations:[{name:'Old name',email:'old@example.test',phone:'+971503333333'}],subscriptions:[{id:'s1',status:'active'}]}, {...customer(3),subscriptions:[{id:'s3',status:'paused'}]}]);
 const r=combine(n,a,{observedAt:at});assert.equal(r.customers.length,3);const c=r.customers[0];assert.equal(c.telephone,'0501111111');assert.equal(c.whatsappNumber,'+971502222222');assert.ok(c.profileObservations.some(p=>p.phone==='+971503333333'));assert.ok(c.profileObservations.some(p=>p.phone==='+971502222222'));assert.equal(c.identityNeedsReview,true);assert.equal(r.report.apiCustomersAbsentFromAdmin,1);assert.equal(r.customers[2].sourceStates.nutritionAdmin.state,'not_returned');
});
test('admin active flag is retained when no subscription detail returned',()=>{const r=combine(nutrition([{...customer(1),hasActiveSubscription:true}]),api([]),{observedAt:at});assert.equal(r.customers[0].hasActiveSubscription,true);assert.deepEqual(r.customers[0].subscriptions,[]);assert.equal(r.customers[0].sourceStates.api.state,'not_returned');});
for(const [name,change] of [['partial admin',n=>n.report.reconciled=false],['duplicate identity',n=>n.customers.push(n.customers[0])],['mismatched canonical identity',n=>n.customers[0].matterCustomerId='2']])test(`rejects ${name}`,()=>{const n=nutrition([customer(1)]);change(n);assert.throws(()=>combine(n,api([])));});
test('parallel reader requests API details and publishes only after both complete',async()=>{
 assert.equal(typeof module.readMatterCustomerDirectoryWithNutrition,'function');let nStarted=false,aStarted=false;let release;const gate=new Promise(r=>release=r);
 const pending=module.readMatterCustomerDirectoryWithNutrition({env:{},clock:()=>at,readNutrition:async()=>{nStarted=true;await gate;return nutrition([customer(1)]);},readApi:async options=>{aStarted=true;assert.equal(options.includeDetails,true);await gate;return api([]);}});
 await new Promise(r=>setImmediate(r));assert.equal(nStarted&&aStarted,true);release();assert.equal((await pending).customers.length,1);
});
test('failed admin read cannot publish half directory or expose source errors',async()=>{assert.equal(typeof module.readMatterCustomerDirectoryWithNutrition,'function');await assert.rejects(()=>module.readMatterCustomerDirectoryWithNutrition({readNutrition:async()=>{throw new Error('secret-cookie');},readApi:async()=>api([customer(1)])}),e=>!e.message.includes('secret-cookie'));});
