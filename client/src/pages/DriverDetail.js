import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { fetchDriverById, updateDriver } from '../store/slices/driverSlice';
import api from '../utils/api';
import UserAvatar from '../components/users/UserAvatar';
import EditDriverModal from '../components/drivers/EditDriverModal';
import LogVacationModal from '../components/drivers/LogVacationModal';
import LogDeductionModal from '../components/drivers/LogDeductionModal';

const STATUS_META = {
  available: { label: 'Active', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: 'check_circle' },
  busy: { label: 'Busy', cls: 'bg-amber-50 text-amber-700 border-amber-200', icon: 'schedule' },
  offline: { label: 'Offline', cls: 'bg-gray-100 text-gray-600 border-gray-200', icon: 'cancel' },
};
const getStatusMeta = (status) => STATUS_META[status] || STATUS_META.offline;

const COMPLETED_STATUSES = ['delivered', 'completed', 'collected'];

const CHART_RANGES = [
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: '1y', label: '1Y' },
];

const buildChartWindow = (range) => {
  const now = new Date();
  now.setHours(23, 59, 59, 999);

  if (range === '30d') {
    const days = 30;
    const rangeStart = new Date(now);
    rangeStart.setDate(rangeStart.getDate() - (days - 1));
    rangeStart.setHours(0, 0, 0, 0);

    const buckets = [];
    for (let i = 0; i < days; i++) {
      const s = new Date(rangeStart);
      s.setDate(rangeStart.getDate() + i);
      const e = new Date(s);
      e.setHours(23, 59, 59, 999);
      buckets.push({ label: `${s.getMonth() + 1}/${s.getDate()}`, start: s, end: e });
    }
    return { start: rangeStart, end: now, buckets };
  }

  if (range === '90d') {
    const weeks = 13;
    const rangeStart = new Date(now);
    rangeStart.setDate(rangeStart.getDate() - (weeks * 7 - 1));
    rangeStart.setHours(0, 0, 0, 0);

    const buckets = [];
    for (let i = 0; i < weeks; i++) {
      const s = new Date(rangeStart);
      s.setDate(rangeStart.getDate() + i * 7);
      const e = new Date(s);
      e.setDate(s.getDate() + 6);
      e.setHours(23, 59, 59, 999);
      buckets.push({ label: `${s.getMonth() + 1}/${s.getDate()}`, start: s, end: e });
    }
    return { start: rangeStart, end: now, buckets };
  }

  // 1y — 12 monthly buckets
  const months = 12;
  const startMonth = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  const buckets = [];
  for (let i = 0; i < months; i++) {
    const s = new Date(startMonth.getFullYear(), startMonth.getMonth() + i, 1);
    const e = new Date(s.getFullYear(), s.getMonth() + 1, 0, 23, 59, 59, 999);
    buckets.push({ label: s.toLocaleDateString('en-US', { month: 'short' }), start: s, end: e });
  }
  return { start: startMonth, end: now, buckets };
};

const fetchAllDeliveriesInRange = async (driverId, start, end) => {
  const MAX_PAGES = 6; // safety cap: 6 * 500 = 3000 records
  let page = 1;
  let all = [];
  while (page <= MAX_PAGES) {
    const res = await api.get('/deliveries', {
      params: { driver: driverId, dateFrom: start.toISOString(), dateTo: end.toISOString(), limit: 500, page }
    });
    const payload = res.data?.data || {};
    const list = payload.deliveries || [];
    all = all.concat(list);
    const pages = payload.pagination?.pages || 1;
    if (page >= pages) break;
    page++;
  }
  return all;
};

const isSameOrWithin = (date, start, end) => {
  const t = new Date(date).setHours(0, 0, 0, 0);
  return t >= new Date(start).setHours(0, 0, 0, 0) && t <= new Date(end).setHours(0, 0, 0, 0);
};

const DriverDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { currentDriver, isLoading } = useSelector((state) => state.driver);

  const [showEditModal, setShowEditModal] = useState(false);
  const [showVacationModal, setShowVacationModal] = useState(false);
  const [showDeductionModal, setShowDeductionModal] = useState(false);

  const [chartRange, setChartRange] = useState('30d');
  const [chartBuckets, setChartBuckets] = useState([]);
  const [chartLoading, setChartLoading] = useState(false);

  const [weeklyStats, setWeeklyStats] = useState(null);
  const [liveLocation, setLiveLocation] = useState(null);

  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  useEffect(() => {
    if (id) dispatch(fetchDriverById(id));
  }, [dispatch, id]);

  // Where the driver's phone last reported being, with its street address
  // (the app sends coordinates only; the server looks the address up).
  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    const load = () => api.get(`/users/drivers/${id}/location`)
      .then((res) => { if (!cancelled) setLiveLocation(res.data?.data?.location || null); })
      .catch(() => { if (!cancelled) setLiveLocation(null); });
    load();
    const timer = setInterval(load, 60 * 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    api.get(`/users/drivers/${id}/stats/weekly`)
      .then((res) => setWeeklyStats(res.data))
      .catch(() => setWeeklyStats(null));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setChartLoading(true);

    const { start, end, buckets } = buildChartWindow(chartRange);

    fetchAllDeliveriesInRange(id, start, end)
      .then((deliveries) => {
        if (cancelled) return;
        const counts = buckets.map(() => 0);
        deliveries.forEach((d) => {
          if (!COMPLETED_STATUSES.includes(d.status)) return;
          const t = new Date(d.scheduledTime).getTime();
          for (let i = 0; i < buckets.length; i++) {
            if (t >= buckets[i].start.getTime() && t <= buckets[i].end.getTime()) {
              counts[i]++;
              break;
            }
          }
        });
        setChartBuckets(buckets.map((b, i) => ({ ...b, count: counts[i] })));
      })
      .catch(() => {
        if (!cancelled) setChartBuckets(buckets.map((b) => ({ ...b, count: 0 })));
      })
      .finally(() => {
        if (!cancelled) setChartLoading(false);
      });

    return () => { cancelled = true; };
  }, [id, chartRange]);

  const handleSaveVacation = useCallback(async (vacation) => {
    await dispatch(updateDriver({ id, driverData: { profile: { vacation } } })).unwrap();
  }, [dispatch, id]);

  const handleSaveDeduction = useCallback(async (deductions) => {
    await dispatch(updateDriver({ id, driverData: { profile: { deductions } } })).unwrap();
  }, [dispatch, id]);

  const handleRemoveDeduction = useCallback(async (index) => {
    if (!currentDriver) return;
    const existing = currentDriver.profile?.deductions || [];
    const next = existing.filter((_, i) => i !== index);
    await dispatch(updateDriver({ id, driverData: { profile: { deductions: next } } })).unwrap();
  }, [dispatch, id, currentDriver]);

  const weeklyTrend = useMemo(() => {
    if (!weeklyStats?.currentWeek?.stats || !weeklyStats?.lastWeek?.stats) return null;
    const cur = weeklyStats.currentWeek.stats;
    const prev = weeklyStats.lastWeek.stats;

    const lateDelta = (cur.avgLateMinutes || 0) - (prev.avgLateMinutes || 0);

    const curAccuracy = cur.total ? ((cur.onTime / cur.total) * 100) : null;
    const prevAccuracy = prev.total ? ((prev.onTime / prev.total) * 100) : null;
    const accuracyDelta = (curAccuracy !== null && prevAccuracy !== null) ? curAccuracy - prevAccuracy : null;

    return { lateDelta, accuracyDelta };
  }, [weeklyStats]);

  const maxBucketCount = useMemo(
    () => Math.max(1, ...chartBuckets.map((b) => b.count)),
    [chartBuckets]
  );

  const vacation = currentDriver?.profile?.vacation || {};
  const allowanceDays = vacation.allowanceDays ?? 30;
  const usedDays = vacation.usedDays || 0;
  const remainingDays = Math.max(0, allowanceDays - usedDays);
  const isCurrentlyOnVacation = vacation.currentStart && vacation.currentEnd
    && new Date(vacation.currentStart) <= new Date() && new Date() <= new Date(vacation.currentEnd);

  const deductions = currentDriver?.profile?.deductions || [];
  const now = new Date();
  const currentMonthDeductions = deductions
    .map((d, index) => ({ ...d, index }))
    .filter((d) => {
      const dt = new Date(d.date);
      return dt.getMonth() === now.getMonth() && dt.getFullYear() === now.getFullYear();
    });
  const baseSalary = currentDriver?.profile?.baseSalary || 0;
  const totalDeductions = currentMonthDeductions.reduce((sum, d) => sum + (d.amount || 0), 0);
  const netSalary = baseSalary - totalDeductions;
  const currentPeriodLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const calendarCells = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startWeekday = firstDay.getDay();

    const ranges = [];
    if (vacation.currentStart && vacation.currentEnd) {
      ranges.push([vacation.currentStart, vacation.currentEnd]);
    }
    (vacation.history || []).forEach((h) => {
      if (h.startDate && h.endDate) ranges.push([h.startDate, h.endDate]);
    });

    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      const onVacation = ranges.some(([s, e]) => isSameOrWithin(date, s, e));
      cells.push({ day, date, onVacation });
    }
    return cells;
  }, [calendarMonth, vacation]);

  if (isLoading && !currentDriver) {
    return (
      <div className="matter-analytics flex items-center justify-center h-64 text-gray-500">
        <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
        Loading driver details...
      </div>
    );
  }

  if (!currentDriver) {
    return (
      <div className="matter-analytics flex items-center justify-center h-64 text-red-600">
        Driver not found
      </div>
    );
  }

  const firstName = currentDriver.profile?.firstName || 'Unknown';
  const lastName = currentDriver.profile?.lastName || 'Driver';
  const statusMeta = getStatusMeta(currentDriver.profile?.status);
  const isActive = currentDriver.isActive !== false;

  return (
    <div className="matter-analytics p-6 max-w-6xl mx-auto w-full">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-6 text-gray-500 text-xs font-semibold">
        <button onClick={() => navigate('/drivers')} className="hover:text-blue-600 transition-colors flex items-center gap-1">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          Back to Fleet
        </button>
        <span>/</span>
        <span className="text-gray-900">Driver Profile</span>
      </div>

      {/* Profile Header Card */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="flex items-center gap-6">
          <UserAvatar
            user={currentDriver}
            sizePx={96}
            fallbackName={`${firstName} ${lastName}`}
            fallbackEmail={currentDriver.email}
            className="shadow-sm"
          />
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h2 className="text-2xl font-semibold text-gray-900">{firstName} {lastName}</h2>
              <span className={`px-2 py-0.5 rounded text-xs font-semibold border flex items-center gap-1 ${isActive ? statusMeta.cls : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
                <span className="material-symbols-outlined text-[14px]">{isActive ? statusMeta.icon : 'cancel'}</span>
                {isActive ? statusMeta.label : 'Inactive'}
              </span>
            </div>
            <p className="text-sm text-gray-500 mb-3 flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px]">badge</span> ID: {currentDriver._id}
            </p>
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-8">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-gray-400 text-[18px]">call</span>
                <span className="text-sm text-gray-900">{currentDriver.profile?.phone || 'No phone'}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-gray-400 text-[18px]">mail</span>
                <span className="text-sm text-gray-900">{currentDriver.email}</span>
              </div>
            </div>
            <div className="flex items-start gap-2 mt-2" data-testid="driver-current-location">
              <span className="material-symbols-outlined text-gray-400 text-[18px]">location_on</span>
              {liveLocation ? (
                <span className="text-sm text-gray-900">
                  {liveLocation.address || 'Address not available'}
                  <a
                    href={`https://www.google.com/maps?q=${liveLocation.latitude},${liveLocation.longitude}`}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-2 text-blue-600 hover:underline"
                  >
                    Map
                  </a>
                  {liveLocation.lastUpdated && (
                    <span className="ml-2 text-xs text-gray-400">
                      updated {new Date(liveLocation.lastUpdated).toLocaleString()}
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-sm text-gray-400">No location reported yet</span>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={() => setShowEditModal(true)}
          className="flex items-center gap-2 px-5 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <span className="material-symbols-outlined text-[18px]">edit</span> Edit Profile
        </button>
      </div>

      {/* KPIs + Chart */}
      <div className="grid grid-cols-12 gap-4 mb-6">
        <div className="col-span-12 lg:col-span-4 flex flex-col gap-3">
          <h3 className="text-base font-semibold text-gray-900">Performance KPIs</h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col justify-between">
              <div className="flex justify-between items-start mb-2">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">OTD Rate (This Month)</span>
                {weeklyTrend?.accuracyDelta != null && (
                  <span className={`material-symbols-outlined text-[18px] ${weeklyTrend.accuracyDelta >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                    {weeklyTrend.accuracyDelta >= 0 ? 'trending_up' : 'trending_down'}
                  </span>
                )}
              </div>
              <div className="text-3xl font-bold text-gray-900">{currentDriver.kpi?.accuracyRate || 0}<span className="text-base text-gray-400">%</span></div>
              <div className="w-full bg-gray-100 h-1 mt-2 rounded-full overflow-hidden">
                <div className="bg-emerald-500 h-full" style={{ width: `${currentDriver.kpi?.accuracyRate || 0}%` }} />
              </div>
            </div>
            <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col justify-between">
              <div className="flex justify-between items-start mb-2">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">KPI Score (This Month)</span>
                <span className="material-symbols-outlined text-blue-600 text-[18px]">military_tech</span>
              </div>
              <div className="text-3xl font-bold text-gray-900">{currentDriver.kpi?.score || 0}<span className="text-base text-gray-400">/100</span></div>
              <div className="w-full bg-gray-100 h-1 mt-2 rounded-full overflow-hidden">
                <div className="bg-blue-600 h-full" style={{ width: `${currentDriver.kpi?.score || 0}%` }} />
              </div>
            </div>
            <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col justify-between">
              <div className="flex justify-between items-start mb-2">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Avg. Delay (This Month)</span>
                <span className="material-symbols-outlined text-amber-500 text-[18px]">schedule</span>
              </div>
              <div className="text-3xl font-bold text-gray-900">{currentDriver.kpi?.avgLateTime || 0}<span className="text-base text-gray-400">m</span></div>
              {weeklyTrend?.lateDelta != null && (
                <div className={`text-[11px] mt-1 flex items-center gap-0.5 ${weeklyTrend.lateDelta > 0 ? 'text-amber-600' : weeklyTrend.lateDelta < 0 ? 'text-emerald-600' : 'text-gray-400'}`}>
                  <span className="material-symbols-outlined text-[12px]">
                    {weeklyTrend.lateDelta > 0 ? 'arrow_drop_up' : weeklyTrend.lateDelta < 0 ? 'arrow_drop_down' : 'remove'}
                  </span>
                  {weeklyTrend.lateDelta === 0 ? 'No change this week' : `${weeklyTrend.lateDelta > 0 ? '+' : ''}${weeklyTrend.lateDelta.toFixed(1)}m this week`}
                </div>
              )}
            </div>
            <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col justify-between">
              <div className="flex justify-between items-start mb-2">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Complaints</span>
                <span className="material-symbols-outlined text-gray-400 text-[18px]">report</span>
              </div>
              <div className={`text-3xl font-bold ${(currentDriver.kpi?.complaintsCount || 0) > 0 ? 'text-red-600' : 'text-gray-900'}`}>{currentDriver.kpi?.complaintsCount || 0}</div>
              <div className="text-[11px] text-gray-400 mt-1">All-Time Total</div>
            </div>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-8 flex flex-col gap-3">
          <div className="flex justify-between items-end">
            <h3 className="text-base font-semibold text-gray-900">Delivery Volume</h3>
            <div className="flex bg-gray-100 rounded p-1 border border-gray-200">
              {CHART_RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setChartRange(r.key)}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                    chartRange === r.key ? 'bg-white border border-gray-200 shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-900'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl p-5 flex-1 flex flex-col relative min-h-[300px]">
            {chartLoading ? (
              <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span> Loading…
              </div>
            ) : (
              <>
                <div className="flex-1 flex items-end justify-around gap-1 px-1 pb-2 border-b border-l border-gray-200 ml-6">
                  {chartBuckets.map((b, i) => {
                    const heightPct = Math.round((b.count / maxBucketCount) * 100);
                    const isPeak = b.count > 0 && b.count === maxBucketCount;
                    return (
                      <div
                        key={i}
                        className={`flex-1 rounded-t-sm relative group transition-all duration-300 cursor-pointer ${
                          isPeak ? 'bg-blue-600' : 'bg-blue-600/20 hover:bg-blue-600/40'
                        }`}
                        style={{ height: `${Math.max(heightPct, 2)}%` }}
                      >
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-gray-900 text-white text-[11px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10 pointer-events-none">
                          {b.count} deliveries
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-around ml-6 text-[10px] text-gray-400 mt-2">
                  {chartBuckets.map((b, i) => (
                    (chartRange !== '30d' || i % 3 === 0) && <span key={i}>{b.label}</span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Recent Deliveries */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden mb-6">
        <div className="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
          <h3 className="text-base font-semibold text-gray-900">Recent Deliveries</h3>
          <Link to={`/deliveries?driver=${id}`} className="text-blue-600 text-xs font-semibold hover:underline flex items-center gap-1">
            View All <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100 text-[11px] text-gray-500 uppercase tracking-wider">
                <th className="p-3 font-semibold">Delivery</th>
                <th className="p-3 font-semibold">Customer</th>
                <th className="p-3 font-semibold">Date</th>
                <th className="p-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="text-sm text-gray-900">
              {(currentDriver.recentDeliveries || []).slice(0, 10).map((d) => {
                const isDelivered = COMPLETED_STATUSES.includes(d.status);
                const isLate = (d.lateMinutes || 0) > 0;
                return (
                  <tr key={d.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                    <td className="p-3 font-mono text-blue-600 text-xs">{String(d.id).slice(-8).toUpperCase()}</td>
                    <td className="p-3">{d.customer || '—'}</td>
                    <td className="p-3 text-gray-500">{new Date(d.date).toLocaleDateString()}</td>
                    <td className="p-3">
                      {isDelivered ? (
                        isLate ? (
                          <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-700 px-2 py-0.5 rounded text-[11px] border border-amber-200">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Delayed ({d.lateMinutes}m)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded text-[11px] border border-emerald-200">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> On Time
                          </span>
                        )
                      ) : (
                        <span className="inline-flex items-center gap-1 bg-gray-100 text-gray-600 px-2 py-0.5 rounded text-[11px] border border-gray-200">
                          {d.status.replace('_', ' ')}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {(!currentDriver.recentDeliveries || currentDriver.recentDeliveries.length === 0) && (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-gray-400">No delivery history found</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Compensation Overview */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden mb-6">
        <div className="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
          <h3 className="text-base font-semibold text-gray-900">Compensation Overview</h3>
          <div className="text-gray-500 text-xs font-medium">Current Period: {currentPeriodLabel}</div>
        </div>
        <div className="p-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Base Salary</span>
              <div className="text-2xl font-bold text-gray-900">AED {baseSalary.toLocaleString()} <span className="text-sm text-gray-400 font-normal">/ mo</span></div>
            </div>
            <div className="md:col-span-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Deductions ({currentPeriodLabel})</span>
                <button
                  onClick={() => setShowDeductionModal(true)}
                  className="text-blue-600 text-xs font-semibold hover:underline flex items-center gap-0.5"
                >
                  <span className="material-symbols-outlined text-[14px]">add</span> Log Deduction
                </button>
              </div>
              <div className="space-y-2">
                {currentMonthDeductions.map((d) => (
                  <div key={d.index} className="flex justify-between items-center p-3 bg-gray-50 rounded-lg border border-gray-100">
                    <div className="flex items-center gap-3">
                      <span className={`material-symbols-outlined text-[20px] ${d.category === 'fine' ? 'text-red-500' : 'text-gray-400'}`}>
                        {d.category === 'fine' ? 'gavel' : d.category === 'damage' ? 'build' : 'remove_circle'}
                      </span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{d.reason}</p>
                        <p className="text-xs text-gray-500">{new Date(d.date).toLocaleDateString()}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm text-red-600">-AED {Number(d.amount || 0).toLocaleString()}</span>
                      <button
                        onClick={() => handleRemoveDeduction(d.index)}
                        className="text-gray-400 hover:text-red-600 transition-colors"
                        title="Remove"
                      >
                        <span className="material-symbols-outlined text-[16px]">close</span>
                      </button>
                    </div>
                  </div>
                ))}
                {currentMonthDeductions.length === 0 && (
                  <div className="text-sm text-gray-400 py-2">No deductions logged this period.</div>
                )}
              </div>
            </div>
          </div>
          <div className="mt-6 pt-6 border-t border-gray-100 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-emerald-500">payments</span>
              <span className="text-base font-semibold text-gray-900">Net Salary</span>
            </div>
            <div className="text-2xl font-bold text-blue-600">AED {netSalary.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Vacation Management */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden mb-6">
        <div className="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
          <h3 className="text-base font-semibold text-gray-900">Vacation Management</h3>
          <div className="text-gray-500 text-xs font-medium">Year: {now.getFullYear()}</div>
        </div>
        <div className="p-5">
          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-12 lg:col-span-4 flex flex-col gap-3">
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider block mb-1">Total Vacation Days</span>
                <div className="text-2xl font-bold text-gray-900">{allowanceDays} Days</div>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider block mb-1">Days Taken</span>
                <div className="text-2xl font-bold text-amber-500">{usedDays} Days</div>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider block mb-1">Remaining Balance</span>
                <div className="text-2xl font-bold text-emerald-500">{remainingDays} Days</div>
              </div>
              {isCurrentlyOnVacation && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Currently on vacation until {new Date(vacation.currentEnd).toLocaleDateString()}
                </div>
              )}
              <button
                onClick={() => setShowVacationModal(true)}
                className="mt-1 bg-blue-600 text-white py-2 px-4 rounded-lg w-full font-medium text-sm hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-[18px]">event_available</span> Request Time Off
              </button>
            </div>

            <div className="col-span-12 lg:col-span-8">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold text-gray-900">
                  {calendarMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                </h4>
                <div className="flex gap-1">
                  <button
                    onClick={() => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                    className="p-1 hover:bg-gray-100 rounded"
                  >
                    <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                  </button>
                  <button
                    onClick={() => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
                    className="p-1 hover:bg-gray-100 rounded"
                  >
                    <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-7 gap-px bg-gray-200 border border-gray-200 rounded overflow-hidden">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                  <div key={i} className="bg-gray-50 p-2 text-center text-[11px] font-semibold text-gray-500">{d}</div>
                ))}
                {calendarCells.map((cell, i) => (
                  <div
                    key={i}
                    className={`bg-white p-2 min-h-[52px] text-xs ${
                      !cell ? 'bg-gray-50' : cell.onVacation ? 'bg-blue-50 border-2 border-blue-200' : ''
                    }`}
                  >
                    {cell && (
                      <>
                        <span className={cell.onVacation ? 'font-bold text-blue-600' : 'text-gray-700'}>{cell.day}</span>
                        {cell.onVacation && <div className="text-[8px] text-blue-600 font-bold mt-1">VACATION</div>}
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {showEditModal && (
        <EditDriverModal driver={currentDriver} onClose={() => setShowEditModal(false)} />
      )}
      {showVacationModal && (
        <LogVacationModal
          driver={currentDriver}
          onClose={() => setShowVacationModal(false)}
          onSave={handleSaveVacation}
        />
      )}
      {showDeductionModal && (
        <LogDeductionModal
          driver={currentDriver}
          onClose={() => setShowDeductionModal(false)}
          onSave={handleSaveDeduction}
        />
      )}
    </div>
  );
};

export default DriverDetail;
