import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {after,before,test} from 'node:test';
import {MongoClient} from 'mongodb';
import {createDriverAuditMongoArchive} from './driverAuditMongoArchive.js';
import {verifyDriverAuditMongoAuthority} from './driverAuditMongoImport.js';
import {createDriverAuditMongoRpc,initializeDriverAuditMongoRpc} from './driverAuditMongoRpc.js';

const uri=process.env.MONGO_TEST_URI;
const skip=!uri;
const hash=value=>createHash('sha256').update(value).digest('hex');
let client;

before(async()=>{
  if(uri){
    assert(/^mongodb:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?\//.test(uri),
      'Native reporting tests require a local isolated MongoDB replica set');
    client=new MongoClient(uri,{maxPoolSize:8,serverSelectionTimeoutMS:5000});
    await client.connect();
  }
});
after(async()=>{await client?.close();});

async function fixture(t){
  const name='driver_audit_rpc_test_'+randomUUID().replaceAll('-','');
  const db=client.db(name);
  t.after(async()=>{await db.dropDatabase();});
  await initializeDriverAuditMongoRpc({db,client});
  const objects=createDriverAuditMongoArchive({db,client,capacityBytes:64*1024*1024});
  return {db,objects,rpc:createDriverAuditMongoRpc({db,client,objects})};
}

const stateArgs=(key,{expected=0,eventId=randomUUID(),body='{"saved":true}',event='{"kind":"test"}',request='{"event":"same"}'}={})=>({
  p_key:key,p_expected:expected,p_event_id:eventId,p_body_text:body,p_event_text:event,p_request_text:request,
});
const owner=()=>randomUUID();
const leaseArgs=(id,lease)=>({p_owner:id,p_token:lease.token});

test('native RPC rejects missing keys, request identity and unsupported operations before access',async()=>{
  const rpc=createDriverAuditMongoRpc({db:{collection:()=>({})},
    client:{startSession(){throw Error('Unexpected transaction');}},objects:{putBytes(){},readBytes(){}}});
  await assert.rejects(rpc('matter_hosted_state_read',{}),{status:400});
  await assert.rejects(rpc('matter_hosted_state_read',{p_key:['example']}),{status:400});
  await assert.rejects(rpc('matter_hosted_lease_assert',{p_owner:[owner()],p_token:'1'}),{status:400});
  await assert.rejects(rpc('matter_hosted_state_cas',{...stateArgs('example'),p_event_id:undefined}),{status:400});
  await assert.rejects(rpc('matter_hosted_membership_lookup',{}),{code:'42501',status:403});
  await assert.rejects(rpc('constructor',{}),{code:'42501',status:403});
});

test('native state preserves exact receipt bytes, PostgreSQL retry identity and conditional reads',{skip},async t=>{
  const {rpc,db}=await fixture(t);
  assert.deepEqual(await rpc('matter_hosted_state_read',{p_key:'review-journal'}),{revision:0,body_text:null});
  const args=stateArgs('review-journal',{body:'{ "saved": true, "note": "✓" }'});
  const committed=await rpc('matter_hosted_state_cas',args);
  assert.equal(committed.revision,1);
  assert.equal(committed.replayed,false);
  assert.equal(committed.body_text,args.p_body_text);
  assert.equal(committed.body_sha256,hash(args.p_body_text));
  const replay=await rpc('matter_hosted_state_cas',{...args,p_body_text:'{"different":true}'});
  assert.equal(replay.replayed,true);
  assert.equal(replay.body_text,args.p_body_text);
  const rows=await rpc('matter_hosted_state_receipts',{p_key:'review-journal',p_after:0,p_limit:1});
  assert.equal(rows.length,1);
  // These signatures were independently read from the restored PostgreSQL functions.
  assert.equal(rows[0].request_sha256,'67fc079fceb6fdf467ce1c2a1a7296a241ee8a14c898686982ded8720a91887d');
  assert.equal(rows[0].event_text,args.p_event_text);
  assert.deepEqual(await rpc('matter_hosted_state_read_if_changed',{p_key:'review-journal',p_revision:1}),
    {revision:1,unchanged:true,body_text:null});
  assert.deepEqual(await rpc('matter_hosted_state_read_if_changed',{p_key:'review-journal',p_revision:0}),
    {revision:1,unchanged:false,body_text:args.p_body_text});
  assert.equal(await db.collection('driverAuditNativeReceipts').countDocuments(),1);
  await assert.rejects(rpc('matter_hosted_state_cas',{...args,p_request_text:'{"event":"changed"}'}),{code:'23505',status:409});
  await assert.rejects(rpc('matter_hosted_state_cas',stateArgs('review-journal')),{code:'PT409',status:409});
});

