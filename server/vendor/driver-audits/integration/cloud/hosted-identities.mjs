// Server-only identity journal. The caller supplies an authenticated hosted actor and trusted dated scope.
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const readers=new Set(['owner','reviewer','viewer']),writers=new Set(['owner','reviewer']);
const fields=new Set(['requestId','revision','recordKeys','personId','vehicle','reason']);
const validDay=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
export function createHostedIdentities({stateStore,config,rows,clock=()=>new Date().toISOString(),key='delivery-identity'}){
 if(!stateStore||typeof rows!=='function'||!config||!validDay(config.date)||!config.sourceAccountId||!config.personId||!config.personName||!Array.isArray(config.recordKeys)||!config.recordKeys.length||new Set(config.recordKeys).size!==config.recordKeys.length||config.recordKeys.some(k=>typeof k!=='string'||!k.startsWith(config.date+'/')||k.length<=config.date.length+1))throw Error('Invalid dated identity scope');
 config=JSON.parse(JSON.stringify(config));const scopeHash=hash(config);
 function access(actor,write=false){if(!actor||typeof actor.id!=='string'||!actor.id||typeof actor.email!=='string'||!actor.email.trim()||!(write?writers:readers).has(actor.role))fail(403,'Staff permission required');}
 async function load(){const value=await stateStore.read(key);let doc;if(value.body===null)doc={config,scopeHash,events:[]};else {try{doc=JSON.parse(value.body);}catch{throw Error('Identity journal invalid');}}
  if(!doc||hash(doc.config)!==scopeHash||doc.scopeHash!==scopeHash||!Array.isArray(doc.events))throw Error('Identity journal scope mismatch');
  for(let i=0;i<doc.events.length;i++){const e=doc.events[i];if(e.revision!==i+1||e.scopeHash!==scopeHash||e.previousHash!==(i?hash(doc.events[i-1]):null))throw Error('Identity journal integrity mismatch');}
  return {value,doc};}
 async function view(doc){const current=await rows();return {scope:'hosted',config,revision:doc.events.length,events:doc.events,deliveries:config.recordKeys.map(key=>{const row=current.find(r=>r.key===key);return {key,customer:row?.delivery?.customer||key.split('/').at(-1),eligible:!!row&&row.date===config.date&&row.delivery?.driver_id===config.sourceAccountId,sourceAccountName:row?.delivery?.driver||null,sourceAccountId:row?.delivery?.driver_id||null};})};}
 return {async read(actor){access(actor);return view((await load()).doc);},async save(input,actor){
  access(actor,true);if(!input||Object.keys(input).some(k=>!fields.has(k))||typeof input.requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId)||!Number.isInteger(input.revision)||!Array.isArray(input.recordKeys)||!input.recordKeys.length||new Set(input.recordKeys).size!==input.recordKeys.length||input.recordKeys.some(k=>!config.recordKeys.includes(k))||input.personId!==config.personId||input.vehicle!==null||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500)fail(400,'Invalid dated confirmation');
  const {value,doc}=await load(),payload={recordKeys:[...input.recordKeys].sort(),personId:input.personId,vehicle:null,reason:input.reason.trim()},requestHash=hash({...payload,actorId:actor.id});
  const existing=doc.events.find(e=>e.requestId===input.requestId);if(existing){if(existing.requestHash!==requestHash)fail(409,'Request identity conflict');return view(doc);}
  const current=await view(doc);if(input.revision!==doc.events.length||payload.recordKeys.some(k=>doc.events.some(e=>e.recordKeys.includes(k))||!current.deliveries.find(d=>d.key===k)?.eligible))fail(409,'Scope or confirmation changed');
  const event={...payload,revision:doc.events.length+1,requestId:input.requestId,requestHash,scopeHash,previousHash:doc.events.length?hash(doc.events.at(-1)):null,date:config.date,sourceAccountId:config.sourceAccountId,sourceAccountName:config.sourceAccountName,personName:config.personName,basis:'User-confirmed actual driver; not a vehicle or photo authorship assertion',actor:{id:actor.id,name:actor.email,role:actor.role},createdAt:clock()};
  const next={...doc,events:[...doc.events,event]},request=JSON.stringify({scopeHash,payload,revision:input.revision,actorId:actor.id});const result=await stateStore.compareAndSwap({key,expectedRevision:value.revision,eventId:input.requestId,body:JSON.stringify(next),event:JSON.stringify(event),request});
  let committed;try{committed=JSON.parse(result.event_text);}catch{throw Error('Invalid committed identity receipt');}if(committed.requestId!==event.requestId||committed.requestHash!==requestHash||committed.scopeHash!==scopeHash)throw Error('Committed identity receipt mismatch');
  return view((await load()).doc);
 }};
}
