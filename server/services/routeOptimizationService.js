import { bulkWriteReportingDeliveries } from './reportingOutbox.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import Delivery from '../models/Delivery.js';
import Handoff from '../models/Handoff.js';
import User from '../models/User.js';
import { resolveDeliveryCoordinatesCached } from './geocoding.js';
import { buildDistanceMatrix, UNREACHABLE_PENALTY } from './distanceMatrixService.js';
import { findMeetingPois } from './poiService.js';
import {
  findHandoffs,
  BIKE_TRIP_CAPACITY,
  HANDOFF_RESERVE_SECONDS
} from './handoffPlanner.js';
import { sendRouteAssignedPushToDriver } from './pushNotificationService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOLVER_SCRIPT_PATH = path.join(__dirname, '..', 'optimizer', 'solve_routes.py');

// Production runs on Linux, where `python3` is the standard command. On a
// Windows dev machine (no python3 by default), set PYTHON_BIN=python in
// your local .env to test this locally.
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const SOLVER_PROCESS_TIMEOUT_MS = 30000;
const COORD_RESOLUTION_CONCURRENCY = 15;

const DEPOT = {
  lat: Number(process.env.DELIVERY_DEPOT_LAT),
  lng: Number(process.env.DELIVERY_DEPOT_LNG),
  label: process.env.DELIVERY_DEPOT_LABEL || 'Depot'
};

// Business-day date ("YYYY-MM-DD" in the fixed local timezone) a delivery
// belongs to — same offset convention as the rest of the server.
export const TZ_OFFSET_MS = Number(process.env.LOCAL_TIMEZONE_OFFSET_MINUTES || 240) * 60 * 1000;
const businessDateOf = (dateLike) => new Date(new Date(dateLike).getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);

// Kitchen departure rules (owner, 2026-09-05). Drivers normally leave at
// KITCHEN_DEPARTURE_TIME (02:00); a route may pull that earlier when its
// scheduled times need it, but never before KITCHEN_EARLIEST_DEPARTURE_TIME
// (01:00). If even the earliest departure can't make every stop on time, a
// plan leaves at the earliest and *reports* the departure that would have
// been needed rather than assuming it. Values are business-time "HH:MM".
const parseClockSeconds = (value, fallbackSeconds) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return fallbackSeconds;
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
};
export const KITCHEN_DEPARTURE_DEFAULT_SECONDS = parseClockSeconds(process.env.KITCHEN_DEPARTURE_TIME, 2 * 3600);
export const KITCHEN_DEPARTURE_EARLIEST_SECONDS = parseClockSeconds(process.env.KITCHEN_EARLIEST_DEPARTURE_TIME, 1 * 3600);

// Van-as-hub rule (owner, 2026-09-06): once Dubai traffic gets bad — by
// default HUB_MODE_START_TIME (06:00) — a meeting with a bike gets a small,
// bounded amount of priority over the van's own schedule (see
// handoffPlanner.js's hubModeShiftGraceSeconds). handoffPlanner works in
// shift-relative seconds, so the wall-clock threshold is converted here
// using the usual departure time as the reference point.
export const HUB_MODE_START_WALLCLOCK_SECONDS = parseClockSeconds(process.env.HUB_MODE_START_TIME, 6 * 3600);
export const HUB_MODE_SHIFT_GRACE_SECONDS = Number(process.env.HUB_MODE_SHIFT_GRACE_MINUTES || 15) * 60;

// A delivery's scheduledTime is the END of its window: 07:00 means "between
// 04:00 and 07:00". Arriving after it is late; before it opens is early. (The
// delivered-on-time reports already use this same 180-minute threshold.)
export const DELIVERY_WINDOW_SECONDS = Number(process.env.DELIVERY_WINDOW_HOURS || 3) * 3600;

// Max stops per route by vehicle type. A driver's profile.stopCapacity
// overrides this when set. The business runs bikes and vans; "car" is only
// here so an unexpectedly-typed driver gets a sane number instead of a
// crash.
const VEHICLE_STOP_CAPACITY = { bike: BIKE_TRIP_CAPACITY, van: 100, car: 40 };
const DEFAULT_STOP_CAPACITY = 40;

