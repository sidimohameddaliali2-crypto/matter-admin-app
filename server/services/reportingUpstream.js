export function createReportingUpstream({baseUrl,credential,fetchImpl=fetch,maxBytes=128*1024*1024}){
 const base=new URL(baseUrl);if(base.protocol!=='https:'||base.origin!==baseUrl||base.username||base.password||!credential||/[\r\n]/.test(credential))throw Error('Configure a private HTTPS reporting origin and server credential');
 let active=0;
 return async({method,path,body,actor})=>{
  const allowed=path==='/'||/^\/api\/reporting\/(status|reviews|fresh-run|api-refresh)(?:\?.*)?$/.test(path)||method==='GET'&&/^\/api\/reporting\/photo-proposals\?[^#]*$/.test(path)||/^\/api\/reporting\/photo(?:\/image)?\?[^#]*$/.test(path)||/^\/report-data\/(detail|history|query|archive|snapshot)-[a-f0-9]{64}\.json$/.test(path);
  if(!allowed||!['GET','POST'].includes(method)||active>=8)throw Error('Reporting request unavailable');
  active++;try{
   const r=await fetchImpl(base.origin+path,{method,headers:{Authorization:'Bearer '+credential,...(body?{'Content-Type':'application/json'}:{}),...(actor?{'X-Reporting-Actor':Buffer.from(JSON.stringify(actor)).toString('base64url')}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(60000)});
   if(r.redirected)throw Error('Unexpected redirect');
   const chunks=[];let size=0;for await(const b of r.body){size+=b.length;if(size>maxBytes)throw Error('Reporting response exceeds limit');chunks.push(b);}
   const type=r.headers.get('content-type')||'';if(!/^(application\/json|text\/html|image\/(jpeg|png|webp))(?:;|$)/i.test(type))throw Error('Unexpected reporting content');
   return {status:r.status,type,body:Buffer.concat(chunks)};
  }finally{active--;}
 };
}
