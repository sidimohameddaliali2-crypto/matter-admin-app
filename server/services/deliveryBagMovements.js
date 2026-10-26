import Bag from '../models/Bag.js';
import {moveBag} from './bagMovementStore.js';
import {normalizeBagId} from './bagInventoryAudit.js';
import {findRegisteredBag} from './bagRecordLookup.js';

export async function recordDeliveryBagMovements(delivery,payload,user) {
  if(!['delivered','completed','collected'].includes(payload.status))return;
  const proof=payload.proof?.toObject?.()||payload.proof||{};
  const collection=delivery.type==='Collection'||delivery.taskType==='Bag Collection'||proof.type==='bag_collection';
  const codes=items=>[...new Set(items.flat().filter(v=>typeof v==='string'&&v.trim()).map(normalizeBagId))];
  const outgoingCodes=collection?[]:codes([payload.bagIds||[],proof.bagIds||[],payload.bagId||proof.bagId||[]]);
  const incomingCodes=codes([proof.returnedBags||[],collection?(proof.scannedBags||payload.bagIds||proof.bagIds||[]):[]]);
  const scanned=proof.qrSkipped===true?[]:codes([proof.bagId||[],proof.bagIds||[],payload.bagIds||[]]);
  const registered=new Map();const scanCodes=new Map();
  for(const code of [...new Set([...outgoingCodes,...incomingCodes])]){
    const bag=await findRegisteredBag(Bag.collection,code);
    if(!bag)throw Object.assign(new Error(`Bag ${code} is not registered. Check the full printed label, including leading zeros.`),{statusCode:404,bagId:code});
    registered.set(code,normalizeBagId(bag.bagId));
    scanCodes.set(normalizeBagId(bag.bagId),code);
  }
  const outgoing=[...new Set(outgoingCodes.map(code=>registered.get(code)))];
  const incoming=[...new Set(incomingCodes.map(code=>registered.get(code)))];
  const scannedStock=new Set(scanned.map(code=>registered.get(code)).filter(Boolean));
  if(outgoing.some(code=>incoming.includes(code)))throw Object.assign(new Error('A bag cannot be delivered and collected in the same stop. Check both lists.'),{statusCode:400});
  for(const [action,list] of [['deliver',outgoing],['collect',incoming]])for(const bagId of list){
    await moveBag(bagId,{action,eventId:`delivery:${delivery._id}:${action}:${bagId}`,physicalScan:scannedStock.has(bagId),scanCode:scanCodes.get(bagId),occurredAt:proof.timestamp||payload.capturedAt,note:`${action} at delivery ${delivery._id}`,deliveryId:String(delivery._id),customerId:delivery.customerId},user);
  }
  if(outgoing.length)delivery.bagAssignment={bagId:outgoing[0],assignedAt:new Date(),assignedBy:user._id,status:'delivered'};
  // All IDs are preserved in typed proof fields; the primary bag is compatibility only.
  delivery.proof={...(delivery.proof?.toObject?.()||delivery.proof||{}),...proof,bagId:outgoing[0]||proof.bagId,bagIds:outgoing,bagScanCodes:scanned,returnedBags:incoming,scannedBags:collection?incoming:proof.scannedBags};
}

export async function legacyBagReturn(identifier,payload,user){
  const bag=await findRegisteredBag(Bag.collection,identifier);
  if(!bag)throw Object.assign(new Error(`Bag ${normalizeBagId(identifier)} is not registered. Check the full printed label, including leading zeros.`),{statusCode:404});
  const action=user.role==='driver'?'collect':'receive';
  const cycle=String(payload.deliveryId||bag.currentDelivery||bag.returnedAt?.toISOString()||'opening');
  return moveBag(bag.bagId,{action,eventId:payload.eventId||`legacy:${cycle}:${action}:${bag.bagId}`,note:payload.notes||payload.reason||`Physical ${action} recorded`,deliveryId:payload.deliveryId,customerId:payload.customerId},user);
}
