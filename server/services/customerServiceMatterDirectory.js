const safeString=(v,max=200)=>typeof v==='string'?v.trim().slice(0,max):'';
const sourceId=value=>{if((typeof value==='number'&&Number.isSafeInteger(value)&&value>0)||(typeof value==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(value)))return String(value);throw new Error('Matter source identity is missing or invalid');};
export function normalizeMatterDirectory(rows,{observedAt=new Date().toISOString(),sourceReport={}}={}){
 const customers=new Map(),subscriptionIds=new Set();
 for(const row of rows){
  const matterCustomerId=sourceId(row.customer_id),id=sourceId(row.subscription_id);
  if(subscriptionIds.has(id))throw new Error('Matter subscription identity repeated across pages');subscriptionIds.add(id);
  const profile={name:safeString(row.name),email:safeString(row.email,320),phone:safeString(row.phone,80)};
  const customer=customers.get(matterCustomerId)||{customerId:`matter:${matterCustomerId}`,matterCustomerId,...profile,subscriptions:[],profileObservations:[],source:'matter_api_subscriptions',sourceObservedAt:observedAt,sourceCoverage:'subscription_customers_only',sourceReport};
  if(!customer.profileObservations.some(p=>JSON.stringify(p)===JSON.stringify(profile)))customer.profileObservations.push(profile);
  customer.subscriptions.push({id,status:safeString(row.subscription_status,80),plan:{id:row.plan?.plan_id==null?'':sourceId(row.plan.plan_id),name:safeString(row.plan?.name)},start:safeString(row.starting_date,40),end:safeString(row.cycle_end_date,40),sourceUpdatedAt:safeString(row.updated_at,60)});
  customers.set(matterCustomerId,customer);
 }
 return [...customers.values()].map(c=>({...c,identityNeedsReview:c.profileObservations.length>1}));
}
export async function readMatterCustomerDirectory({env=process.env,fetchImpl=fetch,pageSize=50,maxPages=200,includeDetails=false,clock=()=>new Date().toISOString()}={}){
 if(env.MATTER_API_READ_ENABLED!=='true'||!env.MATTER_API_TOKEN||!env.MATTER_API_BASE_URL)throw new Error('Matter read access is not configured');
 const base=new URL(env.MATTER_API_BASE_URL);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('Matter source URL must use authenticated HTTPS');
 if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new Error('Invalid Matter page size');
 if(!Number.isInteger(maxPages)||maxPages<1||maxPages>200)throw new Error('Invalid Matter page budget');
 const rows=[];let expectedTotal,expectedPages,pagesRead=0;
 for(let page=1;page<=maxPages;page++){
  const url=new URL(`${base.href.replace(/\/$/,'')}/subscriptions`);url.searchParams.set('page',String(page));url.searchParams.set('page_size',String(pageSize));
  let response;try{response=await fetchImpl(url,{method:'GET',headers:{Authorization:`Bearer ${env.MATTER_API_TOKEN}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000),cache:'no-store'});}catch{throw new Error('Matter directory source could not be reached');}
  if(!response.ok)throw new Error(`Matter directory source rejected the read (${response.status})`);
  const reader=response.body?.getReader();if(!reader)throw new Error('Matter returned no readable body');let length=0;const parts=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>5*1024*1024){await reader.cancel();throw new Error('Matter page exceeds read limit');}parts.push(value);}}finally{reader.releaseLock();}
  let payload;try{payload=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new Error('Matter returned invalid JSON');}
  const meta=payload.meta;
  if(!Array.isArray(payload.data)||payload.data.length>pageSize||!meta||meta.page!==page||meta.page_size!==pageSize||!Number.isSafeInteger(meta.total_records)||meta.total_records<0||!Number.isSafeInteger(meta.total_pages)||meta.total_pages<0)throw new Error('Matter pagination contract did not match');
  if(page===1){expectedTotal=meta.total_records;expectedPages=meta.total_pages;if(expectedPages>maxPages)throw new Error('Matter directory exceeds configured page budget');}
  if(meta.total_records!==expectedTotal||meta.total_pages!==expectedPages)throw new Error('Matter directory totals changed during capture; retry required');
  if(meta.total_pages!==Math.ceil(meta.total_records/pageSize))throw new Error('Matter reported inconsistent page totals');
  rows.push(...payload.data);pagesRead++;
  if(page>=expectedPages){if(meta.next_page!=null)throw new Error('Matter terminal page has a next page');break;}
  if(meta.next_page!==page+1||payload.data.length!==pageSize)throw new Error('Matter directory pagination skipped or truncated a page');
 }
 if(rows.length!==expectedTotal)throw new Error('Matter directory count reconciliation failed');
 let detailsRead=0,detailsFailed=0;
 if(includeDetails){
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(3,rows.length)},async()=>{
   while(cursor<rows.length){
    const index=cursor++,row=rows[index],id=sourceId(row.subscription_id);
    try {
    const url=new URL(`${base.href.replace(/\/$/,'')}/subscriptions/${encodeURIComponent(id)}`);
    let response;try{response=await fetchImpl(url,{method:'GET',headers:{Authorization:`Bearer ${env.MATTER_API_TOKEN}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000),cache:'no-store'});}catch{throw new Error('Matter subscription detail could not be reached');}
    if(!response.ok)throw new Error(`Matter subscription detail rejected the read (${response.status})`);
    const reader=response.body?.getReader();if(!reader)throw new Error('Matter returned no subscription detail');let length=0;const parts=[];
    try{while(true){const{done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>5*1024*1024){await reader.cancel();throw new Error('Matter detail exceeds read limit');}parts.push(value);}}finally{reader.releaseLock();}
    let detail;try{detail=JSON.parse(Buffer.concat(parts).toString('utf8')).data;}catch{throw new Error('Matter returned invalid subscription detail');}
    if(!detail||sourceId(detail.subscription_id)!==id||sourceId(detail.customer_id)!==sourceId(row.customer_id))throw new Error('Matter subscription detail identity mismatch');
    rows[index]={...row,phone:safeString(detail.phone,80)};detailsRead++;
    } catch { detailsFailed++; }
   }
  }));
 }
 const observedAt=clock();
 const report={source:'matter_api_subscriptions',observedAt,pagesRead,detailsRead,detailsFailed,sourceSubscriptionTotal:expectedTotal,sourcePagesExhausted:true,fullCustomerDirectory:false,atomicSnapshot:false,coverage:'subscription_customers_only',limitations:['Only customers returned by the subscriptions endpoint are included. Customers without returned subscriptions are unverified.','Pagination totals and identities reconcile, but the API supplies no atomic snapshot token.']};
 const customers=normalizeMatterDirectory(rows,{observedAt,sourceReport:report});
 return {customers,report:{...report,uniqueCustomers:customers.length,profileConflicts:customers.filter(c=>c.identityNeedsReview).length,customersWithPhone:customers.filter(c=>c.phone).length,subscriptionStatuses:[...new Set(rows.map(r=>r.subscription_status))].sort()}};
}

