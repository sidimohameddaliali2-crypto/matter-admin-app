// Delivery forms can submit a whole record. Ignore the server-owned financial
// capture so ordinary edits can neither forge nor erase historical pricing.
export function removeClientMatterRevenue(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (key.split('.').includes('matterRevenue')) { delete value[key]; continue; }
    if (key === '$rename' && value[key] && typeof value[key] === 'object') {
      for (const [source, destination] of Object.entries(value[key])) {
        if (source.split('.').includes('matterRevenue') || String(destination).split('.').includes('matterRevenue')) delete value[key][source];
      }
    }
    removeClientMatterRevenue(value[key]);
  }
}
export function protectMatterRevenueInput(req, _res, next) {
  removeClientMatterRevenue(req.body);
  next();
}
