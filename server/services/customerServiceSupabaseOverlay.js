import {normalizeCombinedMatterDirectory} from './customerServiceMatterDirectory.js';

// A reread of an imported copy is a new observation, not a new upstream edit.
export function overlaySupabaseDirectory(directory, supabase, api) {
 const customers=new Map(directory.customers.map(c=>[c.customerId,c]));
 const byDelivery=new Map(directory.customers.flatMap(c=>(c.deliveryProfiles||[]).map(p=>[p.customerId,c])));
 const apiIds=new Set(api.customers.map(c=>c.customerId));
 let conflicts=0,addedProfiles=0;
 for(const raw of supabase.customers){
  const normalized=normalizeCombinedMatterDirectory([raw],{customers:[],report:{}},{observedAt:supabase.observedAt,expectedRemoteRecords:1}).customers[0];
  const profile=normalized.deliveryProfiles[0];
  let customer=byDelivery.get(profile.customerId)||customers.get(normalized.customerId);
  const isNew=!customer;
  // An absent source Matter ID cannot contradict an already verified delivery alias.
  // Only an explicit incoming Matter ID can conflict with its retained owner.
  const conflict=Boolean(customer&&normalized.matterCustomerId&&customer.customerId!==normalized.customerId);
  if(isNew){customer=normalized;customers.set(customer.customerId,customer);}
  const updatedAt=raw.updatedAt?.$date||raw.updatedAt||null;
  const newer=Number.isFinite(Date.parse(updatedAt))&&Number.isFinite(Date.parse(customer.sourceObservedAt))&&Date.parse(updatedAt)>Date.parse(customer.sourceObservedAt);
  const eligible=!conflict&&(isNew||newer);
  const observation={...profile,sourceRecordId:raw.sourceRecordId||'',observedAt:supabase.observedAt,sourceUpdatedAt:updatedAt,historicalStoredCopy:true,upstreamLiveSyncVerified:false,identityConflict:conflict,eligibleForAutomaticMatching:eligible};
  customer.supabaseProfiles=[...(customer.supabaseProfiles||[]).filter(p=>p.customerId!==profile.customerId),observation];
  customer.sourceStates={...customer.sourceStates,supabase:{state:'available',observedAt:supabase.observedAt,historicalStoredCopy:true,upstreamLiveSyncVerified:false}};
  if(conflict){conflicts++;customer.identityNeedsReview=true;continue;}
  if(!byDelivery.has(profile.customerId)){
   if(!isNew){customer.deliveryProfiles=[...(customer.deliveryProfiles||[]),{...profile,eligibleForAutomaticMatching:eligible}];customer.deliveryCustomerIds=[...new Set([...(customer.deliveryCustomerIds||[]),profile.customerId])];customer.sourceAliases=[...new Set([...(customer.sourceAliases||[]),`delivery:${profile.customerId}`])];}
   byDelivery.set(profile.customerId,customer);addedProfiles++;
  }
  if(eligible){
   const contact={name:profile.name,email:profile.email,phone:profile.phone};
   if(!customer.profileObservations.some(p=>JSON.stringify(p)===JSON.stringify(contact)))customer.profileObservations.push(contact);
   if(!apiIds.has(customer.customerId)){for(const field of ['name','email','phone'])if(profile[field])customer[field]=profile[field];customer.sourceObservedAt=updatedAt||supabase.observedAt;}
  }
 }
 directory.customers=[...customers.values()];
 directory.report={...directory.report,totalRemoteRecords:directory.report.totalRemoteRecords+addedProfiles,uniqueCustomers:customers.size,supabaseIdentityConflicts:conflicts,supabaseCustomers:supabase.count};
 return directory;
}
