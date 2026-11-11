import { CUSTOMER_RADIUS_METRES } from './truckoomVisitRules.js';
import axios from 'axios';
import dotenv from 'dotenv';
import { cacheGet, cacheSet } from '../config/cache.js';
import { createTruckoomLiveCache, normalizeTruckoomLiveData } from './truckoomLiveData.js';
import { retainGpsResponse, scopedLiveGpsPayload, scopedHistoryGpsPayload } from './truckoomGpsEvidence.js';
import { alertDataRows } from './truckoomAlertData.js';

dotenv.config();

// Live vehicle GPS tracking (Truckoom "Trace") — owner, 2026-09-24. Two
// endpoints originally used by this integration:
//   - getCompanyWiseVehicleData: which vehicles exist (vehicle_no, imei,
//     device_name — the device_name happens to carry the driver's name for
//     most of this fleet, but that's not relied on for matching; a driver
//     is linked to a vehicle_no explicitly via User.profile.truckoomVehicleNo).
//   - getVehiclesWithLocationDetails: each vehicle's current lat/lng (replaced
//     on 2026-10-23 by getTokenBaseLiveData, ProjectId=49, including GPS time).
//
// Both were verified live against the real account before building this:
// getCompanyWiseVehicleData wants a JSON body, getVehiclesWithLocationDetails
// wants plain GET query params — genuinely inconsistent between the two,
// confirmed by testing, not a guess.
//
// Cached briefly (FLEET_CACHE_TTL_SECONDS) so N dispatchers with Live
// Tracking or Driver Routes open, each polling every ~60s client-side,
// don't turn into N real Truckoom calls a minute — one real fetch serves
// all of them.

const FLEET_CACHE_TTL_SECONDS = 60;
const FLEET_CACHE_KEY = 'truckoom:fleet:vehicles:v3';

class TruckoomApiService {
  constructor() {
    this.baseURL = process.env.TRUCKOOM_BASE_URL || 'https://trace.truckoom.com/webservice';
    this.username = process.env.TRUCKOOM_USERNAME;
    this.password = process.env.TRUCKOOM_PASSWORD;
    this.companyName = process.env.TRUCKOOM_COMPANY_NAME;
    this.cachedLiveData = createTruckoomLiveCache();
    this.retainGpsResponse = retainGpsResponse;
  }

  assertConfigured() {
    if (!this.username || !this.password || !this.companyName) {
      throw new Error('Truckoom API is not configured (missing TRUCKOOM_USERNAME/TRUCKOOM_PASSWORD/TRUCKOOM_COMPANY_NAME)');
    }
  }

  isConfigured() {
    return Boolean(this.username && this.password && this.companyName);
  }

  async getAccessToken() {
    this.assertConfigured();
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken;
    if (this.accessTokenPromise) return this.accessTokenPromise;
    this.accessTokenPromise = (async () => {
      const { data } = await axios.post(`${this.baseURL}?token=generateAccessToken`,
        { username: this.username, password: this.password }, { timeout: 15000 });
      const token = data?.data?.token || data?.token;
      if (Number(data?.result) !== 1 || !token) throw new Error('Truckoom token request failed');
      this.accessToken = token;
      this.accessTokenExpiresAt = Date.now() + 30 * 60 * 1000;
      return token;
    })();
    try { return await this.accessTokenPromise; } finally { this.accessTokenPromise = null; }
  }

  async geofenceRequest(method, body, retry = true, beforeDispatch, afterResponse) {
    const token = await this.getAccessToken();
    if (beforeDispatch) await beforeDispatch(body);
    const requestStartedAt = new Date();
    const { data } = await axios.post(`${this.baseURL}?token=${method}`, body,
      { headers: { 'auth-code': token }, timeout: 15000,
        ...(method === 'getVehicleTrackLogs' ? { maxContentLength: 32 * 1024 * 1024 } : {}) });
    const sourceReceipt = afterResponse ? await afterResponse(data, requestStartedAt, new Date(), body) : null;
    if (Number(data?.result) !== 1) {
      if (retry && /token|auth-code/i.test(data?.message || '')) {
        this.accessToken = null;
        return this.geofenceRequest(method, body, false, beforeDispatch, afterResponse);
      }
      throw new Error(`Truckoom ${method} failed`);
    }
    if (sourceReceipt && Array.isArray(data.data)) Object.defineProperty(data.data, 'sourceReceipt', { value: sourceReceipt });
    return data.data;
  }