// Only the source's explicit matterCustomerId may join delivery and website
// records. Similar names, emails, phones and subscription references never join.
export function normalizeCombinedMatterDirectory(remoteRows,apiDirectory,{observedAt=new Date().toISOString(),expectedRemoteRecords}={}){
 if(!Array.isArray(remoteRows)||!Array.isArray(apiDirectory?.customers))throw new Error('Both directory source arrays are required');
 if(expectedRemoteRecords!==undefined&&remoteRows.length!==expectedRemoteRecords)throw new Error('Remote customer count reconciliation failed');
 const customers=new Map(apiDirectory.customers.map(c=>[c.customerId,{...structuredClone(c),sourceAliases:[c.customerId],deliveryCustomerIds:[],deliveryProfiles:[],sourceObservedAt:observedAt}]));
 const seenDeliveryIds=new Set();let explicitMatterLinks=0;
 for(const raw of remoteRows){
  const deliveryId=String(raw.customerId??'');
  if(!deliveryId||deliveryId.length>140||/[\x00-\x1f\x7f]/.test(deliveryId))throw new Error('Remote customer identity is invalid');
  if(seenDeliveryIds.has(deliveryId))throw new Error('Remote customer identity repeated');seenDeliveryIds.add(deliveryId);
  const matterId=raw.matterCustomerId==null||raw.matterCustomerId===''?'':sourceId(raw.matterCustomerId);
  const key=matterId?`matter:${matterId}`:`delivery:${deliveryId}`;
  if(matterId)explicitMatterLinks++;
  const profile={name:[safeString(raw.firstName),safeString(raw.lastName)].filter(Boolean).join(' ').slice(0,200),email:safeString(raw.email,320),phone:safeString(raw.phone,80)};
  const customer=customers.get(key)||{customerId:key,matterCustomerId:matterId,...profile,subscriptions:[],profileObservations:[],identityNeedsReview:false,sourceAliases:[],deliveryCustomerIds:[],deliveryProfiles:[],sourceObservedAt:observedAt};
  customer.sourceAliases=[...new Set([...customer.sourceAliases,`delivery:${deliveryId}`,...(matterId?[`matter:${matterId}`]:[])])];
  customer.deliveryCustomerIds.push(deliveryId);
  customer.deliveryProfiles.push({customerId:deliveryId,...profile,matterCustomerId:matterId,matterSubscriptionId:raw.matterSubscriptionId==null?'':String(raw.matterSubscriptionId),mealPlan:safeString(raw.mealPlan),planStartDate:raw.planStartDate==null?'':String(raw.planStartDate),isActive:typeof raw.isActive==='boolean'?raw.isActive:null});
  for(const field of ['name','email','phone'])if(!customer[field]&&profile[field])customer[field]=profile[field];
  if(!customer.profileObservations.some(p=>JSON.stringify(p)===JSON.stringify(profile)))customer.profileObservations.push(profile);
  // Source profiles remain visible even if a name/contact has changed over time.
  customer.identityNeedsReview=customer.profileObservations.length>1;
  customer.source='matter_delivery_db_and_api';customer.sourceCoverage='remote_customer_collection_and_subscription_customers';
  customers.set(key,customer);
 }
 const report={source:'matter_delivery_db_and_api',observedAt,totalRemoteRecords:remoteRows.length,expectedRemoteRecords:expectedRemoteRecords??null,remoteCollectionReconciled:expectedRemoteRecords!==undefined&&remoteRows.length===expectedRemoteRecords,apiCustomers:apiDirectory.customers.length,apiSubscriptions:apiDirectory.report?.sourceSubscriptionTotal??null,explicitMatterLinks,uniqueCustomers:customers.size,atomicSnapshot:false,fullCustomerDirectory:false,coverage:'remote_customer_collection_and_subscription_customers',limitations:['Remote delivery customer collection plus customers returned by the Matter subscriptions API; completeness of the separate Matter website customer population is unverified.','Only explicit source matterCustomerId links combine records; equal names, emails or phones never merge identities.','Source reads are not a cross-system atomic snapshot.']};
 return {customers:[...customers.values()].map(c=>({...c,sourceReport:report})),report};
}

