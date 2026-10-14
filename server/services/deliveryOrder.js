import { createHash } from 'node:crypto';

export function orderRevision(rows) {
  return createHash('sha256').update(JSON.stringify(rows.map(d => [
    String(d._id), d.routeOrder ?? null, d.updatedAt, d.status
  ]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
}

export function validateOrder(rows, ids, revision) {
  if (revision !== orderRevision(rows)) return 'The route changed. Reload it before saving.';
  const existing = new Set(rows.map(d => String(d._id)));
  if (!Array.isArray(ids) || ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some(id => !existing.has(id))) {
    return 'Include every delivery for this driver and date exactly once.';
  }
  return null;
}
