import { createHash } from 'node:crypto';
import { normalizeBagId,isStandardBagId } from './bagInventoryAudit.js';
export const BAG_STATES=['ready','packed','outbound','with_customer','collected','received','cleaning','quarantined','retired'];
const id=v=>String(v?._id??v??'');
const fault=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const warehouseRoles=new Set(['super_admin','admin','manager','store_keeper']);
export const bagCommandFingerprint=(command,actor)=>createHash('sha256').update(JSON.stringify({action:command.action,actor:id(actor._id),driverId:id(command.driverId),deliveryId:id(command.deliveryId),customerId:command.customerId||'',inspected:command.inspected===true})).digest('hex');

// Pure transition policy. The store commits state and the event together in one
// atomic bag-document update; no transaction-capable Mongo deployment is required.
export function planBagMovement(bag,command,actor,now=new Date()) {
  const {action}=command;
  const scannedDelivery=action==='deliver'&&actor.role==='driver'&&command.physicalScan===true;
  if(!command.eventId||typeof command.eventId!=='string'||command.eventId.length>200)throw fault('A stable movement event ID is required.',400);
  const fingerprint=bagCommandFingerprint(command,actor);
  const prior=(bag.history||[]).find(h=>h.eventId===command.eventId);
  if(prior){if(prior.fingerprint!==fingerprint)throw fault('Movement ID already used for a different action.');return {duplicate:true};}
  let occurredAt=now;
  if(command.occurredAt){
    occurredAt=new Date(command.occurredAt);
    if(!Number.isFinite(occurredAt.getTime())||occurredAt.getTime()>now.getTime()+60000)throw fault('Movement capture time is invalid. Check the device clock.',400);
    if(bag.lifecycleState&&bag.verifiedAt&&occurredAt.getTime()<new Date(bag.verifiedAt).getTime()-60000)throw fault('Offline movement predates a newer physical handover. Review custody before retrying.');
  }
  if(bag.custodyVersion!=null&&(!Number.isInteger(bag.custodyVersion)||bag.custodyVersion<0))throw fault('Invalid custody version. Reconcile this record before movement.');
  if(!scannedDelivery&&(bag.isActive===false||bag.status==='retired'))throw fault('Retired or inactive bags cannot re-enter circulation.');
  if(command.expectedVersion!=null&&command.expectedVersion!==(bag.custodyVersion||0))throw fault('Bag changed since it was opened. Refresh before confirming.');
  const state=bag.lifecycleState||'legacy_unverified';
  const isWarehouse=warehouseRoles.has(actor.role);
  const isDriver=actor.role==='driver';
  const ownDriver=id(bag.assignedTo?.driver)===id(actor._id);
  const note=typeof command.note==='string'?command.note.trim():'';
  if(note.length>2000)throw fault('Evidence notes must be at most 2,000 characters.',400);
  const set={}; const unset={}; let reassignment;
  const warehouse=()=>{if(!isWarehouse)throw fault('Warehouse receiving permission is required.',403);};
  const requireState=(...allowed)=>{if(!allowed.includes(state))throw fault(`Cannot ${action.replaceAll('_',' ')} a bag in ${state}.`);};
  const clearAssignment=()=>{set.lastCustomer=bag.assignedTo?.customer||bag.lastCustomer||null;unset.assignedTo='';unset.currentDelivery='';unset.pendingHandover='';};
  if(action==='observe_warehouse'){
    warehouse();requireState('legacy_unverified');if(!note||command.inspected!==true)throw fault('Confirm the physical bag and provide opening-count evidence.',400);
    if(bag.quantity!=null&&bag.quantity!==1)throw fault('This tag represents an unresolved quantity. Reconcile individual physical tags first.');
    set.lifecycleState=bag.condition==='poor'?'quarantined':'received';set.location='warehouse';set.status='maintenance';set.quantity=1;clearAssignment();
  }else if(action==='pack'){
    warehouse();requireState('ready');if(!command.driverId)throw fault('Select the receiving driver.',400);
    if(bag.isFlagged||bag.condition==='poor')throw fault('Flagged or damaged stock cannot be dispatched.');
    set.lifecycleState='packed';set.status='assigned';set.pendingHandover={driver:command.driverId,preparedBy:actor._id,preparedAt:now};
  }else if(action==='accept'){
    requireState('packed');if(!isDriver||id(bag.pendingHandover?.driver)!==id(actor._id))throw fault('Only the nominated driver may accept this bag.',403);
    set.lifecycleState='outbound';set.location='driver';set.status='assigned';set.assignedTo={driver:actor._id,assignedBy:bag.pendingHandover.preparedBy,assignmentTime:now};unset.pendingHandover='';
  }else if(action==='cancel_handover'){
    warehouse();requireState('packed');if(!note)throw fault('Record why the prepared handover is cancelled.',400);
    set.lifecycleState='ready';set.status='available';unset.pendingHandover='';
  }else if(action==='deliver'){
    if(!isDriver||!command.customerId||!command.deliveryId)throw fault('An assigned driver, customer and delivery are required.',403);
    if(state==='with_customer'&&id(bag.currentDelivery)===id(command.deliveryId)&&bag.assignedTo?.customer?.customerId===command.customerId&&ownDriver)return {duplicate:true};
    // Owner (2026-10-27): the driver's physical delivery scan is authoritative
    // from every prior state, including collected/retired or another holder.
    // Keep damage evidence and old custody in history rather than blocking save.
    const scanned=scannedDelivery;
    if(!scanned)requireState('outbound','legacy_unverified');
    if(!scanned&&(bag.isFlagged||bag.condition==='poor'))throw fault('Flagged or damaged bags cannot be delivered.');
    if(!scanned&&bag.assignedTo?.driver&&!ownDriver)throw fault('Bag is held by another driver. Confirm a transfer first.');
    const oldCustomer=bag.assignedTo?.customer;
    if(oldCustomer?.customerId&&oldCustomer.customerId!==command.customerId){
      if(!scanned)throw fault('Bag has an outstanding association to a different customer. Scan the physical bag to reassign it.');
      reassignment={fromCustomer:oldCustomer,toCustomer:{customerId:command.customerId,customerName:command.customerName||''},fromDelivery:bag.currentDelivery||null,reason:'Physical delivery scan',scannedBy:actor._id};
      set.lastCustomer=oldCustomer;
    }
    set.lifecycleState='with_customer';set.location='customer';set.status=scanned?'in_use':'assigned';set.currentDelivery=command.deliveryId;
    if(scanned){set.isActive=true;set.quantity=1;unset.pendingHandover='';unset.returnedAt='';unset.returnedBy='';unset.returnedByName='';}
    set.assignedTo={driver:actor._id,customer:{customerId:command.customerId,customerName:command.customerName||''},assignmentTime:now,expectedReturn:command.expectedReturn||null};
  }else if(action==='collect'){
    if(!isDriver)throw fault('Only the collecting driver can record pickup.',403);
    if(command.customerId&&bag.assignedTo?.customer?.customerId&&bag.assignedTo.customer.customerId!==command.customerId)throw fault('The scanned bag belongs to a different customer. Review this exception.');
    if(state==='collected'&&ownDriver)return {duplicate:true};
    requireState('with_customer','legacy_unverified');
    set.lifecycleState='collected';set.location='driver';set.status='in_use';set.assignedTo={...bag.assignedTo,driver:actor._id};
  }else if(action==='receive'){
    warehouse();requireState('collected','outbound','legacy_unverified');if(!note)throw fault('Receiving evidence or handover note is required.',400);
    set.lifecycleState=bag.condition==='poor'||bag.isFlagged?'quarantined':'received';set.location='warehouse';set.status='maintenance';set.returnedAt=now;set.returnedBy=actor._id;set.returnedByName=actor.name||'';clearAssignment();
  }else if(action==='start_cleaning'){
    warehouse();requireState('received');set.lifecycleState='cleaning';set.status='maintenance';
  }else if(action==='release'){
    warehouse();requireState('received','cleaning');if(command.inspected!==true)throw fault('Confirm cleaning and inspection before release.',400);
    if(bag.condition==='poor'||bag.isFlagged)throw fault('Damaged or flagged bags must be reviewed before release.');
    set.lifecycleState='ready';set.location='warehouse';set.status='available';set.quantity=1;set.isActive=true;
  }else if(action==='quarantine'){
    warehouse();if(bag.location!=='warehouse'||state==='retired')throw fault('Receive the physical bag before quarantine.');
    if(!note||typeof command.proofPhotoUrl!=='string'||!/^https?:\/\//i.test(command.proofPhotoUrl)||command.proofPhotoUrl.length>2000)throw fault('Damage description and photo evidence are required.',400);
    set.lifecycleState='quarantined';set.status='maintenance';set.condition='poor';set.isFlagged=true;set.flagReason=note;set.damageEvidence={description:note,proofPhotoUrl:command.proofPhotoUrl,reportedBy:actor._id,reportedAt:now};
    clearAssignment();
  }else if(action==='repair'){
    warehouse();requireState('quarantined');if(!note||command.inspected!==true)throw fault('Record repair findings and confirm inspection.',400);
    set.lifecycleState='received';set.condition='good';set.isFlagged=false;set.flagReason='';set.status='maintenance';
  }else if(action==='retire'){
    if(!['super_admin','admin','manager'].includes(actor.role))throw fault('Manager approval is required to retire a bag.',403);
    if(bag.location!=='warehouse'||state==='retired'||!note)throw fault('Receive the bag at warehouse and provide a retirement reason.');
    set.lifecycleState='retired';set.status='retired';set.isActive=false;clearAssignment();
  }else if(action==='offer_transfer'){
    requireState('outbound','collected');if(!isDriver||!ownDriver||!command.driverId||id(command.driverId)===id(actor._id))throw fault('Only the current holder can offer to another driver.',403);
    set.pendingHandover={driver:command.driverId,preparedBy:actor._id,preparedAt:now,transfer:true};
  }else if(action==='accept_transfer'){
    requireState('outbound','collected');if(!isDriver||!bag.pendingHandover?.transfer||id(bag.pendingHandover.driver)!==id(actor._id))throw fault('Only the nominated receiving driver can accept.',403);
    set.assignedTo={...bag.assignedTo,driver:actor._id};unset.pendingHandover='';
  }else throw fault('Unsupported bag movement.',400);
  set.verifiedAt=now;set.updatedAt=now;
  return {set,unset,event:{eventId:command.eventId,fingerprint,eventType:action,status:set.status||bag.status,location:set.location||bag.location,lifecycleState:set.lifecycleState||state,assignedBy:{user:actor._id,name:actor.name||actor.role},assignedTo:set.assignedTo||bag.assignedTo,notes:note,reassignment,physicalScan:scannedDelivery,registeredFromScan:bag.unregistered===true,proofPhotoUrl:command.proofPhotoUrl||null,before:{state:bag.unregistered?'unregistered':state,status:bag.status,location:bag.location,isActive:bag.isActive,condition:bag.condition,isFlagged:bag.isFlagged,pendingHandover:bag.pendingHandover,quantity:bag.quantity??null,assignedTo:bag.assignedTo,currentDelivery:bag.currentDelivery},occurredAt,timestamp:now}};
}

export async function executeBagMovement(repository,bagId,command,actor) {
  const code=normalizeBagId(bagId);
  let bag=await repository.find(code);
  const createFromScan=!bag&&actor.role==='driver'&&command.action==='deliver'&&command.physicalScan===true&&command.customerId&&command.deliveryId&&repository.create;
  if(!bag&&!createFromScan)throw Object.assign(fault(`Bag ${code} is not registered. Check the full printed label, including leading zeros. Open an inventory exception if it is missing from stock.`,404),{bagId:code});
  if(createFromScan){if(!isStandardBagId(code))throw fault('Scan a valid bag tag, such as BAG-00077 or BAG-A0001.',400);bag={bagId:code,history:[],unregistered:true};}
  const plan=planBagMovement(bag,command,actor);
  if(plan.duplicate)return {bag,duplicate:true};
  if(typeof command.scanCode==='string')plan.event.scanCode=command.scanCode;
  const updated=createFromScan?await repository.create(bag,plan):await repository.commit(bag,plan);
  if(updated)return {bag:updated,duplicate:false};
  // Concurrent identical retries may have committed while we were reading.
  const current=await repository.find(normalizeBagId(bagId));
  if(current&&planBagMovement(current,command,actor).duplicate)return {bag:current,duplicate:true};
  throw fault('Concurrent bag movement detected. Refresh and reconcile before retrying.');
}
