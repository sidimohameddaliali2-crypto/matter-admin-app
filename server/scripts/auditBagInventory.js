// Read-only: native collection reads, no app models or automatic index creation.
import '../loadEnv.js';
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadBagSnapshot} from '../services/bagOperationsService.js';
import {auditBagInventory} from '../services/bagInventoryAudit.js';
const client=new mongoose.mongo.MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:15000,connectTimeoutMS:10000,socketTimeoutMS:30000,maxPoolSize:2,appName:'matter-bag-read-only-audit'});
const timer=setTimeout(()=>{console.error('Read-only audit timed out.');process.exit(2);},120000);
try{
  await client.connect();
  const report=auditBagInventory(await loadBagSnapshot(client.db()));
  const output=path.resolve('../tmp/bag-inventory-audit.json');
  await fs.mkdir(path.dirname(output),{recursive:true});
  await fs.writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({output,summary:report.summary,findings:report.findings.map(({code,count})=>({code,count}))},null,2));
}catch(e){console.error(JSON.stringify({success:false,error:e.name,message:'Audit failed. Connection details withheld; no database changes requested.'}));process.exitCode=1;}
finally{clearTimeout(timer);await client.close();}
