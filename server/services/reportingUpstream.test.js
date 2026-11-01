import test from 'node:test';import assert from 'node:assert/strict';
import {createReportingUpstream} from './reportingUpstream.js';
test('upstream uses fixed private HTTPS target, bounded reads and no redirects or arbitrary routes',async()=>{
 assert.throws(()=>createReportingUpstream({baseUrl:'http://example.invalid',credential:'fixture'}));
 const calls=[];const request=createReportingUpstream({baseUrl:'https://reporting.example.invalid',credential:'fixture',fetchImpl:async(url,options)=>{calls.push({url,options});return new Response('retained',{headers:{'Content-Type':'application/json'}})}});
 assert.equal((await request({path:'/api/reporting/reviews',method:'GET'})).body.toString(),'retained');assert.equal(calls[0].url,'https://reporting.example.invalid/api/reporting/reviews');assert.equal(calls[0].options.headers.Authorization,'Bearer fixture');assert.equal(calls[0].options.redirect,'error');
 for(const p of ['//other.invalid/','/api/users','/../api/users'])await assert.rejects(request({path:p,method:'GET'}));assert.equal(calls.length,1);
 const large=createReportingUpstream({baseUrl:'https://reporting.example.invalid',credential:'fixture',maxBytes:3,fetchImpl:async()=>new Response('larger',{headers:{'Content-Type':'application/json'}})});await assert.rejects(large({path:'/',method:'GET'}),/limit/);
});
