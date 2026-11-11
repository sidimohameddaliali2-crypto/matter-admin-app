// Two ordinary reads, one foreground case and one speculative image; bodies hold their lane until
// consumed or cancelled. No caching or changes to report request contents.
export function browserRequestQueue(){
 const original=window.fetch.bind(window),queue=[];let active=0,activeCases=0,activePrefetchCases=0,urgentRun=0;
 const aborted=signal=>signal.reason||new DOMException('Request aborted','AbortError');
 function finish(task){
  if(task.finished)return;task.finished=true;task.request.signal.removeEventListener('abort',task.abort);
  if(task.started){active--;if(task.caseRead){activeCases--;if(task.priority===2)activePrefetchCases--;}}else{const index=queue.indexOf(task);if(index>=0)queue.splice(index,1);}
  drain();
 }
 function drain(){
  while(active<4&&queue.length){
   const eligible=task=>task.caseRead?(task.priority===2?activePrefetchCases<1:activeCases-activePrefetchCases<1):active-activeCases<(task.priority===2?1:2);
   const urgent=queue.findIndex(task=>eligible(task)&&task.priority===0),normal=queue.findIndex(task=>eligible(task)&&task.priority===1),speculative=queue.findIndex(task=>eligible(task)&&task.priority===2);
   const index=urgent>=0&&(normal<0||urgentRun<3)?urgent:normal>=0?normal:speculative;
   if(index<0)break;
   const [task]=queue.splice(index,1);urgentRun=task.priority===0?urgentRun+1:0;
   task.started=true;active++;if(task.caseRead){activeCases++;if(task.priority===2)activePrefetchCases++;}void run(task);
  }
 }
 // A foreground caller can join a cached pending read without issuing another fetch.
 // Promote only its exact queued resource in the same page generation.
 window.__matterPromoteReportRead=(url,generation)=>{
  const task=queue.find(task=>task.priority===2&&task.request.url===url&&task.generation===generation);
  if(task){task.priority=0;task.caseRead=/^\/report-data\/(detail|history)-[a-f0-9]{64}\.json$/.test(new URL(task.request.url).pathname)||new URL(task.request.url).pathname==='/api/reporting/photo/image';drain();}
 };
 async function run(task){
  try{
   const response=await original(new Request(task.request,{signal:task.controller.signal}));
   if(task.finished){await response.body?.cancel().catch(()=>{});return;}
   if(!response.body){task.resolve(response);finish(task);return;}
   task.reader=response.body.getReader();
   // Some existing readers throw on HTTP failure without consuming its body.
   // Drain bounded error bodies before returning so those readers cannot hold slots.
   if(!response.ok){
    const parts=[];let size=0;
    for(;;){const part=await task.reader.read();if(task.finished)return;if(part.done)break;size+=part.value.byteLength;if(size>64*1024)throw Error('Report error response exceeds the 64 KiB limit.');parts.push(part.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
    task.resolve(new Response(bytes,{status:response.status,statusText:response.statusText,headers:response.headers}));finish(task);return;
   }
   const body=new ReadableStream({
    start(controller){task.output=controller;},
    async pull(controller){
     try{const part=await task.reader.read();if(task.finished)return;if(part.done){controller.close();finish(task);}else controller.enqueue(part.value);}
     catch(error){if(!task.finished){controller.error(error);finish(task);}}
    },
    cancel(reason){task.controller.abort(reason);const result=task.reader.cancel(reason);finish(task);return result;}
   },{highWaterMark:0});
   task.resolve(new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers}));
  }catch(error){if(!task.finished){task.reject(error);task.controller.abort(error);if(task.reader)void task.reader.cancel(error).catch(()=>{});finish(task);}}
 }
 window.fetch=async(input,init)=>{
  const request=new Request(input,init),url=new URL(request.url);
  // A draft belongs to the evidence version it was opened against. Route its
  // save to that retained generation even if the automatic head has advanced.
  if(request.method==='POST'&&url.origin===location.origin&&url.pathname==='/api/reporting/reviews'){
   let input,body;try{body=await request.clone().text();input=JSON.parse(body);}catch{}
   if(/^[a-f0-9]{64}$/.test(input?.snapshotHash||'')){
    url.searchParams.set('snapshot',input.snapshotHash);
    // Keep JSON as bytes rather than converting it to a streaming upload;
    // Chromium cannot send a streaming request body to a local HTTP/1 server.
    return original(new Request(url,{body,method:request.method,headers:request.headers,credentials:request.credentials,signal:request.signal,mode:request.mode,cache:request.cache,redirect:request.redirect,referrer:request.referrer,referrerPolicy:request.referrerPolicy,integrity:request.integrity,keepalive:request.keepalive}));
   }
  }
  const resource=/^\/report-data\/(detail|history|query|archive|snapshot)-[a-f0-9]{64}\.json$/.exec(url.pathname);
  if(request.method!=='GET'||url.origin!==location.origin||!resource&&(!url.pathname.startsWith('/api/reporting/')||url.pathname==='/api/reporting/status'))return original(request);
  if(request.signal.aborted)throw aborted(request.signal);
  const prefetch=request.headers.get('X-Report-Prefetch')==='1';request.headers.delete('X-Report-Prefetch');
  const priority=prefetch?2:resource&&['detail','history'].includes(resource[1])||['/api/reporting/gps-evidence','/api/reporting/photo/image'].includes(url.pathname)?0:1;
  return new Promise((resolve,reject)=>{
   if(queue.length>=64){
    let evict=-1;if(!prefetch)for(let i=queue.length-1;i>=0;i--)if(queue[i].priority===2){evict=i;break;}
    if(evict<0){reject(Error('Report request queue is full. Retry this request.'));return;}
    const dropped=queue[evict];dropped.reject(Error('Prefetch dropped from the report request queue.'));finish(dropped);
   }
   const task={request,priority,caseRead:(!prefetch&&!!resource&&['detail','history'].includes(resource[1]))||url.pathname==='/api/reporting/photo/image',generation:String(window.__matterReportingGeneration||''),resolve,reject,controller:new AbortController(),started:false,finished:false,reader:null,output:null};
   task.abort=()=>{if(task.finished)return;const reason=aborted(request.signal);task.controller.abort(reason);if(task.reader)void task.reader.cancel(reason).catch(()=>{});if(task.output)task.output.error(reason);reject(reason);finish(task);};
   request.signal.addEventListener('abort',task.abort,{once:true});queue.push(task);drain();
  });
 };
}
export function addBrowserRequestQueue(html){if(typeof html!=='string'||html.split('</head>').length!==2)throw Error('Renderer unavailable');return html.replace('</head>','<script>('+browserRequestQueue.toString()+')();</script></head>');}
