// Share only simultaneous status reads. A completed result is never retained.
export function installStatusFlight(){
 const original=window.fetch.bind(window),pending=new Map();
 window.fetch=async(input,init)=>{const request=new Request(input,init),url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==location.origin||url.pathname!=='/api/reporting/status'||request.signal.aborted)return original(request);
  const key=JSON.stringify([url.href,request.credentials,[...request.headers]]);let promise=pending.get(key);
  if(!promise){promise=(async()=>{const response=await original(new Request(request,{signal:new AbortController().signal}));const reader=response.body?.getReader(),parts=[];let size=0;try{if(reader)for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65536){await reader.cancel();throw Error('Status response too large');}parts.push(part.value);}}finally{reader?.releaseLock();}const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');return {bytes,status:response.status,statusText:response.statusText,headers};})().finally(()=>{if(pending.get(key)===promise)pending.delete(key);});pending.set(key,promise);}
  const result=await promise;if(request.signal.aborted)throw request.signal.reason||new DOMException('Aborted','AbortError');return new Response(result.bytes.slice(),result);
 };
}
export function addStatusFlight(html){if(html.split('</head>').length!==2)throw Error('Renderer unavailable');return html.replace('</head>','<script>('+installStatusFlight.toString()+')();</script></head>');}
