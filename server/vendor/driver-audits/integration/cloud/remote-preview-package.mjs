import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
import {readManifestBytes} from './repository.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const safeName=s=>typeof s==='string'&&s.length<=240&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)&&s!=='.'&&s!=='..';
const CORE=['publication.private.json','identities.private.json','maps.private.json','gps-index.private.json.gz','preview-read-view.private.json.gz','renderer.private.html','build.private.json','browser-data.private.json.gz'];
const OPTIONAL=['browser-data.private.br','corrections.private.json','release-gps-availability.private.json','case-decisions.private.json','photo-prime.private.json','preview-photo-bindings.private.json'];
const CHUNK=8*1024*1024,MAX_FILE=128*1024*1024,MAX_CORE_FILE=64*1024*1024,MAX_CORE_BYTES=64*1024*1024,MAX_DESCRIPTOR=8*1024*1024,CACHE_BYTES=16*1024*1024;
// The verified November audit has an 11 MB compressed / 149 MB decoded GPS
// index. Keep transfer/storage bounds unchanged and bound only this decoder.
const MAX_GPS_DECODED=256*1024*1024;
function fail(message){throw Error(message);}
function json(bytes,label){try{return JSON.parse(bytes);}catch{fail('Invalid '+label);}}
function readLocal(root,name,manifest){if(!safeName(name)||!hex(manifest[name]))fail('Invalid package filename or digest');const bytes=fs.readFileSync(path.join(root,name));if(sha(bytes)!==manifest[name])fail('Preview package source hash mismatch');return bytes;}
async function scanFile(file,{chunks=false}={}){const stat=fs.statSync(file);if(!stat.isFile()||stat.size>MAX_FILE)fail('Preview package file exceeds limit');const whole=createHash('sha256'),parts=[];let pending=Buffer.alloc(0);for await(const data of fs.createReadStream(file)){whole.update(data);if(chunks){pending=pending.length?Buffer.concat([pending,data]):data;while(pending.length>=CHUNK){const bytes=pending.subarray(0,CHUNK);parts.push({offset:parts.reduce((n,x)=>n+x.size,0),size:bytes.length,sha256:sha(bytes)});pending=pending.subarray(CHUNK);}}}if(chunks&&pending.length)parts.push({offset:parts.reduce((n,x)=>n+x.size,0),size:pending.length,sha256:sha(pending)});return {size:stat.size,sha256:whole.digest('hex'),chunks:parts};}
function readRange(file,offset,size){const fd=fs.openSync(file,'r');try{const bytes=Buffer.alloc(size);let read=0;while(read<size){const n=fs.readSync(fd,bytes,read,size-read,offset+read);if(!n)fail('Preview package file changed during upload');read+=n;}return bytes;}finally{fs.closeSync(fd);}}
function validRef(ref){return !!ref&&ref.version===1&&typeof ref.domain==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(ref.domain)&&safeName(ref.path)&&ref.kind==='immutable-evidence'&&Number.isSafeInteger(ref.size)&&ref.size>=0&&ref.size<=MAX_FILE&&hex(ref.sha256)&&Array.isArray(ref.chunks);}
function verifyGeneration(files,refs,reportHash,generation){
 const pub=json(files.get('publication.private.json'),'publication');
 const view=json(gunzipSync(files.get('preview-read-view.private.json.gz'),{maxOutputLength:MAX_FILE}),'preview read view');
 if(pub?.head?.reportHash!==reportHash||pub?.head?.manifest?.sha256!==generation||view.reportHash!==reportHash||view.generation!==generation||view.catalogHash!==pub.catalog?.sha256)fail('Preview package generation mismatch');
 const browserRef=pub.head.manifest;
 if(browserRef?.url!=='report-data/snapshot-'+browserRef.sha256+'.json'||view.browser?.sha256!==browserRef.sha256||view.browser?.url!==browserRef.url)fail('Preview browser generation mismatch');
 const browserGz=files.get('browser-data.private.json.gz');
 if(sha(gunzipSync(browserGz,{maxOutputLength:MAX_FILE}))!==browserRef.sha256)fail('Preview browser payload mismatch');
 if(files.has('browser-data.private.br')&&sha(brotliDecompressSync(files.get('browser-data.private.br'),{maxOutputLength:MAX_FILE}))!==browserRef.sha256)fail('Preview Brotli payload mismatch');
 const gps=json(gunzipSync(files.get('gps-index.private.json.gz'),{maxOutputLength:MAX_GPS_DECODED}),'GPS index');
 const wanted=new Set([...Object.values(view.deferredQueryFiles||{}),...Object.values(gps.streamFiles||{})]);
 for(const name of wanted)if(!safeName(name)||!refs.has(name))fail('Preview package deferred file is absent');
 return wanted;
}

