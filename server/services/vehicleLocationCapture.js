// Pure capture classification. Repeat observations remain in raw history.
const date = value => {
  if (!(value instanceof Date) && (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value))) return null;
  const parsed = new Date(value);
  return Number.isFinite(+parsed) ? parsed : null;
};
const text = value => typeof value === 'string' ? value : null;

export function buildVehicleLocationSamples({ fleet, drivers, recordedAt, mappingAvailable = true }) {
  const receipt = date(recordedAt);
  if (!Array.isArray(fleet) || !Array.isArray(drivers) || !receipt) throw new Error('Valid capture inputs required');
  const mappings = new Map();
  for (const driver of drivers) {
    const vehicle = String(driver.profile?.truckoomVehicleNo || '').trim();
    if (!vehicle || !driver._id) continue;
    if (!mappings.has(vehicle)) mappings.set(vehicle, new Set());
    mappings.get(vehicle).add(String(driver._id));
  }
  const rows = [], summary = { fleetRows: fleet.length, storedRows: 0, rejectedRows: 0, missingFixClock: 0, staleFixObservations: 0, futureClock: 0, ambiguousDriver: 0, invalidCoordinates: 0, unusablePositionRows: 0, rejectedVehicles: [] };
  for (const vehicle of fleet) {
    const vehicleNo = String(vehicle.vehicleNo || '').trim();
    if (!vehicleNo) {
      summary.rejectedRows++;
      summary.rejectedVehicles.push({ vehicleNo: null, reason: 'missing_vehicle_identity', sourceReceipt: vehicle.sourceReceipt || null });
      continue;
    }
    const rawLatitude = vehicle.rawCoordinates?.latitude ?? vehicle.latitude;
    const rawLongitude = vehicle.rawCoordinates?.longitude ?? vehicle.longitude;
    const latitude = Number.isFinite(rawLatitude) ? rawLatitude : null;
    const longitude = Number.isFinite(rawLongitude) ? rawLongitude : null;
    const flags = [...(vehicle.sourceQualityFlags || [])], gpsTime = date(vehicle.gpsTime), trackerServerTime = date(vehicle.trackerServerTime);
    const driverCandidates = [...(mappings.get(vehicleNo) || [])].sort();
    if (!gpsTime) { flags.push('missing_fix_clock'); summary.missingFixClock++; }
    const fixAgeMs = gpsTime ? +receipt - +gpsTime : null;
    const sourceReceivedAt = date(vehicle.sourceReceipt?.responseReceivedAt) || receipt;
    if (gpsTime && +gpsTime > +sourceReceivedAt) { flags.push('future_fix_clock'); summary.futureClock++; }
    if (fixAgeMs !== null && fixAgeMs > 300000) { flags.push('last_known_fix_older_than_5m'); summary.staleFixObservations++; }
    if (latitude === null || longitude === null) { flags.push('missing_or_nonfinite_position'); summary.unusablePositionRows++; }
    else if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) { flags.push('invalid_coordinates'); summary.invalidCoordinates++; summary.unusablePositionRows++; }
    if (driverCandidates.length > 1) { flags.push('ambiguous_driver_mapping'); summary.ambiguousDriver++; }
    else if (!driverCandidates.length) flags.push(mappingAvailable ? 'missing_driver_mapping' : 'driver_mapping_unavailable');
    rows.push({ vehicleNo, driver: driverCandidates.length === 1 ? driverCandidates[0] : null,
      driverCandidates, driverMappingState: driverCandidates.length === 1 ? 'current_mapping_snapshot' : driverCandidates.length ? 'ambiguous_current_mapping' : mappingAvailable ? 'unmapped' : 'unavailable',
      latitude, longitude, recordedAt: receipt, gpsTime,
      sourceReceipt: vehicle.sourceReceipt || null, sourceRow: vehicle.sourceRow ?? null,
      trackerServerTime, rawGpsTime: text(vehicle.rawGpsTime), rawTrackerServerTime: text(vehicle.rawTrackerServerTime),
      speedKph: Number.isFinite(vehicle.speedKph) ? vehicle.speedKph : null,
      ignition: text(vehicle.ignition), trackerStatus: text(vehicle.trackerStatus), locationSource: text(vehicle.locationSource),
      fixAgeMs, qualityFlags: flags });
  }
  summary.storedRows = rows.length;
  return { rows, summary };
}

export function createVehicleLocationRecorder({ isConfigured, getFleet, getDrivers, insertRows,
  store, intervalMs = 60000, clock = () => new Date(), onResult = () => {}, onError = () => {} }) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60000) throw new Error('Capture interval must be at least one minute');
  let running = false;
  const report = result => { try { onResult(result); } catch { /* Evidence is already acknowledged. */ } return result; };
  const failed = error => { try { onError(error); } catch { /* Keep the original storage outcome. */ } };
  return async function recordOnce() {
    if (!isConfigured()) return { status: 'not-configured' };
    if (running) return { status: 'already-running' };
    running = true;
    let lease;
    try {
      if (store) {
        const pending = await store.claimPending();
        if (pending) {
          try { report(await store.persistBatch(pending)); }
          catch (error) { await store.release(pending, error.code); failed(error); }
        }
        const tickAt = new Date(Math.floor(+clock() / intervalMs) * intervalMs);
        lease = await store.claimTick(tickAt);
        if (!lease) return { status: 'already-claimed' };
      }
      const [fleetResult, driverResult] = await Promise.allSettled([getFleet(), getDrivers()]);
      if (fleetResult.status !== 'fulfilled') throw fleetResult.reason;
      const mappingAvailable = driverResult.status === 'fulfilled';
      const fleet = fleetResult.value;
      if (fleet.captureEvidenceStatus && fleet.captureEvidenceStatus !== 'retained') {
        throw Object.assign(new Error('GPS source evidence was not retained'), { code: 'GPS_ARCHIVE_UNAVAILABLE' });
      }
      const { rows, summary } = buildVehicleLocationSamples({ fleet,
        drivers: mappingAvailable ? driverResult.value : [], mappingAvailable, recordedAt: clock() });
      summary.mappingAvailable = mappingAvailable;
      if (store) {
        const receipts = [...fleet.map(v => v.sourceReceipt), fleet.sourceReceipt].filter(Boolean);
        const sourceReferences = [...new Map(receipts.map(ref => [ref.receiptId, ref])).values()];
        lease = await store.saveBatch(lease, { rows, summary, sourceReferences });
        return report(await store.persistBatch(lease));
      }
      if (rows.length) await insertRows(rows);
      return report({ status: 'complete', ...summary });
    } catch (error) {
      if (lease) { try { await store.release(lease, error.code); } catch { /* Lease expiry enables recovery. */ } }
      failed(error);
      return { status: 'failed' };
    } finally { running = false; }
  };
}
