import {createHash} from 'node:crypto';
export const AUTOMATIC_PREVIEW_HEAD='private-preview-release-head';
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const sha=x=>createHash('sha256').update(x).digest('hex');

// Explicit opt-in publication to the existing private archive and a separate
// report pointer. Never writes collector state, grades, reviews or source data.
export async function publishAutomaticPreview({enabled=false,stateStore,sourceBasis,loadSourceBasis,validation,prepare,clock=()=>new Date()}={}){
 if(enabled!==true)return {status:'disabled'};
 if(!stateStore?.read||!stateStore?.compareAndSwap||!hex(sourceBasis)||typeof loadSourceBasis!=='function'||typeof prepare!=='function'||validation?.ok!==true||!hex(validation.manifestSha256))throw Error('Verified publication inputs required');
 const saved=await stateStore.read(AUTOMATIC_PREVIEW_HEAD);
 if(!Number.isSafeInteger(saved?.revision)||saved.revision<0)throw Error('Invalid report pointer revision');
 const prior=saved.body===null?null:JSON.parse(saved.body);
 if(prior&&(prior.version!==1||!hex(prior.descriptor?.sha256)||!hex(prior.generation)||!hex(prior.reportHash)))throw Error('Invalid retained report pointer');
 if(prior?.sourceBasis===sourceBasis&&prior.inputManifestSha256===validation.manifestSha256)return {status:'unchanged',pointer:prior};
 if(await loadSourceBasis()!==sourceBasis)return {status:'superseded'};
 const prepared=await prepare();
 if(!hex(prepared?.descriptor?.sha256)||!hex(prepared.generation)||!hex(prepared.reportHash))throw Error('Verified remote package required');
 if(await loadSourceBasis()!==sourceBasis)return {status:'superseded'};
 const pointer={version:1,descriptor:prepared.descriptor,generation:prepared.generation,reportHash:prepared.reportHash,sourceBasis,inputManifestSha256:validation.manifestSha256,publishedAt:clock().toISOString(),previous:prior?{descriptor:prior.descriptor,generation:prior.generation,reportHash:prior.reportHash,sourceBasis:prior.sourceBasis}:null};
 const body=JSON.stringify(pointer),event=JSON.stringify({kind:'automatic-private-preview',descriptor:prepared.descriptor.sha256,sourceBasis}),request=JSON.stringify({expectedRevision:saved.revision,body});
 try{
  const receipt=await stateStore.compareAndSwap({key:AUTOMATIC_PREVIEW_HEAD,expectedRevision:saved.revision,eventId:'preview-'+sha(request),body,event,request});
  if(receipt?.body_text!==body)throw Error('Report publication acknowledgement mismatch');
 }catch(error){
  // A lost acknowledgement is resolved from committed state, never by deleting
  // uploads or overwriting a different writer's newer publication.
  const actual=await stateStore.read(AUTOMATIC_PREVIEW_HEAD);
  if(actual.body===body)return {status:'published',recoveredAcknowledgement:true,pointer};
  if(error?.status===409)return {status:'deferred'};
  throw error;
 }
 return {status:'published',pointer};
}
