import test from 'node:test';import assert from 'node:assert/strict';import {createServiceStaffAuth} from './customerServiceStaffAuth.js';
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
