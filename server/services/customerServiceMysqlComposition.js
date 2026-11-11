// Full database customer profiles and subscription API records have independent
// observation times. Only their explicit canonical Matter IDs may join.
export function combineMysqlAndApiDirectories(mysql, api) {
 if(!Array.isArray(mysql?.customers)||mysql.report?.sourceCustomerTotal!==mysql.customers.length||!mysql.report.reconciled||!mysql.report.fullCustomerDirectory||!mysql.report.sourcePagesExhausted||!Number.isFinite(Date.parse(mysql.report.observedAt)))throw Error('Incomplete full customer source');
 const customers=new Map(api.customers.map(c=>[c.customerId,structuredClone(c)]));
 const seen=new Set();
 for(const raw of mysql.customers){
  if(!raw.matterCustomerId||raw.customerId!==`matter:${raw.matterCustomerId}`||seen.has(raw.customerId))throw Error('Invalid full customer identity');seen.add(raw.customerId);
  const a=customers.get(raw.customerId),observations=[];
  for(const source of [raw,a].filter(Boolean))for(const observation of [{name:source.name||'',email:source.email||'',phone:source.phone||''},...(source.profileObservations||[])])if(!observations.some(p=>JSON.stringify(p)===JSON.stringify(observation)))observations.push(structuredClone(observation));
  customers.set(raw.customerId,{...a,...structuredClone(raw),name:raw.name||a?.name||'',email:raw.email||a?.email||'',phone:raw.phone||a?.phone||'',subscriptions:a?.subscriptions||[],profileObservations:observations,eligibleForAutomaticMatching:true,sourceStates:{...a?.sourceStates,nutritionDatabase:{state:'available',observedAt:mysql.report.observedAt},api:a?{state:'available',observedAt:api.report.observedAt}:{state:'not_returned',observedAt:api.report.observedAt}},source:'nutrition_mysql_and_matter_api',sourceCoverage:'nutrition_database_customers_and_subscription_customers',sourceObservedAt:mysql.report.observedAt,subscriptionCoverage:a?'returned_api_subscriptions':'no_returned_api_subscriptions'});
 }
 return{customers:[...customers.values()],report:{...api.report,observedAt:api.report.observedAt}};
}
