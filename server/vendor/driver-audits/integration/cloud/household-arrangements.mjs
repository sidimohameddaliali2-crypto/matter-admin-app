import {createHash} from 'node:crypto';

export const HOUSEHOLD_POLICY='accepted-household-receipt-v1';
export const HOUSEHOLD_KEY='household-arrangements'; // caller supplies the preview namespace
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const nonempty=value=>typeof value==='string'&&value.trim().length>0&&value.length<=2000;
const fail=message=>{throw Error(message);};
export function validateArrangement(a){
 if(!a||!nonempty(a.id)||!Array.isArray(a.customerIds)||a.customerIds.length<2||a.customerIds.length>10||a.customerIds.some(id=>!nonempty(id))||new Set(a.customerIds).size!==a.customerIds.length||!nonempty(a.unitKey)||!date(a.effectiveFrom)||a.effectiveTo!==null&&(!date(a.effectiveTo)||a.effectiveTo<a.effectiveFrom)||a.acceptPartnerReceipt!==true||a.maxUploadGapSeconds!==600||!nonempty(a.sourceRef)||!/^[a-f0-9]{64}$/.test(a.sourceSha256||'')||!nonempty(a.acceptedBy)||!nonempty(a.acceptedAt)||!Number.isFinite(Date.parse(a.acceptedAt)))fail('Invalid household arrangement');
 if(a.unitKeysByCustomer!==undefined){
  const entries=Object.entries(a.unitKeysByCustomer||{});
  if(Array.isArray(a.unitKeysByCustomer)||entries.length!==a.customerIds.length||entries.some(([id,keys])=>!a.customerIds.includes(id)||!Array.isArray(keys)||keys.length<1||keys.length>4||keys.some(k=>!nonempty(k))||new Set(keys).size!==keys.length)||!entries.some(([,keys])=>keys.includes(a.unitKey)))fail('Invalid household address variants');
 }
 if(a.timingIssues!==undefined&&(!Array.isArray(a.timingIssues)||!a.timingIssues.length||new Set(a.timingIssues).size!==a.timingIssues.length||a.timingIssues.some(x=>!["Early upload","Late upload"].includes(x))))fail("Invalid household timing scope");
 return a;
}
export function activeArrangements(document){
 if(!document||document.version!==1||!Array.isArray(document.events))fail('Invalid household journal');
 const latest=new Map(),ids=new Set();
 for(const e of document.events){
  if(!e||!nonempty(e.eventId)||ids.has(e.eventId)||!nonempty(e.at)||!nonempty(e.actor)||!['save','revoke'].includes(e.action))fail('Invalid household event');
  ids.add(e.eventId);
  if(e.action==='save'){validateArrangement(e.arrangement);latest.set(e.arrangement.id,e.arrangement);}
  else {if(!nonempty(e.arrangementId)||!nonempty(e.reason))fail('Invalid household revocation');latest.delete(e.arrangementId);}
 }
 return [...latest.values()];
}
export function createHouseholdStore(state){
 return {
  async read(){const value=await state.read(HOUSEHOLD_KEY),document=value.body===null?{version:1,events:[]}:JSON.parse(value.body);return {revision:value.revision,document,arrangements:activeArrangements(document)};},
  async append(event,expectedRevision){
   const prior=await this.read(),existing=prior.document.events.find(e=>e.eventId===event.eventId);
   if(existing){if(JSON.stringify(existing)!==JSON.stringify(event))throw Error('Household retry identity conflict');return {revision:prior.revision,replayed:true};}
   if(prior.revision!==expectedRevision)throw Error('Household revision conflict');
   const document={version:1,events:[...prior.document.events,event]};activeArrangements(document);
   const receipt=await state.compareAndSwap({key:HOUSEHOLD_KEY,expectedRevision,eventId:event.eventId,body:JSON.stringify(document),event:JSON.stringify(event),request:JSON.stringify({expectedRevision,event})});
   if(receipt.body_text!==JSON.stringify(document)||receipt.event_text!==JSON.stringify(event))throw Error('Household save receipt mismatch');
   return {revision:receipt.revision,replayed:receipt.replayed};
  }
 };
}
const driver=d=>d.driver_id?'id:'+d.driver_id:d.driver?'recorded:'+d.driver:null;
const clock=value=>typeof value==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
// Explicitly accepted address spellings belong to individual accounts. They
// never normalize other customers, whole buildings or unrelated apartments.
const matchesAddress=(rule,address)=>rule.unitKeysByCustomer
 ?rule.unitKeysByCustomer[address.customerId]?.includes(address.identity.unitKey)
 :address.identity.unitKey===rule.unitKey;
