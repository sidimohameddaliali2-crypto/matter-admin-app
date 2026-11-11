// Runtime-owned cache for verified immutable evidence only. Byte accounting uses
// decoded serialized bytes (or image Buffer bytes), not a JS heap measurement.
// Mutable publications, bindings, authorization and journals must never be stored here.
export function createImmutableEvidenceCache({maxBytes=64*1024*1024,maxEntries=64}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxEntries)||maxEntries<1)throw Error('Invalid immutable evidence cache limits');
 const entries=new Map();let used=0;
 const remove=key=>{const value=entries.get(key);if(value){used-=value.bytes;entries.delete(key);}};
 const trim=()=>{while((used>maxBytes||entries.size>maxEntries)&&entries.size)remove(entries.keys().next().value);};
 return {
  getOrLoad(key,load){
   if(typeof key!=='string'||!key||typeof load!=='function')return Promise.reject(Error('Invalid immutable evidence cache request'));
   const found=entries.get(key);if(found){entries.delete(key);entries.set(key,found);return found.promise;}
   const item={bytes:0,promise:null};
   item.promise=Promise.resolve().then(load).then(result=>{
    if(!result||!Object.hasOwn(result,'value')||!Number.isSafeInteger(result.bytes)||result.bytes<0)throw Error('Invalid immutable evidence size');
    if(entries.get(key)===item){if(result.bytes>maxBytes)remove(key);else{item.bytes=result.bytes;used+=item.bytes;trim();}}
    return result.value;
   }).catch(error=>{if(entries.get(key)===item)remove(key);throw error;});
   entries.set(key,item);trim();return item.promise;
  },
  stats:()=>({bytes:used,entries:entries.size})
 };
}
