import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { DollarSign, Wallet, Users, RefreshCw as RenewIcon, Download } from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import * as XLSX from 'xlsx';
import api from '../utils/api';
import { isCycleEnded } from '../utils/subscriptionFormat';
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
  const [customers, setCustomers] = useState([]);
  const [matterSubscriptions, setMatterSubscriptions] = useState([]);
  const [matterFinancials, setMatterFinancials] = useState([]);
  const [windowCounts, setWindowCounts] = useState([]); // [{ day, customerId, count }]
  const [prevMonthCounts, setPrevMonthCounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [reportMonth, setReportMonth] = useState(() => formatBusinessDateInput(new Date()).slice(0, 7));
  const [exporting, setExporting] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const today = formatBusinessDateInput(new Date());
      const monthStart = `${today.slice(0, 8)}01`;
      const windowStart = monthStart < addDays(today, -6) ? monthStart : addDays(today, -6);

      // Same span last month: the 1st up to the same day-of-month (clamped for
      // shorter months, so e.g. 31 Mar compares against all of February).
      const prevMonthStart = `${utcToKey(new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1))).slice(0, 8)}01`;
      const prevMonthLastDay = Number(addDays(monthStart, -1).slice(8, 10));
      const prevMonthSameDayEnd = `${prevMonthStart.slice(0, 8)}${String(Math.min(Number(today.slice(8, 10)), prevMonthLastDay)).padStart(2, '0')}`;

      // /subscriptions/financials fetches full detail per active subscription
      // (hundreds of calls) to get real amount-paid — noticeably slower than
      // the rest of this fetch, but the plan/amount/cycle data has to come
      // from Matter, not the internal Customer record.
      // Delivery counts come from an aggregate endpoint: the plain list caps a
      // page at 500 rows, well under a month of deliveries.
      const [custRes, windowRes, prevMonthRes, matterSubsRes, matterFinRes] = await Promise.all([
        api.get('/customers', { params: { limit: 10000 } }),
        api.get('/deliveries/daily-customer-counts', { params: { dateFrom: windowStart, dateTo: today } }),
        api.get('/deliveries/daily-customer-counts', { params: { dateFrom: prevMonthStart, dateTo: prevMonthSameDayEnd } }),
        api.get('/matter/subscriptions/all'),
        api.get('/matter/subscriptions/financials'),
      ]);

      const dbCustomers = custRes.data?.data || [];
      setCustomers(dbCustomers);
      setWindowCounts(windowRes.data?.data || []);
      setPrevMonthCounts(prevMonthRes.data?.data || []);
      setMatterSubscriptions(matterSubsRes.data?.data || []);
      setMatterFinancials(matterFinRes.data?.data || []);
    } catch (err) {
      console.error('Subscription fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Plan/amount-paid/cycle now come from the real Matter subscription data
  // (matched by Matter customer id, then email) instead of the internal Customer record's own
  // amountPaid/cycleDuration/mealPlan fields, which are often stale or blank.
  // Customers are linked to their Matter subscription by Matter customer id
  // first (stable for the life of the customer), then by email as a fallback
  // for records that don't carry the id yet. If a customer has several
  // subscriptions, an active one wins, then the latest cycle end.
  const matterLookup = useMemo(() => {
    const financialsBySubId = new Map(matterFinancials.map((f) => [String(f.subscription_id), f]));
    const byCustomerId = new Map();
    const byEmail = new Map();
    const better = (candidate, current) => {
      if (!current) return true;
      const ca = candidate.subscriptionStatus === 'active';
      const cu = current.subscriptionStatus === 'active';
      if (ca !== cu) return ca;
      return String(candidate.cycleEndDate || '') > String(current.cycleEndDate || '');
    };
    matterSubscriptions.forEach((s) => {
      const financial = financialsBySubId.get(String(s.subscription_id));
      const cycleDuration = s.starting_date && s.cycle_end_date
        ? Math.max(0, Math.round((new Date(s.cycle_end_date) - new Date(s.starting_date)) / 86400000) + 1)
        : 0;
      const entry = {
        plan: s.plan?.name || 'Standard',
        startingDate: s.starting_date || null,
        cycleEndDate: s.cycle_end_date || null,
        cycleDuration,
        subscriptionStatus: s.subscription_status,
        amountPaid: financial?.gross_paid ?? null
      };
      const custId = s.customer_id != null ? String(s.customer_id) : '';
      if (custId && better(entry, byCustomerId.get(custId))) byCustomerId.set(custId, entry);
      const email = String(s.email || '').trim().toLowerCase();
      if (email && better(entry, byEmail.get(email))) byEmail.set(email, entry);
    });
    return (customer) => {
      const custId = customer.matterCustomerId != null ? String(customer.matterCustomerId) : '';
      return (custId && byCustomerId.get(custId))
        || byEmail.get(String(customer.email || '').trim().toLowerCase())
        || null;
    };
  }, [matterSubscriptions, matterFinancials]);

  // Per-customer daily rate lookup
  const dailyRateMap = useMemo(() => {
    const map = {};
    customers.forEach((c) => {
      const sub = matterLookup(c);
      const amountPaid = sub?.amountPaid || 0;
      const cycleDuration = sub?.cycleDuration || 0;
      map[c.customerId] = cycleDuration > 0 ? amountPaid / cycleDuration : 0;
    });
    return map;
  }, [customers, matterLookup]);

  // dayKey -> revenue / orders (non-cancelled deliveries), from the server's
  // per-day per-customer counts
  const perDayStats = useMemo(() => {
    const stats = {};
    windowCounts.forEach(({ day, customerId, count }) => {
      if (!stats[day]) stats[day] = { revenue: 0, orders: 0 };
      stats[day].revenue += (dailyRateMap[customerId] || 0) * count;
      stats[day].orders += count;
    });
    return stats;
  }, [windowCounts, dailyRateMap]);

  const prevMonthRevenue = useMemo(
    () => prevMonthCounts.reduce((sum, { customerId, count }) => sum + (dailyRateMap[customerId] || 0) * count, 0),
    [prevMonthCounts, dailyRateMap]
  );

  const todayKey = formatBusinessDateInput(new Date());
  const yesterdayKey = addDays(todayKey, -1);
  const monthStartKey = `${todayKey.slice(0, 8)}01`;

  const salesToday = perDayStats[todayKey]?.revenue || 0;
  const ordersToday = perDayStats[todayKey]?.orders || 0;
  const salesYesterday = perDayStats[yesterdayKey]?.revenue || 0;
  const salesTodayTrend = salesYesterday > 0 ? ((salesToday - salesYesterday) / salesYesterday) * 100 : null;

  const mtdRevenue = Object.entries(perDayStats)
    .filter(([day]) => day >= monthStartKey && day <= todayKey)
    .reduce((sum, [, v]) => sum + v.revenue, 0);
  const mtdTrend = prevMonthRevenue > 0 ? ((mtdRevenue - prevMonthRevenue) / prevMonthRevenue) * 100 : null;

  const last7Days = useMemo(() => {
    const days = [];
    for (let i = 6; i >= 0; i -= 1) {
      const key = addDays(todayKey, -i);
      days.push({
        label: DAY_LABELS[dayOfWeek(key)],
        revenue: Math.round((perDayStats[key]?.revenue || 0) * 100) / 100,
        orders: perDayStats[key]?.orders || 0,
      });
    }
    return days;
  }, [perDayStats, todayKey]);

  const ordersThisWeek = last7Days.reduce((s, d) => s + d.orders, 0);
  const weekRevenueFirstHalf = last7Days.slice(0, 4).reduce((s, d) => s + d.revenue, 0);
  const weekRevenueSecondHalf = last7Days.slice(4).reduce((s, d) => s + d.revenue, 0);
  const weekRevenueTrend = weekRevenueFirstHalf > 0 ? ((weekRevenueSecondHalf - weekRevenueFirstHalf) / weekRevenueFirstHalf) * 100 : null;

  // Build enriched customer rows (for filters/table + plan breakdown).
  // Only customers with a matching real Matter subscription are
  // included — without one there's no real plan/amount/cycle data to show.
  const sevenDaysAgoKey = addDays(todayKey, -6);
  const rows = customers.map(c => {
    const sub = matterLookup(c);
    if (!sub) return null;
    const amountPaid = sub.amountPaid || 0;
    const plan = sub.plan;
    const fullName = `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.customerId;
    const isNewThisWeek = sub.startingDate ? sub.startingDate >= sevenDaysAgoKey : false;
    const isActiveSubscription = sub.subscriptionStatus === 'active' && !isCycleEnded(sub.cycleEndDate);
    return { ...c, fullName, amountPaid, plan, isNewThisWeek, isActiveSubscription };
  }).filter(Boolean);

  const activeCustomers = rows.filter(r => r.isActiveSubscription);
  const newThisWeekCount = rows.filter(r => r.isNewThisWeek).length;

  // Renewal Rate = active-and-mid-cycle / (active-and-mid-cycle + cycle-ended).
  // Matches the "Active" vs "Cycle ended" split used on the Customer
  // Management page (same subscription_status + cycle_end_date fields).
  const renewalActiveCount = matterSubscriptions.filter((s) => s.subscription_status === 'active' && !isCycleEnded(s.cycle_end_date)).length;
  const renewalCycleEndedCount = matterSubscriptions.filter((s) => isCycleEnded(s.cycle_end_date)).length;
  const renewalRate = (renewalActiveCount + renewalCycleEndedCount) > 0
    ? (renewalActiveCount / (renewalActiveCount + renewalCycleEndedCount)) * 100
    : null;

  const planBreakdown = {};
  activeCustomers.forEach(r => {
    if (!planBreakdown[r.plan]) planBreakdown[r.plan] = { count: 0, revenue: 0 };
    planBreakdown[r.plan].count++;
    planBreakdown[r.plan].revenue += r.amountPaid;
  });
  const planPerformance = Object.entries(planBreakdown)
    .map(([plan, data]) => ({ plan, ...data }))
    .sort((a, b) => b.revenue - a.revenue);
  const planRevenueTotal = planPerformance.reduce((s, p) => s + p.revenue, 0);

  // Month report: one worksheet per day (who was delivered to and what that
  // earned), then a Summary sheet last. Same method as the dashboard: each
  // delivery earns the customer's daily rate (amount paid / cycle days).
  const handleDownloadMonthReport = async () => {
    if (!/^\d{4}-\d{2}$/.test(reportMonth)) return;
    setExporting(true);
    try {
      const [y, m] = reportMonth.split('-').map(Number);
      const firstKey = `${reportMonth}-01`;
      const lastOfMonth = utcToKey(new Date(Date.UTC(y, m, 0)));
      const lastKey = lastOfMonth > todayKey ? todayKey : lastOfMonth;
      if (lastKey < firstKey) return;

      const res = await api.get('/deliveries/daily-customer-counts', { params: { dateFrom: firstKey, dateTo: lastKey } });
      const counts = res.data?.data || [];
      const customerById = new Map(customers.map((c) => [c.customerId, c]));
      const round2 = (n) => Math.round(n * 100) / 100;

      const infoFor = (customerId) => {
        const c = customerById.get(customerId);
        const sub = c ? matterLookup(c) : null;
        const cycleDays = sub?.cycleDuration || 0;
        const amountPaid = sub?.amountPaid || 0;
        return {
          name: c ? (`${c.firstName || ''} ${c.lastName || ''}`.trim() || customerId) : '(not in customer list)',
          plan: sub ? sub.plan : 'No active Matter subscription',
          amountPaid,
          cycleDays,
          rate: cycleDays > 0 ? amountPaid / cycleDays : 0,
        };
      };

      const wb = XLSX.utils.book_new();
      const daySummary = [];
      const planTotals = {};
      let unmatchedDeliveries = 0;

      for (let key = firstKey; key <= lastKey; key = addDays(key, 1)) {
        const dayRows = counts
          .filter((r) => r.day === key)
          .map((r) => {
            const info = infoFor(r.customerId);
            const revenue = info.rate * r.count;
            if (info.rate === 0) unmatchedDeliveries += r.count;
            if (!planTotals[info.plan]) planTotals[info.plan] = { customers: new Set(), orders: 0, revenue: 0 };
            planTotals[info.plan].customers.add(r.customerId);
            planTotals[info.plan].orders += r.count;
            planTotals[info.plan].revenue += revenue;
            return { id: r.customerId, ...info, count: r.count, revenue };
          })
          .sort((a, b) => a.name.localeCompare(b.name));

        const orders = dayRows.reduce((sum, r) => sum + r.count, 0);
        const revenue = dayRows.reduce((sum, r) => sum + r.revenue, 0);
        daySummary.push({ key, orders, revenue });

        const aoa = [
          ['Customer ID', 'Customer Name', 'Plan', 'Amount Paid (AED)', 'Cycle Days', 'Daily Rate (AED)', 'Deliveries', 'Revenue (AED)'],
          ...dayRows.map((r) => [r.id, r.name, r.plan, round2(r.amountPaid), r.cycleDays, round2(r.rate), r.count, round2(r.revenue)]),
          [],
          ['TOTAL', '', '', '', '', '', orders, round2(revenue)],
        ];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [14, 28, 30, 18, 11, 16, 11, 14].map((wch) => ({ wch }));
        XLSX.utils.book_append_sheet(wb, ws, key);
      }

      const totalOrders = daySummary.reduce((sum, d) => sum + d.orders, 0);
      const totalRevenue = daySummary.reduce((sum, d) => sum + d.revenue, 0);
      const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const summary = [
        [`Sales summary: ${monthLabel}`],
        [lastKey < lastOfMonth ? `Month to date, through ${lastKey}` : 'Full month'],
        [],
        ['Date', 'Day', 'Deliveries', 'Revenue (AED)'],
        ...daySummary.map((d) => [d.key, DAY_LABELS[dayOfWeek(d.key)], d.orders, round2(d.revenue)]),
        [],
        ['TOTAL', '', totalOrders, round2(totalRevenue)],
        ['Average per day', '', round2(totalOrders / daySummary.length), round2(totalRevenue / daySummary.length)],
        [],
        ['By plan'],
        ['Plan', 'Customers', 'Deliveries', 'Revenue (AED)'],
        ...Object.entries(planTotals)
          .sort((a, b) => b[1].revenue - a[1].revenue)
          .map(([plan, v]) => [plan, v.customers.size, v.orders, round2(v.revenue)]),
        [],
        [`Deliveries with no revenue (no matching active Matter subscription): ${unmatchedDeliveries}`],
        ['Revenue is an estimate: each non-cancelled delivery earns the customer daily rate (amount paid / cycle days, from Matter), not cash received on the day.'],
      ];
      const sws = XLSX.utils.aoa_to_sheet(summary);
      sws['!cols'] = [34, 12, 12, 16].map((wch) => ({ wch }));
      XLSX.utils.book_append_sheet(wb, sws, 'Summary');

      XLSX.writeFile(wb, `Sales_Report_${reportMonth}.xlsx`);
    } catch (err) {
      console.error('Month report error:', err);
      alert('Could not build the report. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="customer-mgmt min-h-screen p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3 pb-6 border-b border-black/10">
        <div>
          <h1 className="font-serif-mgmt text-3xl font-bold text-matter-navy">Subscription & Sales Dashboard</h1>
          <p className="text-gray-500 text-sm mt-1">How the plans are selling and what they are earning.</p>
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
            onClick={fetchData}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-lg text-sm font-semibold hover:bg-gray-50 disabled:opacity-50 transition"
          >
            <RenewIcon className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard icon={DollarSign} label="Sales Today" value={`AED ${salesToday.toFixed(0)}`} trend={salesTodayTrend} sub={`${ordersToday} order${ordersToday !== 1 ? 's' : ''}`} />
        <KpiCard icon={Wallet} label="Total Earnings (MTD)" value={`AED ${mtdRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} trend={mtdTrend} sub="vs same period last month" />
        <KpiCard icon={Users} label="Active Subscriptions" value={activeCustomers.length} trend={null} sub={`+${newThisWeekCount} this week`} />
        <KpiCard icon={RenewIcon} label="Renewal Rate" value={renewalRate !== null ? `${renewalRate.toFixed(0)}%` : '—'} trend={null} sub={`${renewalActiveCount} of ${renewalActiveCount + renewalCycleEndedCount}`} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Daily Sales</p>
              <p className="font-serif-mgmt text-lg font-bold text-matter-navy">Last 7 days</p>
            </div>
            <TrendPill value={weekRevenueTrend} />
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={last7Days} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`} />
              <Tooltip formatter={(v) => [`AED ${Number(v).toFixed(0)}`, 'Revenue']} />
              <Area type="monotone" dataKey="revenue" stroke="#4d9eff" strokeWidth={2} fill="#4d9eff" fillOpacity={0.12} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-5">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Orders Per Day</p>
          <p className="font-serif-mgmt text-lg font-bold text-matter-navy mb-4">{ordersThisWeek} this week</p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={last7Days} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip formatter={(v) => [v, 'Orders']} />
              <Bar dataKey="orders" fill="#bcf679" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Meal Plan Performance */}
      {planPerformance.length > 0 && (
        <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-5">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div>
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Meal Plan Performance</p>
              <p className="font-serif-mgmt text-lg font-bold text-matter-navy">Which plans drive the revenue</p>
            </div>
            <p className="text-sm text-gray-500">Total AED {planRevenueTotal.toLocaleString()} combined plan value</p>
          </div>
          <div className="space-y-3">
            {planPerformance.map((p) => {
              const pct = planRevenueTotal > 0 ? Math.round((p.revenue / planRevenueTotal) * 100) : 0;
              return (
                <div key={p.plan} className="border border-gray-100 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                    <div>
                      <p className="font-serif-mgmt font-bold text-matter-navy">{p.plan}</p>
                      <p className="text-xs text-gray-400">{p.count} active subscriber{p.count !== 1 ? 's' : ''}</p>
                    </div>
                    <p className="font-serif-mgmt font-bold text-matter-navy">AED {p.revenue.toLocaleString()}</p>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-matter-sky rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">{pct}% of total plan value</p>
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
