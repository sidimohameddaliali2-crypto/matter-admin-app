import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const options={writeConcern:{w:'majority',j:true,wtimeoutMS:10000}};
const payload=d=>Buffer.isBuffer(d?.bytes)?d.bytes:d?.bytes?.value?.(true);
// Only these three dedicated collections are writable. Original business
// collections and appended reporting history are never updated or deleted.
export function createDriverAuditReplica(db,{capacityBytes}={}){
 if(!Number.isSafeInteger(capacityBytes)||capacityBytes<1||capacityBytes>256*1024*1024)throw Error('Explicit audit storage allowance required');
 const objects=db.collection('driverAuditObjects'),control=db.collection('driverAuditControl'),releases=db.collection('driverAuditReleases');
 return {
  async head(){return (await control.findOne({_id:'head'}))?.head??null;},
  async readObject(key,{maxBytes}={}){
   if(!/^[a-f0-9]{64}\.gz$/.test(key)||!Number.isSafeInteger(maxBytes))throw Error('Invalid audit object request');
   const doc=await objects.findOne({_id:key});
   if(!doc)throw Object.assign(Error('Imported audit object unavailable'),{code:'AUDIT_OBJECT_MISSING'});
   const bytes=payload(doc);
   if(!bytes||bytes.length>maxBytes||bytes.length!==doc.size||sha(bytes)!==key.slice(0,-3))throw Error('Imported audit object unavailable or corrupt');
   return [Buffer.from(bytes)];
  },
  async putObject(key,bytes){
   if(!/^[a-f0-9]{64}\.gz$/.test(key)||!Buffer.isBuffer(bytes)||bytes.length>8*1024*1024||sha(bytes)!==key.slice(0,-3))throw Error('Invalid immutable audit object');
   const field='allocations.'+key.slice(0,-3),charge=bytes.length+1024;
   await control.updateOne({_id:'capacity'},{$setOnInsert:{used:0,limit:capacityBytes,allocations:{}}},{...options,upsert:true});
   const saved=await control.findOne({_id:'capacity'});if(saved.limit!==capacityBytes)throw Error('Audit allowance changed; explicit review required');
   if(saved.allocations[key.slice(0,-3)]!==charge){
    const allocated=await control.updateOne({_id:'capacity',limit:capacityBytes,[field]:{$exists:false},used:{$lte:capacityBytes-charge}},{$inc:{used:charge},$set:{[field]:charge}},options);
    if(!allocated.matchedCount){const current=await control.findOne({_id:'capacity'});if(current.allocations[key.slice(0,-3)]!==charge)throw Error('Audit storage allowance exhausted');}
   }
   // Ambiguous writes retain their allowance reservation; an exact retry reuses it.
   await objects.updateOne({_id:key},{$setOnInsert:{size:bytes.length,bytes:Buffer.from(bytes)}},{...options,upsert:true});
   await this.readObject(key,{maxBytes:bytes.length});
  },
  async activate({expected,head}){
   await releases.updateOne({_id:head.sourceBodySha256},{$setOnInsert:{head}},{...options,upsert:true});
   await control.updateOne({_id:'head'},{$setOnInsert:{head:null}},{...options,upsert:true});
   const match=expected?{'head.sourceBodySha256':expected.sourceBodySha256,'head.sourceRevision':expected.sourceRevision}:{head:null};
   try{const saved=await control.updateOne({_id:'head',...match},{$set:{head}},options);if(!saved.matchedCount)throw Error('Concurrent audit import');}
   catch(error){const actual=await this.head();if(actual?.sourceBodySha256!==head.sourceBodySha256)throw error;}
  },
 };
}
