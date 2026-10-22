import {createHash} from 'node:crypto';
import {normalizeBagId} from './bagInventoryAudit.js';
const id=value=>String(value?._id??value??'');
const validDate=value=>value&&Number.isFinite(new Date(value).getTime())?new Date(value):null;
const name=user=>[user?.profile?.firstName,user?.profile?.lastName].filter(Boolean).join(' ')||user?.name||'Unknown staff';
export function customerBagBalances(bags,followups=[],users=[],now=new Date()){
  const groups=new Map(),staff=new Map(users.map(u=>[id(u._id),u])),saved=new Map(followups.map(f=>[f.customerId,f]));
  for(const bag of bags){
    const customer=bag.assignedTo?.customer;if(!customer?.customerId)continue;
    if(!groups.has(customer.customerId))groups.set(customer.customerId,{customerId:customer.customerId,customerName:customer.customerName||customer.customerId,bags:[],confirmed:0,collected:0,ambiguous:0,outstanding:[],overdueBags:[]});
    const group=groups.get(customer.customerId);group.bags.push(bag.bagId);
    const state=bag.lifecycleState||'legacy_unverified';
    if(state==='collected'&&bag.verifiedAt){group.collected++;continue;}
    // Warehouse-received stock is no longer a customer liability. Unresolved
    // legacy links remain a review signal, never confirmed physical holdings.
    if(['received','cleaning','ready','packed','quarantined','retired'].includes(state))continue;
    const confirmed=state==='with_customer'&&bag.location==='customer'&&!!bag.verifiedAt&&bag.quantity===1;
    if(confirmed)group.confirmed++;else group.ambiguous++;
    group.outstanding.push(bag);
    const due=validDate(bag.assignedTo?.expectedReturn);
    if(confirmed&&due&&due<now)group.overdueBags.push(bag.bagId);
  }
  // Include past follow-ups in the report as resolved after physical custody
  // clears; resolving never needs a manual flag reset or a GET database write.
  for(const row of followups)if(!groups.has(row.customerId))groups.set(row.customerId,{customerId:row.customerId,customerName:row.customerName||row.customerId,bags:[],confirmed:0,collected:0,ambiguous:0,outstanding:[],overdueBags:[]});
  return [...groups.values()].map(group=>{
    const tags=[...new Set(group.outstanding.map(b=>normalizeBagId(b.bagId)))];
    const cycleKey=createHash('sha256').update(JSON.stringify(group.outstanding.map(b=>({record:id(b._id),tag:b.bagId,delivery:id(b.currentDelivery),assignedAt:b.assignedTo?.assignmentTime||null,verifiedAt:b.verifiedAt||null})).sort((a,b)=>a.record.localeCompare(b.record)))).digest('hex');
    const followup=saved.get(group.customerId)||null;
    const current=followup?.cycleKey===cycleKey;
    const due= current?validDate(followup.nextDueAt):null;
    const flagged=tags.length>=2;
    const needsFollowup=flagged||group.overdueBags.length>0||!!(followup&&tags.length);
    return {customerId:group.customerId,customerName:group.customerName,bags:group.bags,confirmed:group.confirmed,collected:group.collected,ambiguous:group.ambiguous,outstandingBagIds:tags,outstanding:tags.length,flagged,flagType:flagged?(group.ambiguous?'verify_two_bags':'two_bags'):null,overdueBags:group.overdueBags,cycleKey,
      needsFollowup,followup,version:followup?.version||0,ownerId:followup?.owner? id(followup.owner):'',ownerName:followup?.owner?name(staff.get(id(followup.owner))):'Unassigned',ownerActive:!!staff.get(id(followup?.owner))?.isActive,
      status:tags.length===0?'resolved':current?followup.status:'open',reminderDue:needsFollowup&&(!due||due<=now),nextDueAt:due?.toISOString()||null,previousCycle:!!followup&&!current,lastContactAt:current?followup.lastContactAt||null:null};
  });
}
export function bagAccountabilityReport(rows,bags,refunds=[],users=[],now=new Date()){
  const owners=new Map(),drivers=new Map(),staff=new Map(users.map(u=>[id(u._id),u]));
  for(const row of rows.filter(r=>r.needsFollowup)){
    const key=row.ownerId||'unassigned';if(!owners.has(key))owners.set(key,{ownerId:key,ownerName:row.ownerName,open:0,due:0,flagged:0,escalated:0});
    const owner=owners.get(key);owner.open++;if(row.reminderDue)owner.due++;if(row.flagged)owner.flagged++;if(row.status==='escalated')owner.escalated++;
  }
  for(const bag of bags.filter(b=>b.lifecycleState==='collected'&&b.location==='driver')){
    const key=id(bag.assignedTo?.driver)||'unknown';if(!drivers.has(key))drivers.set(key,{driverId:key,driverName:name(staff.get(key)),collectedBags:[],oldestCollectionAt:null});
    const driver=drivers.get(key);driver.collectedBags.push(bag.bagId);
    const collected=[...(bag.history||[])].reverse().find(e=>e.eventType==='collect')?.timestamp;
    if(validDate(collected)&&(!driver.oldestCollectionAt||new Date(collected)<new Date(driver.oldestCollectionAt)))driver.oldestCollectionAt=collected;
  }
  return {generatedAt:now.toISOString(),twoBagCustomers:rows.filter(r=>r.flagged).length,confirmedTwoBagCustomers:rows.filter(r=>r.flagType==='two_bags').length,unverifiedTwoBagCustomers:rows.filter(r=>r.flagType==='verify_two_bags').length,dueFollowups:rows.filter(r=>r.reminderDue).length,overdueReturnCustomers:rows.filter(r=>r.overdueBags.length).length,unassigned:rows.filter(r=>r.needsFollowup&&(!r.ownerId||!r.ownerActive)).length,resolved:rows.filter(r=>r.status==='resolved'&&r.followup).length,owners:[...owners.values()],driverReceipts:[...drivers.values()],refunds:{inReview:refunds.filter(c=>c.status==='review').length,approvedAwaitingCompletion:refunds.filter(c=>c.status==='approved').length,approvedAmountMinor:refunds.filter(c=>c.status==='approved').reduce((sum,c)=>sum+c.amountMinor,0)}};
}
