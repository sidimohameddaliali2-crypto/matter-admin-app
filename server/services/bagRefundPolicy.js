import {createHash} from 'node:crypto';
export const BAG_DEPOSIT_MINOR=15500;
export const refundFault=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const id=value=>String(value?._id??value??'');
const customerOf=event=>event.before?.assignedTo?.customer||event.assignedTo?.customer;

// GET derives the queue without creating records. Pair receipt with collection
// so moving a collected bag into warehouse cannot create a second refund.
export function bagReturnSources(bag){
  const sources=new Map();let collection=null,returned=null;
  for(const event of bag.history||[]){
    if(['pack','accept','deliver'].includes(event.eventType))returned=null;
    if(event.eventType==='deliver'){collection=null;continue;}
    if(!event.eventId||!event.assignedBy?.user)continue;
    if(event.eventType==='quarantine'&&returned){returned.receivedDamaged=true;returned.damageEventId=event.eventId;continue;}
    const customer=customerOf(event);
    if(!customer?.customerId)continue;
    if(event.eventType==='collect'&&event.location==='driver'){
      returned=null;collection={recordId:id(bag._id),bagId:bag.bagId,customerId:customer.customerId,customerName:customer.customerName||customer.customerId,returnKey:`${id(bag._id)}:${event.eventId}`,collectedAt:event.timestamp,collectionEventId:event.eventId,receiptEventId:null};
      sources.set(collection.returnKey,collection);
    }else if(event.eventType==='receive'&&event.location==='warehouse'){
      const entry=collection?.customerId===customer.customerId?collection:{recordId:id(bag._id),bagId:bag.bagId,customerId:customer.customerId,customerName:customer.customerName||customer.customerId,returnKey:`${id(bag._id)}:${event.eventId}`};
      returned={...entry,receiptEventId:event.eventId,receivedAt:event.timestamp,receivedDamaged:event.lifecycleState==='quarantined',damageEventId:''};sources.set(entry.returnKey,returned);collection=null;
    }
  }
  return [...sources.values()];
}
export function refundCandidates(bags,cases){
  const used=new Set(cases.flatMap(c=>(c.bags||[]).map(b=>b.returnKey)));
  const activeCustomers=new Set(cases.filter(c=>c.active).map(c=>c.customerId));
  const groups=new Map();
  for(const bag of bags){
    // Old exchanges stay in history, rather than becoming presumed debt.
    const latest=new Map();for(const source of bagReturnSources(bag))latest.set(source.customerId,source);
    for(const source of latest.values()){
      if(used.has(source.returnKey)||activeCustomers.has(source.customerId))continue;
      if(!groups.has(source.customerId))groups.set(source.customerId,{customerId:source.customerId,customerName:source.customerName,amountMinor:BAG_DEPOSIT_MINOR,bags:[]});
      groups.get(source.customerId).bags.push(source);
    }
  }
  return [...groups.values()];
}
export function refundEligibility(refund,bags){
  const blockers=[];
  if(!refund.endEvidence)blockers.push('Confirm this is the final subscription return.');
  if(refund.amountMinor!==BAG_DEPOSIT_MINOR)blockers.push('The recorded deposit must be AED 155.');
  if(!refund.bags?.length)blockers.push('No return bags linked.');
  const linked=new Set((refund.bags||[]).map(b=>b.returnKey));
  for(const bag of bags){
    const latest=bagReturnSources(bag).filter(s=>s.customerId===refund.customerId).at(-1);
    if(latest&&!linked.has(latest.returnKey)&&refund.createdAt&&new Date(latest.receivedAt||latest.collectedAt)>=new Date(refund.createdAt))blockers.push(`${bag.bagId}: a newer return must be added to this case.`);
  }
  for(const bag of bags.filter(b=>b.assignedTo?.customer?.customerId===refund.customerId))blockers.push(`${bag.bagId}: still associated with this customer; reconcile or receive it first.`);
  const items=(refund.bags||[]).map(entry=>{
    const bag=bags.find(b=>id(b._id)===id(entry.recordId));
    const source=bag&&bagReturnSources(bag).find(s=>s.returnKey===entry.returnKey&&s.customerId===refund.customerId);
    const inspection=(refund.inspections||[]).find(i=>id(i.recordId)===id(entry.recordId)&&source?.receiptEventId&&i.receiptEventId===source.receiptEventId&&(i.damageEventId||'')===(source.damageEventId||''));
    if(!source?.receiptEventId)blockers.push(`${entry.bagId}: awaiting warehouse receipt.`);
    else if(!inspection)blockers.push(`${entry.bagId}: awaiting return inspection.`);
    else if(source.receivedDamaged&&inspection.outcome!=='damaged')blockers.push(`${entry.bagId}: damage evidence needs a revised inspection.`);
    return {...(source||entry),recordId:id(entry.recordId),inspection:inspection||null};
  });
  const damaged=items.some(i=>i.inspection?.outcome==='damaged');
  const fingerprint=createHash('sha256').update(JSON.stringify({customerId:refund.customerId,amountMinor:refund.amountMinor,endEvidence:refund.endEvidence,items:items.map(i=>({returnKey:i.returnKey,receipt:i.receiptEventId||null,inspection:i.inspection?{outcome:i.inspection.outcome,note:i.inspection.note,timestamp:i.inspection.timestamp}:null}))})).digest('hex');
  return {eligible:!blockers.length,blockers,items,damaged,amountMinor:BAG_DEPOSIT_MINOR,fingerprint,stage:items.some(i=>!i.receiptEventId)?'awaiting_warehouse':items.some(i=>!i.inspection)?'awaiting_inspection':blockers.length?'review_required':'ready_for_approval'};
}
export function requireRefundApproval(refund,bags){
  const eligibility=refundEligibility(refund,bags);
  if(!eligibility.eligible)throw refundFault(eligibility.blockers.join(' '));
  if(refund.status!=='approved'||refund.approval?.fingerprint!==eligibility.fingerprint)throw refundFault('Current return evidence needs management approval.');
  return eligibility;
}