  async getGeofences() {
    const data = await this.geofenceRequest('getGeofenceList', { project_id: '49' });
    if (!Array.isArray(data)) throw new Error('Unexpected Truckoom geofence list response');
    return data.filter(f => f['Company Name'] === this.companyName);
  }

  async createCustomerGeofence(name, pin, radiusMetres = CUSTOMER_RADIUS_METRES) {
    // Owner (2026-10-30): omit group assignment, like the kitchen geofence.
    const data = await this.geofenceRequest('createGeofence', {
      project_id: '49', geofence_type: 'circle', geo_shape: 'circle',
      reseller_name: 'Truckoom Technologies', company_name: this.companyName,
      geofence_name: name, category_name: 'Area',
      coordinates: [[pin.lat, pin.lng]], radius: String(radiusMetres / 1000),
    });
    if (!data?.geofenceId) throw new Error('Truckoom did not return a geofence id');
    return String(data.geofenceId);
  }

  // Legacy endpoint retained for diagnostics; customer visits use getAlertData.
  async getGeofenceAlerts(date, retry = true) {
    this.assertConfigured();
    try {
      const { data } = await axios.get(this.baseURL, { params: {
        token: 'getGeofenceAlerts', user: this.username, pass: this.password, Date: date,
      }, timeout: 20000 });
      if (!Array.isArray(data)) throw Object.assign(new Error('Truckoom geofence alerts request failed'), { code: 'TRUCKOOM_INVALID_RESPONSE' });
      return data;
    } catch (error) {
      const status=error.response?.status;
      if (retry && (!status || status === 408 || status >= 500)) return this.getGeofenceAlerts(date, false);
      throw error;
    }
  }