// Shift length by the existing profile.shiftTiming values (the driver form
// offers exactly these: morning/afternoon/night are 8-hour blocks, flexible
// is "full day"). Unset falls back to 8h.
const HOUR = 60 * 60;
const SHIFT_DURATION_SECONDS = { morning: 8 * HOUR, afternoon: 8 * HOUR, night: 8 * HOUR, flexible: 12 * HOUR };
const DEFAULT_SHIFT_DURATION_SECONDS = 8 * HOUR;

// A bike is only considered for a second trip (via a van handoff) if its
// first-trip plan leaves at least this much shift unused. This is just a
// gate to skip the cost of a second solve when no bike could take anything —
// the solver itself enforces the real time limit in pass 2, so a bike with
// an hour spare may legitimately end up with just a few extra stops. Kept
// deliberately low: with 20-minute apartment stops, a full 20-stop first
// trip already uses ~7.5 h of an 8 h shift, so an all-apartment bike rarely
// qualifies at all — that's the arithmetic, not a bug.
const MIN_SPARE_FOR_SECOND_TRIP_SECONDS = 1 * HOUR;

// Time spent at the door — now a flat figure by VEHICLE, not by address type
// (owner, 2026-09-05: villa and apartment take the same time; a bike takes
// longer than a van at either). Unknown/'car' vehicle types default to the
// bike figure — the slower one — so the plan stays conservative rather than
// over-promising.
const SERVICE_TIME_SECONDS_BY_VEHICLE = { bike: 10 * 60, van: 5 * 60 };
export function serviceSecondsForVehicleType(vehicleType) {
  return SERVICE_TIME_SECONDS_BY_VEHICLE[vehicleType] ?? SERVICE_TIME_SECONDS_BY_VEHICLE.bike;
}

function driverStopCapacity(driver) {
  const override = Number(driver.profile?.stopCapacity);
  if (Number.isFinite(override) && override > 0) return override;
  return VEHICLE_STOP_CAPACITY[driver.profile?.vehicleType] ?? DEFAULT_STOP_CAPACITY;
}

function driverShiftSeconds(driver) {
  return SHIFT_DURATION_SECONDS[driver.profile?.shiftTiming] ?? DEFAULT_SHIFT_DURATION_SECONDS;
}

const driverDisplayName = (driver) =>
  [driver.profile?.firstName, driver.profile?.lastName].filter(Boolean).join(' ') || driver.email;

