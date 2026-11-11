import {createHash} from 'node:crypto';

const sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const pointerKey=p=>sha(JSON.stringify(canonical({version:p.version,descriptor:p.descriptor,generation:p.generation,reportHash:p.reportHash})));
const validHash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const validPointer=p=>p?.version===1&&p.descriptor&&typeof p.descriptor==='object'&&validHash(p.generation)&&validHash(p.reportHash);
function validatePackage(value,pointer){
 if(!value||!value.manifest||typeof value.manifest!=='object'||Array.isArray(value.manifest)||typeof value.read!=='function'||typeof value.readAsync!=='function'||typeof value.has!=='function')throw Error('Invalid prepared preview package');
 const manifest=value.manifest.files||value.manifest;
 if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||Object.values(manifest).some(x=>!validHash(x)))throw Error('Invalid prepared preview manifest');
 const read=name=>{if(!Object.hasOwn(manifest,name))throw Error('Package file outside manifest');const bytes=value.read(name);if(!Buffer.isBuffer(bytes)||sha(bytes)!==manifest[name])throw Error('Prepared preview file hash mismatch');return bytes;};
 const publication=JSON.parse(read('publication.private.json'));
 if(publication.head?.manifest?.sha256!==pointer.generation||publication.head?.reportHash!==pointer.reportHash)throw Error('Prepared package does not match preview head');
 if(value.generation&&value.generation!==pointer.generation||value.reportHash&&value.reportHash!==pointer.reportHash)throw Error('Prepared preview identity mismatch');
 return {...value,manifest,generation:pointer.generation,reportHash:pointer.reportHash};
}

// Request-triggered polling avoids a background timer in hosted runtimes. A
// complete package and handler are prepared before active changes; failures keep
// the current handler and its metadata intact.
export function createAutomaticHostedPreview({loadPointer,loadPackage,createRuntime,fallback,clock=()=>Date.now(),intervalMs=30000,maxHandlers=3,refreshOnRequest=true}={}){
 if([loadPointer,loadPackage,createRuntime].some(x=>typeof x!=='function')||fallback!==undefined&&typeof fallback!=='function'||typeof clock!=='function'||!Number.isInteger(intervalMs)||intervalMs<1000||!Number.isInteger(maxHandlers)||maxHandlers<1)throw Error('Invalid hosted preview coordinator');
 let active=null,inflight=null,lastAttemptAt=0,stopped=false;
 const retained=[];
 const state={status:'fallback',lastAttemptAt:null,lastError:null,active:null};
 function snapshot(){return structuredClone(state);}
 async function refresh(force=true){
  if(stopped)return {status:'stopped',...snapshot()};
  if(inflight)return inflight;
  if(!force&&clock()-lastAttemptAt<intervalMs)return {status:active?'ready':'fallback',...snapshot()};
  lastAttemptAt=clock();state.lastAttemptAt=new Date(lastAttemptAt).toISOString();state.status=active?'refreshing':'loading';state.lastError=null;
  inflight=(async()=>{
   try{
    const pointer=await loadPointer();if(!validPointer(pointer))throw Error('Invalid automatic preview pointer');
    const identity=pointerKey(pointer);
    if(active?.identity===identity){state.status='ready';return {status:'unchanged',...snapshot()};}
    const loaded=await loadPackage({descriptor:pointer.descriptor,pointer});
    const packageOverride=validatePackage(loaded,pointer);
    const handler=await createRuntime({packageOverride,automaticFeed:true});
    if(typeof handler!=='function')throw Error('Preview runtime handler unavailable');
    const latest=await loadPointer();if(!validPointer(latest)||pointerKey(latest)!==identity)throw Error('Preview head advanced during package preparation');
    const prepared={identity,pointer:structuredClone(pointer),handler,packageOverride,preparedAt:new Date(clock()).toISOString()};
    retained.unshift(prepared);active=prepared;
    while(retained.length>maxHandlers)retained.pop();
    state.status='ready';state.active={generation:pointer.generation,reportHash:pointer.reportHash,descriptorSha256:sha(JSON.stringify(canonical(pointer.descriptor))),preparedAt:prepared.preparedAt};
    return {status:'ready',...snapshot()};
   }catch(error){state.status=active?'stale':'fallback';state.lastError=String(error?.message||error).slice(0,240);return {status:state.status,...snapshot()};}
   finally{inflight=null;}
  })();
  return inflight;
 }
 async function dispatch(req,res){
  if(!stopped&&refreshOnRequest)await refresh(false);
  const query=new URL(req.url,'http://preview.internal').searchParams;
  const requested=query.get('generation')||query.get('snapshot');
  const chosen=requested?retained.find(x=>x.pointer.generation===requested||x.pointer.reportHash===requested):active;
  const handler=chosen?.handler||(!requested?fallback:null)||active?.handler||fallback;
  if(!handler)throw Error('Automatic preview is not ready');
  return handler(req,res);
 }
 dispatch.refresh=()=>refresh(true);
 dispatch.poll=()=>refresh(false);
 dispatch.status=snapshot;
 dispatch.stop=async()=>{stopped=true;if(inflight)await inflight;};
 dispatch.start=()=>refresh(true);
 return dispatch;
}