  async getAlertData(from, to, retry = true) {
    this.assertConfigured();
    // Epoch milliseconds, inclusive endpoints, maximum 24 hours per request.
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from || to - from > 86400000) {
      throw new RangeError('Alert data requires an explicit range of at most 24 hours');
    }
    const token = await this.getAccessToken();
    const { data } = await axios.post(`${this.baseURL}?token=getAlertData`, {
      access_token: token, username: this.username, password: this.password,
      format: 'json', from, to,
    }, { timeout: 25000 });
    const envelopes = Array.isArray(data) ? data : [data];
    if (retry && envelopes.some(item => Number(item?.result ?? item?.status) === 0
      && /token.*(?:invalid|expired)|(?:invalid|expired).*token/i.test(item?.message || ''))) {
      this.accessToken = null;
      return this.getAlertData(from, to, false);
    }
    return alertDataRows(data);
  }

  async getVehicleTrackLogs(vehicleNo, startDate, endDate, { beforeDispatch } = {}) {
    return this.geofenceRequest('getVehicleTrackLogs', {
      vehicle_no: String(vehicleNo), start_date: startDate, end_date: endDate,
    }, false, beforeDispatch, (payload, requestStartedAt, responseReceivedAt, dispatchedBody) => this.retainGpsResponse({
      kind: 'history', scope: { vehicleNo: String(vehicleNo), startDate: dispatchedBody.start_date, endDate: dispatchedBody.end_date },
      requestStartedAt, responseReceivedAt, payload: scopedHistoryGpsPayload(payload, vehicleNo),
    })); // Never retry inside the three-minute limit.
  }

  async deleteCustomerGeofence(id) {
    await this.geofenceRequest('deletGeofence', { project_id: '49', geofence_id: String(id) });
  }

  /** Every vehicle registered under the company — vehicle_no, imei, device_name. */
  async getCompanyVehicles() {
    this.assertConfigured();
    const response = await axios.post(
      `${this.baseURL}?token=getCompanyWiseVehicleData`,
      { username: this.username, password: this.password, company_name: this.companyName },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    if (response.data?.result !== 1) {
      throw new Error(response.data?.message || 'Failed to fetch Truckoom vehicle list');
    }
    const branches = response.data?.data?.branch || [];
    return branches.flatMap((branch) => (branch.vehicles || []).map((v) => ({
      vehicleNo: String(v.vehicle_no || '').trim(),
      imei: v.imei_no || null,
      deviceName: v.device_name || null,
      deviceModel: v.device_model || null,
    })));
  }

  /** New token-based live data, shared at most once a minute across workers. */
  async getVehicleLocations() {
    this.assertConfigured();
    return this.cachedLiveData(async beforeDispatch => {
      const token = await this.getAccessToken();
      await beforeDispatch?.();
      const requestStartedAt = new Date();
      const { data } = await axios.post(`${this.baseURL}?token=getTokenBaseLiveData&ProjectId=49`,
        { company_names: '', format: 'json' }, { headers: { 'auth-code': token }, timeout: 20000, maxContentLength: 32 * 1024 * 1024 });
      if (/token|auth-code/i.test(data?.root?.error || '')) this.accessToken = null;
      let sourceReceipt = null;
      try {
        sourceReceipt = await this.retainGpsResponse({ kind: 'live', scope: { company: this.companyName },
          requestStartedAt, responseReceivedAt: new Date(), payload: scopedLiveGpsPayload(data, this.companyName) });
      } catch {
        // Preserve the operational live view. The recorder rejects this snapshot
        // as unarchived and records a failed tick instead of claiming evidence.
      }
      const vehicles = normalizeTruckoomLiveData(data, this.companyName).map(row => ({ ...row, sourceReceipt }));
      Object.defineProperties(vehicles, { sourceReceipt: { value: sourceReceipt },
        captureEvidenceStatus: { value: sourceReceipt ? 'retained' : 'unavailable' } });
      return vehicles;
    });
  }

  /**
   * Merged, cached view: every vehicle with its current location (location
   * fields null if that vehicle didn't come back in the location call).
   * Driver matching is NOT done here — that needs a DB read (User model),
   * which this service deliberately doesn't depend on; routes/truckoomApi.js
   * joins this against User.profile.truckoomVehicleNo.
   */
  async getFleetStatus() {
    const cached = await cacheGet(FLEET_CACHE_KEY);
    if (cached?.vehicles) {
      Object.defineProperties(cached.vehicles, { sourceReceipt: { value: cached.sourceReceipt || null },
        captureEvidenceStatus: { value: cached.captureEvidenceStatus || 'unverified_cache' } });
      return cached.vehicles;
    }

    const [vehicles, locations] = await Promise.all([
      this.getCompanyVehicles(),
      this.getVehicleLocations(),
    ]);
    const locationsByVehicle = new Map();
    for (const location of locations) {
      const candidates = locationsByVehicle.get(location.vehicleNo) || [];
      candidates.push(location); locationsByVehicle.set(location.vehicleNo, candidates);
    }

    const fleet = vehicles.map((v) => {
      const candidates = locationsByVehicle.get(v.vehicleNo) || [];
      const loc = candidates.length === 1 ? candidates[0] : null;
      return {
        vehicleNo: v.vehicleNo,
        imei: v.imei,
        deviceName: v.deviceName,
        vehicleType: loc?.vehicleType || null,
        latitude: Number.isFinite(loc?.latitude) ? loc.latitude : null,
        longitude: Number.isFinite(loc?.longitude) ? loc.longitude : null,
        gpsTime: loc?.gpsTime || null,
        rawGpsTime: loc?.rawGpsTime || null,
        rawTrackerServerTime: loc?.rawTrackerServerTime || null,
        trackerServerTime: loc?.trackerServerTime || null,
        speedKph: loc?.speedKph ?? null,
        ignition: loc?.ignition || null,
        trackerStatus: loc?.trackerStatus || null,
        address: loc?.address || null,
        locationSource: loc?.locationSource || null,
        rawCoordinates: loc?.rawCoordinates || null,
        sourceRow: loc?.sourceRow ?? null,
        sourceReceipt: loc?.sourceReceipt || candidates[0]?.sourceReceipt || locations.sourceReceipt || null,
        sourceQualityFlags: candidates.length > 1 ? ['conflicting_live_vehicle_rows'] : [],
      };
    });

    const sourceReceipt = locations.sourceReceipt || locations[0]?.sourceReceipt || null;
    const captureEvidenceStatus = locations.captureEvidenceStatus || (sourceReceipt ? 'retained' : 'unverified_cache');
    Object.defineProperties(fleet, { sourceReceipt: { value: sourceReceipt }, captureEvidenceStatus: { value: captureEvidenceStatus } });
    await cacheSet(FLEET_CACHE_KEY, { vehicles: fleet, sourceReceipt, captureEvidenceStatus }, FLEET_CACHE_TTL_SECONDS);
    return fleet;
  }
}

export default new TruckoomApiService();
