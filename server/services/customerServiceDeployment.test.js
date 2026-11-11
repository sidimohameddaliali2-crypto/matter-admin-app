import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {rootCertificates} from 'node:tls';
import {effectivePermissions} from '../models/User.js';
import {customerServicePageGrant,configureCustomerServiceDeployment,verifyCustomerServiceRelease} from './customerServiceDeployment.js';

test('adding the CS page preserves every existing role-default page and cannot promote unrelated roles',()=>{
 for(const role of ['admin','manager','dispatcher','viewer','store_keeper','kitchen']){
  const account={role,isActive:true,permissionsConfigured:false,permissions:{}};
  const before=effectivePermissions(account),set=customerServicePageGrant(account),permissions=Object.fromEntries(Object.entries(set).filter(([key])=>key.startsWith('permissions.')).map(([key,value])=>[key.slice(12),value]));
  const after=effectivePermissions({...account,permissionsConfigured:set.permissionsConfigured,permissions});
  assert.deepEqual(after,{...before,customer_service:true});
 }
 for(const role of ['driver','yellowblock_user','unknown'])assert.equal(customerServicePageGrant({role,isActive:true}),null);
 assert.equal(customerServicePageGrant({role:'viewer',isActive:false}),null);
 assert.equal(customerServicePageGrant({role:'super_admin',isActive:true}),null);
});
test('explicit page choices are preserved and applying an existing grant is idempotent',()=>{
 const account={role:'viewer',isActive:true,permissionsConfigured:true,permissions:{reports:false,customers:true}};
 assert.deepEqual(customerServicePageGrant(account),{'permissions.customer_service':true});
 assert.equal(customerServicePageGrant({...account,permissions:{...account.permissions,customer_service:true}}),null);
 assert.equal(customerServicePageGrant({...account,permissions:{...account.permissions,customer_service:false}},{initialSetupComplete:true}),null,'later page revocation survives every subsequent deployment');
});
test('private connection setup preserves existing login/configuration and is retry-safe',async()=>{
 const serverRoot=await fs.mkdtemp(path.join(os.tmpdir(),'matter-cs-deploy-'));
 const original='JWT_SECRET=unchanged-fictional\nMONGODB_URI=unchanged-fictional\nOTHER_SETTING=keep\nCUSTOMER_SERVICE_STORAGE=old\n';
 const secret={credentials:{projectRef:'trhhjfgfmxofxhnzocks',actualRegion:'eu-central-1',databasePassword:'fictional-db-only'},ca:rootCertificates[0]};
 try{
  await fs.writeFile(path.join(serverRoot,'.env.local'),original);
  const result=await configureCustomerServiceDeployment({serverRoot,encoded:Buffer.from(JSON.stringify(secret)).toString('base64')});
  const updated=await fs.readFile(path.join(serverRoot,'.env.local'),'utf8');
  for(const line of original.split('\n').filter(line=>line&&!line.startsWith('CUSTOMER_SERVICE_')))assert.ok(updated.includes(line));
  assert.equal(updated.match(/CUSTOMER_SERVICE_STORAGE=/g).length,1);assert.equal(result.env.CUSTOMER_SERVICE_STORAGE,'supabase');
  assert.equal((await fs.stat(result.env.CUSTOMER_SERVICE_SUPABASE_CREDENTIALS_PATH)).mode&0o777,0o600);
  assert.equal((await fs.stat(result.directory)).mode&0o777,0o700);
  assert.equal((await fs.stat(path.join(serverRoot,'.env.local'))).mode&0o777,0o600);
  const backup=(await fs.readdir(result.directory)).find(name=>name.startsWith('env-before-'));
  assert.equal(await fs.readFile(path.join(result.directory,backup),'utf8'),original);
  await configureCustomerServiceDeployment({serverRoot,encoded:Buffer.from(JSON.stringify(secret)).toString('base64')});
  assert.equal(await fs.readFile(path.join(serverRoot,'.env.local'),'utf8'),updated);
  assert.equal((await fs.readdir(result.directory)).filter(name=>name.startsWith('env-before-')).length,1);
 }finally{await fs.rm(serverRoot,{recursive:true,force:true});}
});
test('invalid or different-project secrets cannot alter the app configuration',async()=>{
 const serverRoot=await fs.mkdtemp(path.join(os.tmpdir(),'matter-cs-deploy-'));
 try{for(const value of ['',Buffer.from(JSON.stringify({credentials:{projectRef:'other-project'}})).toString('base64')])await assert.rejects(configureCustomerServiceDeployment({serverRoot,encoded:value}));assert.deepEqual(await fs.readdir(serverRoot),[]);}finally{await fs.rm(serverRoot,{recursive:true,force:true});}
});

test('release verification waits for canonical startup and retains the existing authenticated boundary',async()=>{
 let checks=0,waits=0;
 const result=await verifyCustomerServiceRelease({origin:'http://fixture.invalid',wait:async()=>{waits++;},fetchImpl:async url=>url.endsWith('/api/health')?{ok:true,json:async()=>({success:true,database:'connected'})}:{status:++checks===1?503:401}});
 assert.equal(checks,2);assert.equal(waits,1);assert.equal(result.staffAuthenticationRequired,true);
});
test('a healthy old app, broken CS connection or disconnected app is not a verified deployment',async()=>{
 for(const [database,status]of [['connected',200],['connected',503],['disconnected',401]])await assert.rejects(verifyCustomerServiceRelease({origin:'http://fixture.invalid',attempts:1,fetchImpl:async url=>url.endsWith('/api/health')?{ok:true,json:async()=>({success:true,database})}:{status}}));
});
