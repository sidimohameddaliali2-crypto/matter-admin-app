// Only the new Matter target. No upload overwrite, delete, public URL or source bucket support.
import {createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
const base='https://trhhjfgfmxofxhnzocks.supabase.co/storage/v1';
const bucket='matter-report-archive',keyOK=k=>typeof k==='string'&&/^[a-f0-9]{64}\.(gz|json)$/.test(k);
const storageError=(code,message)=>Object.assign(Error(message),{code});
const sha=b=>createHash('sha256').update(b).digest('hex');
async function bytes(response,maxBytes){const chunks=[];let count=0;for await(const chunk of response.body){count+=chunk.byteLength;if(count>maxBytes)throw Error('Archive response exceeds limit');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);}
export function createSupabaseArchiveTransport({secret,fetchImpl=fetch,timeoutMs=30000}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw Error('Invalid archive timeout');
 if(typeof secret!=='string'||!secret||secret.length>8192||/[\r\n]/.test(secret))throw Error('Private archive credential required');
 const headers={apikey:secret,...(secret.startsWith('eyJ')?{Authorization:'Bearer '+secret}:{})};
 const request=async(route,{signal,headers:extra,...options}={})=>{try{return await fetchImpl(base+route,{...options,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),headers:{...headers,...extra}});}catch(e){throw storageError(['AbortError','TimeoutError'].includes(e?.name)?'storage_timeout':'storage_unavailable','Private archive connection unavailable');}};
 async function readObject(key,{signal,maxBytes=16*1024*1024}={}){
  if(!keyOK(key)||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024)throw Error('Invalid archive object request');
  const r=await request('/object/authenticated/'+bucket+'/'+key,{method:'GET',signal});
  if(r.redirected||!r.ok||Number(r.headers.get('content-length'))>maxBytes){
   let missing=r.status===404;
   if(r.status===400)try{const error=JSON.parse(await bytes(r,16384));missing=error.statusCode==='404'||error.statusCode===404;}catch{}
   if(!r.bodyUsed)await r.body?.cancel();
   throw storageError(missing?'storage_not_found':r.status===429?'storage_rate_limit':r.status>=500?'storage_unavailable':'storage_rejected','Private archive object unavailable');
  }
  return r.body;
 }
 return {readObject,async assertPrivate(){const r=await request('/bucket/'+bucket,{method:'GET'});if(!r.ok||r.redirected){await r.body?.cancel();throw Error('Private archive bucket unavailable');}const b=JSON.parse(await bytes(r,16384));if(b.id!==bucket||b.public!==false)throw Error('Archive bucket must be private');return {bucket,public:false};},
  async putVerifiedObject(key,body){
   if(!keyOK(key)||!Buffer.isBuffer(body)||body.length>16*1024*1024||sha(body)!==key.split('.')[0])throw Error('Archive upload hash/size mismatch');
   const r=await request('/object/'+bucket+'/'+key,{method:'POST',headers:{'Content-Type':key.endsWith('.gz')?'application/gzip':'application/json','x-upsert':'false','Cache-Control':'no-store'},body});
   if(r.redirected)throw Error('Archive upload redirected');
   if(!r.ok){let info;try{info=JSON.parse(await bytes(r,16384));}catch{}if(![400,409].includes(r.status)||!['Duplicate','Asset Already Exists','ResourceAlreadyExists'].includes(info?.error||info?.code))throw storageError(r.status===429?'storage_rate_limit':r.status>=500?'storage_unavailable':'storage_rejected','Archive upload failed');}else await r.body?.cancel();
   let readback;try{readback=await bytes(new Response(await readObject(key,{maxBytes:Math.max(1,body.length)})),Math.max(1,body.length));}catch(e){if(['AbortError','TimeoutError'].includes(e?.name))throw storageError('storage_timeout','Private archive readback timed out');throw e;}
   if(readback.length!==body.length||sha(readback)!==sha(body))throw Error('Archive readback verification failed');
   return {key,bytes:body.length,sha256:sha(body),verified:true};
  }
 };
}
