import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {createStaffReportingBridge} from './customerServiceReporting.js';
test('integrated reporting rechecks membership, confines paths, revokes on logout and rewrites its same-origin document',async t=>{let active=true;const app=express();app.use(express.json());const authenticate=async header=>{if(header!=='Bearer cs-test')throw Object.assign(Error(),{statusCode:401});return {user:{_id:'staff'}};};app.set('customerServiceAuth',{authenticate});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});const origin='http://127.0.0.1:'+server.address().port;const bridge=createStaffReportingBridge({origin,authenticate,authorize:async()=>{if(!active)throw Object.assign(Error(),{status:403});return {id:'report-user',role:'viewer'};}});await bridge.attach(async(req,res)=>{try{await bridge.auth.authenticate(req.headers.cookie);res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"frame-ancestors 'none'; base-uri 'none'"});res.end('<html><head></head><body>/api/reporting/status /report-data/example.json</body></html>');}catch(e){res.writeHead(e.status||401);res.end('denied');}});app.use(bridge.prefix,bridge.router);const request=(url,options={})=>fetch(origin+bridge.prefix+url,options);assert.equal((await request('/')).status,401);const login=await request('/session',{method:'POST',headers:{Authorization:'Bearer cs-test','Content-Type':'application/json',Origin:origin},body:'{}'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];const page=await request('/',{headers:{Cookie:cookie}});assert.equal(page.status,200);assert.match(await page.text(),/\/api\/staff-reporting\/api\/reporting\/status/);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'self'/);assert.equal((await request('/api/reporting/reviews',{method:'POST',headers:{Cookie:cookie}})).status,403);assert.equal((await request('/',{headers:{Cookie:cookie,Origin:'https://evil.invalid'}})).status,403);active=false;assert.equal((await request('/',{headers:{Cookie:cookie}})).status,403);active=true;assert.equal((await request('/session',{method:'DELETE',headers:{Cookie:cookie}})).status,204);assert.equal((await request('/',{headers:{Cookie:cookie}})).status,401);});

test('report bridge completes callback writes and preserves mounted font, photo and evidence paths',async t=>{
 const app=express();app.use(express.json());
 const authenticate=async()=>({user:{_id:'staff'}});app.set('customerServiceAuth',{authenticate});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 const bridge=createStaffReportingBridge({origin,authenticate,authorize:async()=>({id:'report-user',email:'staff@example.invalid',role:'viewer'})});
 let callbackWrites=0;
 await bridge.attach(async(req,res)=>{
  await bridge.auth.authenticate(req.headers.cookie);
  if(req.url==='/photo'){
   const body=JSON.stringify({thumbnail:'/api/reporting/photo/image?record=fixture',original:'/api/reporting/photo/image?record=fixture&original=1',nested:[{url:'/report-data/fixture.json'}],description:'Evidence mentions /api/reporting/photo/image',external:{url:'https://example.invalid/photo'}});
   res.writeHead(200,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)});
   await new Promise(resolve=>res.write(body,()=>{callbackWrites++;resolve();}));res.end();return;
  }
  const body='<html><head><style>@font-face{src:url(/report-assets/font-fixture.woff2)}</style></head><body>/api/reporting/status /report-data/fixture.json</body></html>';
  res.writeHead(200,{'Content-Type':'text/html','Content-Length':Buffer.byteLength(body),'Content-Security-Policy':"frame-ancestors 'none'; base-uri 'none'"});
  await new Promise(resolve=>res.write(body,'utf8',()=>{callbackWrites++;resolve();}));res.end();
 });
 app.use(bridge.prefix,bridge.router);
 const login=await fetch(origin+bridge.prefix+'/session',{method:'POST',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body:'{}'});
 const headers={Cookie:login.headers.get('set-cookie').split(';')[0]};
 const html=await fetch(origin+bridge.prefix+'/',{headers,signal:AbortSignal.timeout(2000)});
 const rendered=await html.text();
 assert.match(rendered,/<base href="\/api\/staff-reporting\/">/);
 assert.match(rendered,/url\(\/api\/staff-reporting\/report-assets\/font-fixture.woff2\)/);
 assert.match(rendered,/\/api\/staff-reporting\/api\/reporting\/status/);
 assert.match(html.headers.get('content-security-policy'),/base-uri 'self'/);
 const response=await fetch(origin+bridge.prefix+'/photo',{headers,signal:AbortSignal.timeout(2000)}),photo=await response.json();
 assert.equal(photo.thumbnail,bridge.prefix+'/api/reporting/photo/image?record=fixture');
 assert.equal(photo.original,bridge.prefix+'/api/reporting/photo/image?record=fixture&original=1');
 assert.equal(photo.nested[0].url,bridge.prefix+'/report-data/fixture.json');
 assert.equal(photo.description,'Evidence mentions /api/reporting/photo/image');
 assert.equal(photo.external.url,'https://example.invalid/photo');
 assert.equal(callbackWrites,2);
 assert.equal((await fetch(origin+bridge.prefix+'/api/reporting/reviews/migrate',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).status,403);
});