test('concurrent identical requests replay once and competing revisions have one winner',{skip},async t=>{
  const {rpc,db}=await fixture(t);
  const shared=stateArgs('same-retry');
  const retries=await Promise.all([rpc('matter_hosted_state_cas',shared),rpc('matter_hosted_state_cas',shared)]);
  assert.deepEqual(retries.map(row=>row.replayed).sort(),[false,true]);
  const competing=await Promise.allSettled([rpc('matter_hosted_state_cas',stateArgs('competing')),
    rpc('matter_hosted_state_cas',stateArgs('competing'))]);
  assert.equal(competing.filter(row=>row.status==='fulfilled').length,1);
  assert.equal(competing.find(row=>row.status==='rejected').reason.code,'PT409');
  assert.equal(await db.collection('driverAuditNativeReceipts').countDocuments({key:'competing'}),1);
});

test('imported original state and receipt text replays with its retained request hash',{skip},async t=>{
  const {rpc,db}=await fixture(t);
  const args=stateArgs('review-journal',{body:'{ "original": true }'});
  await db.collection('driverAuditNativeDocuments').insertOne({_id:args.p_key,revision:1,body_text:args.p_body_text});
  await db.collection('driverAuditNativeReceipts').insertOne({key:args.p_key,revision:1,event_id:args.p_event_id,
    request_sha256:'67fc079fceb6fdf467ce1c2a1a7296a241ee8a14c898686982ded8720a91887d',
    body_sha256:hash(args.p_body_text),body_text:args.p_body_text,event_text:args.p_event_text,created_at:new Date()});
  const replay=await rpc('matter_hosted_state_cas',args);
  assert.equal(replay.replayed,true);
  assert.equal(replay.body_text,args.p_body_text);
  assert.equal((await rpc('matter_hosted_state_read',{p_key:args.p_key})).body_text,args.p_body_text);
  assert.equal(await db.collection('driverAuditNativeChunks').countDocuments(),0);
});

test('collector leases reject busy owners, retain fencing tokens and guard review revisions',{skip},async t=>{
  const {rpc,db}=await fixture(t),id=owner(),other=owner();
  const lease=await rpc('matter_hosted_lease_acquire',{p_owner:id.toUpperCase(),p_ttl:30});
  assert.equal(lease.token,'1');
  assert(Number.isFinite(Date.parse(lease.expiresAt)));
  await assert.rejects(rpc('matter_hosted_lease_acquire',{p_owner:other,p_ttl:30}),{code:'55P03',status:409});
  assert.equal(await rpc('matter_hosted_lease_assert',leaseArgs(id,lease)),true);
  assert.equal(await rpc('matter_hosted_lease_release',leaseArgs(other,lease)),false);
  const {p_key,...publication}=stateArgs('collector-state',{body:'{"head":"prior"}'});
  const request={...publication,...leaseArgs(id,lease),p_expected_review_revision:0};
  assert.equal((await rpc('matter_hosted_collector_cas_review',request)).revision,1);
  const [receipt]=await rpc('matter_hosted_state_receipts',{p_key:'collector-state',p_after:0,p_limit:1});
  assert.equal(receipt.request_sha256,'985ff0ab4360754af367269edd734f5233caccb1ff078a91c2dbbd61793cf2e3');
  await rpc('matter_hosted_state_cas',stateArgs('review-journal'));
  await assert.rejects(rpc('matter_hosted_collector_cas_review',{...request,p_expected:1,p_event_id:randomUUID()}),
    {code:'PT409',status:409});
  assert.equal(JSON.parse((await rpc('matter_hosted_state_read',{p_key:'collector-state'})).body_text).head,'prior');
  await db.collection('driverAuditNativeLeases').updateOne({_id:'collector'},{$set:{expires_at:new Date(0)}});
  const next=await rpc('matter_hosted_lease_acquire',{p_owner:other,p_ttl:30});
  assert.equal(next.token,'2');
  assert.equal(await rpc('matter_hosted_lease_assert',leaseArgs(id,lease)),false);
  await assert.rejects(rpc('matter_hosted_collector_cas',{...publication,...leaseArgs(id,lease)}),{code:'PT409',status:409});
});

