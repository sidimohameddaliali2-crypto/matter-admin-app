import {auditBagInventory,normalizeBagId} from './bagInventoryAudit.js';
import {customerBagBalances} from './bagFollowupPolicy.js';
export async function loadBagSnapshot(db) {
  const read=(name,query,projection)=>db.collection(name).find(query,{projection,maxTimeMS:30000}).toArray();
  const bags=await read('bags',{},{});
  const [customers,users,deliveries,scans]=await Promise.all([
    read('customers',{}, {customerId:1}),
    read('users',{}, {role:1,isActive:1,permissions:1,permissionsConfigured:1,profile:1,name:1}),
    read('deliveries',{$or:[{'bagAssignment.bagId':{$exists:true}},{'proof.bagId':{$exists:true}},{'proof.bagIds.0':{$exists:true}},{_id:{$in:bags.map(b=>b.currentDelivery).filter(Boolean)}}]},{customerId:1,status:1,bagAssignment:1,'proof.bagId':1,'proof.bagIds':1}),
    read('storekeeperscans',{}, {bagId:1,action:1,timestamp:1})
  ]);
  return {bags,customers,users,deliveries,scans};
}
export const staffName=user=>[user?.profile?.firstName,user?.profile?.lastName].filter(Boolean).join(' ')||user?.name||'Staff';
export function buildBagWorkspace(snapshot,reviews=[],now=new Date()) {
  const audit=auditBagInventory({...snapshot,now});
  const reviewMap=new Map(reviews.map(r=>[r.subjectKey,r]));
  const users=new Map(snapshot.users.map(u=>[String(u._id),u]));
  const reasons=new Map();
  for(const f of audit.findings)for(const r of f.records){if(!reasons.has(r.recordId))reasons.set(r.recordId,[]);reasons.get(r.recordId).push(f.code);}
  const bags=snapshot.bags.map(b=>({
    _id:String(b._id),bagId:b.bagId,status:b.status,location:b.location,condition:b.condition,quantity:b.quantity??null,
    lifecycleState:b.lifecycleState||'legacy_unverified',custodyVersion:b.custodyVersion||0,verifiedAt:b.verifiedAt||null,
    customerId:b.assignedTo?.customer?.customerId||'',customerName:b.assignedTo?.customer?.customerName||'',
    driverId:String(b.assignedTo?.driver||''),driverName:b.assignedTo?.driver?staffName(users.get(String(b.assignedTo.driver))):'',
    currentDelivery:String(b.currentDelivery||''),pendingHandover:b.pendingHandover||null,
    isFlagged:!!b.isFlagged,flagReason:b.flagReason||'',historyCount:b.history?.length||0,
    reasons:reasons.get(String(b._id))||[],review:reviewMap.get(`bag:${b._id}`)||null
  }));
  return {generatedAt:audit.generatedAt,summary:audit.summary,checks:audit.findings.map(({records,...f})=>f),unknownCodes:audit.unknownCodes,bags,customers:customerBagBalances(snapshot.bags,[],snapshot.users,now),limitations:audit.limitations};
}
export function compareStockCount(bags,scannedCodes) {
  if(!Array.isArray(scannedCodes)||scannedCodes.length>20000||scannedCodes.some(c=>typeof c!=='string'||!c.trim()||c.length>160))throw new Error('Provide up to 20,000 non-empty bag IDs.');
  const normalized=scannedCodes.map(normalizeBagId),unique=[...new Set(normalized)];
  const expectedCodes=[...new Set(bags.filter(b=>b.location==='warehouse'&&b.status!=='retired'&&b.isActive!==false).map(b=>normalizeBagId(b.bagId)))];
  return {scannedCodes:unique,expectedCodes,missingCodes:expectedCodes.filter(c=>!unique.includes(c)),unexpectedCodes:unique.filter(c=>!expectedCodes.includes(c)),duplicateScans:normalized.length-unique.length};
}
