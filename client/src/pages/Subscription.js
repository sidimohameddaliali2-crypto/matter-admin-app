import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { DollarSign, Wallet, Users, RefreshCw as RenewIcon, Download } from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import * as XLSX from 'xlsx';
import api from '../utils/api';
import { salesDashboardDates, sumSalesDays, salesTrend, deliveryRevenueLabel, hasSalesComparisonCoverage } from '../lib/salesDashboard';
import { formatBusinessDateInput } from '../utils/businessTime';

// Day keys ("YYYY-MM-DD") are business-local (Dubai), matching how the server
// buckets deliveries, not the viewer's own device timezone.
const keyToUtc = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const utcToKey = (date) => date.toISOString().slice(0, 10);
const addDays = (key, n) => { const d = keyToUtc(key); d.setUTCDate(d.getUTCDate() + n); return utcToKey(d); };
const dayOfWeek = (key) => keyToUtc(key).getUTCDay();

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function TrendPill({ value }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const up = value >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold px-2 py-0.5 rounded-full ${up ? 'bg-matter-green/25 text-matter-navy' : 'bg-matter-red/10 text-matter-red'}`}>
      <span className="material-symbols-outlined text-[13px]">{up ? 'trending_up' : 'trending_down'}</span>
      {up ? '+' : ''}{value.toFixed(1)}%
    </span>
  );
}

function KpiCard({ icon: Icon, label, value, trend, sub }) {
  return (
    <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">{label}</p>
        <Icon className="w-4 h-4 text-gray-300" />
      </div>
      <p className="font-serif-mgmt text-2xl font-bold text-matter-navy leading-tight">{value}</p>
      <div className="flex items-center gap-2 mt-2">
        <TrendPill value={trend} />
        {sub && <p className="text-xs text-gray-400">{sub}</p>}
      </div>
    </div>
  );
}

const Subscription = () => {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reportMonth, setReportMonth] = useState(() => formatBusinessDateInput(new Date()).slice(0, 7));
  const [exporting, setExporting] = useState(false);
  const todayKey = formatBusinessDateInput(new Date());
  const dates = useMemo(() => salesDashboardDates(todayKey), [todayKey]);
  const fetchData = useCallback(async (force = false) => {
    setLoading(true);
    setError('');
    try {
      const cached = await api.get('/matter/sales-dashboard', { params: { from: dates.from, to: dates.today } });
      if (!cached.data?.success) throw new Error('The sales report could not be verified.');
      setReport(cached.data.data);
      const age = Date.now() - Date.parse(cached.data.data?.observedAt);
      if (force !== true && age >= 0 && age < 15 * 60000) return;
      try { await api.post('/matter/sales-dashboard/refresh'); }
      catch (err) { setError(err.response?.data?.message || 'Matter refresh failed. Previously captured data is shown.'); }
      const response = await api.get('/matter/sales-dashboard', { params: { from: dates.from, to: dates.today } });
      if (!response.data?.success) throw new Error('The sales report could not be verified.');
      setReport(response.data.data);
    } catch (err) { setError(err.response?.data?.message || err.message || 'The sales report could not be loaded.'); }
    finally { setLoading(false); }
  }, [dates]);
  useEffect(() => { fetchData(); }, [fetchData]);
  const days = report?.days || [];
  const today = sumSalesDays(days, todayKey, todayKey);
  const yesterdayKey = addDays(todayKey, -1);
  const yesterday = sumSalesDays(days, yesterdayKey, yesterdayKey);
  const month = sumSalesDays(days, dates.monthStart, todayKey);
  const previousMonth = sumSalesDays(days, dates.previousStart, dates.previousEnd);
  const week = sumSalesDays(days, dates.weekStart, todayKey);
  const priorWeek = sumSalesDays(days, dates.priorWeekStart, dates.priorWeekEnd);
  const salesTodayTrend = hasSalesComparisonCoverage(report, yesterdayKey) ? salesTrend(today, yesterday) : null;
  const mtdTrend = hasSalesComparisonCoverage(report, dates.previousStart) ? salesTrend(month, previousMonth) : null;
  const weekRevenueTrend = hasSalesComparisonCoverage(report, dates.priorWeekStart) ? salesTrend(week, priorWeek) : null;
  const last7Days = Array.from({ length: 7 }, (_, i) => {
    const key = addDays(todayKey, i - 6);
    const value = days.find((entry) => entry.day === key);
    return { label: DAY_LABELS[dayOfWeek(key)], revenue: value?.paymentsReceived || 0, orders: value?.orders || 0 };
  });
  const planPerformance = [...(report?.plans || [])].sort((a, b) => b.count - a.count);
  const planCount = planPerformance.reduce((sum, plan) => sum + plan.count, 0);
  const moneyLabel = (period) => !report?.observedAt ? 'Unavailable'
    : `${period.unknownPayments ? 'Known ' : ''}AED ${period.paymentsReceived.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const handleDownloadMonthReport = async () => {
    if (!/^\d{4}-\d{2}$/.test(reportMonth)) return;
    setExporting(true);
    try {
      const [year, monthNumber] = reportMonth.split('-').map(Number);
      const from = reportMonth + '-01';
      const monthEnd = utcToKey(new Date(Date.UTC(year, monthNumber, 0)));
      const to = monthEnd > todayKey ? todayKey : monthEnd;
      if (to < from) return;
      const response = await api.get('/matter/sales-dashboard', { params: { from, to } });
      if (!response.data?.success || !response.data.data?.observedAt) throw new Error('Verified Matter sales information is unavailable.');
      const data = response.data.data;
      const wb = XLSX.utils.book_new();
      const round = (amount) => amount == null ? '' : Math.round(amount * 100) / 100;
      for (const day of data.days) {
        const rows = data.details.filter((entry) => entry.date === day.day);
        const sheet = XLSX.utils.aoa_to_sheet([
          ['Customer ID', 'Matter Customer ID', 'Customer Name', 'Status', 'Captured Subscription', 'Captured Plan', 'Paid Amount (AED)', 'Paid Deliveries', 'Allocated Revenue (AED)', 'Pricing Status', 'Additional Delivery', 'Entitlement Delivery Number', 'Included in Paid Counts'],
          ...rows.map((entry) => [entry.customerId, entry.matterCustomerId, entry.name, entry.status, entry.subscriptionId, entry.plan, round(entry.amountPaid), entry.paidDeliveries, round(entry.revenue), entry.pricingStatus, entry.additional ? 'Yes' : 'No', entry.entitlementDeliveryNumber, entry.additional ? 'No' : 'Yes']),
          [], ['Known delivery revenue', '', '', '', '', '', '', '', round(day.knownDeliveryRevenue)],
          ['Completed deliveries with unavailable pricing', day.unpriced],
          ['Additional deliveries (excluded from paid counts and revenue)', day.additional || 0],
          ['Observed payments received (AED)', round(day.paymentsReceived)],
        ]);
        sheet['!cols'] = [18, 18, 28, 16, 22, 26, 20, 16, 24, 45, 22, 28, 26].map((wch) => ({ wch }));
        XLSX.utils.book_append_sheet(wb, sheet, day.day);
      }
      const summary = XLSX.utils.aoa_to_sheet([
        ['Matter sales report', reportMonth],
        ['Source observation', new Date(data.observedAt).toISOString()],
        ['Payment coverage', data.paymentCoverage],
        ['Historical delivery prices are not inferred from current subscriptions. Missing values are blank, not zero.'],
        [], ['Date', 'Included Scheduled Deliveries', 'Included Completed Deliveries', 'Known Delivery Revenue (AED)', 'Unpriced Completed Deliveries', 'Observed Payments Received (AED)', 'Payments Needing Review', 'Additional Deliveries (Excluded)'],
        ...data.days.map((day) => [day.day, day.orders, day.completed, round(day.knownDeliveryRevenue), day.unpriced, round(day.paymentsReceived), day.unknownPayments, day.additional || 0]),
        [], ['TOTAL', data.totals.orders, data.totals.completed, round(data.totals.knownDeliveryRevenue), data.totals.unpriced, round(data.totals.paymentsReceived), data.totals.unknownPayments, data.totals.additional || 0],
        ['Renewal rate', 'Unavailable: complete renewal event history is not provided by Matter.'],
      ]);
      summary['!cols'] = [35, 24, 24, 32, 30, 34, 28].map((wch) => ({ wch }));
      XLSX.utils.book_append_sheet(wb, summary, 'Summary');
      const additional = data.details.filter((entry) => entry.additional);
      if (additional.length) {
        const sheet = XLSX.utils.aoa_to_sheet([
          ['Date', 'Customer ID', 'Customer Name', 'Subscription', 'Delivery Number', 'Paid Entitlement', 'Revenue Included (AED)'],
          ...additional.map((entry) => [entry.date, entry.customerId, entry.name, entry.subscriptionId, entry.entitlementDeliveryNumber, entry.paidEntitlement, 0]),
        ]);
        sheet['!cols'] = [16, 20, 30, 22, 20, 20, 26].map((wch) => ({ wch }));
        XLSX.utils.book_append_sheet(wb, sheet, 'Additional deliveries');
      }
      XLSX.writeFile(wb, `Sales_Report_${reportMonth}.xlsx`);
    } catch (err) { setError(err.response?.data?.message || err.message || 'Could not build the report. Please retry.'); }
    finally { setExporting(false); }
  };

  return (
    <div className="customer-mgmt min-h-screen p-6 space-y-6">
      {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <p className="text-sm text-gray-600">{report?.observedAt ? `Matter data captured ${new Date(report.observedAt).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })} (Dubai).` : 'No verified Matter sales capture is available.'} Payments shown are those observed in Matter; unavailable account history may make earlier periods incomplete.</p>
      {!!month.unpriced && <p role="status" className="text-sm text-amber-800">{month.unpriced} completed deliveries this month have unavailable pricing. Their revenue is excluded from the known subtotal, not treated as free deliveries.</p>}
      {!!month.additional && <p role="status" className="text-sm text-blue-800">{month.additional} additional deliveries this month exceeded the paid entitlement. They are excluded from paid delivery counts and revenue and listed separately below.</p>}
      {!!(report?.unidentifiedPayments || month.unknownPayments) && <p role="status" className="text-sm text-amber-800">Some payment records need review. Only known AED payments are included; comparisons may be unavailable.</p>}
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3 pb-6 border-b border-black/10">
        <div>
          <h1 className="font-serif-mgmt text-3xl font-bold text-matter-navy">Subscription & Sales Dashboard</h1>
          <p className="text-gray-500 text-sm mt-1">Payments received, captured delivery revenue and current Matter subscriptions.</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="month"
            value={reportMonth}
            max={todayKey.slice(0, 7)}
            onChange={(e) => setReportMonth(e.target.value)}
            className="px-3 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-lg text-sm"
            title="Month for the Excel report"
          />
          <button
            onClick={handleDownloadMonthReport}
            disabled={loading || exporting || !reportMonth}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-lg text-sm font-semibold hover:bg-gray-50 disabled:opacity-50 transition"
          >
            <Download className="w-4 h-4" />
            {exporting ? 'Building…' : 'Download Excel'}
          </button>
          <button
            onClick={() => fetchData(true)}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-lg text-sm font-semibold hover:bg-gray-50 disabled:opacity-50 transition"
          >
            <RenewIcon className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        <KpiCard icon={DollarSign} label="Observed Payments Today" value={moneyLabel(today)} trend={salesTodayTrend} sub="By payment date in Matter" />
        <KpiCard icon={Wallet} label="Observed Payments MTD" value={moneyLabel(month)} trend={mtdTrend} sub={mtdTrend === null ? 'Comparison unavailable until both periods have capture coverage' : 'vs same period last month'} />
        <KpiCard icon={Users} label="Active Subscriptions" value={report?.observedAt ? report.activeSubscriptions : 'Unavailable'} trend={null} sub={`${report?.subscriptionStartsLast7Days || 0} subscription starts in last 7 days; includes renewals`} />
        <KpiCard icon={Wallet} label="Delivery Revenue MTD" value={report?.observedAt ? deliveryRevenueLabel(month) : 'Unavailable'} sub={`${month.completed} completed; ${month.unpriced} need pricing`} />
        <KpiCard icon={RenewIcon} label="Renewal Rate" value="Unavailable" trend={null} sub="Complete renewal history is required" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Observed Payments Received</p>
              <p className="font-serif-mgmt text-lg font-bold text-matter-navy">Last 7 days</p>
            </div>
            <TrendPill value={weekRevenueTrend} />
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={last7Days} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`} />
              <Tooltip formatter={(v) => [`AED ${Number(v).toFixed(0)}`, 'Payments received']} />
              <Area type="monotone" dataKey="revenue" stroke="#4d9eff" strokeWidth={2} fill="#4d9eff" fillOpacity={0.12} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-5">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Scheduled Deliveries Per Day (Additional Excluded)</p>
          <p className="font-serif-mgmt text-lg font-bold text-matter-navy mb-4">{week.orders} in the last 7 days</p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={last7Days} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip formatter={(v) => [v, 'Scheduled deliveries']} />
              <Bar dataKey="orders" fill="#bcf679" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Meal Plan Performance */}
      {!!report?.details?.some((entry) => entry.additional) && (
        <section className="bg-white rounded-2xl border border-matter-dust/40 p-5">
          <h2 className="text-lg font-semibold text-matter-navy">Additional deliveries — excluded from paid counts and revenue</h2>
          <p className="text-sm text-gray-500 mb-3">Showing up to 20 entries in the loaded period. The monthly Excel report contains all entries.</p>
          <ul className="divide-y divide-gray-100">
            {report.details.filter((entry) => entry.additional).slice(0, 20).map((entry) => (
              <li key={entry.id} className="py-2 text-sm"><a className="text-blue-700 underline" href={`/deliveries/${entry.id}`}>{entry.name || entry.customerId}</a> · {entry.date} · Delivery {entry.entitlementDeliveryNumber} of {entry.paidEntitlement} paid · AED 0 included</li>
            ))}
          </ul>
        </section>
      )}
      {planPerformance.length > 0 && (
        <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-5">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div>
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Active Subscriptions by Plan</p>
              <p className="font-serif-mgmt text-lg font-bold text-matter-navy">Current Matter plan distribution</p>
            </div>
            <p className="text-sm text-gray-500">{planCount} active subscriptions</p>
          </div>
          <div className="space-y-3">
            {planPerformance.map((p) => {
              const pct = planCount > 0 ? Math.round((p.count / planCount) * 100) : 0;
              return (
                <div key={p.plan} className="border border-gray-100 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                    <div>
                      <p className="font-serif-mgmt font-bold text-matter-navy">{p.plan}</p>
                      <p className="text-xs text-gray-400">{p.count} active subscriber{p.count !== 1 ? 's' : ''}</p>
                    </div>
                    <p className="font-serif-mgmt font-bold text-matter-navy">{p.count} subscriptions</p>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-matter-sky rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">{pct}% of active subscriptions</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
};

export default Subscription;
