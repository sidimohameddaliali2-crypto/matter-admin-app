// Start the two authenticated, generation-bound reads while the renderer parses.
// One consumer takes each response; no mutable journal or persistent cache.
export function installPreviewStartup(resources){
 const original=window.fetch.bind(window),pending=new Map();
 for(const path of resources){const url=new URL(path,location.href);if(url.origin!==location.origin)continue;
  const promise=original(url.href,{credentials:'same-origin',cache:'no-store'});pending.set(url.href,promise);promise.catch(()=>{if(pending.get(url.href)===promise)pending.delete(url.href);});
 }
 window.fetch=(input,init)=>{const request=new Request(input,init),url=new URL(request.url);let key=url.href;if(!url.search&&/^\/report-data\/snapshot-[a-f0-9]{64}\.json$/.test(url.pathname)){const match=[...pending.keys()].find(candidate=>{const saved=new URL(candidate);return saved.origin===url.origin&&saved.pathname===url.pathname;});if(match)key=match;}const value=pending.get(key);if(request.method==='GET'&&value){pending.delete(key);return value.then(response=>{if(request.signal.aborted){void response.body?.cancel();throw request.signal.reason||new DOMException('Aborted','AbortError');}return response;});}return original(request);};
}
export function addPreviewStartup(html,{url,generation}){
 if(!/^report-data\/snapshot-[a-f0-9]{64}\.json$/.test(url)||! /^[a-f0-9]{64}$/.test(generation))throw Error('Invalid startup evidence binding');
 if(html.split('</head>').length!==2)throw Error('Renderer unavailable');
 const resources=['/'+url+'?generation='+generation,'/api/reporting/evidence-overlay?generation='+generation];
 return html.replace('</head>','<script>('+installPreviewStartup.toString()+')('+JSON.stringify(resources)+');</script></head>');
}