// Prepare an immutable private archive package from a fully validated local candidate.
// This function is inert until explicitly called with a transport that can write.
function inspectPackage({privateRoot,maxBytes,validation}={}){
 if(!path.isAbsolute(privateRoot||'')||!Number.isSafeInteger(maxBytes)||maxBytes<=0||validation?.ok!==true)fail('Invalid remote preview package inputs');
 const root=fs.realpathSync(privateRoot),manifestPath=path.join(root,'files.private.json'),manifestBytes=fs.readFileSync(manifestPath),manifestSha256=sha(manifestBytes);
 if(validation.manifestSha256!==manifestSha256)fail('Validated preview manifest changed');
 const manifest=json(manifestBytes,'preview file manifest');if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||!Object.keys(manifest).length)fail('Invalid preview file manifest');
 const local=new Map();let uploadBytes=0;
 for(const name of Object.keys(manifest)){
  if(!safeName(name)||!hex(manifest[name]))fail('Invalid preview manifest entry');
  const file=path.join(root,name),meta=fs.statSync(file);if(!meta.isFile()||meta.size>MAX_FILE)fail('Preview package file exceeds limit');const actual=scanSync(file);if(actual!==manifest[name])fail('Preview package source hash mismatch');local.set(name,{file,size:meta.size,sha256:actual});
  if(/^archive-[a-f0-9]{64}\.private\.bin$/.test(name)){
   const digest=name.slice(8,-12);if(actual!==digest)fail('Retained archive object hash mismatch');uploadBytes+=meta.size;
  }
 }
 const core=new Map();let preloadBytes=0;for(const name of CORE) {if(!local.has(name))fail('Required preview runtime file missing');const meta=local.get(name);if(meta.size>MAX_CORE_FILE||(preloadBytes+=meta.size)>MAX_CORE_BYTES)fail('Preview runtime core exceeds preload limit');core.set(name,readLocal(root,name,manifest));}
 for(const name of OPTIONAL)if(local.has(name)){const meta=local.get(name);if(meta.size>MAX_CORE_FILE||(preloadBytes+=meta.size)>MAX_CORE_BYTES)fail('Preview runtime core exceeds preload limit');core.set(name,readLocal(root,name,manifest));}
 const files=new Map();for(const name of CORE)files.set(name,local.get(name));for(const name of OPTIONAL)if(local.has(name))files.set(name,local.get(name));
 const publication=json(core.get('publication.private.json'),'publication'),reportHash=publication?.head?.reportHash,generation=publication?.head?.manifest?.sha256;
 if(!hex(reportHash)||!hex(generation))fail('Invalid preview generation identity');
 const fileRefs=new Map();for(const name of local.keys())fileRefs.set(name,null);
 const wanted=verifyGeneration(core,fileRefs,reportHash,generation);
 for(const name of wanted)if(!files.has(name)){if(!local.has(name))fail('Preview package file missing');files.set(name,local.get(name));}
 for(const [name,meta]of files){uploadBytes+=meta.size;}
 if(uploadBytes>maxBytes)fail('Remote preview package exceeds upload cap');
 return {root,local,files,core,manifestSha256,reportHash,generation,uploadBytes,maxBytes};
}
function scanSync(file){const fd=fs.openSync(file,'r'),hash=createHash('sha256'),buf=Buffer.alloc(CHUNK);try{let offset=0;for(;;){const n=fs.readSync(fd,buf,0,buf.length,offset);if(!n)break;hash.update(buf.subarray(0,n));offset+=n;}return hash.digest('hex');}finally{fs.closeSync(fd);}}
function fileRef(name,meta,chunks){return {version:1,domain:'previewRuntime',path:name,kind:'immutable-evidence',size:meta.size,sha256:meta.sha256,chunks};}
export async function planRemotePreviewPackage(args={}){
 const plan=inspectPackage(args);
 const refs={};for(const [name,meta]of plan.files){const scan=await scanFile(meta.file,{chunks:true});if(scan.sha256!==meta.sha256||scan.size!==meta.size)fail('Preview package changed during planning');refs[name]=fileRef(name,meta,scan.chunks);}
 const descriptorBytes=Buffer.from(JSON.stringify({version:1,files:refs,sourceManifestSha256:plan.manifestSha256,reportHash:plan.reportHash,generation:plan.generation}));if(descriptorBytes.length>MAX_DESCRIPTOR)fail('Preview package descriptor exceeds limit');const totalBytes=plan.uploadBytes+[...plan.files.values()].reduce((n,m)=>n+m.size,0)+descriptorBytes.length;if(totalBytes>plan.maxBytes)fail('Remote preview package exceeds upload cap');return {sourceManifestSha256:plan.manifestSha256,reportHash:plan.reportHash,generation:plan.generation,totalBytes,files:[...plan.files].map(([name,meta])=>({name,sha256:meta.sha256,size:meta.size})),retainedObjects:[...plan.local].filter(([name])=>/^archive-[a-f0-9]{64}\.private\.bin$/.test(name)).map(([name,meta])=>({key:name.slice(8,-12)+'.gz',sha256:name.slice(8,-12),size:meta.size}))};
}
export async function prepareRemotePreviewPackage({privateRoot,transport,maxBytes,validation,runBatch}={}){
 if(typeof transport?.putVerifiedObject!=='function'||typeof runBatch!=='function')fail('Verified bounded upload adapter required');
 const plan=inspectPackage({privateRoot,maxBytes,validation});
 const runtimeOps=[],refs={};
 // Hash each local file in bounded chunks; retain only chunk metadata until upload.
 for(const [name,meta]of plan.files){const scan=await scanFile(meta.file,{chunks:true});if(scan.sha256!==meta.sha256||scan.size!==meta.size)fail('Preview package changed during preparation');refs[name]=fileRef(name,meta,scan.chunks);for(const chunk of scan.chunks)runtimeOps.push({key:chunk.sha256+'.gz',file:meta.file,offset:chunk.offset,size:chunk.size,sha256:chunk.sha256});}
 const descriptor={version:1,files:refs,sourceManifestSha256:plan.manifestSha256,reportHash:plan.reportHash,generation:plan.generation};
 const descriptorBytes=Buffer.from(JSON.stringify(descriptor));if(descriptorBytes.length>MAX_DESCRIPTOR)fail('Preview package descriptor exceeds limit');
 const descriptorScan=scanBuffer(descriptorBytes),descriptorRef=fileRef('descriptor.json',{size:descriptorBytes.length,sha256:descriptorScan.sha256},descriptorScan.chunks);descriptorRef.domain='previewPackage';
 const rawOps=[...plan.local].filter(([name])=>/^archive-[a-f0-9]{64}\.private\.bin$/.test(name)).map(([name,meta])=>({key:name.slice(8,-12)+'.gz',file:meta.file,offset:0,size:meta.size,sha256:meta.sha256,raw:true}));
 if([...rawOps,...runtimeOps].some(op=>op.size>32*1024*1024))fail('Single preview package object exceeds batch limit');
 const descriptorOps=descriptorScan.chunks.map(chunk=>({key:chunk.sha256+'.gz',bytes:descriptorBytes.subarray(chunk.offset,chunk.offset+chunk.size),size:chunk.size,sha256:chunk.sha256}));
 const all=[...rawOps,...runtimeOps,...descriptorOps];
 const actualBytes=plan.uploadBytes+[...plan.files.values()].reduce((n,m)=>n+m.size,0)+descriptorBytes.length;if(actualBytes>maxBytes)fail('Remote preview package exceeds upload cap');
 for(let i=0;i<all.length;){let end=i,bytes=0;while(end<all.length&&end-i<64&&bytes+all[end].size<=32*1024*1024){bytes+=all[end].size;end++;}if(end===i)fail('Single preview package object exceeds batch limit');const batch=all.slice(i,end),result=await runBatch({bytes,objects:batch.length},async()=>{for(const op of batch){const data=op.bytes||readRange(op.file,op.offset,op.size);if(sha(data)!==op.sha256)fail('Preview package changed during upload');const receipt=await transport.putVerifiedObject(op.key,data);if(receipt?.verified!==true||receipt.sha256!==op.sha256||receipt.key!==op.key)fail('Preview package upload was not verified');}return {status:'complete',uploaded:batch.length};});if(result?.status!=='complete')fail('Preview package upload batch incomplete');i=end;}
 return {descriptor:descriptorRef,generation:plan.generation,reportHash:plan.reportHash,totalBytes:actualBytes};
}
function scanBuffer(bytes){const chunks=[];for(let offset=0;offset<bytes.length;offset+=CHUNK){const part=bytes.subarray(offset,Math.min(bytes.length,offset+CHUNK));chunks.push({offset,size:part.length,sha256:sha(part)});}return {size:bytes.length,sha256:sha(bytes),chunks};}

