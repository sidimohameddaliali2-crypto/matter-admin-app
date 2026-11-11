const origin='https://trhhjfgfmxofxhnzocks.supabase.co';
export function createHostedRpc({secret,fetchImpl=fetch}){
 if(typeof secret!=='string'||!secret||/[\r\n]/.test(secret))throw Error('Hosted credential required');
 return async(name,args)=>{
  if(!/^matter_hosted_[a-z_]+$/.test(name)||!args||typeof args!=='object')throw Error('Invalid hosted RPC');
  let response;try{response=await fetchImpl(origin+'/rest/v1/rpc/'+name,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{apikey:secret,...(secret.startsWith('eyJ')?{Authorization:'Bearer '+secret}:{}),'Content-Type':'application/json'},body:JSON.stringify(args)});}catch(e){throw Object.assign(Error('Hosted state connection unavailable'),{diagnosticCategory:e?.name==='TimeoutError'||e?.name==='AbortError'?'state-timeout':'state-transport'});}
  const parts=[];let size=0;try{for await(const b of response.body){size+=b.length;if(size>70*1024*1024)throw Object.assign(Error('Hosted state response exceeds limit'),{diagnosticCategory:'state-invalid-response'});parts.push(Buffer.from(b));}}catch(e){if(e?.diagnosticCategory)throw e;throw Object.assign(Error('Hosted state connection unavailable'),{diagnosticCategory:e?.name==='TimeoutError'||e?.name==='AbortError'?'state-timeout':'state-transport'});}
  let value;try{value=JSON.parse(Buffer.concat(parts).toString());}catch{throw Object.assign(Error('Invalid hosted state response'),{diagnosticCategory:response.status===429?'state-rate-limit':response.status>=500?'state-server-error':'state-invalid-response'});}
  if(!response.ok||response.redirected)throw Object.assign(Error('Hosted state operation failed'),{status:response.status,code:typeof value?.code==='string'?value.code:undefined,diagnosticCategory:value?.code==='40001'?'state-contention':response.status===429?'state-rate-limit':response.status>=500?'state-server-error':'state-rejected'});
  return value;
 };
}
