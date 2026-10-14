import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Users, Award, Package, MapPin, Clock, FileText, Download, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import api from '../utils/api';
import { formatDate, isCycleEnded } from '../utils/subscriptionFormat';

function KpiCard({ icon: Icon, label, value, sub }) {
  return (
    <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">{label}</p>
        <Icon className="w-4 h-4 text-gray-300" />
      </div>
      <p className="font-serif-mgmt text-2xl font-bold text-matter-navy leading-tight truncate">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

const escapeCsvCell = (value) => {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const downloadCsv = (filename, header, rows) => {
  const csv = [header, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join('\n');
  const blob = new Blob([String.fromCharCode(0xFEFF) + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const todayKey = () => new Date().toISOString().slice(0, 10);

function ReportModal({ subscriptions, onClose }) {
  const [downloadingKey, setDownloadingKey] = useState(null);
  const [downloadError, setDownloadError] = useState('');
  const [expandedKey, setExpandedKey] = useState(null);
  const [rangeFrom, setRangeFrom] = useState(todayKey);
  const [rangeTo, setRangeTo] = useState(todayKey);

  const downloadLeadDeliveryDate = () => {
    const activeSubs = subscriptions.filter(
      (s) => s.subscription_status === 'active' && !isCycleEnded(s.cycle_end_date)
    );

    const rows = activeSubs.map((s) => {
      const duration = s.starting_date && s.cycle_end_date
        ? Math.round((new Date(s.cycle_end_date) - new Date(s.starting_date)) / 86400000) + 1
        : null;
      return [
        s.name || '',
        formatDate(s.starting_date),
        duration !== null ? `${duration} days` : '—',
        formatDate(s.cycle_end_date),
      ];
    });

    downloadCsv(
      `lead-delivery-date-${todayKey()}.csv`,
      ['Customer Name', 'Starting Date', 'Duration', 'Last Delivery Date'],
      rows
    );
    onClose();
  };

  // Matter's delivery_schedule already reflects pauses: a paused day's entry
  // has status "paused" and its auto-assigned resume day is added back in as
  // a normal "active" entry — so filtering on status === 'active' naturally
  // excludes skipped customers and includes resumed ones, for every date in
  // the chosen range. One worksheet per date, matching the Reports page's
  // Multi-Month Excel Export pattern.
  const downloadDeliverySheet = async () => {
    if (rangeTo < rangeFrom) {
      setDownloadError('The end date must be on or after the start date.');
      return;
    }
    setDownloadError('');
    setDownloadingKey('delivery-sheet');
    try {
      const res = await api.get('/matter/subscriptions/delivery-on-date', {
        params: { date: rangeFrom, dateTo: rangeTo }
      });
      const subs = res.data?.data || [];

      const byDate = new Map();
      subs.forEach((s) => {
        const dateKey = s.delivery_date || rangeFrom;
        if (!byDate.has(dateKey)) byDate.set(dateKey, []);
        byDate.get(dateKey).push(s);
      });
      const sortedDates = Array.from(byDate.keys()).sort();

      if (sortedDates.length === 0) {
        setDownloadError('No scheduled deliveries found for that date range.');
        return;
      }

      const workbook = XLSX.utils.book_new();
      sortedDates.forEach((dateKey) => {
        const dayCustomers = byDate.get(dateKey)
          .slice()
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        const sheetData = [
          ['Matter Delivery Tracker'],
          [`Deliveries for ${dateKey}`],
          [`Total: ${dayCustomers.length}`],
          [],
          ['Customer Name', 'Email', 'Phone', 'Address', 'Zone', 'Delivery Window', 'Plan', 'Meals/Day', 'Snacks/Day', 'Exclusions'],
        ];

        dayCustomers.forEach((s) => {
          sheetData.push([
            s.name || '',
            s.email || '',
            s.phone || '',
            s.address || '',
            s.zone || '',
            s.delivery_window?.label || '',
            s.plan_name || '',
            s.meal_frequency ?? '',
            s.snacks_per_day ?? '',
            (s.exclusions || []).join('; '),
          ]);
        });

        const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
        worksheet['!cols'] = [24, 26, 16, 32, 18, 18, 18, 12, 12, 24].map((w) => ({ wch: w }));
        // Sheet names can't exceed 31 chars or contain : \ / ? * [ ] — "YYYY-MM-DD" is safe
        XLSX.utils.book_append_sheet(workbook, worksheet, dateKey);
      });

      const workbookArray = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const filename = rangeFrom === rangeTo
        ? `delivery-sheet-${rangeFrom}.xlsx`
        : `delivery-sheet-${rangeFrom}-to-${rangeTo}.xlsx`;

      const blob = new Blob([workbookArray], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      console.error('Failed to generate delivery sheet:', err);
      setDownloadError(err.response?.data?.message || 'Failed to generate the delivery sheet.');
    } finally {
      setDownloadingKey(null);
    }
  };

  const REPORTS = [
    {
      key: 'lead-delivery-date',
      label: 'Lead Delivery Date',
      description: "Active customers' starting date, duration and last delivery date.",
      onDownload: downloadLeadDeliveryDate,
    },
    {
      key: 'delivery-sheet',
      label: 'Delivery Sheet',
      description: 'Excel file with one tab per date — skipped customers excluded, resumed customers included.',
      needsRange: true,
      onDownload: downloadDeliverySheet,
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl border border-matter-dust/40 shadow-xl w-full max-w-md">
        <div className="border-b border-gray-100 px-6 py-4 flex items-center justify-between rounded-t-2xl">
          <h3 className="font-serif-mgmt text-lg font-semibold text-matter-navy">Reports</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-2">
          {downloadError && <p className="text-sm text-matter-red mb-1">{downloadError}</p>}
          {REPORTS.map((report) => {
            const isLoading = downloadingKey === report.key;
            const isExpanded = expandedKey === report.key;
            return (
              <div key={report.key} className="rounded-xl border border-gray-100 overflow-hidden">
                <button
                  onClick={() => (
                    report.needsRange
                      ? setExpandedKey((k) => (k === report.key ? null : report.key))
                      : report.onDownload()
                  )}
                  disabled={downloadingKey !== null}
                  className="w-full flex items-center gap-3 text-left p-3.5 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-matter-sky/20 text-matter-navy flex-shrink-0">
                    {isLoading ? (
                      <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{report.label}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{isLoading ? 'Generating…' : report.description}</p>
                  </span>
                </button>
                {report.needsRange && isExpanded && (
                  <div className="px-3.5 pb-3.5 pt-1 border-t border-gray-100 bg-gray-50/50 space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1">From</label>
                        <input
                          type="date"
                          value={rangeFrom}
                          onChange={(e) => setRangeFrom(e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-matter-sky focus:border-matter-sky"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1">To</label>
                        <input
                          type="date"
                          value={rangeTo}
                          onChange={(e) => setRangeTo(e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-matter-sky focus:border-matter-sky"
                        />
                      </div>
                    </div>
                    <button
                      onClick={report.onDownload}
                      disabled={downloadingKey !== null}
                      className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 bg-matter-sky text-matter-navy rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {isLoading ? 'Generating…' : 'Download CSV'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const CustomerAnalytics = () => {
  const [subscriptions, setSubscriptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showReportModal, setShowReportModal] = useState(false);

  const [analytics, setAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState('');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/matter/subscriptions/all');
      setSubscriptions(res.data?.data || []);
    } catch (err) {
      console.error('Failed to load subscriptions:', err);
      setError(err.response?.data?.message || 'Failed to load subscriptions.');
      setSubscriptions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const generateFullAnalytics = async () => {
    setAnalyticsLoading(true);
    setAnalyticsError('');
    try {
      const res = await api.get('/matter/subscriptions/analytics');
      setAnalytics(res.data?.data || []);
    } catch (err) {
      console.error('Failed to generate full analytics:', err);
      setAnalyticsError(err.response?.data?.message || 'Failed to generate full analytics.');
    } finally {
      setAnalyticsLoading(false);
    }
  };

  const stats = useMemo(() => {
    const total = subscriptions.length;
    let active = 0;
    let renewal = 0;
    const statusCounts = { active: 0, paused: 0, cancelled: 0, expired: 0 };
    const planCounts = new Map();

    subscriptions.forEach((s) => {
      if (s.subscription_status === 'active') active += 1;
      if (s.renewal_eligible) renewal += 1;
      if (statusCounts[s.subscription_status] !== undefined) statusCounts[s.subscription_status] += 1;
      const plan = s.plan?.name || 'No plan';
      planCounts.set(plan, (planCounts.get(plan) || 0) + 1);
    });

    const planBreakdown = Array.from(planCounts.entries())
      .map(([plan, count]) => ({ plan, count, pct: total > 0 ? Math.round((count / total) * 100) : 0 }))
      .sort((a, b) => b.count - a.count);

    return { total, active, renewal, statusCounts, planBreakdown, mostPopular: planBreakdown[0] || null };
  }, [subscriptions]);

  const fullStats = useMemo(() => {
    if (!analytics) return null;
    const withLife = analytics.filter((a) => a.created_at);
    const now = Date.now();
    const lifeMonths = (createdAt) => (now - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24 * 30.44);

    const avgLife = withLife.length > 0
      ? withLife.reduce((s, a) => s + lifeMonths(a.created_at), 0) / withLife.length
      : null;

    const perPlanLife = new Map();
    withLife.forEach((a) => {
      const plan = a.plan_name || 'No plan';
      if (!perPlanLife.has(plan)) perPlanLife.set(plan, []);
      perPlanLife.get(plan).push(lifeMonths(a.created_at));
    });
    let longestPlan = null;
    let longestAvg = -1;
    perPlanLife.forEach((lives, plan) => {
      const avg = lives.reduce((s, v) => s + v, 0) / lives.length;
      if (avg > longestAvg) { longestAvg = avg; longestPlan = plan; }
    });

    const zoneCounts = new Map();
    analytics.forEach((a) => {
      if (!a.zone) return;
      zoneCounts.set(a.zone, (zoneCounts.get(a.zone) || 0) + 1);
    });
    const zoneTotal = Array.from(zoneCounts.values()).reduce((s, v) => s + v, 0);
    const zoneBreakdown = Array.from(zoneCounts.entries())
      .map(([zone, count]) => ({ zone, count, pct: zoneTotal > 0 ? Math.round((count / zoneTotal) * 100) : 0 }))
      .sort((a, b) => b.count - a.count);

    return { avgLife, longestPlan, zoneBreakdown, sampleSize: analytics.length };
  }, [analytics]);

  const STATUS_LABELS = { active: 'Active', paused: 'Paused', cancelled: 'Cancelled', expired: 'Expired' };
  const STATUS_COLORS = { active: 'bg-matter-green', paused: 'bg-matter-purple', cancelled: 'bg-matter-red', expired: 'bg-gray-300' };

  return (
    <div className="customer-mgmt min-h-screen p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3 pb-6 border-b border-black/10">
        <div>
          <h1 className="font-serif-mgmt text-3xl font-bold text-matter-navy">Customer Analytics & Reports</h1>
          <p className="text-gray-500 text-sm mt-1">Plan popularity, subscriber status and delivery zones, computed from your live Matter subscriptions.</p>
        </div>
        <button
          onClick={() => setShowReportModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-lg text-sm font-semibold hover:bg-gray-50 transition"
        >
          <FileText className="w-4 h-4" />
          Report
        </button>
      </div>

      {showReportModal && (
        <ReportModal subscriptions={subscriptions} onClose={() => setShowReportModal(false)} />
      )}

      {loading ? (
        <div className="text-center py-16 text-gray-400 animate-pulse">Loading…</div>
      ) : error ? (
        <div className="text-center py-16 text-matter-red">{error}</div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard icon={Users} label="Active Subscribers" value={stats.active} sub={`${stats.total} total subscriptions`} />
            <KpiCard icon={Clock} label="Due for Renewal" value={stats.renewal} sub="renewal_eligible = true" />
            <KpiCard icon={Package} label="Total Subscriptions" value={stats.total} sub="active + paused + cancelled + expired" />
            <KpiCard icon={Award} label="Most Popular Plan" value={stats.mostPopular?.plan || '—'} sub={stats.mostPopular ? `${stats.mostPopular.pct}% of all subscriptions` : null} />
          </div>

          {/* Plan Popularity */}
          <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-5">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Plan Popularity</p>
            <p className="font-serif-mgmt text-lg font-bold text-matter-navy mb-4">Share of all subscriptions</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {stats.planBreakdown.map((p) => (
                <div key={p.plan} className="border border-gray-100 rounded-xl p-4">
                  <p className="font-serif-mgmt font-bold text-matter-navy truncate" title={p.plan}>{p.plan}</p>
                  <p className="text-2xl font-bold text-matter-sky mt-1">{p.pct}%</p>
                  <p className="text-xs text-gray-400 mt-0.5">{p.count} subscriber{p.count !== 1 ? 's' : ''}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Status Breakdown */}
          <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-5">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Subscriber Status</p>
            <p className="font-serif-mgmt text-lg font-bold text-matter-navy mb-4">Where every subscription stands today</p>
            <div className="space-y-3">
              {Object.entries(stats.statusCounts).map(([status, count]) => {
                const pct = stats.total > 0 ? Math.round((count / stats.total) * 100) : 0;
                return (
                  <div key={status} className="flex items-center gap-3">
                    <span className="text-sm text-gray-700 w-24 flex-shrink-0">{STATUS_LABELS[status]}</span>
                    <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${STATUS_COLORS[status]}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs text-gray-500 w-20 text-right flex-shrink-0">{count} ({pct}%)</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Full Analytics (on-demand, expensive) */}
          <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-5">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
              <div>
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Full Analytics</p>
                <p className="font-serif-mgmt text-lg font-bold text-matter-navy">Subscription life & delivery zones</p>
              </div>
              <button
                onClick={generateFullAnalytics}
                disabled={analyticsLoading}
                className="inline-flex items-center gap-2 px-4 py-2 bg-matter-sky text-matter-navy rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition"
              >
                <span className="material-symbols-outlined text-[18px]">{analyticsLoading ? 'progress_activity' : 'insights'}</span>
                {analyticsLoading ? 'Generating…' : analytics ? 'Regenerate' : 'Generate Full Analytics'}
              </button>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              Fetches full detail for every active subscription to compute join dates and delivery zones — can take 15–30 seconds.
            </p>

            {analyticsError && <p className="text-sm text-matter-red mb-3">{analyticsError}</p>}

            {!analytics && !analyticsLoading && (
              <p className="text-sm text-gray-400">Not generated yet — click "Generate Full Analytics" above.</p>
            )}

            {fullStats && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="border border-gray-100 rounded-xl p-4">
                    <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Avg. Subscription Life</p>
                    <p className="font-serif-mgmt text-2xl font-bold text-matter-navy">
                      {fullStats.avgLife !== null ? `${fullStats.avgLife.toFixed(1)} months` : '—'}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">{fullStats.longestPlan ? `Longest: ${fullStats.longestPlan}` : ''}</p>
                  </div>
                  <div className="border border-gray-100 rounded-xl p-4">
                    <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Sample Size</p>
                    <p className="font-serif-mgmt text-2xl font-bold text-matter-navy">{fullStats.sampleSize}</p>
                    <p className="text-xs text-gray-400 mt-1">active subscriptions analyzed</p>
                  </div>
                </div>

                <div>
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3">
                    <MapPin className="w-3.5 h-3.5" />
                    Zone Breakdown
                  </p>
                  {fullStats.zoneBreakdown.length === 0 ? (
                    <p className="text-sm text-gray-400">No zone data on active addresses.</p>
                  ) : (
                    <div className="space-y-2">
                      {fullStats.zoneBreakdown.map((z) => (
                        <div key={z.zone} className="flex items-center gap-3">
                          <span className="text-sm text-gray-700 w-28 truncate flex-shrink-0">{z.zone}</span>
                          <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full bg-matter-sky rounded-full" style={{ width: `${z.pct}%` }} />
                          </div>
                          <span className="text-xs text-gray-500 w-20 text-right flex-shrink-0">{z.count} · {z.pct}%</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <p className="text-xs text-gray-400">
            Retention and month-over-month new-vs-churned trends aren't shown here — they'd need historical
            point-in-time snapshots this app doesn't store, and showing invented numbers would be worse than
            showing nothing.
          </p>
        </>
      )}
    </div>
  );
};

export default CustomerAnalytics;