function boundAddress(row,index){
 const a=index.records[row.key]?.addressStop;
 return a?.recordKey===row.key&&a.assessmentHash===row.assessmentHash&&a.deliverySourceSha256===row.delivery.source_sha256&&a.state==='apartment_identified'&&a.customerId&&a.identity?.unitKey?a:null;
}
// Owner-accepted receipt arrangements explain timing, never assert handover or
// change an original clock. No name/proximity inference and no GPS fabrication.
export function householdResolutions(rows,index,arrangements){
 arrangements.forEach(validateArrangement);
 const byKey=new Map(rows.map(r=>[r.key,r])),result=new Map();
 for(const row of rows){
  const own=boundAddress(row,index);if(!own)continue;
  const rules=arrangements.filter(a=>a.customerIds.includes(own.customerId)&&matchesAddress(a,own)&&row.date>=a.effectiveFrom&&(!a.effectiveTo||row.date<=a.effectiveTo));
  if(rules.length!==1)continue; // overlapping instructions require correction
  const rule=rules[0],d=row.delivery,upload=clock(d.upload);
  if(upload===null||!driver(d)||d.earliest_delivery_evidence?.customerRestriction===true)continue;
  const peers=rows.filter(p=>p.key!==row.key&&p.date===row.date);
  for(const peer of peers){
   const a=boundAddress(peer,index),p=peer.delivery,start=clock(p.window_start),end=clock(p.deadline),otherUpload=clock(p.upload);
   const sharedStop=own.stopId&&a?.stopId===own.stopId&&own.stopMembers?.includes(peer.key)&&a?.stopMembers?.includes(row.key);
   const sharedAccount=!d.vehicle&&!p.vehicle&&d.driver_id&&p.driver_id===d.driver_id;
   if(!a||a.customerId===own.customerId||!rule.customerIds.includes(a.customerId)||!matchesAddress(rule,a)||peer.date!==row.date||!sharedStop&&!sharedAccount||d.vehicle&&p.vehicle&&p.vehicle!==d.vehicle||driver(p)!==driver(d)||start===null||end===null||start>end||otherUpload===null||Math.abs(otherUpload-upload)>rule.maxUploadGapSeconds*1000||upload<start||upload>end||otherUpload<start||otherUpload>end)continue;
   result.set(row.key,{policy:HOUSEHOLD_POLICY,arrangementId:rule.id,arrangementHash:sha(rule),timingIssues:rule.timingIssues||["Early upload"],receivingRecordKey:peer.key,receivingWindowStart:p.window_start,receivingWindowEnd:p.deadline,recordKey:row.key,assessmentHash:row.assessmentHash,deliverySourceSha256:d.source_sha256,partnerRecordKey:peer.key,partnerAssessmentHash:peer.assessmentHash,partnerSourceSha256:p.source_sha256,stopId:sharedStop?own.stopId:sha([row.date,rule.unitKey,driver(d),...[row.key,peer.key].sort()]),stopBasis:sharedStop?'saved_stop_group':'same_driver_account_apartment_and_upload_batch',acceptedBy:rule.acceptedBy,sourceRef:rule.sourceRef,sourceSha256:rule.sourceSha256,physicalDeliveryConfirmed:false});break;
  }
 }
 return result;
}
