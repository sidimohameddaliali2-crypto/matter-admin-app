// Shared read projections. Internal archive payloads never belong in API views.
export function driverMappings(drivers) {
  const groups = new Map();
  for (const driver of drivers) {
    const vehicle = String(driver.profile?.truckoomVehicleNo || '').trim();
    if (!vehicle || !driver._id) continue;
    if (!groups.has(vehicle)) groups.set(vehicle, new Map());
    groups.get(vehicle).set(String(driver._id), driver);
  }
  return new Map([...groups].map(([vehicle, candidates]) => [vehicle, {
    driver: candidates.size === 1 ? [...candidates.values()][0] : null,
    state: candidates.size === 1 ? 'current_mapping_snapshot' : 'ambiguous_current_mapping',
  }]));
}

export function captureMetadata(point) {
  if (point.driverMappingState === undefined && point.trackerServerTime === undefined
    && point.speedKph === undefined && point.captureBatchId === undefined) return undefined;
  const ref = point.sourceReceipt;
  return {
    trackerServerTime: point.trackerServerTime || null,
    rawGpsTime: point.rawGpsTime ?? null, rawTrackerServerTime: point.rawTrackerServerTime ?? null,
    speedKph: Number.isFinite(point.speedKph) ? point.speedKph : null,
    ignition: point.ignition ?? null, trackerStatus: point.trackerStatus ?? null,
    locationSource: point.locationSource ?? null, qualityFlags: point.qualityFlags || [],
    fixAgeMs: Number.isFinite(point.fixAgeMs) ? point.fixAgeMs : null,
    driverMappingState: point.driverMappingState ?? null,
    driverCandidates: (point.driverCandidates || []).map(String),
    sourceReceipt: ref ? { receiptId: ref.receiptId, sha256: ref.sha256,
      kind: ref.kind, responseReceivedAt: ref.responseReceivedAt } : null,
    sourceRow: point.sourceRow ?? null,
    batchId: point.captureBatchId ?? null, batchRow: point.captureRow ?? null,
    physicalDriverIdentityConfirmed: false,
  };
}

export const CAPTURE_FIELDS = 'trackerServerTime rawGpsTime rawTrackerServerTime speedKph ignition trackerStatus locationSource qualityFlags fixAgeMs driverMappingState driverCandidates sourceReceipt sourceRow captureBatchId captureRow';
