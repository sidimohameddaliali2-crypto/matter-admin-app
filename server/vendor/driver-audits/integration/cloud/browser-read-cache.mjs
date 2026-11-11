// Page-memory only: no disk, browser storage, CDN or mutable API caching.
export function browserReadCache(){
 const original=window.fetch.bind(window),cache=new Map(),pending=new Map(),limit=32*1024*1024,perItem=8*1024*1024;let used=0;
 const aborted=signal=>{if(signal?.aborted)throw signal.reason||new DOMException('Aborted','AbortError');};
 const deliver=(entry,signal)=>{aborted(signal);return new Response(entry.bytes.slice(0),{status:200,headers:entry.headers});};
 const wait=(promise,signal)=>{if(!signal)return promise;aborted(signal);return new Promise((resolve,reject)=>{const cancel=()=>reject(signal.reason||new DOMException('Aborted','AbortError'));signal.addEventListener('abort',cancel,{once:true});promise.then(v=>{signal.removeEventListener('abort',cancel);if(!signal.aborted)resolve(v);},e=>{signal.removeEventListener('abort',cancel);reject(e);});});};
 window.fetch=async(input,init)=>{
  const request=new Request(input,init),url=new URL(request.url),match=/^\/report-data\/(detail|history|query)-([a-f0-9]{64})\.json$/.exec(url.pathname);
  const photo=url.pathname==='/api/reporting/photo/image'&&url.searchParams.getAll('record').length===1&&url.searchParams.getAll('snapshot').length===1&&/^[a-f0-9]{64}$/.test(url.searchParams.get('snapshot')||'')&&[...url.searchParams.keys()].every(k=>['record','snapshot'].includes(k));
  if(request.method!=='GET'||url.origin!==location.origin||!match&&!photo)return original(request);
  aborted(request.signal);const key=String(window.__matterReportingGeneration||'')+'|'+url.href;
  const existing=cache.get(key);if(existing){cache.delete(key);cache.set(key,existing);return deliver(existing,request.signal);}
  let loading=pending.get(key);
  if(loading&&request.headers.get('X-Report-Prefetch')!=='1')window.__matterPromoteReportRead?.(url.href,String(window.__matterReportingGeneration||''));
  if(!loading){
   loading={controller:new AbortController(),users:0,responseOwned:false,promise:null};const entry=loading;
   entry.promise=(async()=>{
    const response=await original(new Request(request,{signal:entry.controller.signal}));if(!response.ok)return {response};
    const advertised=response.headers.get('x-report-bytes'),length=Number(advertised);
    if(advertised===null||!Number.isSafeInteger(length)||length<0||length>perItem)return {response};
    const reader=response.body.getReader(),parts=[];let size=0;
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>length||size>perItem){await reader.cancel();throw Error('Evidence exceeds the declared size.');}parts.push(part.value);}}finally{reader.releaseLock();}
    if(size!==length)throw Error('Evidence size does not match this report.');
    const joined=new Uint8Array(size);let offset=0;for(const part of parts){joined.set(part,offset);offset+=part.byteLength;}const bytes=joined.buffer;
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');if(hash!==(photo?response.headers.get('x-report-image-sha256'):match[2]))throw Error('Evidence does not match this report.');
    const headers=new Headers(response.headers);headers.delete('content-encoding');headers.delete('content-length');const value={bytes,headers};
    while(used+bytes.byteLength>limit&&cache.size){const first=cache.keys().next().value;used-=cache.get(first).bytes.byteLength;cache.delete(first);}
    cache.set(key,value);used+=bytes.byteLength;return {entry:value};
   })().finally(()=>{if(pending.get(key)===entry)pending.delete(key);});pending.set(key,entry);
  }
  loading.users++;
  try{const result=await wait(loading.promise,request.signal);if(result.entry)return deliver(result.entry,request.signal);
   if(!loading.responseOwned){aborted(request.signal);loading.responseOwned=true;request.signal.addEventListener('abort',()=>loading.controller.abort(request.signal.reason),{once:true});return result.response;}
   return original(request);
  }finally{loading.users--;if(loading.users===0&&!loading.responseOwned)loading.controller.abort();}
 };
}
export function addBrowserReadCache(html){if(typeof html!=='string'||html.split('</head>').length!==2)throw Error('Invalid report HTML');return html.replace('</head>','<script>('+browserReadCache.toString()+')();</script></head>');}