test('archive consumption is idempotent per operation and charges a shared key once',{skip},async t=>{
  const {rpc,db}=await fixture(t),id=randomUUID(),second=randomUUID(),key='a'.repeat(64)+'.gz';
  const reserve=()=>rpc('matter_hosted_archive_reserve',{p_id:id,p_reserved_bytes:4096});
  assert.deepEqual(await reserve(),{id,reserved_bytes:4096,consumed_bytes:0,released:false});
  const consume={p_id:id,p_operation_id:randomUUID(),p_bytes:1024,p_object_key:key};
  assert.equal((await rpc('matter_hosted_archive_consume',consume)).consumed_bytes,1024);
  assert.equal((await rpc('matter_hosted_archive_consume',consume)).consumed_bytes,1024);
  await assert.rejects(rpc('matter_hosted_archive_consume',{...consume,p_bytes:1025}),{code:'PT409',status:409});
  await rpc('matter_hosted_archive_reserve',{p_id:second,p_reserved_bytes:2048});
  await rpc('matter_hosted_archive_consume',{...consume,p_id:second,p_operation_id:randomUUID()});
  const capacity=await rpc('matter_hosted_archive_capacity',{p_requested_bytes:0});
  assert.equal(capacity.used_bytes,1024+4096+2048);
  await rpc('matter_hosted_archive_release',{p_id:id});
  await rpc('matter_hosted_archive_release',{p_id:id});
  await rpc('matter_hosted_archive_release',{p_id:second});
  assert.equal((await rpc('matter_hosted_archive_capacity',{p_requested_bytes:0})).used_bytes,1024);
  assert.equal(await db.collection('driverAuditNativeConsumption').countDocuments(),2);
  assert.equal(await db.collection('driverAuditNativeArchiveLedger').countDocuments(),1);
  assert.equal((await reserve()).released,true);
  await assert.rejects(rpc('matter_hosted_archive_consume',{...consume,p_operation_id:randomUUID()}),{code:'PT409',status:409});
});

test('archive capacity admission cannot oversubscribe the final available bytes',{skip},async t=>{
  const {rpc,db}=await fixture(t);
  await db.collection('driverAuditNativeArchiveControl').updateOne({_id:'total'},{$set:{used_bytes:60_000_000_000-150}});
  const attempts=await Promise.allSettled([rpc('matter_hosted_archive_reserve',{p_id:randomUUID(),p_reserved_bytes:100}),
    rpc('matter_hosted_archive_reserve',{p_id:randomUUID(),p_reserved_bytes:100})]);
  assert.equal(attempts.filter(row=>row.status==='fulfilled').length,1);
  assert.equal(attempts.find(row=>row.status==='rejected').reason.code,'PT409');
  assert.equal((await rpc('matter_hosted_archive_capacity',{p_requested_bytes:51})).allowed,false);
});

