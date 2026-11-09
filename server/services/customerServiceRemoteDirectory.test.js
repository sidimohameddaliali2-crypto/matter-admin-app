import test from 'node:test';
import assert from 'node:assert/strict';
import {readRemoteCustomerDirectory} from './customerServiceRemoteDirectory.js';
const env={CUSTOMER_SERVICE_REMOTE_MONGODB_URI:'mongodb+srv://fixture.invalid/',CUSTOMER_SERVICE_REMOTE_MONGODB_DATABASE:'test'};
function fixture(rows,{counts=[rows.length,rows.length],fail=false}={}){
 const calls=[];let count=0,closed=0;
 const collection={countDocuments:async(...args)=>{calls.push(['count',...args]);return counts[count++];},find:(filter,options)=>{calls.push(['find',filter,options]);let limit;return{sort(value){calls.push(['sort',value]);return this;},limit(n){limit=n;return this;},async toArray(){if(fail)throw Error('private credential detail');return rows.filter(r=>!filter._id||r._id>filter._id.$gt).slice(0,limit);}};}};
 const clientFactory=(uri,options)=>{calls.push(['connectOptions',options]);return{connect:async()=>{},db:name=>{calls.push(['database',name]);return{collection:name=>{calls.push(['collection',name]);return collection;}};},close:async()=>{closed++;}};};
 return{clientFactory,calls,get closed(){return closed;}};
}
test('isolated remote reader uses bounded keyset reads, narrow projection, TLS and closes',async()=>{
 const f=fixture([{_id:'a',customerId:'A',firstName:'Fixture'},{_id:'b',customerId:'B'}]);const r=await readRemoteCustomerDirectory({env,clientFactory:f.clientFactory,pageSize:1,clock:()=>new Date('2026-11-06T00:00:00Z')});
 assert.equal(r.count,2);assert.equal(r.customers[0].sourceRecordId,'a');assert.equal(r.observedAt,'2026-11-06T00:00:00.000Z');assert.equal(r.report.atomicSnapshot,false);assert.equal(f.closed,1);assert.equal(f.calls[0][1].tls,true);assert.equal(f.calls.filter(c=>c[0]==='find').length,2);assert.equal(f.calls.find(c=>c[0]==='find')[2].projection.password,undefined);
});
test('count drift, duplicated IDs and provider failures fail closed and close connection',async()=>{
 for(const f of [fixture([{_id:'a',customerId:'A'}],{counts:[1,2]}),fixture([{_id:'a',customerId:'A'},{_id:'b',customerId:'A'}]),fixture([{_id:'a',customerId:'A'}],{fail:true})]){await assert.rejects(readRemoteCustomerDirectory({env,clientFactory:f.clientFactory}),e=>!e.message.includes('private'));assert.equal(f.closed,1);}
});
test('explicit database and secure connection are required before constructing client',async()=>{
 for(const bad of [{...env,CUSTOMER_SERVICE_REMOTE_MONGODB_DATABASE:''},{...env,CUSTOMER_SERVICE_REMOTE_MONGODB_URI:'mongodb://fixture.invalid/?tls=false'},{...env,CUSTOMER_SERVICE_REMOTE_MONGODB_URI:'mongodb://fixture.invalid/?tlsAllowInvalidCertificates=true'}])await assert.rejects(readRemoteCustomerDirectory({env:bad,clientFactory:()=>{assert.fail('must not construct');}}));
});
test('record budget rejects oversized collection without reading rows',async()=>{const f=fixture([],{counts:[100001]});await assert.rejects(readRemoteCustomerDirectory({env,clientFactory:f.clientFactory}));assert.equal(f.calls.some(c=>c[0]==='find'),false);assert.equal(f.closed,1);});
test('failed connection still closes its private client without leaking driver errors',async()=>{let closed=0;await assert.rejects(readRemoteCustomerDirectory({env,clientFactory:()=>({connect:async()=>{throw Error('private URI and password');},close:async()=>closed++})}),e=>!e.message.includes('password'));assert.equal(closed,1);});
