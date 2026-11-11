import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const validPath=p=>typeof p==='string'&&p.length<2048&&p.split('/').every(s=>s&&s!=='.'&&s!=='..'&&!s.includes('\\'));
const domainOK=s=>typeof s==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(s);
const MAX=8*1024*1024;
export async function readManifestBytes(transport,manifest,{maxBytes}){
 if(!manifest||manifest.version!==1||!Number.isSafeInteger(manifest.size)||manifest.size<0||manifest.size>maxBytes||!hex(manifest.sha256)||!Array.isArray(manifest.chunks))throw Error('Invalid retained manifest');
 const parts=[];let offset=0;const full=createHash('sha256');
 for(const c of manifest.chunks){
  if(c.offset!==offset||!Number.isSafeInteger(c.size)||c.size<1||c.size>MAX||offset+c.size>manifest.size||!hex(c.sha256))throw Error('Invalid retained chunk');
  const stream=await transport.readObject(c.sha256+'.gz',{maxBytes:c.size});let n=0;const chunks=[];
  for await(const part of stream){n+=part.length;if(n>c.size)throw Error('Retained chunk exceeds size');chunks.push(Buffer.from(part));}
  const bytes=Buffer.concat(chunks,n);if(n!==c.size||sha(bytes)!==c.sha256)throw Error('Retained chunk integrity failure');
  parts.push(bytes);full.update(bytes);offset+=n;
 }
 if(offset!==manifest.size||full.digest('hex')!==manifest.sha256)throw Error('Retained file integrity failure');
 return Buffer.concat(parts,offset);
}
export async function archiveBytes(transport,body,{domain='catalog',path='index.json',kind='immutable-evidence'}={}){
 if(!Buffer.isBuffer(body)||!domainOK(domain)||!validPath(path))throw Error('Invalid archive bytes');
 const chunks=[];
 for(let offset=0;offset<body.length;offset+=MAX){const bytes=body.subarray(offset,offset+MAX),digest=sha(bytes);const receipt=await transport.putVerifiedObject(digest+'.gz',bytes);if(receipt?.verified!==true||receipt.sha256!==digest)throw Error('Unverified archive write');chunks.push({offset,size:bytes.length,sha256:digest});}
 return {version:1,domain,path,kind,size:body.length,sha256:sha(body),chunks};
}
export async function archiveCatalog(transport,files,{concurrency=4}={}){
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw Error('Invalid catalog concurrency');
 const groups=new Map(),seen=new Set();
 for(const f of files){if(!domainOK(f.domain)||!validPath(f.path)||!hex(f.sha256))throw Error('Invalid catalog file');const name=f.domain+'/'+f.path;if(seen.has(name))throw Error('Duplicate catalog path');seen.add(name);const group=f.domain+':'+sha(f.path).slice(0,2);if(!groups.has(group))groups.set(group,[]);groups.get(group).push(f);}
 const index={version:1,fileCount:files.length,shards:{}};
 const ordered=[...groups].sort(([a],[b])=>a.localeCompare(b)),results=new Array(ordered.length);let cursor=0,failure;
 await Promise.all(Array.from({length:Math.min(concurrency,ordered.length)},async()=>{while(!failure){const i=cursor++;if(i>=ordered.length)return;const [group,entries]=ordered[i];try{entries.sort((a,b)=>a.path.localeCompare(b.path));results[i]=await archiveBytes(transport,Buffer.from(JSON.stringify(entries)),{path:group+'.json'});}catch(e){failure=e;}}}));
 if(failure)throw failure;
 for(let i=0;i<ordered.length;i++)index.shards[ordered[i][0]]=results[i];
 return archiveBytes(transport,Buffer.from(JSON.stringify(index)));
}
export async function mergeCatalog(transport,catalog,files,{concurrency=4}={}){
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw Error('Invalid catalog concurrency');
 const index=JSON.parse(await readManifestBytes(transport,catalog,{maxBytes:8*1024*1024}));
 if(index.version!==1||!index.shards||!Number.isSafeInteger(index.fileCount))throw Error('Invalid retained catalog');
 const groups=new Map(),seen=new Set();
 for(const f of files){if(!domainOK(f.domain)||!validPath(f.path)||!hex(f.sha256))throw Error('Invalid catalog file');const key=f.domain+'/'+f.path;if(seen.has(key))throw Error('Duplicate catalog path');seen.add(key);const group=f.domain+':'+sha(f.path).slice(0,2);if(!groups.has(group))groups.set(group,[]);groups.get(group).push(f);}
 const ordered=[...groups],results=new Array(ordered.length);let cursor=0,failure;
 await Promise.all(Array.from({length:Math.min(concurrency,ordered.length)},async()=>{while(!failure){const i=cursor++;if(i>=ordered.length)return;const [group,additions]=ordered[i];try{const entries=index.shards[group]?JSON.parse(await readManifestBytes(transport,index.shards[group],{maxBytes:16*1024*1024})):[];if(!Array.isArray(entries))throw Error('Invalid retained shard');const map=new Map(entries.map(f=>[f.domain+'/'+f.path,f]));if(map.size!==entries.length)throw Error('Duplicate retained path');let added=0;for(const f of additions){const prior=map.get(f.domain+'/'+f.path);if(prior){if(prior.sha256!==f.sha256||prior.size!==f.size)throw Error('Immutable catalog path conflict');continue;}map.set(f.domain+'/'+f.path,f);added++;}if(added===0){results[i]={added,manifest:index.shards[group]};continue;}const next=[...map.values()].sort((a,b)=>a.path.localeCompare(b.path));results[i]={added,manifest:await archiveBytes(transport,Buffer.from(JSON.stringify(next)),{path:group+'.json'})};}catch(e){failure=e;}}}));
 if(failure)throw failure;
 if(results.every(result=>result.added===0))return catalog;
 for(let i=0;i<ordered.length;i++){index.shards[ordered[i][0]]=results[i].manifest;index.fileCount+=results[i].added;}
 return archiveBytes(transport,Buffer.from(JSON.stringify(index)));
}
// Catalog and chunks are immutable. A small CAS document alone selects the visible generation.
export function createCloudRepository({stateStore,transport,key='report-head',cacheBytes=32*1024*1024}){
 const cache=new Map();let used=0;
 async function bytes(m,maxBytes){if(m.size>maxBytes)throw Error('Retained file exceeds limit');if(cache.has(m.sha256))return Buffer.from(cache.get(m.sha256));const b=await readManifestBytes(transport,m,{maxBytes});if(b.length<=cacheBytes){while(used+b.length>cacheBytes&&cache.size){const first=cache.keys().next().value;used-=cache.get(first).length;cache.delete(first);}cache.set(m.sha256,b);used+=b.length;}return Buffer.from(b);}
 async function pointer(){const value=await stateStore.read(key);if(!value.body)throw Error('Report migration has not published a generation');const p=JSON.parse(value.body);if(p.version!==1||!p.head||!p.catalog)throw Error('Invalid report publication');return {...p,revision:value.revision};}
 async function resolve(p,domain,path){if(!domainOK(domain)||!validPath(path))throw Error('Invalid retained path');const index=JSON.parse(await bytes(p.catalog,8*1024*1024));if(index.version!==1||!index.shards||typeof index.shards!=='object')throw Error('Invalid retained catalog');const shard=index.shards[domain+':'+sha(path).slice(0,2)];if(!shard)throw Object.assign(Error('Retained path absent'),{code:'ENOENT'});const entries=JSON.parse(await bytes(shard,16*1024*1024));if(!Array.isArray(entries))throw Error('Invalid retained shard');const matches=entries.filter(f=>f.domain===domain&&f.path===path);if(matches.length===0)throw Object.assign(Error('Retained path absent'),{code:'ENOENT'});if(matches.length!==1)throw Error('Ambiguous retained path');return matches[0];}
 return {getPublication:pointer,async getHead(){return (await pointer()).head;},async resolveFile(domain,path){return resolve(await pointer(),domain,path);},async readFile(domain,path,{maxBytes}){return bytes(await resolve(await pointer(),domain,path),maxBytes);},
  async pin(){const p=await pointer();return {getHead:async()=>p.head,resolveFile:(domain,path)=>resolve(p,domain,path),readFile:async(domain,path,{maxBytes})=>bytes(await resolve(p,domain,path),maxBytes),publication:p};}
 };
}
