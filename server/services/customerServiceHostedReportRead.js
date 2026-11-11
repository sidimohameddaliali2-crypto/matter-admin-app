import fs from 'node:fs/promises';import {createHash} from 'node:crypto';
const route=/^report-data\/(?:detail|history|query|archive|snapshot)-([a-f0-9]{64})\.json$/;
// Temporary local recovery reader through the already authorized reporting app.
// The caller must first enforce local staff access and the frozen resource allowlist.
export function hostedReportResourceReader({sessionFile,fetchImpl=fetch}){
 return async name=>{
  const match=route.exec(name);if(!match)throw Object.assign(Error('Invalid report resource'),{status:404});
  const session=JSON.parse(await fs.readFile(sessionFile));if(session.origin!=='https://matter-private-reporting.vercel.app'||typeof session.cookie!=='string'||/[\r\n]/.test(session.cookie))throw Error('Invalid private reporting session');
  const response=await fetchImpl(session.origin+'/'+name,{method:'GET',redirect:'error',headers:{Cookie:session.cookie},signal:AbortSignal.timeout(30000)});
  if(!response.ok){await response.body?.cancel();throw Object.assign(Error('Authorized reporting evidence unavailable; renew local reporting session if expired'),{status:response.status===401?503:response.status});}
  const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;if(bytes>16*1024*1024){await response.body?.cancel().catch(()=>{});throw Error('Report resource exceeds bounded recovery size');}chunks.push(chunk);}const body=Buffer.concat(chunks);
  if(createHash('sha256').update(body).digest('hex')!==match[1])throw Error('Recovered report resource integrity mismatch');
  return {body,gzip:false,decodedBytes:body.length,encodedBytes:body.length};
 };
}
