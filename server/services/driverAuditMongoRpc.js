import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';

const maxTextBytes=32*1024*1024;
const archiveLimit=60_000_000_000;
const maxRevision=Number.MAX_SAFE_INTEGER;
const keyPattern=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
const eventPattern=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,159}$/;
const uuidPattern=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const objectPattern=/^[a-f0-9]{64}\.(?:gz|json)$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
const options={
  readConcern:{level:'snapshot'},writeConcern:{w:'majority',j:true,wtimeoutMS:10000},
  readPreference:'primary',maxCommitTimeMS:10000,
};
const argumentsFor={
  matter_hosted_state_read:['p_key'],
  matter_hosted_state_read_if_changed:['p_key','p_revision'],
  matter_hosted_state_receipts:['p_key','p_after','p_limit'],
  matter_hosted_state_cas:['p_key','p_expected','p_event_id','p_body_text','p_event_text','p_request_text'],
  matter_hosted_lease_acquire:['p_owner','p_ttl'],
  matter_hosted_lease_assert:['p_owner','p_token'],
  matter_hosted_lease_release:['p_owner','p_token'],
  matter_hosted_collector_cas:['p_owner','p_token','p_expected','p_event_id','p_body_text','p_event_text','p_request_text'],
  matter_hosted_collector_cas_review:['p_owner','p_token','p_expected','p_expected_review_revision','p_event_id','p_body_text','p_event_text','p_request_text'],
  matter_hosted_qualification_lease_acquire:['p_owner','p_ttl'],
  matter_hosted_qualification_lease_assert:['p_owner','p_token'],
  matter_hosted_qualification_lease_release:['p_owner','p_token'],
  matter_hosted_qualification_cas:['p_owner','p_token','p_expected','p_event_id','p_body_text','p_event_text','p_request_text'],
  matter_hosted_archive_capacity:['p_requested_bytes'],
  matter_hosted_archive_reserve:['p_id','p_reserved_bytes'],
  matter_hosted_archive_consume:['p_id','p_operation_id','p_bytes','p_object_key'],
  matter_hosted_archive_release:['p_id'],
  matter_hosted_preview_road_cache:['p_action','p_key','p_owner','p_value'],
};

function failure(message,code='PT409'){
  return Object.assign(Error(message),{code,status:code==='42501'?403:409});
}
function valid(condition,message){
  if(!condition)throw Object.assign(Error(message),{status:400});
}
function integer(value,min=0,max=maxRevision){
  return Number.isSafeInteger(value)&&value>=min&&value<=max;
}
const matches=(pattern,value)=>typeof value==='string'&&pattern.test(value);
const readOptions=session=>session?{session}:{readConcern:{level:'majority'},readPreference:'primary'};
function jsonObject(text,limit=maxTextBytes){
  valid(typeof text==='string'&&Buffer.byteLength(text)<=limit,'Invalid native reporting text');
  let value;
  try{value=JSON.parse(text);}catch{valid(false,'Invalid native reporting JSON');}
  valid(value!==null&&typeof value==='object'&&!Array.isArray(value),'Invalid native reporting document');
  return value;
}
function requestHash(key,request){
  // Existing photo receipts validate this exact PostgreSQL jsonb array text.
  return hash('['+JSON.stringify(key)+', '+JSON.stringify(request)+']');
}
function boundReviewRequest(request,revision){
  return '{"requestText": '+JSON.stringify(request)+', "reviewRevision": '+revision+'}';
}

export async function initializeDriverAuditMongoRpc({db,client}){
  valid(db?.collection&&db?.admin&&client?.startSession,'Native reporting requires MongoDB transactions');
  const hello=await db.admin().command({hello:1});
  valid((typeof hello.setName==='string'||hello.msg==='isdbgrid')&&
    Number.isFinite(hello.logicalSessionTimeoutMinutes),'Native reporting requires a transaction-capable replica set');
  const receipts=db.collection('driverAuditNativeReceipts');
  await receipts.createIndex({key:1,revision:1},{unique:true});
  await receipts.createIndex({key:1,event_id:1},{unique:true});
  await db.collection('driverAuditNativeConsumption').createIndex({reservation_id:1,operation_id:1},{unique:true});
  await db.collection('driverAuditNativeReservations').createIndex({released_at:1});
  await db.collection('driverAuditNativeArchiveControl').updateOne({_id:'total'},{
    $setOnInsert:{used_bytes:0,reserved_bytes:0,write_fence:0},
  },{upsert:true,writeConcern:options.writeConcern});
  for(const name of ['collector','qualification']){
    await db.collection('driverAuditNativeLeases').updateOne({_id:name},{
      $setOnInsert:{owner_id:null,token:0,expires_at:new Date(0),write_fence:0},
    },{upsert:true,writeConcern:options.writeConcern});
  }
  const session=client.startSession();
  try{
    await session.withTransaction(async()=>{
      await db.collection('driverAuditNativeArchiveControl').updateOne({_id:'total'},{$inc:{write_fence:1}},{session});
    },options);
  }finally{await session.endSession();}
  return {transactions:true};
}

