// An additive image-reference repair. It does not replace an assessment or review.
import {createHash} from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const clock=x=>x===null||typeof x==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(x)&&Number.isFinite(Date.parse(x));
function validate(registry){
 if(registry?.version!==1||!hex(registry.generation)||!hex(registry.reportHash)||!Array.isArray(registry.entries)||registry.entries.length>100000)throw Error('Invalid photo repair registry');
 const seen=new Set();
 for(const e of registry.entries){
  if(!e||typeof e.recordKey!=='string'||e.recordKey.length>300||!/^\d{4}-\d{2}-\d{2}$/.test(e.date)||!e.recordKey.startsWith(e.date+'/')||seen.has(e.recordKey)||![e.sourceRowSha256,e.assessmentHash,e.urlSha256,e.imageSha256].every(hex)||!clock(e.proofTimestamp)||!Array.isArray(e.sources)||!e.sources.length||e.sources.length>1000)throw Error('Invalid photo repair entry');
  seen.add(e.recordKey);
  for(const s of e.sources)if(!s||['recordKey','imageSha256','urlSha256','proofTimestamp'].some(k=>s[k]!==e[k])||!hex(s.receiptSha256)||!hex(s.captureSha256)||typeof s.observedAt!=='string'||!clock(s.observedAt))throw Error('Invalid photo repair provenance');
 }
 return registry;
}
export function applyPhotoBindingRepair(rows,registry){
 if(!Array.isArray(rows))throw Error('Invalid photo rows');
 if(registry===null)return rows;
 const entries=new Map(validate(registry).entries.map(e=>[e.recordKey,e]));
 return rows.map(row=>{
  const e=entries.get(row.key),d=row.delivery||{},proof=Object.hasOwn(d,'raw_upload')?d.raw_upload:d.upload??null;
  if(!e||row.key!==row.date+'/'+d.delivery_id||row.date!==e.date||row.assessmentHash!==e.assessmentHash||d.source_sha256!==e.sourceRowSha256||typeof d.photo_url!=='string'||sha(d.photo_url)!==e.urlSha256||proof!==e.proofTimestamp||d.photo_sha256!=null)return row;
  return {...row,delivery:{...d,photo_sha256:e.imageSha256}};
 });
}
export async function loadPhotoBindingRepair(repository){
 const p=repository?.publication?.photoBindingRepair;
 if(!p)return null;
 if(p.version!==1||!hex(p.sha256)||p.path!=='photo-binding-repairs/'+p.sha256+'.json')throw Error('Invalid photo repair pointer');
 const bytes=await repository.readFile('state',p.path,{maxBytes:16*1024*1024});
 if(!Buffer.isBuffer(bytes)||sha(bytes)!==p.sha256)throw Error('Photo repair integrity failure');
 return validate(JSON.parse(bytes));
}
