import { bagIdAliases } from './bagInventoryAudit.js';

// Preserve existing records and receipts. Never rename stock or choose between
// two physical inventory records that happen to share an equivalent label.
export async function findRegisteredBag(collection, code) {
  const matches=(await Promise.all(bagIdAliases(code).map(bagId=>collection.findOne({bagId})))).filter(Boolean);
  const distinct=new Map(matches.map(bag=>[String(bag._id),bag]));
  if(distinct.size>1)throw Object.assign(new Error('Multiple stock records match this bag label. Dispatch must reconcile the duplicate records.'),{statusCode:409});
  return distinct.values().next().value||null;
}
