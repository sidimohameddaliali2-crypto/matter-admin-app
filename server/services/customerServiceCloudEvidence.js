import mongoose from 'mongoose';
import {cloudInbox,cloudSqlText as lit,decodeCloudRecord} from './customerServiceCloudStore.js';
const fields=new Set(['_id','conversationId','source','scope','externalMessageId','sentAt']);
export function evidencePredicate(filter){
 const parts=[];
 for(const [key,value]of Object.entries(filter)){
  if(['$or','$and'].includes(key)){if(!Array.isArray(value)||!value.length)throw Error('Invalid evidence filter');parts.push('('+value.map(evidencePredicate).join(key==='$or'?' OR ':' AND ')+')');continue;}
  if(!fields.has(key))throw Error('Unsupported evidence filter');
  const column=key==='_id'?'id':`body->>${lit(key)}`;
  if(value&&typeof value==='object'&&!(value instanceof Date)&&!value._bsontype){
   for(const [op,v]of Object.entries(value)){
    if(op==='$in'){if(!Array.isArray(v))throw Error('Invalid evidence set');parts.push(v.length?`${column} IN (${v.map(x=>lit(String(x))).join(',')})`:'false');}
    else if(['$gte','$gt','$lte','$lt'].includes(op))parts.push(`${column} ${{'$gte':'>=','$gt':'>','$lte':'<=','$lt':'<'}[op]} ${lit(new Date(v).toISOString())}`);
    else throw Error('Unsupported evidence comparison');
   }
  }else parts.push(value===null?`${column} IS NULL`:`${column}=${lit(value instanceof Date?value.toISOString():String(value))}`);
 }
 return parts.length?parts.join(' AND '):'true';
}
export async function readCloudEvidence(filter,{limit=50001,sort='ascending'}={}){
 const cloud=cloudInbox();if(!cloud)throw Error('Cloud inbox unavailable');
 if(!Number.isInteger(limit)||limit<1||limit>50001)throw Error('Invalid evidence limit');
 const rows=await cloud.store.query(`SELECT COALESCE(jsonb_agg(r),'[]'::jsonb) FROM (SELECT kind,id,payload,sha256 FROM gallabox_private.inbox_record WHERE kind='servicemessages' AND ${evidencePredicate(filter)} ORDER BY body->>'sentAt' ${sort==='descending'?'DESC':'ASC'},id LIMIT ${limit}) r;`,{maxBytes:64*1024*1024});
 return rows.map(decodeCloudRecord);
}
export async function cloudConversationIdsInRange(range){
 const ids=await cloudInbox().store.query(`SELECT COALESCE(jsonb_agg(c),'[]'::jsonb) FROM (SELECT DISTINCT conversation_id c FROM gallabox_private.message_time WHERE sent_at>=${lit(range.from.toISOString())} AND sent_at<${lit(range.to.toISOString())} LIMIT 10001) x;`);
 return ids.map(x=>new mongoose.Types.ObjectId(x));
}
