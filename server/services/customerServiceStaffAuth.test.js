import test from 'node:test';import assert from 'node:assert/strict';import {createServiceStaffAuth,createExistingAppStaffAuth,isVerifiedServiceActor} from './customerServiceStaffAuth.js';
const principal={_id:'111111111111111111111111',isActive:true,role:'viewer',profile:{firstName:'Real',lastName:'Staff'},permissions:{customerService:true},permissionsConfigured:true};
test('Matter session is verified upstream and mapped by subject, never by claimed name or role',async()=>{let called=0;const auth=createServiceStaffAuth({supabase:{authenticate:()=>{}},resolve:async(p,id)=>{assert.equal(p,'matter');assert.equal(id,'222222222222222222222222');return principal;},fetchImpl:async(url,opts)=>{called++;assert.equal(url,'https://matterapp.online/api/auth/me');assert.equal(opts.method,'GET');return Response.json({success:true,data:{user:{_id:'222222222222222222222222',role:'admin'}}});}});assert.equal((await auth.authenticate('Bearer cs-matter.token')).user,principal);assert.equal(called,1);});
test('unknown, disabled and unlinked identities fail closed',async()=>{const auth=createServiceStaffAuth({supabase:{authenticate:()=>{}},resolve:async()=>null,fetchImpl:async()=>Response.json({success:true,data:{user:{_id:'222222222222222222222222',isActive:true,role:'admin'}}})});await assert.rejects(auth.authenticate('Bearer cs-matter.token'),e=>e.statusCode===403);await assert.rejects(auth.authenticate('Bearer invented'),e=>e.statusCode===401);});
test('disabled, non-staff and revoked Matter sessions never reach linked identity resolution',async()=>{
 for(const response of [Response.json({success:true,data:{user:{_id:'222222222222222222222222',isActive:false,role:'admin'}}}),Response.json({success:true,data:{user:{_id:'222222222222222222222222',role:'driver'}}}),new Response('',{status:401})]){
  let resolutions=0;
  const auth=createServiceStaffAuth({supabase:{},resolve:async()=>{resolutions++;return principal;},fetchImpl:async()=>response});
  await assert.rejects(auth.authenticate('Bearer cs-matter.token'),e=>e.statusCode===401);
  assert.equal(resolutions,0);
 }
});
test('existing app JWT resolves the exact verified subject without another login or provider call',async()=>{
 const account={...principal,_id:'222222222222222222222222',permissions:{customer_service:true}};let checks=0,resolutions=0;
 const auth=createExistingAppStaffAuth({authenticate:async token=>{checks++;assert.equal(token,'original.jwt');return account;},resolve:async(provider,subject)=>{resolutions++;assert.equal(provider,'matter');assert.equal(subject,account._id);return principal;}});
 const result=await auth.authenticate('Bearer original.jwt');
 assert.equal(result.user,principal);assert.equal(result.token,undefined);assert.equal(isVerifiedServiceActor(result.user),true);assert.equal(checks,1);assert.equal(resolutions,1);
});
test('existing app identity, page access and canonical link are checked on every request',async()=>{
 let account={...principal,permissions:{customer_service:true}},linked=principal;
 const auth=createExistingAppStaffAuth({authenticate:async()=>account,resolve:async()=>linked});
 assert.equal((await auth.authenticate('Bearer jwt')).user,principal);
 linked=null;await assert.rejects(auth.authenticate('Bearer jwt'),e=>e.statusCode===403);
 linked=principal;account={...principal,permissions:{customer_service:false}};await assert.rejects(auth.authenticate('Bearer jwt'),e=>e.statusCode===403);
 for(const change of [{isActive:false},{role:'driver'},{role:'yellowblock_user'}]){
  account={...principal,...change};await assert.rejects(auth.authenticate('Bearer jwt'),e=>e.statusCode===401);
 }
});
test('existing app malformed or failed sessions never reach canonical identity resolution',async()=>{
 let resolutions=0;
 const auth=createExistingAppStaffAuth({authenticate:async()=>{throw Error('Revoked session');},resolve:async()=>{resolutions++;return principal;}});
 for(const header of [undefined,'Bearer','Basic abc','Bearer a b','Bearer bad','Bearer '+'x'.repeat(9001)])await assert.rejects(auth.authenticate(header),e=>e.statusCode===401);
 assert.equal(resolutions,0);
});
