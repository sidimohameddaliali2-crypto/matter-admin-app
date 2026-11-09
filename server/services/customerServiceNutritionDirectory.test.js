import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('./customerServiceNutritionDirectory.js').catch(() => ({}));
const read = options => { assert.equal(typeof module.readNutritionCustomerDirectory, 'function', 'Nutrition reader must exist'); return module.readNutritionCustomerDirectory(options); };
const env = { CUSTOMER_SERVICE_NUTRITION_COOKIE: 'session=fixture', MATTER_API_TOKEN: 'must-not-send' };
const row = id => ({id, fullName:`Person ${id}`, firstName:'Person',lastName:String(id),email:`person${id}@example.test`,telephone:'0501234567',whatsappNumber:'+971501234568',accountStatus:'active',hasActiveSubscription:false});
const page = (data, currentPage=1, total=data.length, perPage=2) => ({data,currentPage,lastPage:Math.max(1,Math.ceil(total/perPage)),perPage,total});
const response = payload => new Response(`0:{"a":"$@1","b":"fixture"}\n1:${JSON.stringify(payload)}\n`, {headers:{'content-type':'text/x-component'}});
const options = fetchImpl => ({env,fetchImpl,pageSize:2,clock:()=>new Date('2026-11-06T00:00:00Z')});
test('complete directory preserves both source phones and verifies the first page after exhausting pagination', async()=>{
 const calls=[];
 const result=await read(options(async(url,init)=>{calls.push({url:String(url),init});const [{page:p}]=JSON.parse(init.body);return response(page(p===1?[row(1),row(2)]:[row(3)],p,3));}));
 assert.equal(result.customers.length,3); assert.equal(result.customers[0].customerId,'matter:1');
 assert.deepEqual(result.customers[0].profileObservations.map(p=>p.phone),['0501234567','+971501234568']);
 assert.equal(result.report.fullCustomerDirectory,true);assert.equal(result.report.atomicSnapshot,false);assert.equal(result.report.uniqueCustomers,3);
 assert.equal(calls.length,3);
 for(const {url,init} of calls){assert.equal(url,'https://admin.matternutrition.xyz/customers');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(init.headers.Cookie,env.CUSTOMER_SERVICE_NUTRITION_COOKIE);assert.equal(init.headers.Authorization,undefined);assert.equal(init.headers['next-action'],'40cf3c4d92f5b4cee202f07e3b97d51514b28cf8f8');assert.ok(init.signal);}
});
for(const [label,make] of [
 ['authentication failure',()=>new Response('private session=fixture',{status:401})],
 ['redirect',()=>new Response('',{status:302,headers:{location:'https://example.test'}})],
 ['HTML login',()=>new Response('<html>login</html>')],
 ['malformed RSC',()=>new Response('0:{}\n1:not-json',{headers:{'content-type':'text/x-component'}})],
 ['wrong page',()=>response(page([row(1),row(2)],2))],
 ['duplicate identities',()=>response(page([row(1),row(1)]))],
 ['truncated page',()=>response(page([row(1)],1,2))],
 ['invalid identity',()=>response(page([{...row(1),id:null}]))],
 ['excessive total',()=>response(page([row(1),row(2)],1,100001))],
 ])test(`fails closed on ${label}`,async()=>{await assert.rejects(()=>read(options(async()=>make())),e=>!e.message.includes('session=fixture'));});
test('rejects stable-count source changes during verification pass',async()=>{let calls=0;await assert.rejects(()=>read(options(async()=>response(page([{...row(1),fullName:++calls===1?'Before':'After'}])))),/changed|failed/i);});
test('does not expand scientific phone strings or infer prefixes',async()=>{const r=await read(options(async()=>response(page([{...row(1),telephone:'5.01E+11',whatsappNumber:'0507654321'}]))));assert.equal(r.customers[0].phone,'5.01E+11');assert.equal(r.customers[0].profileObservations[1].phone,'0507654321');});
test('requires separate Nutrition cookie configuration',async()=>{await assert.rejects(()=>read({...options(async()=>{throw new Error('should not fetch');}),env:{MATTER_API_TOKEN:'other-service'}}),/configured|configuration/i);});
test('rejects unsafe action override before read',async()=>{await assert.rejects(()=>read({...options(async()=>{throw new Error('should not fetch');}),env:{...env,CUSTOMER_SERVICE_NUTRITION_ACTION:'bad\r\naction'}}));});
test('bounds streamed response size',async()=>{await assert.rejects(()=>read({...options(async()=>new Response('x'.repeat(1025),{headers:{'content-type':'text/x-component'}})),maxPageBytes:1024}));});