// Load a single immutable preview generation. Only runtime-core files are kept synchronously;
// deferred queries and GPS streams are fetched on demand through readAsync.
export async function loadRemotePreviewPackage({descriptor,transport}={}){
 if(!validRef(descriptor)||typeof transport?.readObject!=='function'||descriptor.domain!=='previewPackage'||descriptor.path!=='descriptor.json'||descriptor.size>MAX_DESCRIPTOR)fail('Invalid remote preview descriptor reference');
 const body=await readManifestBytes(transport,descriptor,{maxBytes:MAX_DESCRIPTOR});if(sha(body)!==descriptor.sha256)fail('Remote preview descriptor hash mismatch');
 const value=json(body,'remote preview descriptor');if(value.version!==1||!hex(value.sourceManifestSha256)||!hex(value.reportHash)||!hex(value.generation)||!value.files||typeof value.files!=='object'||Array.isArray(value.files))fail('Invalid remote preview descriptor');
 const refs=new Map();for(const [name,ref]of Object.entries(value.files)){if(!safeName(name)||!validRef(ref)||ref.domain!=='previewRuntime'||ref.path!==name||refs.has(name))fail('Invalid remote preview file reference');refs.set(name,ref);}
 for(const name of CORE)if(!refs.has(name))fail('Remote preview core file missing');
 const cache=new Map();let used=0;
 async function readVerified(name){const ref=refs.get(name);if(!ref)fail('Remote preview file unavailable');const bytes=await readManifestBytes(transport,ref,{maxBytes:MAX_FILE});if(sha(bytes)!==ref.sha256)fail('Remote preview file hash mismatch');return bytes;}
 let coreBytes=0;for(const name of CORE) {const bytes=await readVerified(name);if(bytes.length>MAX_CORE_FILE||(coreBytes+=bytes.length)>MAX_CORE_BYTES)fail('Remote preview runtime core exceeds preload limit');cache.set(name,bytes);}
 for(const name of OPTIONAL)if(refs.has(name)){const bytes=await readVerified(name);if(bytes.length>MAX_CORE_FILE||(coreBytes+=bytes.length)>MAX_CORE_BYTES)fail('Remote preview runtime core exceeds preload limit');cache.set(name,bytes);}
 const wanted=verifyGeneration(cache,refs,value.reportHash,value.generation);for(const name of wanted)if(!refs.has(name))fail('Remote preview deferred file missing');
 const asyncCache=new Map();
 return {descriptor:value,generation:value.generation,reportHash:value.reportHash,coreBytes,manifest:Object.fromEntries([...refs].map(([name,ref])=>[name,ref.sha256])),has:name=>refs.has(name),read(name){if(!cache.has(name))fail('Preview file is not in synchronous runtime core');return Buffer.from(cache.get(name));},async readAsync(name){if(!refs.has(name))fail('Remote preview file unavailable');if(cache.has(name))return Buffer.from(cache.get(name));let entry=asyncCache.get(name);if(entry){const bytes=await entry.promise;if(entry.bytes){asyncCache.delete(name);asyncCache.set(name,entry);}return Buffer.from(bytes);}entry={bytes:0,promise:null};entry.promise=readVerified(name).then(bytes=>{if(bytes.length<=CACHE_BYTES){entry.bytes=bytes.length;while(used+bytes.length>CACHE_BYTES){const first=[...asyncCache].find(([key,item])=>key!==name&&item.bytes>0);if(!first)break;asyncCache.delete(first[0]);used-=first[1].bytes;}if(used+bytes.length<=CACHE_BYTES)used+=bytes.length;else entry.bytes=0;}if(!entry.bytes)asyncCache.delete(name);return bytes;}).catch(e=>{asyncCache.delete(name);throw e;});asyncCache.set(name,entry);return Buffer.from(await entry.promise);}};
}
