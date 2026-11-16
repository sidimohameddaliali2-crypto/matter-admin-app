import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
const MAX=512*1024*1024;
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(s);
export function createArchiveReservation({rpc,transport,ensureCapacity,id=randomUUID}={}){
 if(typeof rpc!=='function'||!transport?.putVerifiedObject||typeof ensureCapacity!=='function'||typeof id!=='function')throw Error('Invalid archive reservation dependencies');
 const contexts=new AsyncLocalStorage();
 const validate=(r,c,released)=>{if(!r||r.id!==c.id||r.reserved_bytes!==c.reserved||!Number.isSafeInteger(r.consumed_bytes)||r.consumed_bytes<0||r.consumed_bytes>c.reserved||r.released!==released)throw Error('Invalid archive reservation response');};
 async function capacity({bytes,phase}={}){const c=contexts.getStore();if(!c||c.closed)throw Error('Archive reservation context required');if(!Number.isSafeInteger(bytes)||bytes<0||bytes>MAX)throw Error('Invalid archive capacity request');if(phase==='worker-preflight'){if(c.started||!bytes)throw Error('Invalid archive reservation');c.started=true;c.id=id();c.reserved=bytes;if(!uuid(c.id))throw Error('Invalid archive reservation id');try{validate(await rpc('matter_hosted_archive_reserve',{p_id:c.id,p_reserved_bytes:bytes}),c,false);}catch(e){c.failed=true;throw e;}c.active=true;return true;}if(!c.active||c.failed||bytes>c.reserved)throw Error('Archive reservation unavailable');return true;}
 async function putVerifiedObject(key,bytes){const c=contexts.getStore();if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>16*1024*1024||typeof key!=='string'||!/^[a-f0-9]{64}\.(?:gz|json)$/.test(key)||createHash('sha256').update(bytes).digest('hex')!==key.slice(0,64)){if(c)c.failed=true;throw Error('Invalid archive object binding');}if(!c)throw Error('Archive reservation context required');if(!c.active||c.closed||c.failed||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>16*1024*1024)throw Error('Archive reservation unavailable');const op=id();if(!uuid(op))throw Error('Invalid archive operation id');c.consumed+=bytes.length;if(c.consumed>c.reserved){c.failed=true;throw Error('Archive reservation exceeded');}const task=(async()=>{try{validate(await rpc('matter_hosted_archive_consume',{p_id:c.id,p_operation_id:op,p_bytes:bytes.length,p_object_key:key}),c,false);const receipt=await transport.putVerifiedObject(key,bytes);if(receipt?.verified!==true)throw Error('Unverified archive write');return receipt;}catch(e){c.failed=true;throw e;}})();c.pending.add(task);try{return await task;}finally{c.pending.delete(task);}}
 async function run(fn){
  if(typeof fn!=='function')throw Error('Invalid archive operation');
  const c={started:false,active:false,failed:false,consumed:0,pending:new Set()};
  return contexts.run(c,async()=>{
   let result;
   try{result=await fn();}
   catch(error){c.failed=true;throw error;}
   finally{
    c.closed=true;
    await Promise.allSettled([...c.pending]);
   }
   const emptyLeaseDeferral=result?.status==='deferred'&&result.reason==='collector-lease-busy'&&c.consumed===0;
   if(c.active&&!c.failed&&(['complete','not-due','disabled'].includes(result?.status)||emptyLeaseDeferral)){
    validate(await rpc('matter_hosted_archive_release',{p_id:c.id}),c,true);
   }
   return result;
  });
 }
 return {run,ensureCapacity:capacity,transport:{...transport,putVerifiedObject}};
}
