// Real worker/cache regression with fictional responses and a loopback-only server.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const worker=await readFile(new URL('../../client/public/service-worker.js',import.meta.url));
const server=createServer((req,res)=>{
  if(req.url==='/service-worker.js'){res.setHeader('content-type','text/javascript');res.end(worker);return;}
  if(req.url.startsWith('/api/')){
    res.setHeader('content-type','application/json');
    if(req.url.startsWith('/api/customer-service')){
      res.setHeader('cache-control','no-store');
      if(req.headers.authorization!=='Bearer supervisor'){res.statusCode=403;res.end('{"success":false}');return;}
      res.end('{"success":true,"cases":["private-fixture"]}');return;
    }
    res.end('{"delivery":"offline-driver-fixture"}');return;
  }
  res.setHeader('content-type','text/html');res.end('<!doctype html><title>Worker isolation QA</title>');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
try{
 const page=await browser.newPage();await page.goto(base);
 // Simulate an installed old release with both sensitive and driver cache entries.
 await page.evaluate(async()=>{const c=await caches.open('delivery-tracker-v5-bag-reminders');await c.put('/api/customer-service/issues',new Response('{"cases":["old-private-fixture"]}'));await c.put('/api/customer-service-capture/normalized',new Response('old-capture'));await c.put('/api/deliveries',new Response('{"delivery":"offline-driver-fixture"}'));});
 await page.evaluate(async()=>{await navigator.serviceWorker.register('/service-worker.js');await navigator.serviceWorker.ready;});
 await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
 const keys=await page.evaluate(async()=>{const c=await caches.open('delivery-tracker-v5-bag-reminders');return (await c.keys()).map(r=>new URL(r.url).pathname)});
 assert.ok(!keys.some(k=>k.startsWith('/api/customer-service')),'Worker upgrade must purge old service responses');
 assert.ok(keys.includes('/api/deliveries'),'Worker upgrade must preserve the driver cache');
 const get=(url,token)=>page.evaluate(async({url,token})=>{const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});return {status:r.status,body:await r.json()};},{url,token});
 assert.equal((await get('/api/customer-service/issues','supervisor')).status,200);
 assert.equal((await get('/api/customer-service/issues','outsider')).status,403);
 assert.equal(await page.evaluate(async()=>Boolean(await caches.match('/api/customer-service/issues'))),false,'Fresh sensitive responses must never be cached');
 await get('/api/deliveries','driver');
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 const offline=await get('/api/customer-service/issues','outsider');assert.equal(offline.status,503);assert.equal(offline.body.success,false);assert.ok(!JSON.stringify(offline).includes('private-fixture'));
 assert.equal((await get('/api/deliveries','driver')).body.delivery,'offline-driver-fixture');
 console.log('PASS: cache upgrade purge, driver cache preservation, fresh service no-cache, online account denial, offline service denial, offline delivery retrieval');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