export async function enrichMissingMatterPhones(directory,{env=process.env,fetchImpl=fetch}={}){
 if(env.MATTER_API_READ_ENABLED!=='true'||!env.MATTER_API_TOKEN)throw new Error('Matter read access is not configured');
 const base=new URL(env.MATTER_API_BASE_URL);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('Matter source URL must use authenticated HTTPS');
 const result=structuredClone(directory),candidates=result.customers.filter(c=>!c.phone&&c.matterCustomerId&&c.subscriptions?.length);let cursor=0,completed=0,failed=0,phonesAdded=0;
 await Promise.all(Array.from({length:Math.min(3,candidates.length)},async()=>{while(cursor<candidates.length){const customer=candidates[cursor++],id=sourceId(customer.subscriptions[0].id);try{
  const response=await fetchImpl(new URL(`${base.href.replace(/\/$/,'')}/subscriptions/${encodeURIComponent(id)}`),{method:'GET',headers:{Authorization:`Bearer ${env.MATTER_API_TOKEN}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000),cache:'no-store'});
  if(!response.ok)throw new Error('Detail read failed');
  const reader=response.body?.getReader();if(!reader)throw new Error('No detail body');let length=0;const parts=[];
  try{while(true){const{done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>5*1024*1024){await reader.cancel();throw new Error('Detail too large');}parts.push(value);}}finally{reader.releaseLock();}
  const detail=JSON.parse(Buffer.concat(parts).toString('utf8')).data;
  if(!detail||sourceId(detail.subscription_id)!==id||sourceId(detail.customer_id)!==customer.matterCustomerId)throw new Error('Identity mismatch');
  const phone=safeString(detail.phone,80);if(phone){customer.phone=phone;phonesAdded++;}completed++;
 }catch{failed++;}}}));
 result.report.phoneEnrichment={requested:candidates.length,completed,failed,phonesAdded,observedAt:new Date().toISOString()};
 result.report.customersWithPhone=result.customers.filter(c=>c.phone).length;
 for(const customer of result.customers)customer.sourceReport=result.report;
 return result;
}
