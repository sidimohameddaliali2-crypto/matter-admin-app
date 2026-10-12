// Identity rules for the customer upload endpoints (issue #4).
//
// customerId is stored as a plain string on 9 other collections (Delivery,
// DeliveryChange, Bag, MenuSelectionRecord, ...), so changing it on the
// Customer alone orphans all of that history. An upload must therefore never
// change an EXISTING customer's customerId — an intended rename goes through
// PATCH /api/customers/:id/rename-id, which cascades to every collection.
//
// `byEmail` / `byId` are the existing Customer matching the row's email
// (case-insensitive) and the row's customerId — either may be null.
//
// Returns one of:
//   { action: 'create' }                      neither exists
//   { action: 'update', customer }            safe: the ID stays as it is
//   { action: 'conflict', reason, ... }       needs a human; mutate nothing
export function classifyUploadRow({ customerId, idGenerated = false }, { byEmail = null, byId = null }) {
  if (!byEmail && !byId) return { action: 'create' };

  if (byEmail && byId) {
    if (String(byEmail._id) === String(byId._id)) return { action: 'update', customer: byId };
    return {
      action: 'conflict',
      reason: `email belongs to ${byEmail.customerId} but customer ID "${customerId}" belongs to a different customer (${byId.customerId})`,
      existingCustomerId: byEmail.customerId,
      otherCustomerId: byId.customerId
    };
  }

  if (byId) return { action: 'update', customer: byId };

  // Email exists under another customerId. A generated ID (legacy emails-only
  // upload) carries no intent, so just match the person by email.
  if (idGenerated || byEmail.customerId === customerId) return { action: 'update', customer: byEmail };
  return {
    action: 'conflict',
    reason: `this email already belongs to ${byEmail.customerId}; supplied customer ID "${customerId}" was not applied (use Rename ID to change an ID)`,
    existingCustomerId: byEmail.customerId,
    otherCustomerId: null
  };
}