export function createDriverAuditMongoRpc({db,client,objects}){
  valid(db?.collection&&client?.startSession&&objects?.putBytes&&objects?.readBytes,
    'Native reporting state and immutable storage are required');
  const documents=db.collection('driverAuditNativeDocuments');
  const receipts=db.collection('driverAuditNativeReceipts');
  const leases=db.collection('driverAuditNativeLeases');
  const reservations=db.collection('driverAuditNativeReservations');
  const consumption=db.collection('driverAuditNativeConsumption');
  const ledger=db.collection('driverAuditNativeArchiveLedger');
  const control=db.collection('driverAuditNativeArchiveControl');
  const roads=db.collection('driverAuditNativeRoadCache');

  async function transaction(operation){
    for(let attempt=0;attempt<3;attempt++){
      const session=client.startSession();
      try{
        let result;
        await session.withTransaction(async()=>{result=await operation(session);},options);
        return result;
      }catch(error){
        // Concurrent first inserts can collide before MongoDB labels a retry.
        if(error.code!==11000||attempt===2)throw error;
      }finally{await session.endSession();}
    }
  }
  async function now(session){
    const result=await control.aggregate([
      {$match:{_id:'total'}},{$project:{_id:0,now:'$$NOW'}},
    ],readOptions(session)).next();
    valid(result?.now instanceof Date,'Native reporting clock is unavailable');
    return result.now;
  }
  async function storeText(text,session){
    return objects.putBytes(gzipSync(Buffer.from(text),{level:6}),{session});
  }
  async function readText(row,field,session){
    let text=row[field+'_text'];
    if(typeof text!=='string'){
      const packed=await objects.readBytes(row[field+'_ref'],{maxBytes:maxTextBytes+1024*1024,session});
      text=gunzipSync(packed,{maxOutputLength:maxTextBytes}).toString('utf8');
    }
    jsonObject(text);
    if(row[field+'_sha256']&&hash(text)!==row[field+'_sha256'])throw Error('Native reporting text integrity failure');
    return text;
  }
  async function stateRead(key,session){
    valid(matches(keyPattern,key),'Invalid native reporting key');
    const row=await documents.findOne({_id:key},readOptions(session));
    if(!row||row.revision===0)return {revision:0,body_text:null};
    valid(integer(row.revision,1),'Invalid native reporting revision');
    return {revision:row.revision,body_text:await readText(row,'body',session)};
  }
  async function receiptResult(row,replayed,session){
    return {revision:row.revision,replayed,event_text:await readText(row,'event',session),
      body_text:await readText(row,'body',session),body_sha256:row.body_sha256};
  }
  function checkCas(args){
    valid(integer(args.p_expected,0,maxRevision-1)&&matches(eventPattern,args.p_event_id),'Invalid native reporting revision request');
    jsonObject(args.p_body_text);
    jsonObject(args.p_event_text);
    jsonObject(args.p_request_text);
  }
  async function cas(key,args,session,signatureRequest=args.p_request_text){
    checkCas(args);
    const signature=requestHash(key,signatureRequest);
    const previous=await receipts.findOne({key,event_id:args.p_event_id},{session});
    if(previous){
      if(previous.request_sha256!==signature)throw failure('Native reporting request identity conflict','23505');
      return receiptResult(previous,true,session);
    }
    const current=await documents.findOne({_id:key},{session});
    if((current?.revision??0)!==args.p_expected)throw failure('Native reporting revision conflict');
    // A staged import proof describes exact saved heads. A new state commit
    // must invalidate that proof and conflict with a concurrent activation.
    await db.collection('driverAuditNativeControl').updateOne({_id:'authority',status:'staging'},
      {$inc:{writeFence:1}},{session});
    const body_ref=await storeText(args.p_body_text,session),event_ref=await storeText(args.p_event_text,session);
    const revision=args.p_expected+1,body_sha256=hash(args.p_body_text),event_sha256=hash(args.p_event_text);
    const saved={revision,body_ref,body_sha256};
    if(current){
      const changed=await documents.updateOne({_id:key,revision:args.p_expected},
        {$set:saved,$unset:{body_text:''}},{session});
      if(changed.matchedCount!==1)throw failure('Native reporting revision conflict');
    }else await documents.insertOne({_id:key,...saved},{session});
    const receipt={key,revision,event_id:args.p_event_id,request_sha256:signature,
      body_sha256,event_sha256,body_ref,event_ref,created_at:await now(session)};
    await receipts.insertOne(receipt,{session});
    return receiptResult(receipt,false,session);
  }
  async function guardReview(revision,session){
    valid(integer(revision,0,maxRevision-1),'Invalid native review revision');
    const current=await documents.findOne({_id:'review-journal'},{session});
    if((current?.revision??0)!==revision)throw failure('Native review revision changed');
    if(!current){
      await documents.insertOne({_id:'review-journal',revision:0,write_fence:1},{session});
      return;
    }
    const result=await documents.updateOne({_id:'review-journal',revision},{$inc:{write_fence:1}},{session});
    if(result.matchedCount!==1)throw failure('Native review revision changed');
  }
  function checkedOwner(args){
    valid(matches(uuidPattern,args.p_owner),'Invalid native lease owner');
    const token=Number(args.p_token);
    valid((typeof args.p_token==='string'||typeof args.p_token==='number')&&integer(token,1),'Invalid native lease token');
    return token;
  }
  async function leaseValid(name,args,session){
    const token=checkedOwner(args);
    const row=await leases.findOne({_id:name,owner_id:args.p_owner,token},readOptions(session));
    return !!row&&row.expires_at>await now(session);
  }
  async function touchLease(name,session){
    const row=await leases.findOneAndUpdate({_id:name},{$inc:{write_fence:1}},
      {session,returnDocument:'after',includeResultMetadata:false});
    valid(row&&integer(row.token)&&row.expires_at instanceof Date,'Native lease metadata is unavailable');
    return row;
  }
  async function leaseAcquire(name,args,session){
    valid(matches(uuidPattern,args.p_owner)&&integer(args.p_ttl,30,900),'Invalid native lease request');
    const row=await touchLease(name,session),time=await now(session);
    if(row.expires_at>time)throw failure('Native reporting lease is busy',name==='collector'?'55P03':'PT409');
    valid(row.token<maxRevision,'Native reporting lease token exhausted');
    const token=row.token+1,expiresAt=new Date(time.getTime()+args.p_ttl*1000);
    await leases.updateOne({_id:name,token:row.token},{$set:{owner_id:args.p_owner,token,expires_at:expiresAt}},{session});
    return {token:String(token),expiresAt:expiresAt.toISOString()};
  }
  async function leaseRelease(name,args,session){
    await touchLease(name,session);
    if(!await leaseValid(name,args,session))return false;
    await leases.updateOne({_id:name},{$set:{expires_at:await now(session)}},{session});
    return true;
  }
  async function fencedCas(name,args,session,reviewGuard=false){
    await touchLease(name,session);
    if(!await leaseValid(name,args,session))throw failure('Native reporting lease expired or changed');
    let key='collector-state',signature=args.p_request_text;
    if(name==='qualification'){
      key='migration-publication-qualification';
      valid(jsonObject(args.p_body_text).diagnosticOnly===true,'Native diagnostic marker required');
    }else if(reviewGuard){
      await guardReview(args.p_expected_review_revision,session);
      signature=boundReviewRequest(args.p_request_text,args.p_expected_review_revision);
    }
    const result=await cas(key,args,session,signature);
    if(!await leaseValid(name,args,session))throw failure('Native reporting lease expired or changed');
    return result;
  }
  async function archiveControl(session){
    const row=await control.findOneAndUpdate({_id:'total'},{$inc:{write_fence:1}},
      {session,returnDocument:'after',includeResultMetadata:false});
    valid(row&&integer(row.used_bytes,0,archiveLimit)&&integer(row.reserved_bytes,0,archiveLimit),
      'Native archive capacity ledger is invalid');
    return row;
  }
  const reservationResult=row=>({id:row._id,reserved_bytes:row.reserved_bytes,
    consumed_bytes:row.consumed_bytes,released:row.released_at!==null});
  async function reserve(args,session){
    valid(matches(uuidPattern,args.p_id)&&integer(args.p_reserved_bytes,1,512*1024*1024),'Invalid native archive reservation');
    const total=await archiveControl(session);
    let row=await reservations.findOne({_id:args.p_id},{session});
    if(row){
      if(row.reserved_bytes!==args.p_reserved_bytes)throw failure('Native archive reservation identity conflict');
    }else{
      if(total.used_bytes+total.reserved_bytes+args.p_reserved_bytes>archiveLimit)throw failure('Native archive capacity unavailable');
      row={_id:args.p_id,reserved_bytes:args.p_reserved_bytes,consumed_bytes:0,held_at:await now(session),released_at:null};
      await reservations.insertOne(row,{session});
      await control.updateOne({_id:'total'},{$inc:{reserved_bytes:args.p_reserved_bytes}},{session});
    }
    return reservationResult(row);
  }
  async function consume(args,session){
    valid(matches(uuidPattern,args.p_id)&&matches(uuidPattern,args.p_operation_id)&&integer(args.p_bytes,1,16*1024*1024),
      'Invalid native archive consumption');
    if(!matches(objectPattern,args.p_object_key))throw failure('Native archive consumption needs an immutable object key');
    await archiveControl(session);
    const row=await reservations.findOne({_id:args.p_id},{session});
    if(!row||row.released_at!==null)throw failure('Native archive reservation is unavailable');
    const prior=await consumption.findOne({reservation_id:args.p_id,operation_id:args.p_operation_id},{session});
    if(prior){
      if(prior.consumed_bytes!==args.p_bytes||prior.object_key!==args.p_object_key)throw failure('Native archive consumption identity conflict');
      return reservationResult(row);
    }
    if(row.consumed_bytes+args.p_bytes>row.reserved_bytes)throw failure('Native archive reservation exhausted');
    const known=await ledger.findOne({_id:args.p_object_key},{session});
    if(known){
      if(known.object_bytes!==args.p_bytes)throw failure('Native archive object size differs');
    }else{
      await ledger.insertOne({_id:args.p_object_key,object_bytes:args.p_bytes,first_recorded_at:await now(session)},{session});
      await control.updateOne({_id:'total'},{$inc:{used_bytes:args.p_bytes}},{session});
    }
    await consumption.insertOne({reservation_id:args.p_id,operation_id:args.p_operation_id,
      consumed_bytes:args.p_bytes,object_key:args.p_object_key,consumed_at:await now(session)},{session});
    row.consumed_bytes+=args.p_bytes;
    await reservations.updateOne({_id:row._id},{$set:{consumed_bytes:row.consumed_bytes}},{session});
    return reservationResult(row);
  }
  async function release(args,session){
    valid(matches(uuidPattern,args.p_id),'Invalid native archive reservation');
    const total=await archiveControl(session);
    const row=await reservations.findOne({_id:args.p_id},{session});
    if(!row)throw failure('Native archive reservation is unavailable');
    if(row.released_at===null){
      valid(total.reserved_bytes>=row.reserved_bytes,'Native archive reservation total differs');
      row.released_at=await now(session);
      await reservations.updateOne({_id:row._id},{$set:{released_at:row.released_at}},{session});
      await control.updateOne({_id:'total'},{$inc:{reserved_bytes:-row.reserved_bytes}},{session});
    }
    return reservationResult(row);
  }
  async function roadCache(args,session){
    valid(['claim','save','release'].includes(args.p_action)&&matches(/^[a-f0-9]{64}$/,args.p_key)&&
      matches(uuidPattern,args.p_owner),'Invalid native road cache request');
    if(args.p_action==='claim'){
      await roads.updateOne({_id:args.p_key},{$setOnInsert:{owner:null,value_text:null,
        lease_until:new Date(0),expires_at:new Date(0)}},{upsert:true,session});
    }
    const row=await roads.findOneAndUpdate({_id:args.p_key},{$inc:{write_fence:1}},
      {session,returnDocument:'after',includeResultMetadata:false});
    if(!row)return {state:args.p_action==='save'?'stale':'released'};
    const time=await now(session);
    if(args.p_action==='claim'){
      if(row.value_text!==null&&row.expires_at>time)return {state:'hit',value:JSON.parse(row.value_text)};
      if(row.value_text===null&&row.lease_until>time)return {state:'busy'};
      await roads.updateOne({_id:args.p_key},{$set:{owner:args.p_owner,value_text:null,
        lease_until:new Date(time.getTime()+30000),expires_at:new Date(time.getTime()+60000)}},{session});
      return {state:'claimed'};
    }
    if(args.p_action==='save'){
      if(row.owner!==args.p_owner||row.lease_until<=time||row.value_text!==null)return {state:'stale'};
      const text=JSON.stringify(args.p_value),value=jsonObject(text,4*1024*1024);
      valid(['ready','partial'].includes(value.status)&&Array.isArray(value.paths),'Invalid native road geometry');
      await roads.updateOne({_id:args.p_key},{$set:{value_text:text,expires_at:new Date(time.getTime()+7*86400000),lease_until:time}},{session});
      return {state:'saved'};
    }
    if(row.owner===args.p_owner&&row.value_text===null)await roads.deleteOne({_id:args.p_key},{session});
    return {state:'released'};
  }

  return async function rpc(name,args){
    if(!Object.hasOwn(argumentsFor,name))throw failure('Native reporting operation is unavailable','42501');
    const allowed=argumentsFor[name];
    valid(args&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).every(key=>allowed.includes(key)),
      'Invalid native reporting arguments');
    args={...args};
    for(const key of ['p_owner','p_id','p_operation_id']){
      if(typeof args[key]==='string')args[key]=args[key].toLowerCase();
    }
    if(['matter_hosted_state_cas','matter_hosted_collector_cas','matter_hosted_collector_cas_review',
      'matter_hosted_qualification_cas'].includes(name))checkCas(args);
    switch(name){
      case 'matter_hosted_state_read': return stateRead(args.p_key);
      case 'matter_hosted_state_read_if_changed': {
        valid(integer(args.p_revision),'Invalid native conditional revision');
        const row=await stateRead(args.p_key);
        const unchanged=row.revision===args.p_revision;
        return {revision:row.revision,unchanged,body_text:unchanged?null:row.body_text};
      }
      case 'matter_hosted_state_receipts': {
        const {p_key,p_after=0,p_limit=1}=args;
        valid(matches(keyPattern,p_key)&&integer(p_after)&&p_limit===1,'Invalid native receipt request');
        const rows=await receipts.find({key:p_key,revision:{$gt:p_after}},readOptions()).sort({revision:1}).limit(1).toArray();
        const result=[];
        for(const row of rows){
          const saved=await receiptResult(row,false);
          result.push({revision:row.revision,event_id:row.event_id,request_sha256:row.request_sha256,
            body_sha256:row.body_sha256,body_text:saved.body_text,event_text:saved.event_text,
            created_at:row.created_at instanceof Date?row.created_at.toISOString():row.created_at});
        }
        return result;
      }
      case 'matter_hosted_state_cas':
        valid(matches(keyPattern,args.p_key),'Invalid native reporting key');
        if(['collector-state','migration-publication-qualification'].includes(args.p_key))throw failure('Native state requires its writer lease','42501');
        return transaction(session=>cas(args.p_key,args,session));
      case 'matter_hosted_lease_acquire': return transaction(session=>leaseAcquire('collector',args,session));
      case 'matter_hosted_lease_assert': return leaseValid('collector',args);
      case 'matter_hosted_lease_release': return transaction(session=>leaseRelease('collector',args,session));
      case 'matter_hosted_collector_cas': return transaction(session=>fencedCas('collector',args,session));
      case 'matter_hosted_collector_cas_review': return transaction(session=>fencedCas('collector',args,session,true));
      case 'matter_hosted_qualification_lease_acquire': return transaction(session=>leaseAcquire('qualification',args,session));
      case 'matter_hosted_qualification_lease_assert': return leaseValid('qualification',args);
      case 'matter_hosted_qualification_lease_release': return transaction(session=>leaseRelease('qualification',args,session));
      case 'matter_hosted_qualification_cas': return transaction(session=>fencedCas('qualification',args,session));
      case 'matter_hosted_archive_capacity':
        valid(integer(args.p_requested_bytes,0,archiveLimit),'Invalid native capacity request');
        return transaction(async session=>{
          const row=await archiveControl(session),used=row.used_bytes+row.reserved_bytes;
          return {used_bytes:used,requested_bytes:args.p_requested_bytes,limit_bytes:archiveLimit,
            allowed:used+args.p_requested_bytes<=archiveLimit};
        });
      case 'matter_hosted_archive_reserve': return transaction(session=>reserve(args,session));
      case 'matter_hosted_archive_consume': return transaction(session=>consume(args,session));
      case 'matter_hosted_archive_release': return transaction(session=>release(args,session));
      case 'matter_hosted_preview_road_cache': return transaction(session=>roadCache(args,session));
    }
  };
}
