const text=v=>v==null?'':String(v).trim();
const ref=v=>text(v?._id??v);
// Printed QR labels use BAG_ while inventory IDs use BAG-. Keep every digit,
// including leading zeros; the separator is the only interchangeable part.
export const normalizeBagId=v=>text(v).toUpperCase().replace(/^BAG_/, 'BAG-');
export const bagIdAliases=v=>{
  const code=normalizeBagId(v);
  return code.startsWith('BAG-')?[code,code.replace(/^BAG-/, 'BAG_')]:[code];
};
export function auditBagInventory({bags,customers=[],users=[],deliveries=[],scans=[],now=new Date()}) {
  const findings=[];
  const check=(code,detail,action,predicate)=>{
    const records=bags.filter(predicate).map(b=>({recordId:ref(b._id),bagId:b.bagId}));
    if(records.length)findings.push({code,detail,proposedAction:action,count:records.length,records});
  };
  const customerIds=new Set(customers.map(c=>text(c.customerId)));
  const userIds=new Set(users.map(u=>ref(u._id)));
  const deliveryIds=new Set(deliveries.map(d=>ref(d._id)));
  const duplicates=new Map();
  for(const b of bags){const code=normalizeBagId(b.bagId);if(!duplicates.has(code))duplicates.set(code,[]);duplicates.get(code).push(ref(b._id));}
  check('identity_collision','A normalized bag ID resolves to multiple records.','Compare physical tags before merging.',b=>duplicates.get(normalizeBagId(b.bagId)).length>1);
  check('nonstandard_id','Tag differs from BAG-0001 format.','Verify the label; preserve leading zeros.',b=>!/^BAG-\d{4,}$/.test(normalizeBagId(b.bagId)));
  check('quantity_unverified','Legacy quantity is missing or is not one.','Confirm one physical bag per tag.',b=>b.quantity!==1);
  check('custody_ambiguous','Assigned bag is also recorded at the warehouse.','Establish the physical holder before correction.',b=>!b.lifecycleState&&['assigned','in_use'].includes(b.status)&&b.location==='warehouse');
  check('customer_unmatched','Customer ID is absent from the internal customer register.','Review legacy IDs and customer merges.',b=>b.assignedTo?.customer?.customerId&&!customerIds.has(text(b.assignedTo.customer.customerId)));
  check('holder_unmatched','Assigned driver no longer exists.','Confirm the physical holder.',b=>b.assignedTo?.driver&&!userIds.has(ref(b.assignedTo.driver)));
  check('delivery_unmatched','Linked delivery no longer exists.','Review the source history; do not assume return.',b=>b.currentDelivery&&!deliveryIds.has(ref(b.currentDelivery)));
  check('return_date_missing','Customer-associated bag has no return deadline.','Agree a deadline prospectively.',b=>b.assignedTo?.customer?.customerId&&b.status!=='available'&&!b.assignedTo.expectedReturn);
  check('history_missing','No lifecycle events are recorded.','Create a verified opening observation, not invented history.',b=>!b.history?.length);
  check('driver_recorded_return','Available bag return was recorded by a driver.','Check physical warehouse receipt.',b=>b.status==='available'&&users.find(u=>ref(u._id)===ref(b.returnedBy))?.role==='driver');
  check('damaged_available','Poor-condition bag is available.','Inspect and quarantine.',b=>b.condition==='poor'&&b.status==='available');
  const tally=field=>bags.reduce((a,b)=>(a[b[field]||'unrecorded']=(a[b[field]||'unrecorded']||0)+1,a),{});
  const bagCodes=new Set(bags.map(b=>normalizeBagId(b.bagId)));
  const unknownCodes=[...new Set([...deliveries.flatMap(d=>[d.bagAssignment?.bagId,d.proof?.bagId,...(Array.isArray(d.proof?.bagIds)?d.proof.bagIds:[])]),...scans.map(s=>s.bagId)].filter(Boolean).map(normalizeBagId))].filter(c=>!bagCodes.has(c));
  return {generatedAt:now.toISOString(),readOnly:true,summary:{bagRecords:bags.length,distinctIds:bagCodes.size,byStatus:tally('status'),byLocation:tally('location'),verifiedRecords:bags.filter(b=>b.lifecycleState&&b.verifiedAt).length,unknownHistoricalCodes:unknownCodes.length},findings,unknownCodes,limitations:['Recorded data is not a physical stock count.','Findings overlap and must not be added together.','Historical unknown codes do not establish missing physical stock.']};
}
