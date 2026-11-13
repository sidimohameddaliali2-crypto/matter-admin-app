const states=new Set(['checking','pending','ready','failed','capacity-blocked','budget-deferred']);
const capacityReasons=new Set(['build-disk','replica-storage','import-transfer']);
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;

export async function readDriverAuditSyncStatus(db,generation,clock=Date.now){
 let saved;
 try{saved=await db.collection('driverAuditControl').findOne({_id:'sync-status'},{maxTimeMS:1000});}
 catch{return {status:'failed',pending:true,latestCaptureAt:null,checkedAt:null};}
 if(!saved)return {status:'snapshot',pending:false,latestCaptureAt:null,checkedAt:null};
 const checkedAt=iso(saved.checkedAt);
 const age=checkedAt?clock()-Date.parse(checkedAt):Infinity;
 const current=age>=0&&age<30*60_000;
 const status=current&&states.has(saved.status)?saved.status:'failed';
 const visibleStatus=status==='ready'&&saved.activeGeneration!==generation?'pending':status;
 const reason=saved.capacity?.kind;
 const showCapacity=visibleStatus==='capacity-blocked'&&saved.errorCode==='AUDIT_CAPACITY'&&capacityReasons.has(reason);
 return {status:visibleStatus,pending:saved.pending===true||visibleStatus==='failed'||visibleStatus==='pending',
  latestCaptureAt:iso(saved.latestCaptureAt),checkedAt,...(showCapacity?{capacityReason:reason}:{})};
}