test('diagnostic writes use an independent lease and keep the canonical state fenced',{skip},async t=>{
  const {rpc}=await fixture(t),id=owner();
  await assert.rejects(rpc('matter_hosted_state_cas',stateArgs('collector-state')),{code:'42501'});
  await assert.rejects(rpc('matter_hosted_state_cas',stateArgs('migration-publication-qualification')),{code:'42501'});
  const lease=await rpc('matter_hosted_qualification_lease_acquire',{p_owner:id,p_ttl:60});
  const {p_key,...args}=stateArgs('migration-publication-qualification',{body:'{"diagnosticOnly":true}'});
  assert.equal((await rpc('matter_hosted_qualification_cas',{...args,...leaseArgs(id,lease)})).revision,1);
  assert.deepEqual(await rpc('matter_hosted_state_read',{p_key:'collector-state'}),{revision:0,body_text:null});
  assert.equal(await rpc('matter_hosted_qualification_lease_assert',leaseArgs(id,lease)),true);
  assert.equal(await rpc('matter_hosted_qualification_lease_release',leaseArgs(id,lease)),true);
});

test('state payloads above the BSON limit round trip through immutable byte references',{skip},async t=>{
  const {rpc,db}=await fixture(t);
  const body=JSON.stringify({large:'retained'.repeat(2_300_000)});
  assert(Buffer.byteLength(body)>16*1024*1024);
  await rpc('matter_hosted_state_cas',stateArgs('large-state',{body}));
  assert.equal((await rpc('matter_hosted_state_read',{p_key:'large-state'})).body_text,body);
  const row=await db.collection('driverAuditNativeDocuments').findOne({_id:'large-state'});
  assert.equal(typeof row.body_text,'undefined');
  assert.equal(row.body_sha256,hash(body));
  assert(row.body_ref.size<Buffer.byteLength(body));
});

test('a failed immutable event write rolls back its state, receipt and chunk allocation',{skip},async t=>{
  const {rpc,db,objects}=await fixture(t);
  let puts=0;
  const failing=createDriverAuditMongoRpc({db,client,objects:{...objects,async putBytes(bytes,options){
    const reference=await objects.putBytes(bytes,options);
    if(++puts===2)throw Error('Injected immutable write failure');
    return reference;
  }}});
  const args=stateArgs('failure-recovery');
  await assert.rejects(failing('matter_hosted_state_cas',args),/Injected immutable write failure/);
  assert.equal(await db.collection('driverAuditNativeDocuments').countDocuments(),0);
  assert.equal(await db.collection('driverAuditNativeReceipts').countDocuments(),0);
  assert.equal(await db.collection('driverAuditNativeChunks').countDocuments(),0);
  assert.equal((await objects.status()).usedBytes,0);
  assert.equal((await rpc('matter_hosted_state_cas',args)).revision,1);
});

test('a review committed after a publication snapshot prevents a stale guarded publication',{skip},async t=>{
  const {rpc,db,objects}=await fixture(t),id=owner();
  const lease=await rpc('matter_hosted_lease_acquire',{p_owner:id,p_ttl:60});
  const {p_key,...initial}=stateArgs('collector-state',{body:'{"head":"original"}'});
  await rpc('matter_hosted_collector_cas',{...initial,...leaseArgs(id,lease)});
  let acknowledge,release,paused=false;
  const observed=new Promise(resolve=>{acknowledge=resolve;});
  const resume=new Promise(resolve=>{release=resolve;});
  const collection=db.collection('driverAuditNativeDocuments');
  const wrapped=new Proxy(collection,{get(target,key){
    if(key==='findOne')return async(filter,options)=>{
      const row=await target.findOne(filter,options);
      if(filter._id==='review-journal'&&options?.session&&!paused){
        paused=true;
        acknowledge();
        await resume;
      }
      return row;
    };
    const value=target[key];
    return typeof value==='function'?value.bind(target):value;
  }});
  const competing=createDriverAuditMongoRpc({db:{collection:name=>name==='driverAuditNativeDocuments'?wrapped:db.collection(name)},client,objects});
  const {p_key:unused,...next}=stateArgs('collector-state',{expected:1,body:'{"head":"stale"}'});
  const outcome=competing('matter_hosted_collector_cas_review',{...next,...leaseArgs(id,lease),p_expected_review_revision:0})
    .then(value=>({value}),error=>({error}));
  await observed;
  try{await rpc('matter_hosted_state_cas',stateArgs('review-journal'));}
  finally{release();}
  assert.equal((await outcome).error?.code,'PT409');
  assert.equal((await rpc('matter_hosted_state_read',{p_key:'collector-state'})).body_text,initial.p_body_text);
  assert.equal((await rpc('matter_hosted_state_read',{p_key:'review-journal'})).revision,1);
});