function runSolver(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [SOLVER_SCRIPT_PATH]);
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Route solver timed out'));
    }, SOLVER_PROCESS_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(
        `Failed to start route solver (is Python installed and on PATH? tried "${PYTHON_BIN}"): ${err.message}`
      ));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(stderr.trim() || `Route solver exited with code ${code}`));
      }
      try {
        const result = JSON.parse(stdout);
        if (!result.success) return reject(new Error(result.error || 'Route solver reported failure'));
        resolve(result);
      } catch (err) {
        reject(new Error(`Could not parse route solver output: ${err.message}${stderr ? ` (stderr: ${stderr.trim()})` : ''}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function resolveCoordinatesForAll(deliveries) {
  const coordsByDeliveryId = new Map();
  const unresolvedDeliveries = [];

  for (let i = 0; i < deliveries.length; i += COORD_RESOLUTION_CONCURRENCY) {
    const batch = deliveries.slice(i, i + COORD_RESOLUTION_CONCURRENCY);
    await Promise.all(batch.map(async (delivery) => {
      try {
        const coords = await resolveDeliveryCoordinatesCached(delivery);
        if (coords) {
          coordsByDeliveryId.set(String(delivery._id), coords);
        } else {
          unresolvedDeliveries.push({ id: String(delivery._id), customerName: delivery.customerName });
        }
      } catch (err) {
        unresolvedDeliveries.push({ id: String(delivery._id), customerName: delivery.customerName, error: err.message });
      }
    }));
  }

  return { coordsByDeliveryId, unresolvedDeliveries };
}

/**
 * Compute an optimized set of driver routes for a set of deliveries. Does
 * NOT write anything to the database — the result is meant to be reviewed
 * (e.g. in a dispatcher preview UI) before calling applyRoutePlan.
 *
 * Two-pass: pass 1 is the plain solve. If anything was left unassigned and a
 * bike has spare shift time, pass 2 re-solves letting it take a second trip
 * (capacity doubled, shift reduced by the handoff reserve) — a bike's real
 * daily capacity is 20 stops per trip, up to 2 trips (40/day), not a flat 20.
 * handoffPlanner then gets the second trip's bags to the bike: a van + meeting
 * point if one fits, otherwise the bike rides back to the kitchen itself
 * (neither mechanism requires the other to exist); only truncates the bike
 * back to one trip if NEITHER fits its shift.
 *
 * @param {string[]} deliveryIds - Mongo ObjectIds of deliveries to route
 * @param {string[]} driverIds - Mongo ObjectIds of drivers to route them across
 * @param {object} [options]
 * @param {number|null} [options.fixedDepartureSeconds] - Pin every vehicle's
 *   kitchen departure to this exact wall-clock time (seconds from local
 *   midnight) instead of letting the solver float between
 *   KITCHEN_EARLIEST_DEPARTURE_TIME and KITCHEN_DEPARTURE_TIME. Dispatcher-set,
 *   one-time per plan — nothing is persisted.
 * @param {{driverId: string, hubReadySeconds: number, hubLocation?: {lat:number,lng:number}}[]} [options.hubVans] -
 *   Vans the dispatcher has dragged into "Hub" for this plan. Each entry hard-
 *   caps that van's OWN deliveries so it finishes them (incl. the modeled
 *   return-to-depot leg) by hubReadySeconds — a real wall-clock cutoff, not a
 *   preference — freeing the rest of its true shift for handoffPlanner's van-
 *   as-hub matching (which still sees the van's full shift for that purpose;
 *   only the solve's own-delivery budget is reduced). An optional hubLocation
 *   (a dragged 🚚 pin) forces every bike to meet that van at that exact point
 *   instead of near the bike's own route. One-time per plan.
 * @param {number|null} [options.bikeTripCapacity] - Simulation-only override
 *   of the real 20-stops-per-trip rule for every bike in this plan (both the
 *   solve's capacity dimension and handoffPlanner's trip-split point). Real
 *   dispatching should never pass this — it exists so a "what if bikes could
 *   carry more/fewer per trip" run can be previewed without touching any
 *   driver's actual profile.stopCapacity.
 * @param {number|null} [options.maxEarlyDepartureSeconds] - Simulation-only:
 *   when the departure is left floating (no fixedDepartureSeconds), caps how
 *   much earlier than KITCHEN_DEPARTURE_DEFAULT_SECONDS the solver may pull
 *   the start, replacing the real KITCHEN_EARLIEST_DEPARTURE_TIME floor for
 *   this plan only (e.g. 3*3600 means "never more than 3 hours early").
 *   Ignored when fixedDepartureSeconds is also set.
 */
export async function optimizeRoutes(deliveryIds, driverIds, options = {}) {
  const { fixedDepartureSeconds = null, hubVans = [], bikeTripCapacity = null, maxEarlyDepartureSeconds = null } = options;
  if (!Number.isFinite(DEPOT.lat) || !Number.isFinite(DEPOT.lng)) {
    throw new Error('DELIVERY_DEPOT_LAT/DELIVERY_DEPOT_LNG are not configured');
  }
  if (!Array.isArray(deliveryIds) || deliveryIds.length === 0) {
    throw new Error('At least one delivery is required');
  }
  if (!Array.isArray(driverIds) || driverIds.length === 0) {
    throw new Error('At least one driver is required');
  }
  if (fixedDepartureSeconds != null && (!Number.isFinite(fixedDepartureSeconds) || fixedDepartureSeconds < 0 || fixedDepartureSeconds >= 24 * 3600)) {
    throw new Error('fixedDepartureSeconds must be seconds from midnight (0-86399)');
  }
  if (maxEarlyDepartureSeconds != null && (!Number.isFinite(maxEarlyDepartureSeconds) || maxEarlyDepartureSeconds < 0)) {
    throw new Error('maxEarlyDepartureSeconds must be a non-negative number of seconds');
  }
  if (bikeTripCapacity != null && (!Number.isFinite(bikeTripCapacity) || bikeTripCapacity < 1 || bikeTripCapacity > 200)) {
    throw new Error('bikeTripCapacity must be a positive number of stops (1-200)');
  }

  const [deliveries, drivers] = await Promise.all([
    Delivery.find({ _id: { $in: deliveryIds } }),
    User.find({ _id: { $in: driverIds } }).select('profile email')
  ]);

  if (deliveries.length === 0) throw new Error('No matching deliveries found');
  if (drivers.length === 0) throw new Error('No matching drivers found');

  const { coordsByDeliveryId, unresolvedDeliveries } = await resolveCoordinatesForAll(deliveries);

  const routableDeliveries = deliveries.filter((d) => coordsByDeliveryId.has(String(d._id)));
  if (routableDeliveries.length === 0) {
    throw new Error('None of the selected deliveries have a resolvable address/location');
  }

  const points = [
    { lat: DEPOT.lat, lng: DEPOT.lng },
    ...routableDeliveries.map((d) => coordsByDeliveryId.get(String(d._id)))
  ];
  const stopIds = routableDeliveries.map((d) => String(d._id));

  const { durations: fullDurations } = await buildDistanceMatrix(points);

  // A stop the depot can't reach by road at all (outside the routing
  // engine's map coverage, or — belt and suspenders alongside the
  // plausibility check in geocoding.js — a coordinate that's technically a
  // valid lat/lng but nowhere near the real address) can't be served by any
  // driver no matter what. Left in, its 999000s "unreachable" penalty
  // dwarfs any sane per-driver time budget and can make the ENTIRE solve
  // infeasible rather than just excluding the one bad stop. Drop it before
  // the solver ever sees it, same treatment as an unresolved address.
  const reachableIndexes = []; // indexes into routableDeliveries/stopIds
  routableDeliveries.forEach((d, i) => {
    const matrixIndex = i + 1; // +1 because index 0 in fullDurations is the depot
    const reachableFromDepot = fullDurations[0][matrixIndex] < UNREACHABLE_PENALTY;
    const reachableToDepot = fullDurations[matrixIndex][0] < UNREACHABLE_PENALTY;
    if (reachableFromDepot && reachableToDepot) {
      reachableIndexes.push(i);
    } else {
      unresolvedDeliveries.push({ id: String(d._id), customerName: d.customerName });
    }
  });

  const solvableDeliveries = reachableIndexes.map((i) => routableDeliveries[i]);
  if (solvableDeliveries.length === 0) {
    throw new Error('None of the selected deliveries are reachable by road from the depot.');
  }
  const solvableStopIds = reachableIndexes.map((i) => stopIds[i]);
  // Sub-matrix over [depot, ...solvableDeliveries] — index 0 plus each
  // reachable stop's original matrix index (i+1).
  const keepIndexes = [0, ...reachableIndexes.map((i) => i + 1)];
  const durations = keepIndexes.map((row) => keepIndexes.map((col) => fullDurations[row][col]));

  const deliveryById = new Map(solvableDeliveries.map((d) => [String(d._id), d]));
  const subIndexByStopId = new Map(solvableStopIds.map((id, i) => [id, i + 1]));

  // A simulation-only bikeTripCapacity overrides EVERY bike's capacity here
  // (even one with its own profile.stopCapacity set) — the whole point is
  // previewing "what if bikes could carry more/fewer per trip" without
  // touching real driver profiles.
  const baseCapacities = drivers.map((d) => (
    bikeTripCapacity != null && d.profile?.vehicleType === 'bike' ? bikeTripCapacity : driverStopCapacity(d)
  ));
  const shiftSeconds = drivers.map(driverShiftSeconds);

  // Dispatcher-designated "hub" vans (this plan only — see optimizeRoutes
  // jsdoc). Matched by driverId onto the drivers[] order used everywhere
  // else in this function; a hubVans entry for a driver not in this plan's
  // selection is silently ignored.
  const hubReadyByDriverId = new Map(
    (hubVans || [])
      .filter((h) => h && h.driverId != null && Number.isFinite(Number(h.hubReadySeconds)))
      .map((h) => [String(h.driverId), Number(h.hubReadySeconds)])
  );
  const vehicleHubReadySeconds = drivers.map((d) => hubReadyByDriverId.get(String(d._id)) ?? null);
  const hasHubVans = vehicleHubReadySeconds.some((v) => v != null);
  // Optional dispatcher-pinned meeting location per hub van (a dragged 🚚
  // pin in the simulation). When present, every bike meets that van at this
  // exact point instead of near wherever the bike is working.
  const hubLocationByDriverId = {};
  (hubVans || []).forEach((h) => {
    const lat = Number(h?.hubLocation?.lat);
    const lng = Number(h?.hubLocation?.lng);
    if (h?.driverId != null && Number.isFinite(lat) && Number.isFinite(lng)) {
      hubLocationByDriverId[String(h.driverId)] = { lat, lng };
    }
  });
  // Flat per-vehicle dwell time (bike vs van — see serviceSecondsForVehicleType),
  // the same at every stop that vehicle visits. The solver needs this per
  // vehicle (it's choosing which vehicle serves which stop); handoffPlanner
  // needs it per LOCATION instead, built further down once each pass's solve
  // has actually decided which vehicle visits which stop.
  const vehicleServiceSeconds = drivers.map((d) => serviceSecondsForVehicleType(d.profile?.vehicleType));

  // Each stop's scheduled delivery time as seconds from local (Dubai)
  // midnight — the soft deadline the solver tries to hit. Index 0 (depot)
  // has none. A missing scheduledTime leaves that stop unconstrained (null).
  const softDeadlines = [null, ...solvableDeliveries.map((d) => {
    if (!d.scheduledTime) return null;
    const local = new Date(new Date(d.scheduledTime).getTime() + TZ_OFFSET_MS);
    return local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds();
  })];
  const hasAnyDeadline = softDeadlines.some((v) => v !== null);
  // A fixed departure or a hub van both need the solver's wall-clock mode
  // (absolute times) even on a batch with no per-customer scheduled times at
  // all — a plain shift-relative solve has no notion of "the clock time this
  // van must be free by." Forcing it on here doesn't change scheduleAware
  // (that stays tied to real customer deadlines only, below).
  const sendTimeWindow = hasAnyDeadline || fixedDepartureSeconds != null || maxEarlyDepartureSeconds != null || hasHubVans;
  // Simulation-only (owner, 2026-09-14): replace the real "never more than
  // ~1h early" floor with a dispatcher-chosen cap on how early the floating
  // departure may go, instead of pinning an exact time. Ignored whenever a
  // fixed departure is set (that already collapses the window to one instant).
  // Clamped at midnight (0) — the wall-clock model here doesn't represent a
  // departure on the PREVIOUS day, same limitation the real
  // KITCHEN_EARLIEST_DEPARTURE_TIME already has (it's always a same-day
  // "HH:MM" too). A max-early value big enough to cross midnight is capped
  // there rather than silently doing something else.
  const earliestDepartureSeconds = maxEarlyDepartureSeconds != null
    ? Math.max(0, KITCHEN_DEPARTURE_DEFAULT_SECONDS - maxEarlyDepartureSeconds)
    : KITCHEN_DEPARTURE_EARLIEST_SECONDS;

  const solveWith = (capacities, maxDurations) => runSolver({
    depot_index: 0,
    num_vehicles: drivers.length,
    duration_matrix: durations,
    stop_ids: solvableStopIds,
    vehicle_service_seconds: vehicleServiceSeconds,
    vehicle_capacities: capacities,
    vehicle_max_route_durations: maxDurations,
    ...(sendTimeWindow ? {
      soft_deadlines: softDeadlines,
      // Real departure window: leave at the usual time, earlier only when the
      // deadlines demand it, never before the earliest allowed. Without this
      // the floating start drifted to midnight and every ETA was an
      // "earliest possible" lower bound rather than a realistic clock time.
      // A dispatcher-fixed departure collapses this to a single instant.
      start_window_seconds: fixedDepartureSeconds != null
        ? [fixedDepartureSeconds, fixedDepartureSeconds]
        : [
          Math.min(earliestDepartureSeconds, KITCHEN_DEPARTURE_DEFAULT_SECONDS),
          Math.max(earliestDepartureSeconds, KITCHEN_DEPARTURE_DEFAULT_SECONDS)
        ],
      // Hard cutoff (owner, 2026-09-06): a hub van stops taking its own
      // deliveries once it must be free for hub duty — capped on the
      // solver's END cumul (which already includes the modeled return-to-
      // depot leg), not a preference. null entries leave that vehicle
      // unconstrained here.
      ...(hasHubVans ? { vehicle_hub_ready_seconds: vehicleHubReadySeconds } : {})
    } : {})
  });

  const buildRoutes = (solverResult, capacities, maxDurations) => drivers.map((driver, vehicleIndex) => {
    const orderedDeliveryIds = solverResult.routes[String(vehicleIndex)] || [];
    const arrivals = solverResult.arrivals || {};
    return {
      driverId: String(driver._id),
      driverName: driverDisplayName(driver),
      vehicleType: driver.profile?.vehicleType || null,
      capacity: capacities[vehicleIndex],
      maxDurationSeconds: maxDurations[vehicleIndex],
      // Wall-clock cutoff for this van's OWN deliveries, when the dispatcher
      // designated it as a hub for this plan (null otherwise).
      hubReadySeconds: vehicleHubReadySeconds[vehicleIndex] ?? null,
      estimatedDurationSeconds: solverResult.route_durations?.[String(vehicleIndex)] ?? null,
      // Total seconds this driver's stops are predicted to run past their
      // scheduled time (0 when no deadlines / all on time).
      latenessSeconds: solverResult.route_lateness_seconds?.[String(vehicleIndex)] ?? 0,
      stops: orderedDeliveryIds.map((deliveryId, index) => {
        const delivery = deliveryById.get(deliveryId);
        const arrival = arrivals[deliveryId];
        const deadline = softDeadlines[subIndexByStopId.get(deliveryId)];
        return {
          deliveryId,
          routeOrder: index,
          customerName: delivery?.customerName,
          address: delivery?.address,
          scheduledTime: delivery?.scheduledTime ?? null,
          etaSeconds: arrival ?? null, // predicted arrival, seconds from midnight
          lateSeconds: (arrival != null && deadline != null) ? Math.max(0, arrival - deadline) : 0
        };
      })
    };
  });

  const toUnassignedEntries = (ids) => ids.map((deliveryId) => {
    const delivery = deliveryById.get(deliveryId);
    return { id: deliveryId, customerName: delivery?.customerName };
  });

  // ---- Pass 1: plain solve.
  const pass1 = await solveWith(baseCapacities, shiftSeconds);
  let routes = buildRoutes(pass1, baseCapacities, shiftSeconds);
  let unassignedIds = pass1.unassigned || [];
  let totalDurationSeconds = pass1.total_duration_seconds;
  let handoffs = [];
  let kitchenReturns = [];
  let handoffDiagnostics = [];
  let passes = 1;

  // ---- Pass 2: give bikes with spare time a second trip (20 stops per trip,
  // up to 2 trips/40 stops a day), then get the second trip's bags to the
  // bike — a van handoff if one fits, otherwise the bike rides back to the
  // kitchen itself (findHandoffs tries both; neither needs the other to
  // exist, so this doesn't require a van in the plan).
  const secondTripBikes = drivers
    .map((d, i) => ({ d, i }))
    .filter(({ d, i }) => d.profile?.vehicleType === 'bike'
      && routes[i].stops.length > 0
      && (shiftSeconds[i] - (routes[i].estimatedDurationSeconds ?? 0)) >= MIN_SPARE_FOR_SECOND_TRIP_SECONDS);

  if (unassignedIds.length > 0 && secondTripBikes.length > 0) {
    const capacities2 = [...baseCapacities];
    const maxDurations2 = [...shiftSeconds];
    for (const { i } of secondTripBikes) {
      capacities2[i] = baseCapacities[i] * 2;
      maxDurations2[i] = shiftSeconds[i] - HANDOFF_RESERVE_SECONDS;
    }

    const pass2 = await solveWith(capacities2, maxDurations2);
    const routes2 = buildRoutes(pass2, capacities2, maxDurations2);

    // handoffPlanner works with a per-LOCATION dwell array (a stop's service
    // time as visited in THIS plan) — build it from what pass 2 actually
    // decided, so every stop gets its real assigned vehicle's flat figure. No
    // ambiguity: each stop is on exactly one route in a solved plan.
    const serviceTimesByLocation = new Array(durations.length).fill(0); // index 0 = depot
    routes2.forEach((route, vehicleIndex) => {
      const seconds = vehicleServiceSeconds[vehicleIndex];
      route.stops.forEach((stop) => {
        serviceTimesByLocation[subIndexByStopId.get(stop.deliveryId)] = seconds;
      });
    });

    const planned = await findHandoffs({
      routes: routes2,
      durations,
      serviceTimes: serviceTimesByLocation,
      indexOf: (stopId) => subIndexByStopId.get(stopId),
      pointOf: (stopId) => coordsByDeliveryId.get(stopId),
      depot: { lat: DEPOT.lat, lng: DEPOT.lng },
      drivers,
      fetchTable: buildDistanceMatrix,
      fetchPois: findMeetingPois,
      // Wall-clock hub-hours threshold, converted to shift-relative seconds
      // using the usual departure as the reference point (never negative —
      // a batch with no scheduled-time awareness still gets a sane offset).
      hubModeStartSeconds: Math.max(0, HUB_MODE_START_WALLCLOCK_SECONDS - KITCHEN_DEPARTURE_DEFAULT_SECONDS),
      hubModeShiftGraceSeconds: HUB_MODE_SHIFT_GRACE_SECONDS,
      ...(bikeTripCapacity != null ? { tripCapacity: bikeTripCapacity } : {}),
      ...(Object.keys(hubLocationByDriverId).length > 0 ? { hubLocationByDriverId } : {})
    });

    routes = planned.adjustedRoutes.map((r, i) => ({
      ...r,
      // Report the bike's TRUE shift to the UI — the planner already added
      // its own dwell/wait on top of the estimate, so the reserve is spent.
      maxDurationSeconds: shiftSeconds[i]
    }));
    unassignedIds = [...(pass2.unassigned || []), ...planned.unassignedFromTruncation];
    totalDurationSeconds = routes.reduce((sum, r) => sum + (r.estimatedDurationSeconds || 0), 0);
    handoffs = planned.handoffs;
    kitchenReturns = planned.kitchenReturns;
    handoffDiagnostics = planned.diagnostics;
    passes = 2;
  }

  // On-time summary across whatever routes we ended up with.
  const totalLatenessSeconds = routes.reduce((sum, r) => sum + (r.latenessSeconds || 0), 0);
  const lateStops = routes.reduce((n, r) => n + r.stops.filter((s) => (s.lateSeconds || 0) > 0).length, 0);
  const totalStops = routes.reduce((n, r) => n + r.stops.length, 0);

  return {
    routes,
    unresolvedDeliveries,
    // Stops nothing could take within capacity/shift (incl. a bike's second
    // trip that no van could carry) — fine addresses that need more drivers
    // or a smaller batch. Distinct from unresolvedDeliveries (bad addresses).
    unassignedDeliveries: toUnassignedEntries(unassignedIds),
    handoffs,
    kitchenReturns,
    handoffDiagnostics,
    passes,
    totalDurationSeconds,
    // On-time picture (all zero when the batch has no scheduled times).
    scheduleAware: hasAnyDeadline,
    totalLatenessSeconds,
    lateStops,
    onTimeStops: totalStops - lateStops,
    depot: DEPOT
  };
}

/**
 * Persist a (possibly dispatcher-edited) route plan onto the underlying
 * Delivery documents — sets driver, routeOrder and routeOptimizedAt — and,
 * when the plan includes van↔bike handoffs, records those too: supersedes
 * any still-"planned" handoff for the same drivers on that day, creates the
 * new Handoff docs, and links each bike's second-trip deliveries to theirs.
 *
 * @param {{driverId: string, stops: {deliveryId: string, routeOrder: number}[]}[]} routes
 * @param {Array} [handoffs] as returned by optimizeRoutes
 * @param {{createdBy?: string}} [meta]
 */
export async function applyRoutePlan(routes, handoffs = [], kitchenReturns = [], { createdBy } = {}) {
  const optimizedAt = new Date();
  const bulkOps = [];
  routes.forEach(({ driverId, stops }) => {
    stops.forEach(({ deliveryId, routeOrder }) => {
      bulkOps.push({
        updateOne: {
          filter: { _id: deliveryId },
          // Every delivery in the plan starts with no handoff; the ones that
          // are a bike's second trip get theirs set below.
          update: { $set: { driver: driverId, routeOrder, routeOptimizedAt: optimizedAt, handoff: null } }
        }
      });
    });
  });

  if (bulkOps.length === 0) return { modifiedCount: 0, handoffsCreated: 0 };
  const result = await bulkWriteReportingDeliveries(Delivery, bulkOps);

  // This is the main day-to-day path deliveries actually get assigned to
  // drivers through, and it previously sent no signal to the driver at all
  // — a route only ever showed up once the driver happened to reopen the
  // app and it re-fetched. One push per driver (not per stop), fire-and-
  // forget so a slow/failed push never delays the API response.
  const pushJobs = routes
    .filter(({ stops }) => Array.isArray(stops) && stops.length > 0)
    .map(({ driverId, stops }) => sendRouteAssignedPushToDriver({ driverId, stopCount: stops.length }));
  Promise.allSettled(pushJobs).catch(() => {});

  let handoffsCreated = 0;
  const vanHandoffs = Array.isArray(handoffs) ? handoffs : [];
  const kitchenReturnList = Array.isArray(kitchenReturns) ? kitchenReturns : [];
  if (vanHandoffs.length > 0 || kitchenReturnList.length > 0) {
    const allDeliveryIds = [...vanHandoffs, ...kitchenReturnList].flatMap((h) => h.deliveryIds || []);
    const sample = await Delivery.findOne({ _id: { $in: allDeliveryIds } }).select('scheduledTime').lean();
    const date = businessDateOf(sample?.scheduledTime || optimizedAt);

    // Supersede any still-"planned" record (either type) for every bike/van
    // touched by this new plan, so re-running Optimize Routes for the same
    // day never leaves a stale handoff or kitchen return lying around.
    const driverIds = [...new Set([
      ...vanHandoffs.flatMap((h) => [h.bikeDriverId, h.vanDriverId]),
      ...kitchenReturnList.map((k) => k.bikeDriverId)
    ])];
    await Handoff.updateMany(
      { date, status: 'planned', $or: [{ bike: { $in: driverIds } }, { van: { $in: driverIds } }] },
      { $set: { status: 'cancelled' } }
    );

    const docs = await Handoff.insertMany([
      ...vanHandoffs.map((h) => ({
        type: 'van_handoff',
        van: h.vanDriverId,
        bike: h.bikeDriverId,
        date,
        meetingPoint: h.meetingPoint,
        plannedVanArrivalSeconds: h.plannedVanArrivalSeconds,
        plannedBikeArrivalSeconds: h.plannedBikeArrivalSeconds,
        expectedWaitSeconds: h.expectedWaitSeconds,
        vanAfterRouteOrder: h.vanAfterRouteOrder,
        bikeAfterRouteOrder: h.bikeAfterRouteOrder,
        deliveryIds: h.deliveryIds,
        status: 'planned',
        createdBy: createdBy || undefined
      })),
      ...kitchenReturnList.map((k) => ({
        type: 'kitchen_return',
        bike: k.bikeDriverId,
        date,
        meetingPoint: { ...DEPOT, name: DEPOT.label, poiType: 'kitchen' },
        plannedBikeDepartSeconds: k.plannedDepartSeconds,
        detourSeconds: k.detourSeconds,
        vanReason: k.vanReason,
        bikeAfterRouteOrder: k.afterRouteOrder,
        deliveryIds: k.deliveryIds,
        status: 'planned',
        createdBy: createdBy || undefined
      }))
    ]);
    handoffsCreated = docs.length;

    await bulkWriteReportingDeliveries(Delivery, docs.map((doc) => ({
      updateMany: {
        filter: { _id: { $in: doc.deliveryIds } },
        update: { $set: { handoff: doc._id } }
      }
    })));
  }

  return { modifiedCount: result.modifiedCount, handoffsCreated };
}
