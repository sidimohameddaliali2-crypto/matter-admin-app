// Fixed Matter-owned target. Server independently checks the current staff identity.
const base='https://trhhjfgfmxofxhnzocks.supabase.co/functions/v1/matter-reporting';
export function createReportingConnection({getToken,enabled=false,fetchImpl=fetch}){
 async function read(route,{signal,hash,maxBytes=16*1024*1024}={}){
  if(!enabled)throw Error('Reporting connection is disabled');const token=getToken();if(!token)throw Object.assign(Error('Matter staff sign-in required'),{status:401});
  const r=await fetchImpl(base+route,{method:'GET',headers:{Authorization:'Bearer '+token},credentials:'omit',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000)});
  if(!r.ok||r.redirected){await r.body?.cancel();throw Object.assign(Error(r.status===401?'Matter staff sign-in required':r.status===403?'Reports permission required':'Reporting evidence unavailable. Retry shortly.'),{status:r.status});}
  const chunks=[];let length=0;for await(const b of r.body){length+=b.length;if(length>maxBytes)throw Error('Reporting response exceeds limit');chunks.push(b);}const bytes=new Uint8Array(length);let offset=0;for(const b of chunks){bytes.set(b,offset);offset+=b.length;}
  if(getToken()!==token||signal?.aborted)throw Object.assign(Error('Staff session changed'),{status:401});
  if(hash){const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');if(actual!==hash)throw Error('Evidence integrity failure');}return bytes;
 }
 return {live:async(options={})=>{if(options.day&&!/^\d{4}-\d{2}-\d{2}$/.test(options.day))throw Error('Invalid capture day');return JSON.parse(new TextDecoder().decode(await read('/live'+(options.day?'/'+options.day:''),options)));},metadata:async options=>JSON.parse(new TextDecoder().decode(await read('/reports',options))),photo:async(binding,options)=>{if(!/^[a-f0-9]{64}$/.test(binding.sha256)||!['image/jpeg','image/png','image/webp'].includes(binding.type))throw Error('Photo unavailable');return new Blob([await read('/photos/'+binding.sha256,{...options,hash:binding.sha256,maxBytes:8*1024*1024})],{type:binding.type});}};
}