test('a review saved during import verification invalidates the activation proof',{skip},async t=>{
  const {rpc,db}=await fixture(t),id=owner(),importSha256='a'.repeat(64);
  const lease=await rpc('matter_hosted_lease_acquire',{p_owner:id,p_ttl:60});
  const {p_key,...head}=stateArgs('collector-state');
  await rpc('matter_hosted_collector_cas',{...head,...leaseArgs(id,lease)});
  await rpc('matter_hosted_state_cas',stateArgs('review-journal'));
  const original=[];
  for(const key of ['collector-state','review-journal']){
    const row=await rpc('matter_hosted_state_read',{p_key:key});
    original.push({key,...row});
  }
  await db.collection('driverAuditNativeControl').insertOne({_id:'authority',status:'staging',importSha256,writeFence:0});
  await assert.rejects(verifyDriverAuditMongoAuthority({db,rpc,original,importSha256,async verifyResults(){
    await rpc('matter_hosted_state_cas',stateArgs('review-journal',{expected:1,body:'{"newReview":true}'}));
    return {verified:true,resultsEqual:true,gpsEqual:true,reviewHistoryEqual:true,photosEqual:true};
  }}),/changed during verification/);
  const gate=await db.collection('driverAuditNativeControl').findOne({_id:'authority'});
  assert.equal(gate.writeFence,1);
  assert.equal(gate.paritySha256,undefined);
  assert.equal((await rpc('matter_hosted_state_read',{p_key:'review-journal'})).revision,2);
});

test('road geometry claims preserve owners, cache hits and expiry without touching review journals',{skip},async t=>{
  const {rpc,db}=await fixture(t),id=owner(),other=owner(),key='b'.repeat(64);
  const call=(p_action,p_owner=id,p_value=null)=>rpc('matter_hosted_preview_road_cache',{p_action,p_key:key,p_owner,p_value});
  assert.deepEqual(await call('claim'),{state:'claimed'});
  assert.deepEqual(await call('claim',other),{state:'busy'});
  assert.deepEqual(await call('save',other,{status:'ready',paths:[]}),{state:'stale'});
  const value={status:'ready',paths:[]};
  assert.deepEqual(await call('save',id,value),{state:'saved'});
  assert.deepEqual(await call('claim',other),{state:'hit',value});
  await call('release');
  assert.deepEqual(await call('claim',other),{state:'hit',value});
  await db.collection('driverAuditNativeRoadCache').updateOne({_id:key},{$set:{expires_at:new Date(0)}});
  assert.deepEqual(await call('claim',other),{state:'claimed'});
  await db.collection('driverAuditNativeRoadCache').updateOne({_id:key},{$set:{lease_until:new Date(0)}});
  assert.deepEqual(await call('save',other,value),{state:'stale'});
  assert.equal(await db.collection('driverAuditNativeReceipts').countDocuments(),0);
  const missing={p_key:'c'.repeat(64),p_owner:id};
  assert.deepEqual(await rpc('matter_hosted_preview_road_cache',{...missing,p_action:'release'}),{state:'released'});
  assert.deepEqual(await rpc('matter_hosted_preview_road_cache',{...missing,p_action:'save',p_value:null}),{state:'stale'});
  assert.equal(await db.collection('driverAuditNativeRoadCache').countDocuments({_id:missing.p_key}),0);
});
