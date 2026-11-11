import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';import path from 'node:path';
const hash=value=>createHash('sha256').update(value).digest('hex');
// View-only identities: never modify delivery rows or reuse a different source version.
export function weekendCustomerIdentities(reportRows,snapshots){
 const versions=new Map();for(const s of snapshots.filter(Boolean))for(const row of s.rows||[]){const key=s.day+'/'+row.id,sha=hash(JSON.stringify(row));versions.set(key+'/'+sha,row);}
 const identities={};for(const row of reportRows){const weekday=new Date(row.date+'T12:00:00Z').getUTCDay();if(weekday!==0&&weekday!==6)continue;const raw=versions.get(row.key+'/'+row.delivery?.source_sha256);if(!raw)continue;
  const top=raw.customerId,nested=raw.customer?.customerId,valid=x=>(typeof x==='string'&&x.trim().length>0)||(typeof x==='number'&&Number.isFinite(x));
  if(valid(top)&&valid(nested)&&String(top)!==String(nested))continue;const id=valid(top)?top:valid(nested)?nested:null;if(id===null)continue;identities[row.key]=hash('matter-delivery-customer:'+String(id));
 }return identities;
}
export async function readIdentityCapture(dir){
 try{const file=path.join(dir,'snapshot.private.json'),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024*1024)return null;
  const [bytes,manifest]=await Promise.all([fs.readFile(file),fs.readFile(path.join(dir,'manifest.private.json'),'utf8')]);const s=JSON.parse(bytes),m=JSON.parse(manifest);
  if(m.sha256!==hash(bytes)||m.bytes!==bytes.length||m.day!==s.day||m.runId!==path.basename(dir)||s.kind!=='matter-api-mirror-v1'||!Array.isArray(s.rows)||!Array.isArray(s.locations)||s.receipt?.snapshotComplete!==true||s.receipt.rowCount!==s.rows.length||s.receipt.uniqueCount!==s.rows.length||new Set(s.rows.map(r=>r.id)).size!==s.rows.length||s.snapshotHash!==hash(JSON.stringify({day:s.day,rows:s.rows,locations:s.locations})))return null;return s;
 }catch{return null;}
}
