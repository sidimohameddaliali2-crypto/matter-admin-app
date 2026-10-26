// Fixed owner-requested range only. Read-only unless --apply is supplied.
import '../loadEnv.js';
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import path from 'node:path';
import {requestedABagIds,planABagRegistration} from '../services/bagARange.js';
import {bagIdAliases,normalizeBagId} from '../services/bagInventoryAudit.js';
if(process.argv.slice(2).some(arg=>arg!=='--apply'))throw new Error('Only --apply is supported.');
if(!process.env.MONGODB_URI)throw new Error('MONGODB_URI is not configured.');
const apply=process.argv.includes('--apply');
const client=new mongoose.mongo.MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:15000,connectTimeoutMS:10000,socketTimeoutMS:30000,maxPoolSize:2,appName:'matter-owner-requested-a-bag-registration'});
try{
  await client.connect();const bags=client.db().collection('bags');
  const query={bagId:{$in:requestedABagIds().flatMap(bagIdAliases)}};
  const projection={bagId:1,status:1,location:1,quantity:1,lifecycleState:1,verifiedAt:1,custodyVersion:1};
  const before=await bags.find(query,{projection,maxTimeMS:30000}).toArray();
  const plan=planABagRegistration(before);
  const output=path.resolve('../tmp/bag-a-series-registration.json');
  await fs.mkdir(path.dirname(output),{recursive:true});
  // Preserve the bounded preflight evidence before attempting any insertion.
  await fs.writeFile(output,JSON.stringify({apply,range:{first:plan.ids[0],last:plan.ids.at(-1),count:500},before,missing:plan.missing},null,2)+'\n',{mode:0o600});
  let inserted=0;
  if(apply&&plan.operations.length){
    const indexes=await bags.listIndexes().toArray();
    if(!indexes.some(index=>index.unique&&Object.keys(index.key).length===1&&index.key.bagId===1))throw new Error('A unique bagId index is required; no indexes were created by this script.');
    inserted=(await bags.bulkWrite(plan.operations,{ordered:true,writeConcern:{w:'majority'}})).upsertedCount;
  }
  const after=await bags.find(query,{projection,maxTimeMS:30000}).toArray();
  const remaining=planABagRegistration(after).missing;
  const summary={apply,requested:500,alreadyPresent:plan.existing,inserted,registeredNow:new Set(after.map(b=>normalizeBagId(b.bagId))).size,missing:remaining.length,output};
  await fs.writeFile(output,JSON.stringify({summary,before,after,remaining},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(summary,null,2));
  if(apply&&remaining.length)process.exitCode=1;
}catch(e){console.error(JSON.stringify({success:false,error:e.name,message:'A-series registration did not complete. Inspect the local preflight report and retry safely; existing bags are never overwritten.'}));process.exitCode=1;}
finally{await client.close();}
