// Coverage only: no timing or severity rules are applied until the original package is reconciled.
const fail = message => { throw new Error(message); };
export const reportingDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;

const categories = ['Awaiting assessment', 'Photo missing', 'GPS missing', 'Date missing'];
const validateCoverageSnapshot = s => {if(s?.kind !== 'matter-reporting-coverage-v1' || s.assessmentAvailable !== false || s.ruleVersion !== null || !Array.isArray(s.deliveries) || !Array.isArray(s.issues)) fail('Reporting source is unavailable.');};
function filters(input, snapshot) {
  const allowed = new Set(['from', 'to', 'driver', 'category', 'status', 'search', 'dateBasis']);
  if (Object.keys(input).some(k => !allowed.has(k))) fail('Unsupported report filter.');
  const f = {from: input.from || snapshot.source.query.dateFrom, to: input.to || snapshot.source.query.dateTo, driver: input.driver || '', category: input.category || '', status: input.status || '', search: input.search || '', dateBasis: input.dateBasis || 'service'};
  if (!reportingDate(f.from) || !reportingDate(f.to) || f.from > f.to || !['service', 'undated'].includes(f.dateBasis) || typeof f.search !== 'string' || f.search.length > 200 || typeof f.driver !== 'string' || f.driver.length > 200 || f.category && !categories.includes(f.category) || f.status && !['unreviewed', 'open', 'investigating', 'resolved', 'needs_evidence'].includes(f.status)) fail('Choose valid service dates and report filters.');
  return f;
}
function reviewView(events, issueId) {
  const history = events.filter(e => e.data.issueId === issueId);
  return {revision: history.length, status: history.at(-1)?.data.status || 'unreviewed', latest: history.at(-1) || null, history};
}
export function selectReportingPopulation(snapshot, input = {}, events = []) {
  validateCoverageSnapshot(snapshot);
  events=events.filter(e=>e.data.snapshotHash===snapshot.snapshotHash);
  const f = filters(input, snapshot), search = f.search.toLocaleLowerCase('en');
  const scopeRows = snapshot.deliveries.filter(r => (f.dateBasis === 'undated' ? !r.serviceDate : r.serviceDate && r.serviceDate >= f.from && r.serviceDate <= f.to) && (!f.driver || r.driverId === f.driver) && (!search || [r.customerName, r.driverName, r.id].some(v => v.toLocaleLowerCase('en').includes(search))));
  const scopedIds = new Set(scopeRows.map(r => r.id));
  const issues = snapshot.issues.filter(i => scopedIds.has(i.deliveryId) && (!f.category || i.category === f.category)).map(i => ({...i, review: reviewView(events, i.id)})).filter(i => !f.status || i.review.status === f.status);
  const issueIds = new Set(issues.map(i => i.deliveryId));
  const deliveries = f.category || f.status ? scopeRows.filter(r => issueIds.has(r.id)) : scopeRows;
  const rowMap = new Map(deliveries.map(r => [r.id, r]));
  const drivers = [...new Map(deliveries.map(r => [r.driverId, {id: r.driverId, name: r.driverName}])).values()].map(driver => {
    const own = deliveries.filter(r => r.driverId === driver.id), ownIds = new Set(own.map(r => r.id));
    return {...driver, total: own.length, assessed: 0, missingPhotos: own.filter(r => !r.photoReferencePresent).length, missingGps: own.filter(r => !r.sourceGpsPresent).length, cases: issues.filter(i => ownIds.has(i.deliveryId)).length, timingTiers: null, unusablePhotos: null};
  }).sort((a, b) => a.name.localeCompare(b.name));
  const summary = {deliveries: deliveries.length, assessed: 0, timingEligible: null, uploadsInWindow: null, physicalOnTime: null,
    photosReferenced: deliveries.filter(r => r.photoReferencePresent).length,
    photosCached: deliveries.filter(r => r.photoState === 'cached_unreviewed').length,
    missingPhotos: deliveries.filter(r => !r.photoReferencePresent).length,
    missingGps: deliveries.filter(r => !r.sourceGpsPresent).length,
    coverageCases: issues.length, uniqueRecordsInCases: issueIds.size,
    unreviewedCases: issues.filter(i => i.review.status === 'unreviewed').length,
    undatedSourceRecords: snapshot.deliveries.filter(r => !r.serviceDate).length,
  };
  return {kind: snapshot.kind, snapshotHash: snapshot.snapshotHash, source: snapshot.source, filters: f, summary, drivers, deliveries,
    cases: issues.map(i => ({...i, delivery: rowMap.get(i.deliveryId)})),
    driverOptions: [...new Map(snapshot.deliveries.map(r => [r.driverId, {id: r.driverId, name: r.driverName}])).values()].sort((a, b) => a.name.localeCompare(b.name)),
    categories, limitations: snapshot.limitations, assessmentAvailable: false, ruleVersion: null, usage: snapshot.usage,
    comparison: snapshot.source.query.dateFrom === '2026-10-19' && snapshot.source.query.dateTo === '2026-10-25' ? {label: 'Population reconciliation pending', handoffWeeklyRecords: 1428, capturedWeeklyRecords: snapshot.deliveries.length, difference: snapshot.deliveries.length - 1428, classification: 'unreconciled_population', note: 'Whole archive, independent of current filters. This is a count comparison to the handoff, not a matched-record or policy-change comparison.'} : null};
}

const csvCell = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"';
export function reportingCsv(view) {
  const header = ['Service date', 'Fulfillment date', 'Driver', 'Customer', 'Case', 'Tier', 'Minutes', 'Source schedule', 'App completion', 'Proof timestamp - meaning unconfirmed', 'Photo capture', 'Server receipt', 'Visit arrival', 'Visit departure', 'Photo state', 'Review status', 'Responsible person', 'Follow-up date', 'Response', 'Delivery ID', 'Case ID', 'Snapshot SHA-256'];
  const rows = view.cases.map(c => {const r = c.delivery, a = c.review.latest?.data;return [r.serviceDate, r.fulfillmentDate, r.driverName, r.customerName, c.title, 'Ungraded', '', r.scheduledTime, r.appCompletionTime, r.proofTimestamp, '', '', '', '', r.photoState, c.review.status, a?.responsiblePerson, a?.followUpDate, a?.response, r.id, c.id, view.snapshotHash];});
  return '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
