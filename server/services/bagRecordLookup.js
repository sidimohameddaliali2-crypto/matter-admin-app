import { bagIdAliases } from './bagInventoryAudit.js';

// Preserve existing records and receipts. Never rename stock or choose between
// two physical inventory records that happen to share an equivalent label.
export async function findRegisteredBag(collection, code, session) {
  const aliases = bagIdAliases(code);
  const matches = session
    ? await collection.find({bagId:{$in:aliases}}, {session}).limit(3).toArray()
    : (await Promise.all(aliases.map(bagId => collection.findOne({bagId})))).filter(Boolean);
  const distinct=new Map(matches.map(bag=>[String(bag._id),bag]));
  if(distinct.size>1)throw Object.assign(new Error('Multiple stock records match this bag label. Dispatch must reconcile the duplicate records.'),{statusCode:409});
  return distinct.values().next().value||null;
}
