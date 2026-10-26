import {normalizeBagId,bagIdAliases} from './bagInventoryAudit.js';
export const requestedABagIds=()=>Array.from({length:500},(_,i)=>`BAG-A${String(i+1).padStart(4,'0')}`);
export function planABagRegistration(existing,now=new Date()){
  const ids=requestedABagIds(),groups=new Map();
  for(const bag of existing){const code=normalizeBagId(bag.bagId);if(!ids.includes(code))continue;if(!groups.has(code))groups.set(code,[]);groups.get(code).push(bag);}
  const conflicts=[...groups].filter(([,rows])=>rows.length>1).map(([code])=>code);
  if(conflicts.length)throw new Error(`Duplicate labels need reconciliation: ${conflicts.join(', ')}`);
  const missing=ids.filter(code=>!groups.has(code));
  return {ids,missing,existing:ids.length-missing.length,operations:missing.map(bagId=>({updateOne:{filter:{bagId:{$in:bagIdAliases(bagId)}},upsert:true,update:{$setOnInsert:{bagId,bagType:'standard',status:'maintenance',location:'warehouse',quantity:1,isActive:true,custodyVersion:0,createdAt:now,updatedAt:now,notes:'Owner-requested A-series registration. Physical warehouse observation, cleaning and inspection pending.',history:[{eventId:`register-a-series:${bagId}`,eventType:'register_batch',status:'maintenance',location:'warehouse',assignedBy:{name:'Owner-requested bag registration'},notes:'Tag registered from the requested BAG-A0001–BAG-A0500 range. No physical receipt, holder, condition or inspection was verified by this import.',timestamp:now}]}}}}))};
}
