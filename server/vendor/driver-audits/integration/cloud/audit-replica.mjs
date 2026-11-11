import {createHash} from 'node:crypto';
import {readManifestBytes} from './repository.mjs';
import {loadRemotePreviewPackage} from './remote-preview-package.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const MAX_IMPORT=128*1024*1024;
export function checkedAuditPointer(value){
 if(!Number.isSafeInteger(value?.revision)||value.revision<1||typeof value.body!=='string')throw Error('Published audit revision required');
 const p=JSON.parse(value.body);
 if(p.version!==1||!hex(p.generation)||!hex(p.reportHash)||!hex(p.descriptor?.sha256))throw Error('Invalid audit publication');
 return {...p,sourceRevision:value.revision,sourceBodySha256:sha(value.body)};
}
// store is deliberately limited to separate, immutable reporting objects. It has
// no reference to operational delivery, vehicle, assignment or user collections.
export async function importAuditReplica({loadSource,sourceTransport,store,maxBytes=MAX_IMPORT}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_IMPORT)throw Error('Invalid audit transfer bound');
 const source=checkedAuditPointer(await loadSource()),prior=await store.head();
 if(prior&&source.sourceRevision<prior.sourceRevision)throw Error('Audit source revision moved backwards');
 if(prior?.sourceRevision===source.sourceRevision){if(prior.sourceBodySha256!==source.sourceBodySha256)throw Error('Audit source revision conflict');return {status:'unchanged',head:prior};}
 const staged=new Map();let bytes=0;
 const transport={readObject:async(key,{maxBytes:limit}={})=>{
  if(!/^[a-f0-9]{64}\.gz$/.test(key)||!Number.isSafeInteger(limit)||limit<1||limit>128*1024*1024)throw Error('Invalid audit object request');
  if(staged.has(key))return [staged.get(key)];
  const parts=[];let size=0;for await(const chunk of await sourceTransport.readObject(key,{maxBytes:limit})){size+=chunk.length;if(size>limit||bytes+size>maxBytes)throw Error('Audit transfer exceeds allowance');parts.push(Buffer.from(chunk));}
  const body=Buffer.concat(parts);if(sha(body)!==key.slice(0,-3))throw Error('Audit object hash mismatch');bytes+=size;staged.set(key,body);return [body];
 }};
 // Validate core identities, all deferred files and every byte before publishing.
 const pkg=await loadRemotePreviewPackage({descriptor:source.descriptor,transport});
 if(pkg.generation!==source.generation||pkg.reportHash!==source.reportHash)throw Error('Audit publication binding mismatch');
 for(const ref of Object.values(pkg.descriptor.files))await readManifestBytes(transport,ref,{maxBytes:128*1024*1024});
 const latest=checkedAuditPointer(await loadSource());
 if(latest.sourceRevision!==source.sourceRevision||latest.sourceBodySha256!==source.sourceBodySha256)return {status:'superseded'};
 for(const [key,body]of staged)await store.putObject(key,body);
 const loaded=await loadRemotePreviewPackage({descriptor:source.descriptor,transport:store});
 if(loaded.generation!==source.generation)throw Error('Imported audit readback mismatch');
 // Fence against a late source change and another importer. A failed transfer
// never replaces the previous report. Immutable objects are safe to resume.
 const final=checkedAuditPointer(await loadSource());
 if(final.sourceRevision!==source.sourceRevision||final.sourceBodySha256!==source.sourceBodySha256)return {status:'superseded'};
 const head={...source,importedAt:new Date().toISOString(),transferBytes:bytes,objects:staged.size};
 await store.activate({expected:prior,head});
 const actual=await store.head();if(actual?.sourceBodySha256!==source.sourceBodySha256)throw Error('Audit activation readback mismatch');
 return {status:'imported',head:actual};
}
