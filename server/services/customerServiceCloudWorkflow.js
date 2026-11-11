import {AsyncLocalStorage} from 'node:async_hooks';
import mongoose from 'mongoose';
import {randomUUID} from 'node:crypto';
import {cloudInbox,cloudSqlText as lit,encodeCloudRecord,decodeCloudRecord} from './customerServiceCloudStore.js';
const transactions=new AsyncLocalStorage();
export const cloudWorkflowEnabled=()=>cloudInbox()?.workflow===true;
const value=v=>v instanceof Date?v.toISOString():v?._bsontype==='ObjectId'?String(v):v;
const path=key=>'$'+key.split('.').map(k=>/^\d+$/.test(k)?`[${k}]`:'.'+JSON.stringify(k)).join('');
export function workflowFilter(filter={}) {
 const clauses=Object.entries(filter).map(([key,condition])=>{
  if(key==='$or'||key==='$and')return '('+(condition.length?condition.map(workflowFilter).join(key==='$or'?' OR ':' AND '):key==='$or'?'FALSE':'TRUE')+')';
  if(key.startsWith('$'))throw Error('Unsupported workflow filter');
  const exists=`jsonb_path_exists(body,${lit(path(key))}::jsonpath)`;
  const compare=(op,v)=>`jsonb_path_exists(body,${lit(path(key)+` ? (@ ${op} $v)`)}::jsonpath,${lit(JSON.stringify({v:value(v)}))}::jsonb)`;
  const scalarKeys=new Set(['_id','userId','reviewerId','ownerId','issueId','conversationId','status','sampleType','sampleKey','outcome','enabled','availabilityDate','version','sourceRevision','episodeKey']);
  const exact=v=>scalarKeys.has(key)&&v!==null?(key==='_id'?`id=${lit(value(v))}`:typeof value(v)==='string'?`body->>${lit(key)}=${lit(value(v))}`:`body->${lit(key)}=${lit(JSON.stringify(value(v)))}::jsonb`):compare('==',v);
  const equal=v=>v===null?`(NOT ${exists} OR ${compare('==',null)})`:exact(v);
  if(condition===null||typeof condition!=='object'||condition instanceof Date||condition?._bsontype)return equal(condition);
  return '('+Object.entries(condition).map(([op,v])=>{
   if(op==='$exists')return v?exists:`NOT ${exists}`;
   if(op==='$in'||op==='$nin'){if(scalarKeys.has(key)&&v.every(x=>typeof value(x)==='string')){const expr=`${key==='_id'?'id':'body->>'+lit(key)} IN (SELECT jsonb_array_elements_text(${lit(JSON.stringify(v.map(value)))}::jsonb))`;return op==='$nin'?`NOT COALESCE((${expr}),false)`:expr;}const inner='('+(v.length?v.map(equal).join(' OR '):'FALSE')+')';return op==='$nin'?'NOT '+inner:inner;}
   if(op==='$ne')return 'NOT COALESCE('+equal(v)+',false)';
   if(['$gt','$gte','$lt','$lte'].includes(op))return compare({$gt:'>',$gte:'>=',$lt:'<',$lte:'<='}[op],v);
   if(op==='$regex')return `COALESCE(body#>>${lit('{'+key.split('.').join(',')+'}')}::text[],'') ${condition.$options?.includes('i')?'~*':'~'} ${lit(v)}`;
   if(op==='$options')return 'TRUE';
   throw Error('Unsupported workflow operator '+op);
  }).join(' AND ')+')';
 });return clauses.length?clauses.join(' AND '):'TRUE';
}
async function query(sql){const tx=transactions.getStore();return tx?tx.query(sql):cloudInbox().store.query(sql);}
export async function cloudWorkflowTransaction(operation){
 if(transactions.getStore())return operation();
 const store=cloudInbox().store;
 return store.transaction(async tx=>{
  await tx("SELECT pg_advisory_xact_lock(hashtext('gallabox_private.inbox'));");
  await tx("SELECT set_config('gallabox.workflow_writer','cloud',true);");
  const head=await tx('SELECT row_to_json(h) FROM gallabox_private.inbox_head h WHERE singleton FOR UPDATE;');
  const state={query:tx,revision:Number(head.revision)+1,writes:0};
  const execute=()=>transactions.run(state,operation);
  const result=await (store.withWorkflowReads?store.withWorkflowReads(tx.read,execute):execute());
  if(state.writes){await tx(`UPDATE gallabox_private.inbox_head SET revision=${state.revision},committed_at=now() WHERE singleton; INSERT INTO gallabox_private.inbox_commit(run_id,revision,records,captured_at) VALUES(${lit('workflow:'+randomUUID())},${state.revision},${state.writes},now());`);}
  return result;
 });
}
async function persist(model,document){
 if(!transactions.getStore())return cloudWorkflowTransaction(()=>persist(model,document));
 document.save=()=>persist(model,document);
 await document.validate();document.updatedAt=new Date();document.createdAt ||= document.updatedAt;
 const row=encodeCloudRecord(model.collection.name,document.toObject()),tx=transactions.getStore();tx.revision++;
 await query(`INSERT INTO gallabox_private.inbox_record_history(kind,id,revision,payload,sha256) SELECT kind,id,revision,payload,sha256 FROM gallabox_private.inbox_record WHERE kind=${lit(row.kind)} AND id=${lit(row.id)};
 INSERT INTO gallabox_private.inbox_record(kind,id,body,payload,sha256,revision) VALUES(${lit(row.kind)},${lit(row.id)},${lit(JSON.stringify(row.body))}::jsonb,${lit(row.payload)},${lit(row.sha256)},${tx.revision}) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,payload=excluded.payload,sha256=excluded.sha256,revision=excluded.revision;`);tx.writes++;return document;
}
function hydrate(model,raw){const d=model.hydrate(raw);d.save=()=>persist(model,d);return d;}
function selected(raw,selection){if(!selection)return raw;const fields=typeof selection==='string'?selection.split(/\s+/).filter(Boolean):Object.entries(selection).map(([k,v])=>v?k:'-'+k);const positives=fields.filter(f=>!f.startsWith('-'));if(!positives.length){const r={...raw};for(const f of fields)delete r[f.slice(1)];return r;}const r={_id:raw._id};for(const f of positives){const parts=f.split('.');let from=raw,to=r;for(let i=0;i<parts.length;i++){const p=parts[i];if(from?.[p]===undefined)break;if(i===parts.length-1)to[p]=from[p];else{to[p]||={};to=to[p];from=from[p];}}}return r;}
function builder(model,filter,single=false,mode='find',field){
 const options={sort:{},limit:single?1:null,lean:false,populate:[]};
 const run=async()=>{
  const order=Object.entries(options.sort).map(([k,v])=>`body#>>${lit('{'+k.split('.').join(',')+'}')}::text[] ${v<0?'DESC':'ASC'} NULLS ${v<0?'LAST':'FIRST'}`).join(',');
  if(mode==='distinct')return (await query(`SELECT COALESCE(jsonb_agg(DISTINCT body->${lit(field)}) FILTER(WHERE body->${lit(field)} IS NOT NULL),'[]') FROM gallabox_private.inbox_record WHERE kind=${lit(model.collection.name)} AND (${workflowFilter(filter)});`)).flat();
  if(mode==='count')return Number(await query(`SELECT count(*)::integer FROM gallabox_private.inbox_record WHERE kind=${lit(model.collection.name)} AND (${workflowFilter(filter)});`));
  const rows=await query(`SELECT COALESCE(jsonb_agg(r),'[]') FROM (SELECT kind,id,payload,sha256 FROM gallabox_private.inbox_record WHERE kind=${lit(model.collection.name)} AND (${workflowFilter(filter)}) ${order?'ORDER BY '+order:''} ${options.limit?'LIMIT '+Number(options.limit):''}) r;`);
  let docs=rows.map(decodeCloudRecord);
  if(mode==='count')return docs.length;
  if(mode==='distinct')return [...new Map(docs.flatMap(d=>{const v=d[field];return Array.isArray(v)?v:[v];}).filter(v=>v!==undefined).map(v=>[String(v),v])).values()];
  if(mode==='exists')return docs.length?{_id:docs[0]._id}:null;
  for(const [key,select] of options.populate){
   const ref=model.schema.path(key)?.options.ref;if(!ref)throw Error('Unknown workflow population');
   const ids=[...new Set(docs.map(d=>String(d[key]||'')).filter(Boolean))];let related;
   if(ref==='User'){
    const {sourceStaffUsers}=await import('./customerServiceStaffDirectory.js');related=await sourceStaffUsers(ids);
    const missing=ids.filter(id=>!related.some(u=>String(u._id)===id));
    if(missing.length&&mongoose.connection.readyState===1)related.push(...await mongoose.model(ref).find({_id:{$in:missing}}).select(select||'').lean());
   }else related=await mongoose.model(ref).find({_id:{$in:ids}}).select(select||'').lean();
   const byId=new Map(related.map(d=>[String(d._id),selected(d,select)]));docs=docs.map(d=>({...d,[key]:byId.get(String(d[key]))||null}));
  }
  docs=docs.map(d=>options.lean?selected(d,options.selection):hydrate(model,selected(d,options.selection)));
  return single?docs[0]||null:docs;
 };
 const chain={then:(a,b)=>run().then(a,b),catch:b=>run().catch(b),lean(){options.lean=true;return chain;},session(){return chain;},select(v){options.selection=v;return chain;},sort(v){options.sort=v;return chain;},limit(v){options.limit=v;return chain;},populate(k,s){options.populate.push([k,s]);return chain;},exec:run};return chain;
}
function applyUpdate(doc,update,insert){for(const [op,fields] of Object.entries(update)){for(const [key,v] of Object.entries(fields)){if(op==='$set'||op==='$setOnInsert'&&insert)doc.set(key,v);else if(op==='$inc')doc.set(key,(doc.get(key)||0)+v);else if(op==='$push'){const a=doc.get(key);a.push(...(v?.$each||[v]));}else if(op==='$addToSet')doc.get(key).addToSet(...(v?.$each||[v]));else if(op==='$unset')doc.set(key,undefined);else if(op!=='$setOnInsert')throw Error('Unsupported workflow update '+op);}}}
export function cloudWorkflowModel(model){return new Proxy(model,{get(target,key,receiver){
 if(!cloudWorkflowEnabled())return Reflect.get(target,key,receiver);
 if(key==='find')return f=>builder(model,f);
 if(key==='findOne')return f=>builder(model,f,true);
 if(key==='findById')return id=>builder(model,{_id:id},true);
 if(key==='exists')return f=>builder(model,f,true,'exists');
 if(key==='countDocuments')return f=>builder(model,f,false,'count');
 if(key==='distinct')return (field,f)=>builder(model,f,false,'distinct',field);
 if(key==='create')return async input=>cloudWorkflowTransaction(async()=>{const result=[];for(const row of Array.isArray(input)?input:[input])result.push(await persist(model,new model(row)));return Array.isArray(input)?result:result[0];});
 if(['updateOne','updateMany','findOneAndUpdate'].includes(key))return (filter,update,options={})=>{
  const execute=()=>cloudWorkflowTransaction(async()=>{let docs=await builder(model,filter);if(key!=='updateMany')docs=docs.slice(0,1);let insert=false;if(!docs.length&&options.upsert){insert=true;docs=[new model(Object.fromEntries(Object.entries(filter).filter(([k,v])=>!k.startsWith('$')&&(typeof v!=='object'||v?._bsontype))))];}for(const d of docs){applyUpdate(d,update,insert);await persist(model,d);}return key==='findOneAndUpdate'?docs[0]||null:{matchedCount:insert?0:docs.length,modifiedCount:insert?0:docs.length,upsertedCount:insert?docs.length:0};});
  return {then:(a,b)=>execute().then(a,b),session(){return this;},lean(){return this;}};
 };
 if(key==='aggregate')return async pipeline=>{if(pipeline.length!==2||!pipeline[0].$match||pipeline[1].$group?.count?.$sum!==1)throw Error('Unsupported workflow aggregation');const rows=await builder(model,pipeline[0].$match).lean(),field=pipeline[1].$group._id.slice(1),group=new Map();for(const r of rows){const id=String(r[field]);group.set(id,{_id:r[field],count:(group.get(id)?.count||0)+1});}return [...group.values()];};
 // Fail closed for mutation methods that have not been ported.
 if(/^(delete|replace|insert|bulk|find.*(Delete|Remove|Replace))/.test(String(key)))return ()=>{throw Error('Unsupported cloud workflow mutation');};
 return Reflect.get(target,key,receiver);
 }});}
