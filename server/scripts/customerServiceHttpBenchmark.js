// Bounded loopback HTTP timing. This does not measure rendered browser visibility.
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
const configPath=process.argv[2];
if(!configPath)throw Error('Provide an owner-private benchmark configuration file.');
const config=JSON.parse(fs.readFileSync(configPath,'utf8')),base=new URL(config.baseUrl);
if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.username||base.password)throw Error('Benchmark only supports loopback previews.');
const samples=config.samples??3;
if(!Number.isInteger(samples)||samples<1||samples>5||!Array.isArray(config.targets)||config.targets.length<1||config.targets.length>6)throw Error('Use 1–5 samples and at most six targets.');
for(const target of config.targets){const url=new URL(target.path,base);if(url.origin!==base.origin||!/^\/api\/(customer-service\/|reporting\/|session$)/.test(url.pathname)||!/^[-a-z0-9_]+$/.test(target.label))throw Error('Use named read-only staff API targets in the same preview.');}
const raw=fs.readFileSync(config.tokenFile,'utf8').trim();let token=raw;try{token=JSON.parse(raw).token;}catch{}
if(typeof token!=='string'||!token||/[\r\n]/.test(token))throw Error('Private token file is invalid.');
const observations=[];
for(const target of config.targets)for(let sample=0;sample<samples;sample++){
 const start=performance.now();let status=null,bytes=0,error=null;
 try{const response=await fetch(new URL(target.path,base),{headers:{Authorization:'Bearer '+token},redirect:'manual',signal:AbortSignal.timeout(30000)});status=response.status;for await(const chunk of response.body||[]){bytes+=chunk.byteLength;if(bytes>16*1024*1024)throw Error('bounded_body_limit');}}
 catch(e){error=e.name==='TimeoutError'?'timeout':e.message==='bounded_body_limit'?'body_limit':'request_failed';}
 observations.push({target:target.label,sample,phase:sample===0?'first_request':'repeat_request',status,bytes,durationMs:Math.round(performance.now()-start),error,at:new Date().toISOString()});
}
const report={version:'local-http-timing-v1',evidenceType:'automated_loopback_http_not_browser',commit:config.commit||null,build:config.build||null,baseUrl:base.origin,dataVolume:config.dataVolume||null,dataVolumeSource:config.dataVolumeSource||'Not supplied',observations,limitations:['First request does not establish a cold browser or empty database cache.','Body completion is not rendered visibility.','No acceptance thresholds are implied.']};
const output=path.resolve(config.output);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({output,samples:observations.length,successful:observations.filter(x=>x.status===200&&!x.error).length}));
