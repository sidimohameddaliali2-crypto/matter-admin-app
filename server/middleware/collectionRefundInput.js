// Ordinary delivery edits (including whole-record forms) cannot overwrite the
// manager-owned refund ledger. Only /collections/:id/refund writes these fields.
export function removeClientCollectionRefund(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (key.split('.').includes('collectionRefund')) { delete value[key]; continue; }
    if (key === '$rename' && value[key] && typeof value[key] === 'object') {
      for (const [source, destination] of Object.entries(value[key])) {
        if (source.split('.').includes('collectionRefund') || String(destination).split('.').includes('collectionRefund')) delete value[key][source];
      }
    }
    removeClientCollectionRefund(value[key]);
  }
}
export function protectCollectionRefundInput(req, _res, next) { removeClientCollectionRefund(req.body); next(); }
