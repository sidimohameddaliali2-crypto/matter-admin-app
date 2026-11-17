// These models already own detailed source observations and retry/lease history.
// Business activity must not duplicate a continuously sampled GPS evidence feed.
const observationModels = new Set([
  'VehicleLocationHistory', 'VehicleLocationCaptureBatch', 'TrackerSyncLease',
  'TruckoomGpsReceipt', 'TruckoomTrackHistory', 'TrackerGeofenceEvent', 'TruckoomLiveSnapshot',
]);
export const shouldAuditModel = name => !observationModels.has(name);

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
