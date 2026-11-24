// These models already own detailed source observations and retry/lease history.
// Business activity must not duplicate a continuously sampled GPS evidence feed.
const observationModels = new Set([
  'VehicleLocationHistory', 'VehicleLocationCaptureBatch', 'TrackerSyncLease',
  'TruckoomGpsReceipt', 'TruckoomTrackHistory', 'TrackerGeofenceEvent', 'TruckoomLiveSnapshot',
  'ReportingCounter', 'ReportingOutbox',
]);
export const shouldAuditModel = name => !observationModels.has(name);

// The two-minute tracker verdict refresh retains its terminal audit result.
// Defer only its duplicate full pre-write snapshot; never classify a human or
// mixed business update as background tracker maintenance.
export function isAutomaticTrackerVisit(context, model, operation, update = {}, options = {}) {
  if (context?.job !== 'customer-tracker-visits' || context.request || context.actionId
    || model !== 'Delivery' || operation !== 'updateOne' || options.upsert) return false;
  if (!update.$set?.trackerVisit || typeof update.$set.trackerVisit !== 'object' || Array.isArray(update.$set.trackerVisit)) return false;
  return Object.keys(update).every(key => ['$set', '$setOnInsert'].includes(key))
    && Object.keys(update.$set).every(key => ['trackerVisit', 'trackerVisitGpsBaseline', 'updatedAt'].includes(key))
    && Object.keys(update.$setOnInsert || {}).every(key => key === 'createdAt');
}

export function isLocationOnlyUpdate(update = {}) {
  if (!update.$set || !Object.hasOwn(update.$set, 'location')) return false;
  if (Object.keys(update).some(operator => !['$set', '$setOnInsert'].includes(operator))) return false;
  return Object.keys(update.$set).every(field => ['location', 'updatedAt'].includes(field)) &&
    Object.keys(update.$setOnInsert || {}).every(field => field === 'createdAt');
}

export function isAutomaticDriverLocation(req) {
  const actor = req?.activityActor;
  return Boolean(req?.method === 'PUT' && actor?.role === 'driver' &&
    actor.id === String(req.params?.id || '') && !req.activityContext?.actionId &&
    /^\/api\/(?:users\/)?drivers\/:id\/location$/.test(req.activityRoute?.path || ''));
}
