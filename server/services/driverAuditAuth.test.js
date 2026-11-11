import test from 'node:test';import assert from 'node:assert/strict';
import {createDriverAuditAuth} from './driverAuditAuth.js';
import {auditRoute,createDriverAuditIntegration} from './driverAuditIntegration.js';
import {createServer} from 'node:http';
test('audit staff sessions recheck permission, roles, revocation and CSRF',async()=>{
 let user={_id:'staff-1',email:'staff@example.invalid',isActive:true,role:'manager',permissions:{reports:true}},calls=0;
 const auth=createDriverAuditAuth({origin:'https://app.example.invalid',secret:'a'.repeat(32),authenticateStaffToken:async token=>{calls++;assert.equal(token,'valid.staff.token');return user;}});
 const issued=await auth.issue('Bearer valid.staff.token');assert.match(issued.cookie,/HttpOnly; SameSite=Strict/);assert.match(issued.cookie,/Secure/);
 const session=await auth.authenticate(issued.cookie);assert.equal(session.actor.role,'reviewer');assert.equal(session.actor.id,'matter:staff-1');assert.ok(auth.csrfMatches(session.csrf,session.csrf));assert.ok(!auth.csrfMatches(session.csrf,'x'.repeat(64)));
 user.role='viewer';assert.equal((await auth.authenticate(issued.cookie)).actor.role,'viewer');
 user.permissions.reports=false;await assert.rejects(auth.authenticate(issued.cookie),{status:403});user.permissions.reports=true;user.isActive=false;await assert.rejects(auth.authenticate(issued.cookie),{status:403});
 await assert.rejects(auth.authenticate(''),{status:401});await assert.rejects(auth.authenticate('matter_driver_audit=x; matter_driver_audit=y'),{status:401});assert.ok(calls>=5);assert.match(auth.clearCookie,/Max-Age=0/);
});
test('disabled audit integration does not contact a database or alter operations routes',async()=>{
 const middleware=createDriverAuditIntegration({env:{},db:()=>{throw Error('must not run');}});let next=0,status;
 const operational=['/','/reports','/deliveries','/drivers','/customer-service','/api/auth/login','/api/deliveries','/api/reports','/api/customer-service','/api/staff-reporting/','/api/partner','/api/member'];
 for(const enabled of [undefined,'1']){const handler=createDriverAuditIntegration({env:{DRIVER_AUDIT_ENABLED:enabled},db:()=>{throw Error('Existing routes must not initialize audit storage');}});for(const url of operational)await handler({url},{},()=>next++);}
 assert.equal(next,operational.length*2);
 await middleware({url:'/driver-audit-view'}, {writeHead:s=>status=s,end:()=>{}},()=>next++);assert.equal(status,503);assert.equal(next,operational.length*2);
 assert.ok(!auditRoute('/api/reports'));assert.ok(auditRoute('/report-data/snapshot-a.json'));
});
test('staff-only session handshake, refresh and logout work without a report import or Supabase sign-in',async t=>{
 const env={DRIVER_AUDIT_ENABLED:'1',JWT_SECRET:'s'.repeat(32)},user={_id:'one',isActive:true,email:'staff@example.invalid',role:'viewer',permissions:{reports:true}};
 const authenticateStaffToken=async token=>{if(token!=='valid.jwt.token')throw Error('invalid');return user;};
 let admissions=0;const handler=createDriverAuditIntegration({env,authenticateStaffToken,dependencies:{budget:{reserve:async()=>{admissions++;return {allowed:false};},settle:async()=>{throw Error('No denied settlement');}},state:{read:async()=>{throw Error('No cloud reads during session handshake');}},archive:{readObject:async()=>{throw Error('No archive read');}},store:{head:async()=>null}}});
 const server=createServer((req,res)=>handler(req,res,()=>{res.writeHead(404);res.end();}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));env.DRIVER_AUDIT_ORIGIN='http://127.0.0.1:'+server.address().port;const origin=env.DRIVER_AUDIT_ORIGIN;
 const call=(path,method='GET',headers={})=>fetch(origin+path,{method,headers});
 const issued=await call('/api/driver-audits/session','POST',{origin,'content-type':'application/json',authorization:'Bearer valid.jwt.token'});assert.equal(issued.status,200);const cookie=issued.headers.get('set-cookie');
 assert.equal((await call('/api/session','GET',{cookie})).status,200);
 assert.equal((await call('/api/session/refresh','POST',{cookie,origin,'content-type':'application/json'})).status,200);
 assert.equal((await call('/api/session','POST',{cookie,origin,'content-type':'application/json'})).status,403);
 env.DRIVER_AUDIT_IMPORT_ENABLED='1';const denied=await call('/driver-audit-view','GET',{cookie});assert.equal(denied.status,503);assert.equal(denied.headers.get('x-audit-import-status'),'budget-exhausted');assert.equal(admissions,1);
 assert.equal((await call('/api/driver-audits/session','POST',{origin:'https://elsewhere.invalid','content-type':'application/json',authorization:'Bearer valid.jwt.token'})).status,403);
 user.isActive=false;assert.equal((await call('/api/session','GET',{cookie})).status,403);
 const ended=await call('/api/driver-audits/session','DELETE',{origin});assert.equal(ended.status,204);assert.match(ended.headers.get('set-cookie'),/Max-Age=0/);assert.equal((await call('/api/session')).status,401);
});
