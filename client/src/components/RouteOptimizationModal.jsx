import React, { useRef, useState } from 'react';
import { X, Route, MapPin, AlertTriangle, Loader2, Repeat, Printer, Clock, CheckCircle2, Truck, GripVertical } from 'lucide-react';
import api from '../utils/api';
import { activityReference, recordActivityChange } from '../utils/activityCapture';

// "HH:MM" <-> seconds-from-midnight, for the departure-time and hub-ready
// inputs (plain <input type="time"> fields).
const clockToSeconds = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
};
const secondsToClock = (seconds) => {
  if (seconds == null) return '';
  const h = Math.floor(seconds / 3600) % 24;
  const m = Math.round((seconds % 3600) / 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

// Seconds-from-midnight -> "HH:MM" (12h) for showing ETAs.
const formatClock = (seconds) => {
  if (seconds == null) return null;
  let h = Math.floor(seconds / 3600) % 24;
  const m = Math.round((seconds % 3600) / 60);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
};

const scheduledClock = (iso) => {
  if (!iso) return null;
  // scheduledTime is stored UTC for a Dubai (UTC+4) business time.
  const d = new Date(new Date(iso).getTime() + 240 * 60000);
  return formatClock(d.getUTCHours() * 3600 + d.getUTCMinutes() * 60);
};

const getDriverDisplayName = (driver) => {
  if (!driver) return 'Unnamed driver';
  const parts = [driver.profile?.firstName, driver.profile?.lastName].filter(Boolean);
  return parts.join(' ') || driver.email || 'Unnamed driver';
};

// Builds a single Google Maps multi-stop navigation link for a driver's
// ordered route — no Directions API needed, this is just a URL scheme
// Google Maps already supports. Google's URLs API caps this at 9 waypoints
// on desktop (only 3 on mobile browsers) — this is opened from the
// dispatcher's desktop preview, so 9 is the relevant ceiling. Beyond that,
// the link is left out rather than silently generating a broken/truncated
// one; the per-stop order in the list below still fully reflects the plan.
const MAX_WAYPOINTS_DESKTOP = 9;

const buildMultiStopMapsLink = (stops) => {
  if (!stops.length || stops.length > MAX_WAYPOINTS_DESKTOP + 1) return null;
  const encoded = stops.map((s) => encodeURIComponent(s.address || s.customerName || ''));
  const destination = encoded[encoded.length - 1];
  const waypoints = encoded.slice(0, -1).join('|');
  const params = new URLSearchParams({ api: '1', destination });
  if (waypoints) params.set('waypoints', waypoints);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
};

// Planned times are "seconds from shift start" (the optimizer doesn't know
// the clock time a shift begins), so they're shown as an offset into the
// shift rather than a wall-clock time.
const formatShiftOffset = (seconds) => {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `+${h}h${String(m).padStart(2, '0')}`;
};

const formatMinutes = (seconds) => `${Math.round((seconds || 0) / 60)} min`;

function KitchenReturnRow({ kitchenReturn }) {
  const bags = kitchenReturn.deliveryIds?.length || 0;
  return (
    <li className="flex items-start gap-3 px-4 py-2.5 text-sm bg-amber-50 border-y border-amber-100">
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-amber-200 text-amber-800 flex items-center justify-center mt-0.5">
        <Repeat className="w-3 h-3" />
      </span>
      <div className="min-w-0">
        <p className="font-medium text-amber-900">
          Ride back to the kitchen for trip 2 ({bags} {bags === 1 ? 'bag' : 'bags'})
        </p>
        <p className="text-xs text-amber-700">
          No van needed — adds ~{formatMinutes(kitchenReturn.detourSeconds)} for the round trip and reload
        </p>
      </div>
    </li>
  );
}

function HandoffRow({ handoff, role }) {
  const counterpart = role === 'bike' ? handoff.vanName : handoff.bikeName;
  const bags = handoff.deliveryIds?.length || 0;
  return (
    <li className="flex items-start gap-3 px-4 py-2.5 text-sm bg-violet-50 border-y border-violet-100">
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-violet-200 text-violet-800 flex items-center justify-center mt-0.5">
        <Repeat className="w-3 h-3" />
      </span>
      <div className="min-w-0">
        <p className="font-medium text-violet-900">
          {role === 'bike'
            ? `Collect trip 2 (${bags} ${bags === 1 ? 'bag' : 'bags'}) from ${counterpart}`
            : `Hand over ${bags} ${bags === 1 ? 'bag' : 'bags'} to ${counterpart}`}
        </p>
        <p className="text-violet-700 truncate flex items-center gap-1">
          <MapPin className="w-3 h-3 flex-shrink-0" />
          {handoff.meetingPoint?.name || 'Meeting point'}
          {handoff.meetingPoint?.poiType === 'unsnapped' ? ' (no petrol station/parking nearby — meet at the van stop)' : ''}
        </p>
        <p className="text-xs text-violet-600">
          {role === 'bike' ? 'Bike' : 'Van'} arrives {formatShiftOffset(role === 'bike' ? handoff.plannedBikeArrivalSeconds : handoff.plannedVanArrivalSeconds)} into shift
          {' · '}{counterpart} {formatShiftOffset(role === 'bike' ? handoff.plannedVanArrivalSeconds : handoff.plannedBikeArrivalSeconds)}
          {' · '}expected wait {formatMinutes(handoff.expectedWaitSeconds)}
        </p>
      </div>
    </li>
  );
}

export default function RouteOptimizationModal({ open, onClose, deliveries = [], drivers = [], onApplied, initialSelectedDriverIds = [] }) {
  const [selectedDriverIds, setSelectedDriverIds] = useState(initialSelectedDriverIds);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [plan, setPlan] = useState(null);
  // One-time, per-plan dispatcher controls (owner, 2026-09-06) — nothing here
  // is remembered/persisted; they only shape the next Generate Routes call.
  const [departureClock, setDepartureClock] = useState(''); // '' = let the solver float as usual
  const [hubVanIds, setHubVanIds] = useState([]); // driver ids dragged into "Hub Vans"
  const latestHubs = useRef(hubVanIds);
  latestHubs.current = hubVanIds;
  const [hubReadyClockByDriverId, setHubReadyClockByDriverId] = useState({});
  const [dragOverHubZone, setDragOverHubZone] = useState(false);

  if (!open) return null;

  const toggleDriver = (driverId) => {
    setSelectedDriverIds((prev) => (
      prev.includes(driverId) ? prev.filter((id) => id !== driverId) : [...prev, driverId]
    ));
    // A van removed from the plan can't stay designated as a hub for it.
    removeHubVan(driverId);
  };

  const vanDriverOptions = drivers.filter(
    (d) => selectedDriverIds.includes(d._id) && d.profile?.vehicleType === 'van' && !hubVanIds.includes(d._id)
  );

  const addHubVan = (driverId) => {
    if (latestHubs.current.includes(driverId)) return;
    const next = [...latestHubs.current, driverId];
    observeHubs(next);
    latestHubs.current = next;
    setHubVanIds(next);
  };
  const removeHubVan = (driverId) => {
    if (latestHubs.current.includes(driverId)) observeHubs(latestHubs.current.filter(id => id !== driverId));
    latestHubs.current = latestHubs.current.filter(id => id !== driverId);
    setHubVanIds((prev) => prev.filter((id) => id !== driverId));
    setHubReadyClockByDriverId((prev) => {
      const next = { ...prev };
      delete next[driverId];
      return next;
    });
  };
  const setHubReadyClock = (driverId, clock) => {
    setHubReadyClockByDriverId((prev) => ({ ...prev, [driverId]: clock }));
  };
  const observeHubs = ids => {
    const labels = values => values.map(id => { const driver = drivers.find(item => item._id === id); return activityReference([driver?.profile?.firstName, driver?.profile?.lastName].filter(Boolean).join(' ') || driver?.name || 'Driver', id); });
    recordActivityChange({ field: 'Hub vans', form: 'Optimize routes proposal', before: labels(latestHubs.current), after: labels(ids) });
  };

  const handleGenerate = async () => {
    if (selectedDriverIds.length === 0) {
      setError('Select at least one driver.');
      return;
    }
    const fixedDepartureSeconds = departureClock ? clockToSeconds(departureClock) : null;
    if (departureClock && fixedDepartureSeconds == null) {
      setError('Invalid departure time.');
      return;
    }
    const hubVans = [];
    for (const driverId of hubVanIds) {
      const clock = hubReadyClockByDriverId[driverId];
      const hubReadySeconds = clockToSeconds(clock);
      if (hubReadySeconds == null) {
        setError(`Set a "ready for hub duty by" time for ${getDriverDisplayName(drivers.find((d) => d._id === driverId))}.`);
        return;
      }
      hubVans.push({ driverId, hubReadySeconds });
    }
    setError('');
    setGenerating(true);
    setPlan(null);
    try {
      const res = await api.post('/deliveries/optimize-routes', {
        deliveryIds: deliveries.map((d) => d._id),
        driverIds: selectedDriverIds,
        ...(fixedDepartureSeconds != null ? { fixedDepartureSeconds } : {}),
        ...(hubVans.length > 0 ? { hubVans } : {})
      });
      setPlan(res.data?.data || null);
    } catch (err) {
      console.error('Optimize routes error:', err);
      setError(err.response?.data?.message || 'Failed to generate routes.');
    } finally {
      setGenerating(false);
    }
  };

  const handleApply = async () => {
    if (!plan) return;
    setError('');
    setApplying(true);
    try {
      const routes = plan.routes
        .filter((r) => r.stops.length > 0)
        .map((r) => ({
          driverId: r.driverId,
          stops: r.stops.map((s) => ({ deliveryId: s.deliveryId, routeOrder: s.routeOrder }))
        }));
      const handoffs = (plan.handoffs || []).map((h) => ({
        bikeDriverId: h.bikeDriverId,
        vanDriverId: h.vanDriverId,
        vanAfterRouteOrder: h.vanAfterRouteOrder,
        bikeAfterRouteOrder: h.bikeAfterRouteOrder,
        meetingPoint: h.meetingPoint,
        plannedVanArrivalSeconds: h.plannedVanArrivalSeconds,
        plannedBikeArrivalSeconds: h.plannedBikeArrivalSeconds,
        expectedWaitSeconds: h.expectedWaitSeconds,
        deliveryIds: h.deliveryIds
      }));
      const kitchenReturns = (plan.kitchenReturns || []).map((k) => ({
        bikeDriverId: k.bikeDriverId,
        afterRouteOrder: k.afterRouteOrder,
        plannedDepartSeconds: k.plannedDepartSeconds,
        detourSeconds: k.detourSeconds,
        vanReason: k.vanReason,
        deliveryIds: k.deliveryIds
      }));
      await api.post('/deliveries/optimize-routes/apply', { routes, handoffs, kitchenReturns });
      onApplied?.();
      handleClose();
    } catch (err) {
      console.error('Apply route plan error:', err);
      setError(err.response?.data?.message || 'Failed to apply the route plan.');
    } finally {
      setApplying(false);
    }
  };

  const handleClose = () => {
    setSelectedDriverIds([]);
    setPlan(null);
    setError('');
    setDepartureClock('');
    setHubVanIds([]);
    setHubReadyClockByDriverId({});
    onClose?.();
  };

  const handoffsByBike = new Map((plan?.handoffs || []).map((h) => [h.bikeDriverId, h]));
  const handoffsByVan = new Map();
  (plan?.handoffs || []).forEach((h) => {
    if (!handoffsByVan.has(h.vanDriverId)) handoffsByVan.set(h.vanDriverId, []);
    handoffsByVan.get(h.vanDriverId).push(h);
  });
  const customerNameById = new Map(
    (plan?.routes || []).flatMap((r) => r.stops.map((s) => [s.deliveryId, s.customerName]))
  );
  const kitchenReturnByBike = new Map((plan?.kitchenReturns || []).map((k) => [k.bikeDriverId, k]));
  const bikesWithoutHandoff = (plan?.handoffDiagnostics || []).filter((d) => !d.handoff);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 sticky top-0 bg-white print:hidden">
          <div className="flex items-center gap-2">
            <Route className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-bold text-gray-900">Optimize Routes</h2>
          </div>
          <button onClick={handleClose} className="p-1 hover:bg-gray-100 rounded-lg">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <p className="text-sm text-gray-500 print:hidden">
            {deliveries.length} selected {deliveries.length === 1 ? 'delivery' : 'deliveries'} — pick which drivers
            to split them across, then generate an optimized route for each.
          </p>

          {!plan && (
            <>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Drivers</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {drivers.map((driver) => {
                    const isVan = driver.profile?.vehicleType === 'van';
                    const isHub = hubVanIds.includes(driver._id);
                    const isSelected = selectedDriverIds.includes(driver._id);
                    return (
                      <label
                        key={driver._id}
                        draggable={isVan && isSelected}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', driver._id);
                          e.dataTransfer.effectAllowed = 'copy';
                        }}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ${
                          isVan && isSelected ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
                        } ${
                          isHub
                            ? 'bg-orange-50 border-orange-300 text-orange-900'
                            : isSelected
                            ? 'bg-blue-50 border-blue-300 text-blue-900'
                            : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                        }`}
                        title={isVan && isSelected ? 'Drag into "Hub Vans" below to make this van a hub for this plan' : undefined}
                      >
                        {isVan && isSelected ? <GripVertical className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" /> : null}
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleDriver(driver._id)}
                          className="accent-blue-600"
                        />
                        <span className="min-w-0 truncate">
                          {getDriverDisplayName(driver)}
                          {driver.profile?.vehicleType ? <span className="text-gray-400"> · {driver.profile.vehicleType}</span> : null}
                          {isHub ? <span className="ml-1 text-[10px] font-semibold text-orange-700 uppercase">Hub</span> : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <Clock className="w-4 h-4 text-gray-400" />
                  <span className="font-medium">Kitchen departure</span>
                  <input
                    type="time"
                    value={departureClock}
                    onChange={(e) => setDepartureClock(e.target.value)}
                    className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
                  />
                  {departureClock ? (
                    <button
                      type="button"
                      onClick={() => { recordActivityChange({ field: 'Kitchen departure', form: 'Optimize routes proposal', before: departureClock, after: '' }); setDepartureClock(''); }}
                      className="text-xs text-gray-400 hover:text-gray-600 underline"
                    >
                      Clear
                    </button>
                  ) : null}
                </label>
                <p className="mt-1 text-xs text-gray-400">
                  {departureClock
                    ? `Every driver leaves the kitchen at exactly ${departureClock} for this plan.`
                    : 'Leave blank to let the optimizer choose the departure time (as late as scheduled times allow, no earlier than needed).'}
                </p>
              </div>

              <div
                onDragOver={(e) => { e.preventDefault(); setDragOverHubZone(true); }}
                onDragLeave={() => setDragOverHubZone(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverHubZone(false);
                  const driverId = e.dataTransfer.getData('text/plain');
                  const driver = drivers.find((d) => d._id === driverId);
                  if (driver?.profile?.vehicleType === 'van' && selectedDriverIds.includes(driverId)) {
                    addHubVan(driverId);
                  }
                }}
                className={`rounded-lg border-2 border-dashed p-3 transition-colors ${
                  dragOverHubZone ? 'border-orange-400 bg-orange-50' : 'border-gray-200 bg-gray-50'
                }`}
              >
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
                  <Truck className="w-3.5 h-3.5" /> Hub Vans
                </p>
                {hubVanIds.length === 0 ? (
                  <p className="mt-1 text-xs text-gray-400">
                    {vanDriverOptions.length > 0
                      ? 'Drag a selected van here to make it a hub for this plan — it stops taking its own deliveries once it must be ready.'
                      : 'Select a van driver above, then drag its card here to make it a hub for this plan.'}
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {hubVanIds.map((driverId) => {
                      const driver = drivers.find((d) => d._id === driverId);
                      return (
                        <li key={driverId} className="flex items-center gap-2 bg-white border border-orange-200 rounded-lg px-3 py-2 text-sm">
                          <Truck className="w-4 h-4 text-orange-500 flex-shrink-0" />
                          <span className="font-medium text-gray-900 truncate flex-1 min-w-0">{getDriverDisplayName(driver)}</span>
                          <span className="text-xs text-gray-500 flex-shrink-0">ready for hub duty by</span>
                          <input
                            type="time"
                            value={hubReadyClockByDriverId[driverId] || ''}
                            data-activity-label={`Hub ready by for ${activityReference([driver?.profile?.firstName, driver?.profile?.lastName].filter(Boolean).join(' ') || driver?.name || 'Driver', driverId)}`}
                            onChange={(e) => setHubReadyClock(driverId, e.target.value)}
                            className="border border-gray-300 rounded px-2 py-1 text-xs flex-shrink-0"
                          />
                          <button
                            type="button"
                            onClick={() => removeHubVan(driverId)}
                            className="text-gray-400 hover:text-gray-600 flex-shrink-0"
                            title="Remove hub designation"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="mt-2 text-[11px] text-gray-400">
                  Hard cutoff: before that time the van does normal deliveries; after it, zero more of its own — the rest of its shift is reserved for meeting bikes.
                </p>
              </div>

              {error && (
                <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              <button
                onClick={handleGenerate}
                disabled={generating}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
                {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Route className="w-4 h-4" />}
                {generating ? 'Generating routes… this can take up to a minute when planning van↔bike handoffs' : 'Generate Routes'}
              </button>
            </>
          )}

          {plan && (
            <>
              {plan.scheduleAware && (
                <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${plan.lateStops > 0 ? 'bg-amber-50 border border-amber-200 text-amber-800' : 'bg-emerald-50 border border-emerald-200 text-emerald-800'}`}>
                  {plan.lateStops > 0 ? <Clock className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />}
                  <span>
                    Scheduled times respected: <strong>{plan.onTimeStops}</strong> on time
                    {plan.lateStops > 0
                      ? <>, <strong>{plan.lateStops}</strong> predicted late (about {Math.round(plan.totalLatenessSeconds / 60)} min total). Late stops are kept in the plan and marked below — add a driver or adjust to cut it.</>
                      : ' — every stop is predicted to arrive by its scheduled time.'}
                  </span>
                </div>
              )}

              {plan.unresolvedDeliveries?.length > 0 && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2 text-sm print:hidden">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    {plan.unresolvedDeliveries.length} {plan.unresolvedDeliveries.length === 1 ? 'delivery has' : 'deliveries have'} no
                    resolvable address/location and were left out of this plan:{' '}
                    {plan.unresolvedDeliveries.map((d) => d.customerName || d.id).join(', ')}
                  </span>
                </div>
              )}

              {plan.unassignedDeliveries?.length > 0 && (
                <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-800 rounded-lg px-3 py-2 text-sm print:hidden">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    {plan.unassignedDeliveries.length} {plan.unassignedDeliveries.length === 1 ? 'delivery' : 'deliveries'} couldn't
                    fit within the selected drivers' capacity and shift hours — add more drivers or split the batch:{' '}
                    {plan.unassignedDeliveries.map((d) => d.customerName || d.id).join(', ')}
                  </span>
                </div>
              )}

              {plan.handoffs?.length > 0 && (
                <div className="bg-violet-50 border border-violet-200 text-violet-900 rounded-lg px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold flex items-center gap-1.5">
                      <Repeat className="w-4 h-4" />
                      {plan.handoffs.length} van↔bike {plan.handoffs.length === 1 ? 'handoff' : 'handoffs'} planned
                    </p>
                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-violet-700 hover:underline print:hidden"
                      title="Print the kitchen packing manifest for these handoffs"
                    >
                      <Printer className="w-3.5 h-3.5" /> Print manifest
                    </button>
                  </div>
                  <ul className="mt-2 space-y-2">
                    {plan.handoffs.map((h) => (
                      <li key={`${h.bikeDriverId}-${h.vanDriverId}`} className="text-xs">
                        <span className="font-medium">BIKE {h.bikeName}</span> via <span className="font-medium">VAN {h.vanName}</span>
                        {' — '}{h.deliveryIds?.length || 0} bags at {h.meetingPoint?.name || 'meeting point'}
                        {' · '}van {formatShiftOffset(h.plannedVanArrivalSeconds)}, bike {formatShiftOffset(h.plannedBikeArrivalSeconds)} into shift
                        <details className="mt-1">
                          <summary className="cursor-pointer text-violet-700">Packing list</summary>
                          <ol className="list-decimal ml-5 mt-1 space-y-0.5">
                            {(h.deliveryIds || []).map((id) => (
                              <li key={id}>{customerNameById.get(id) || id}</li>
                            ))}
                          </ol>
                        </details>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[11px] text-violet-700 print:hidden">
                    Kitchen: pack each bike's trip-2 bags as one labelled crate ("BIKE name via VAN name") and load it on that van before departure.
                  </p>
                </div>
              )}

              {plan.kitchenReturns?.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-3 py-2 text-sm">
                  <p className="font-semibold flex items-center gap-1.5">
                    <Repeat className="w-4 h-4" />
                    {plan.kitchenReturns.length} kitchen {plan.kitchenReturns.length === 1 ? 'return' : 'returns'} — no van could take these
                  </p>
                  <p className="mt-1 text-[11px] text-amber-700">
                    A van meeting is always tried first (a short detour beats riding back). These fell back because:
                  </p>
                  <ul className="mt-2 space-y-2">
                    {plan.kitchenReturns.map((k) => (
                      <li key={k.bikeDriverId} className="text-xs">
                        <span className="font-medium">{k.bikeName}</span> rides back to the kitchen for trip 2
                        {' — '}{k.deliveryIds?.length || 0} bags, ~{formatMinutes(k.detourSeconds)} round trip
                        {' · '}leaves stop 20 {formatShiftOffset(k.plannedDepartSeconds)} into shift
                        {k.vanReason ? (
                          <span className="block mt-0.5 text-amber-800">
                            <span className="font-medium">Why not a van:</span> {k.vanReason}
                          </span>
                        ) : null}
                        <details className="mt-1">
                          <summary className="cursor-pointer text-amber-700">Packing list</summary>
                          <ol className="list-decimal ml-5 mt-1 space-y-0.5">
                            {(k.deliveryIds || []).map((id) => (
                              <li key={id}>{customerNameById.get(id) || id}</li>
                            ))}
                          </ol>
                        </details>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[11px] text-amber-700 print:hidden">
                    Kitchen: have each bike's trip-2 bags ready as one labelled crate ("BIKE name — trip 2") for pickup when they return.
                  </p>
                </div>
              )}

              {bikesWithoutHandoff.length > 0 && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2 text-sm print:hidden">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Second trip not possible for:</p>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {bikesWithoutHandoff.map((d) => (
                        <li key={d.bikeDriverId}><span className="font-medium">{d.bikeName}</span> — {d.reason}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              <div className="space-y-4">
                {plan.routes.map((route) => {
                  const mapsLink = buildMultiStopMapsLink(route.stops);
                  const bikeHandoff = handoffsByBike.get(route.driverId);
                  const vanHandoffs = handoffsByVan.get(route.driverId) || [];
                  const vanHandoffAfter = new Map(vanHandoffs.map((h) => [h.vanAfterRouteOrder, h]));
                  const kitchenReturn = kitchenReturnByBike.get(route.driverId);
                  return (
                    <div key={route.driverId} className="border border-gray-200 rounded-lg overflow-hidden">
                      <div className="flex items-center justify-between bg-gray-50 px-4 py-2.5 border-b border-gray-200">
                        <span className="font-semibold text-gray-900">
                          {route.driverName}
                          {bikeHandoff || kitchenReturn ? <span className="ml-2 text-xs font-medium text-violet-700">2 trips</span> : null}
                          {route.hubReadySeconds != null ? (
                            <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-orange-700">
                              <Truck className="w-3 h-3" /> Hub from {secondsToClock(route.hubReadySeconds)}
                            </span>
                          ) : null}
                        </span>
                        <span className="text-xs text-gray-500 text-right">
                          {route.stops.length}{route.capacity ? ` / ${route.capacity}` : ''} {route.stops.length === 1 && !route.capacity ? 'stop' : 'stops'}
                          {route.vehicleType ? ` · ${route.vehicleType}` : ''}
                          {route.estimatedDurationSeconds != null && route.maxDurationSeconds ? (
                            <span className="block">
                              {(route.estimatedDurationSeconds / 3600).toFixed(1)}h of {(route.maxDurationSeconds / 3600).toFixed(0)}h shift
                            </span>
                          ) : null}
                          {route.latenessSeconds > 0 ? (
                            <span className="block text-amber-600 font-medium">{Math.round(route.latenessSeconds / 60)} min late total</span>
                          ) : plan.scheduleAware && route.stops.length > 0 ? (
                            <span className="block text-emerald-600">all on time</span>
                          ) : null}
                        </span>
                      </div>
                      {route.stops.length === 0 ? (
                        <p className="px-4 py-3 text-sm text-gray-400">No stops assigned.</p>
                      ) : (
                        <>
                          <ol className="divide-y divide-gray-100">
                            {route.stops.map((stop) => (
                              <React.Fragment key={stop.deliveryId}>
                                <li className="flex items-start gap-3 px-4 py-2.5 text-sm">
                                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center mt-0.5">
                                    {stop.routeOrder + 1}
                                  </span>
                                  <div className="min-w-0">
                                    <p className="font-medium text-gray-900 truncate">{stop.customerName || 'Unknown customer'}</p>
                                    <p className="text-gray-500 truncate flex items-center gap-1">
                                      <MapPin className="w-3 h-3 flex-shrink-0" />
                                      {stop.address || '—'}
                                    </p>
                                  </div>
                                </li>
                                {bikeHandoff && stop.routeOrder === bikeHandoff.bikeAfterRouteOrder && (
                                  <HandoffRow handoff={bikeHandoff} role="bike" />
                                )}
                                {kitchenReturn && stop.routeOrder === kitchenReturn.afterRouteOrder && (
                                  <KitchenReturnRow kitchenReturn={kitchenReturn} />
                                )}
                                {vanHandoffAfter.has(stop.routeOrder) && (
                                  <HandoffRow handoff={vanHandoffAfter.get(stop.routeOrder)} role="van" />
                                )}
                              </React.Fragment>
                            ))}
                          </ol>
                          {mapsLink ? (
                            <a
                              href={mapsLink}
                              target="_blank"
                              rel="noreferrer"
                              className="block px-4 py-2 text-xs font-semibold text-blue-600 hover:bg-blue-50 border-t border-gray-100 print:hidden"
                            >
                              Open full route in Google Maps →
                            </a>
                          ) : route.stops.length > MAX_WAYPOINTS_DESKTOP + 1 ? (
                            <p className="px-4 py-2 text-xs text-gray-400 border-t border-gray-100 print:hidden">
                              Too many stops ({route.stops.length}) for a single Google Maps link — navigate stop by
                              stop instead, in the order shown above.
                            </p>
                          ) : null}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              {error && (
                <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              <div className="flex gap-2 print:hidden">
                <button
                  onClick={() => setPlan(null)}
                  className="px-4 py-2.5 bg-white border border-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-50"
                >
                  Back
                </button>
                <button
                  onClick={handleApply}
                  disabled={applying}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50"
                >
                  {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Route className="w-4 h-4" />}
                  {applying ? 'Applying…' : plan.handoffs?.length ? 'Apply Routes & Handoffs' : 'Apply Routes'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
