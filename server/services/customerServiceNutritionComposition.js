import { readNutritionCustomerDirectory } from './customerServiceNutritionDirectory.js';
import { readMatterCustomerDirectory } from './customerServiceMatterDirectory.js';

function indexed(directory) {
  if (!Array.isArray(directory?.customers) || directory.report?.uniqueCustomers !== directory.customers.length || !Number.isFinite(Date.parse(directory.report?.observedAt))) throw new Error('Unreconciled source directory');
  const result = new Map();
  for (const customer of directory.customers) {
    if (typeof customer.matterCustomerId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(customer.matterCustomerId) || customer.customerId !== `matter:${customer.matterCustomerId}` || result.has(customer.customerId) || !Array.isArray(customer.subscriptions)) throw new Error('Invalid canonical source identity');
    result.set(customer.customerId, customer);
  }
  return result;
}

// Only the source's explicit Matter ID joins these directories. Names, emails
// and phones are retained as observations and never establish a directory join.
export function combineNutritionAndMatterDirectories(nutrition, api, { observedAt = new Date().toISOString() } = {}) {
  const admin = indexed(nutrition), subscriptions = indexed(api);
  if (!nutrition.report.reconciled || !nutrition.report.fullAdminCustomerDirectory || nutrition.report.sourceCustomerTotal !== admin.size || !api.report.sourcePagesExhausted || !Number.isFinite(Date.parse(observedAt))) throw new Error('Complete source directories are required');
  const uniqueSubscriptionIds = new Set();
  for (const c of subscriptions.values()) for (const s of c.subscriptions) {
    if (typeof s.id !== 'string' || !s.id || uniqueSubscriptionIds.has(s.id)) throw new Error('Duplicate or missing subscription identity');
    uniqueSubscriptionIds.add(s.id);
  }
  if (uniqueSubscriptionIds.size !== api.report.sourceSubscriptionTotal) throw new Error('Subscription totals do not reconcile');
  const keys = [...new Set([...admin.keys(), ...subscriptions.keys()])];
  const customers = keys.map(key => {
    const n = admin.get(key), a = subscriptions.get(key), profileObservations = [];
    for (const source of [n,a].filter(Boolean)) {
      const candidates = [{ name:source.name||'', email:source.email||'', phone:source.phone||'' }, ...(source.profileObservations||[])];
      // Preserve either phone even when a supplied normalized observation list
      // omitted it; no prefix guessing or scientific-notation conversion.
      for (const phone of [source.telephone,source.whatsappNumber].filter(p=>typeof p==='string'&&p)) candidates.push({name:source.name||'',email:source.email||'',phone});
      for (const p of candidates) if (!profileObservations.some(existing=>JSON.stringify(existing)===JSON.stringify(p))) profileObservations.push(structuredClone(p));
    }
    const values = field => new Set(profileObservations.map(p=>p[field]).filter(Boolean));
    return { ...structuredClone(a||{}), ...structuredClone(n||{}), customerId:key, matterCustomerId:(n||a).matterCustomerId,
      name:n?.name||a?.name||'', email:n?.email||a?.email||'', phone:n?.phone||a?.phone||'',
      subscriptions:structuredClone(a?.subscriptions||[]), profileObservations,
      identityNeedsReview:[...['name','email','phone']].some(field=>values(field).size>1),
      subscriptionCoverage:a?'returned_api_subscriptions':'no_returned_api_subscriptions',
      source:'nutrition_admin_and_matter_api',sourceCoverage:'nutrition_admin_customer_directory_and_subscription_customers',sourceObservedAt:observedAt,
      sourceStates:{nutritionAdmin:{state:n?'available':'not_returned',observedAt:nutrition.report.observedAt},api:{state:a?'available':'not_returned',observedAt:api.report.observedAt}},
    };
  });
  const report = { source:'nutrition_admin_and_matter_api', observedAt, uniqueCustomers:customers.length,
    nutritionCustomers:admin.size, apiCustomers:subscriptions.size, sourceSubscriptionTotal:api.report.sourceSubscriptionTotal,
    apiCustomersAbsentFromAdmin:[...subscriptions.keys()].filter(k=>!admin.has(k)).length,
    adminCustomersWithoutReturnedSubscriptions:[...admin.keys()].filter(k=>!subscriptions.has(k)).length,
    nutritionObservedAt:nutrition.report.observedAt,apiObservedAt:api.report.observedAt,
    nutritionRead:structuredClone(nutrition.report),apiRead:structuredClone(api.report),
    fullCustomerDirectory:true,fullAdminCustomerDirectory:true,sourcePagesExhausted:true,atomicSnapshot:false,
    coverage:'nutrition_admin_customer_directory_and_subscription_customers',
    customersWithPhone:customers.filter(c=>c.phone).length,profileConflicts:customers.filter(c=>c.identityNeedsReview).length,
    limitations:['The unfiltered Nutrition admin customer directory is complete according to its reconciled pagination; API-only identities are also retained.','No returned API subscription does not establish an inactive customer; the admin active flag remains a separate source observation.','Only exact Matter customer IDs join sources. Conflicting profile observations are preserved.','Independent source reads do not form an atomic snapshot.',...(nutrition.report.limitations||[]),...(api.report.limitations||[])] };
  return { customers:customers.map(c=>({...c,sourceReport:report})), report };
}

export async function readMatterCustomerDirectoryWithNutrition({ env=process.env,fetchImpl=fetch,clock=()=>new Date().toISOString(),readNutrition=readNutritionCustomerDirectory,readApi=readMatterCustomerDirectory }={}) {
  // Wait for both bounded readers even on failure; no partial admin generation
  // or credential-bearing upstream error is returned to persistence callers.
  const results = await Promise.allSettled([
    Promise.resolve().then(()=>readNutrition({env,fetchImpl,clock})),
    Promise.resolve().then(()=>readApi({env,fetchImpl,clock,includeDetails:true})),
  ]);
  if(results.some(r=>r.status!=='fulfilled')) throw new Error('Complete Nutrition and Matter directory read failed; previous directory must be retained.');
  return combineNutritionAndMatterDirectories(results[0].value,results[1].value,{observedAt:new Date(clock()).toISOString()});
}
