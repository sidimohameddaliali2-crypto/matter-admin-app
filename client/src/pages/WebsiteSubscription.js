import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Search, Package, PauseCircle, Receipt, CheckCircle2, X, RefreshCw } from 'lucide-react';
import api from '../utils/api';
import { recordActivityChange } from '../utils/activityCapture';
import DeliveryCalendar from '../components/DeliveryCalendar';
import { matchLabels } from '../components/subscriptionUi';
import { formatDate, formatMoney, isCycleEnded, daysUntil } from '../utils/subscriptionFormat';
import CustomerMatterDetails, { CustomerTypeTag, CustomerTagBadges } from '../components/CustomerMatterDetails';
import { websiteMetadataCustomer, hasUpcomingPlan, typeLabel, matchesCustomerType } from '../utils/customerMatterMetadata';

// "Due for renewal" = fewer than 6 days left until renewal_due_date, and the
// cycle hasn't already ended (a cycle-ended customer belongs in that tab
// instead, not "due for renewal").
const isDueForRenewal = (s) => {
  if (isCycleEnded(s.cycle_end_date)) return false;
  const d = daysUntil(s.renewal_due_date);
  return d !== null && d < 6;
};

const PAGE_STEP = 60;

// Real subscription_status values are active/paused/cancelled/expired.
// renewal_eligible is a separate real flag layered on top of that.
const STATUS_PILL = {
  active: 'bg-matter-green/25 text-matter-navy',
  paused: 'bg-matter-dust/60 text-matter-charcoal',
  cancelled: 'bg-matter-red/10 text-matter-red',
  expired: 'bg-matter-red/10 text-matter-red',
};

function StatusPill({ status }) {
  return (
    <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full capitalize whitespace-nowrap ${STATUS_PILL[status] || 'bg-gray-100 text-gray-600'}`}>
      {status || 'unknown'}
    </span>
  );
}

/* ---------------------------------------------------------------------- */
/* Left panel: searchable / filterable customer list                      */
/* ---------------------------------------------------------------------- */

function CustomerListPanel({ selectedId, onSelect, onRefresh }) {
  const [allSubscriptions, setAllSubscriptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusTab, setStatusTab] = useState('all');
  const [typeFilter, setTypeFilter] = useState('');
  const selectionRef = useRef({ selectedId, onSelect });
  selectionRef.current = { selectedId, onSelect };
  const [visibleCount, setVisibleCount] = useState(PAGE_STEP);
  const [noMatchIds, setNoMatchIds] = useState(new Set());
  const [noMatchOnly, setNoMatchOnly] = useState(false);
  const [noMatchError, setNoMatchError] = useState('');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/matter/subscriptions/all');
      const list = res.data?.data || [];
      setAllSubscriptions(list);
      if (!selectionRef.current.selectedId && list.length > 0) selectionRef.current.onSelect(list[0].subscription_id, { replace: true });
    } catch (err) {
      console.error('Failed to load subscriptions:', err);
      setError(err.response?.data?.message || 'Failed to load subscriptions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Which of these subscriptions have no internal customer match, computed
  // in bulk in one call (the same email -> name cascade as GET
  // /customers/match, minus phone — the list endpoint doesn't return phone
  // numbers, only the full per-subscription detail does).
  useEffect(() => {
    if (allSubscriptions.length === 0) {
      setNoMatchIds(new Set());
      setNoMatchError('');
      return undefined;
    }
    let mounted = true;
    setNoMatchError('');
    api.post('/customers/match/bulk', {
      subscriptions: allSubscriptions.map((s) => ({
        subscriptionId: s.subscription_id,
        email: s.email,
        name: s.name,
      })),
    })
      .then((res) => {
        if (mounted) setNoMatchIds(new Set((res.data?.data?.unmatchedIds || []).map(String)));
      })
      .catch((err) => {
        console.error('Bulk customer match failed:', err);
        if (mounted) {
          setNoMatchIds(new Set());
          setNoMatchError('Could not check internal matches.');
        }
      });
    return () => { mounted = false; };
  }, [allSubscriptions]);

  const statusCounts = useMemo(() => {
    const counts = { all: allSubscriptions.length, active: 0, renewal: 0, cycleEnded: 0, cancelled: 0, upcoming: 0 };
    allSubscriptions.forEach((s) => {
      const cycleEnded = isCycleEnded(s.cycle_end_date);
      if (s.subscription_status === 'cancelled') counts.cancelled += 1;
      if (cycleEnded) counts.cycleEnded += 1;
      else if (s.subscription_status === 'active') counts.active += 1;
      if (isDueForRenewal(s)) counts.renewal += 1;
      if (hasUpcomingPlan(websiteMetadataCustomer(s))) counts.upcoming += 1;
    });
    return counts;
  }, [allSubscriptions]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return allSubscriptions.filter((s) => {
      const cycleEnded = isCycleEnded(s.cycle_end_date);
      if (statusTab === 'active' && (s.subscription_status !== 'active' || cycleEnded)) return false;
      if (statusTab === 'renewal' && !isDueForRenewal(s)) return false;
      if (statusTab === 'cycleEnded' && !cycleEnded) return false;
      if (statusTab === 'cancelled' && s.subscription_status !== 'cancelled') return false;
      if (statusTab === 'upcoming' && !hasUpcomingPlan(websiteMetadataCustomer(s))) return false;
      if (!matchesCustomerType(websiteMetadataCustomer(s), typeFilter)) return false;
      if (noMatchOnly && !noMatchIds.has(String(s.subscription_id))) return false;
      if (term) {
        const haystack = `${s.name || ''} ${s.email || ''} ${s.subscription_id || ''} ${s.customer_id || ''} ${s.customer_type || ''} ${(s.customer_tags || []).map(tag => tag.name).join(' ')}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [allSubscriptions, statusTab, search, noMatchOnly, noMatchIds, typeFilter]);

  useEffect(() => { setVisibleCount(PAGE_STEP); }, [statusTab, search, noMatchOnly, typeFilter]);

  const visible = filtered.slice(0, visibleCount);

  const tabs = [
    { key: 'all', label: 'All', count: statusCounts.all },
    { key: 'active', label: 'Active', count: statusCounts.active },
    { key: 'upcoming', label: 'Upcoming plan', count: statusCounts.upcoming },
    { key: 'renewal', label: 'Due for renewal', count: statusCounts.renewal },
    { key: 'cycleEnded', label: 'Cycle ended', count: statusCounts.cycleEnded },
    { key: 'cancelled', label: 'Cancelled', count: statusCounts.cancelled },
  ];

  return (
    <div role="region" aria-label="Customer list" className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-4 flex flex-col lg:sticky lg:top-6 lg:max-h-[calc(100vh-140px)]">
      <div className="relative mb-3 flex-shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          placeholder="Search name, email, ID, type or tag"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-matter-sky focus:border-matter-sky"
        />
      </div>

      <div className="mb-3 flex items-end gap-2 flex-shrink-0">
        <label className="flex-1 min-w-0 text-xs font-semibold text-gray-600">Customer type
          <select aria-label="Customer type" value={typeFilter} onChange={event => setTypeFilter(event.target.value)}
            className="mt-1 w-full border border-gray-200 rounded-xl px-3 py-2.5 bg-white text-sm font-normal focus:outline-none focus:ring-2 focus:ring-matter-sky">
            <option value="">All customer types</option>
            {[...new Set(['new', 'returning', ...allSubscriptions.map(s => s.customer_type).filter(Boolean)])].sort().map(type => <option key={type} value={type}>{typeLabel(type)}</option>)}
            <option value="__unknown">Not provided</option>
          </select>
        </label>
        <button type="button" aria-label="Refresh Matter customers" title="Refresh Matter customers" disabled={loading} onClick={async () => { await fetchAll(); onRefresh?.(); }}
          className="p-2.5 rounded-xl border border-gray-200 text-gray-600 disabled:opacity-50 hover:bg-gray-50">
          <RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4 flex-shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setStatusTab(tab.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              statusTab === tab.key ? 'bg-matter-sky text-matter-navy' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {tab.label}
            {tab.key === 'upcoming' && ` (${tab.count})`}
          </button>
        ))}
        <button
          onClick={() => setNoMatchOnly((v) => !v)}
          title="Show only subscriptions with no internal customer match"
          className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
            noMatchOnly ? 'bg-matter-red/15 text-matter-red' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          <span className="material-symbols-outlined text-[14px]">person_off</span>
          No internal match{noMatchIds.size > 0 ? ` (${noMatchIds.size})` : ''}
        </button>
        {noMatchError && (
          <span className="text-xs text-matter-red self-center">{noMatchError}</span>
        )}
      </div>

      {error && allSubscriptions.length > 0 && <p role="alert" className="text-xs text-matter-red mb-2">{error} Showing the previously loaded list.</p>}
      <div className="flex-1 overflow-y-auto no-scrollbar space-y-2 min-h-[200px]">
        {loading ? (
          <div className="text-center py-12 text-gray-400 animate-pulse text-sm">Loading…</div>
        ) : error && allSubscriptions.length === 0 ? (
          <div className="text-center py-12 text-matter-red text-sm px-2">{error}</div>
        ) : visible.length === 0 ? (
          <div className="text-center py-12">
            <Package className="w-10 h-10 mx-auto mb-2 text-gray-300" />
            <p className="text-gray-400 text-sm">No subscriptions found</p>
          </div>
        ) : (
          <>
            {visible.map((s) => {
              const isSelected = String(s.subscription_id) === String(selectedId);
              return (
                <button
                  key={s.subscription_id}
                  onClick={() => onSelect(s.subscription_id)}
                  className={`w-full text-left rounded-xl p-3 border transition-colors ${
                    isSelected ? 'bg-matter-green border-matter-green' : 'bg-white border-gray-100 hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <p className="font-semibold text-gray-900 truncate">{s.name}</p>
                    <StatusPill status={s.subscription_status} />
                  </div>
                  <p className="text-xs text-gray-500 truncate">
                    CUS-{s.customer_id} · {s.plan?.name || 'No plan'}
                  </p>
                  <CustomerMatterDetails customer={websiteMetadataCustomer(s)} compact />
                </button>
              );
            })}
            {visibleCount < filtered.length && (
              <button
                onClick={() => setVisibleCount((c) => c + PAGE_STEP)}
                className="w-full text-center py-2 text-xs font-medium text-gray-500 hover:text-gray-800"
              >
                Load more ({filtered.length - visibleCount} remaining)
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Right panel: selected customer's profile                               */
/* ---------------------------------------------------------------------- */

function MiniField({ label, value }) {
  return (
    <div>
      <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-0.5">{label}</p>
      <p className="text-sm text-gray-900 font-medium break-words">{value ?? '—'}</p>
    </div>
  );
}

function ActionIcon({ href, icon, title }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target={href.startsWith('http') ? '_blank' : undefined}
      rel={href.startsWith('http') ? 'noreferrer' : undefined}
      title={title}
      className="flex items-center justify-center w-10 h-10 rounded-lg bg-gray-50 border border-gray-200 text-gray-700 hover:bg-gray-100 transition-colors"
    >
      <span className="material-symbols-outlined text-[18px]">{icon}</span>
    </a>
  );
}

const MACRO_BLOCKS = [
  { key: 'carbohydrates', label: 'Carbs', box: 'bg-matter-dust/60', track: 'bg-matter-dust', fill: 'bg-matter-charcoal', text: 'text-matter-charcoal' },
  { key: 'protein', label: 'Protein', box: 'bg-matter-purple/20', track: 'bg-matter-purple/30', fill: 'bg-matter-purple', text: 'text-matter-navy' },
  { key: 'fat', label: 'Fat', box: 'bg-matter-green/25', track: 'bg-matter-green/40', fill: 'bg-matter-charcoal', text: 'text-matter-navy' },
];

function MacroBlock({ label, grams, max, box, track, fill, text }) {
  const pct = max > 0 ? Math.min(100, Math.round(((grams || 0) / max) * 100)) : 0;
  return (
    <div className={`rounded-xl p-3 ${box}`}>
      <div className={`flex items-center justify-between text-xs font-semibold uppercase tracking-wide mb-2 ${text}`}>
        <span>{label}</span>
        <span className="text-base font-bold">{grams !== undefined ? `${grams}g` : '—'}</span>
      </div>
      <div className={`h-1.5 rounded-full overflow-hidden ${track}`}>
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const addDaysToDateStr = (dateStr, days) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const buildMonthDays = (year, monthIndex) => {
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const days = [];
  for (let d = 1; d <= daysInMonth; d += 1) {
    days.push(`${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return { firstWeekday, days };
};

const PAUSE_CALENDAR_WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function PauseModal({ subscriptionId, cycleEndDate, onClose, onSuccess }) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const minPauseDate = addDaysToDateStr(todayStr, 2);
  const minReturnDate = addDaysToDateStr(todayStr, 1);

  const [mode, setMode] = useState('pause');
  const [pauseDates, setPauseDates] = useState([]);
  const [returnDates, setReturnDates] = useState([]);
  const latestDates = useRef({ pauseDates, returnDates });
  latestDates.current = { pauseDates, returnDates };
  const changeDates = (field, next) => {
    recordActivityChange({ field: field === 'pauseDates' ? 'Pause days' : 'Return days', form: `Subscription pause · ${subscriptionId}`, before: latestDates.current[field], after: next });
    latestDates.current = { ...latestDates.current, [field]: next };
    (field === 'pauseDates' ? setPauseDates : setReturnDates)(next);
  };
  const changeMode = next => {
    recordActivityChange({ field: 'Calendar selection mode', form: `Subscription pause · ${subscriptionId}`, before: mode, after: next });
    setMode(next);
  };
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const today = new Date();
  const monthsToShow = [0, 1, 2].map((offset) => {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    return { year: d.getFullYear(), monthIndex: d.getMonth(), label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) };
  });

  const isDisabled = (iso) => (mode === 'pause' ? iso < minPauseDate : iso < minReturnDate);

  const toggleDate = (iso) => {
    if (isDisabled(iso)) return;
    if (mode === 'pause') {
      changeDates('returnDates', latestDates.current.returnDates.filter(d => d !== iso));
      const dates = latestDates.current.pauseDates;
      changeDates('pauseDates', dates.includes(iso) ? dates.filter(d => d !== iso) : [...dates, iso].sort());
    } else {
      changeDates('pauseDates', latestDates.current.pauseDates.filter(d => d !== iso));
      const dates = latestDates.current.returnDates;
      changeDates('returnDates', dates.includes(iso) ? dates.filter(d => d !== iso) : [...dates, iso].sort());
    }
  };

  const removePauseDate = (iso) => changeDates('pauseDates', latestDates.current.pauseDates.filter(d => d !== iso));
  const removeReturnDate = (iso) => changeDates('returnDates', latestDates.current.returnDates.filter(d => d !== iso));

  const dayClassName = (iso) => {
    if (pauseDates.includes(iso)) return 'bg-matter-purple text-white hover:opacity-90';
    if (returnDates.includes(iso)) return 'bg-matter-green text-matter-navy hover:opacity-90';
    if (isDisabled(iso)) return 'text-gray-300 cursor-not-allowed';
    return 'text-gray-700 hover:bg-matter-sky/15 cursor-pointer';
  };

  const handleSubmit = async () => {
    setError('');
    if (pauseDates.length === 0) {
      setError('Select at least one day to pause.');
      return;
    }
    if (returnDates.length > pauseDates.length) {
      setError(`You've selected ${returnDates.length} return days but only ${pauseDates.length} pause day(s) — remove ${returnDates.length - pauseDates.length} return day(s).`);
      return;
    }

    const finalReturnDates = [...returnDates];
    const usedReturnDates = new Set(returnDates);
    let cursor = cycleEndDate ? addDaysToDateStr(cycleEndDate, 1) : null;
    while (finalReturnDates.length < pauseDates.length) {
      if (!cursor) {
        setError('No cycle end date on file to auto-assign the remaining return day(s) — please pick them manually on the calendar.');
        return;
      }
      while (usedReturnDates.has(cursor)) cursor = addDaysToDateStr(cursor, 1);
      usedReturnDates.add(cursor);
      finalReturnDates.push(cursor);
      cursor = addDaysToDateStr(cursor, 1);
    }
    finalReturnDates.sort();

    setSubmitting(true);
    try {
      await api.post(`/matter/subscriptions/${subscriptionId}/pauses`, {
        paused_days: pauseDates,
        chosen_days: finalReturnDates,
        reason: reason.trim() || undefined
      });
      onSuccess();
    } catch (err) {
      console.error('Failed to create pause:', err);
      setError(err.response?.data?.message || 'Failed to create pause.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl border border-matter-dust/40 shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between rounded-t-2xl">
          <h3 className="font-serif-mgmt text-lg font-semibold text-matter-navy">Pause Delivery</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-xs text-matter-charcoal bg-matter-dust/30 border border-matter-dust rounded-lg px-3 py-2">
            This reschedules real deliveries on the customer's live subscription. Any pause day left without a
            matching return day is auto-assigned one right after their cycle ends{cycleEndDate ? ` (${formatDate(cycleEndDate)})` : ''}.
          </p>

          <div className="inline-flex rounded-lg border border-gray-200 p-1 bg-gray-50">
            <button
              type="button"
              onClick={() => changeMode('pause')}
              className={`px-3 py-1.5 rounded-md text-sm font-semibold transition ${mode === 'pause' ? 'bg-matter-purple text-white' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              Select pause days
            </button>
            <button
              type="button"
              onClick={() => changeMode('return')}
              className={`px-3 py-1.5 rounded-md text-sm font-semibold transition ${mode === 'return' ? 'bg-matter-green text-matter-navy' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              Select return days
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {monthsToShow.map(({ year, monthIndex, label }) => {
              const { firstWeekday, days } = buildMonthDays(year, monthIndex);
              const cells = [...Array(firstWeekday).fill(null), ...days];
              return (
                <div key={label} className="border border-gray-100 rounded-lg p-2">
                  <p className="text-xs font-semibold text-gray-600 mb-1 text-center">{label}</p>
                  <div className="grid grid-cols-7 gap-0.5">
                    {PAUSE_CALENDAR_WEEKDAYS.map((w, i) => (
                      <div key={`${label}-wd-${i}`} className="text-[9px] text-gray-300 text-center">{w}</div>
                    ))}
                    {cells.map((iso, idx) => {
                      if (!iso) return <div key={`${label}-blank-${idx}`} />;
                      const day = Number(iso.slice(8, 10));
                      return (
                        <button
                          type="button"
                          key={iso}
                          onClick={() => toggleDate(iso)}
                          disabled={isDisabled(iso)}
                          title={iso}
                          className={`w-full aspect-square rounded text-[10px] flex items-center justify-center font-medium transition ${dayClassName(iso)}`}
                        >
                          {day}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-matter-purple inline-block" /> Pause</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-matter-green inline-block" /> Return</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Pause days ({pauseDates.length})</p>
              {pauseDates.length === 0 ? (
                <p className="text-sm text-gray-400">None selected</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {pauseDates.map((iso) => (
                    <span key={iso} className="inline-flex items-center gap-1 text-xs bg-matter-purple/10 text-matter-purple rounded-full px-2 py-1">
                      {formatDate(iso)}
                      <button type="button" aria-label={`Remove pause day ${iso}`} onClick={() => removePauseDate(iso)}><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Return days ({returnDates.length})</p>
              {returnDates.length === 0 ? (
                <p className="text-sm text-gray-400">
                  {pauseDates.length > 0 ? 'Will auto-assign after cycle end' : 'None selected'}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {returnDates.map((iso) => (
                    <span key={iso} className="inline-flex items-center gap-1 text-xs bg-matter-green/20 text-matter-navy rounded-full px-2 py-1">
                      {formatDate(iso)}
                      <button type="button" aria-label={`Remove return day ${iso}`} onClick={() => removeReturnDate(iso)}><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Reason (optional)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Customer travel"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-matter-sky"
            />
          </div>

          {error && <p className="text-sm text-matter-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="inline-flex items-center gap-2 px-4 py-2 bg-matter-sky text-matter-navy rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50"
            >
              <PauseCircle className={`w-4 h-4 ${submitting ? 'animate-pulse' : ''}`} />
              {submitting ? 'Submitting…' : 'Confirm Pause'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CustomerProfilePanel({ subscriptionId, refreshVersion }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [match, setMatch] = useState(null);
  const [matchLoading, setMatchLoading] = useState(false);
  const [invoice, setInvoice] = useState(null);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [invoiceError, setInvoiceError] = useState('');
  const [mealProfile, setMealProfile] = useState(null);
  const [mealLoading, setMealLoading] = useState(false);
  const [mealError, setMealError] = useState('');
  const [showPauseModal, setShowPauseModal] = useState(false);
  const [activeTab, setActiveTab] = useState('logistics');

  // Manual "Internal Customer Match" linking — for when the automatic
  // email/phone/name match finds nothing (or finds the wrong record).
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [linkSearch, setLinkSearch] = useState('');
  const [linkResults, setLinkResults] = useState([]);
  const [linkSearching, setLinkSearching] = useState(false);
  const [linkingId, setLinkingId] = useState(null);
  const [linkError, setLinkError] = useState('');

  const loadProfile = useCallback(() => {
    if (!subscriptionId) return undefined;
    let mounted = true;
    setLoading(true);
    setError('');
    setInvoice(null);
    setInvoiceError('');
    api.get(`/matter/subscriptions/${subscriptionId}`)
      .then((res) => {
        if (!mounted) return;
        setProfile(res.data?.data?.data || null);
      })
      .catch((err) => {
        if (!mounted) return;
        console.error('Failed to load subscription profile:', err);
        setError(err.response?.data?.message || 'Failed to load this subscription.');
      })
      .finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, [subscriptionId, refreshVersion]);

  useEffect(() => { setActiveTab('logistics'); return loadProfile(); }, [loadProfile]);

  useEffect(() => {
    if (!profile) return;
    let mounted = true;
    setMatchLoading(true);
    api.get('/customers/match', {
      params: { email: profile.email, phone: profile.phone, name: profile.name, subscriptionId: profile.subscription_id },
    })
      .then((res) => { if (mounted) setMatch(res.data?.data || null); })
      .catch((err) => {
        console.error('Customer match failed:', err);
        if (mounted) setMatch(null);
      })
      .finally(() => mounted && setMatchLoading(false));
    return () => { mounted = false; };
  }, [profile]);

  // Search internal customers to manually link one to this subscription.
  useEffect(() => {
    if (!showLinkPicker) return undefined;
    const q = linkSearch.trim();
    if (!q) {
      setLinkResults([]);
      return undefined;
    }
    let mounted = true;
    setLinkSearching(true);
    const timer = setTimeout(() => {
      api.get('/customers', { params: { search: q, limit: 8 } })
        .then((res) => { if (mounted) setLinkResults(res.data?.data || []); })
        .catch((err) => {
          console.error('Customer search failed:', err);
          if (mounted) setLinkResults([]);
        })
        .finally(() => mounted && setLinkSearching(false));
    }, 300);
    return () => { mounted = false; clearTimeout(timer); };
  }, [showLinkPicker, linkSearch]);

  const handleLinkCustomer = async (customerId) => {
    if (!profile?.subscription_id) return;
    setLinkingId(customerId);
    setLinkError('');
    try {
      const res = await api.post('/customers/match/link', {
        customerId,
        subscriptionId: profile.subscription_id,
      });
      setMatch(res.data?.data || null);
      setShowLinkPicker(false);
      setLinkSearch('');
      setLinkResults([]);
    } catch (err) {
      console.error('Failed to link customer:', err);
      setLinkError(err.response?.data?.message || 'Could not link this customer.');
    } finally {
      setLinkingId(null);
    }
  };

  useEffect(() => {
    const customerId = match?.customer?.customerId;
    if (!customerId) {
      setMealProfile(null);
      return;
    }
    let mounted = true;
    setMealLoading(true);
    setMealError('');
    api.get(`/menus/customers/${customerId}/meal-profile`)
      .then((res) => { if (mounted) setMealProfile(res.data?.data || null); })
      .catch((err) => {
        console.error('Failed to load meal selections:', err);
        if (mounted) setMealError('Could not load meal selections.');
      })
      .finally(() => mounted && setMealLoading(false));
    return () => { mounted = false; };
  }, [match]);

  const handleCreateInvoice = async () => {
    setInvoiceLoading(true);
    setInvoiceError('');
    try {
      const res = await api.post(`/xero/invoices/from-subscription/${subscriptionId}`);
      setInvoice(res.data?.data || null);
    } catch (err) {
      console.error('Failed to create Xero invoice:', err);
      setInvoiceError(err.response?.data?.message || 'Failed to create invoice in Xero.');
    } finally {
      setInvoiceLoading(false);
    }
  };

  const websiteExclusions = profile?.exclusions || [];
  const internalExclusionNames = (match?.customer?.mealExclusion || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const websiteTitlesLower = new Set(websiteExclusions.map((ex) => ex.title.toLowerCase()));
  const missingFromWebsite = internalExclusionNames.filter((name) => !websiteTitlesLower.has(name.toLowerCase()));

  const mealsByDate = (mealProfile?.selectedMeals || []).reduce((acc, meal) => {
    const key = meal.date ? String(meal.date).slice(0, 10) : 'Unknown date';
    if (!acc[key]) acc[key] = [];
    acc[key].push(meal);
    return acc;
  }, {});
  const groupedMealDates = Object.entries(mealsByDate).sort((a, b) => b[0].localeCompare(a[0]));

  const macroMax = Math.max(profile?.macros?.protein || 0, profile?.macros?.carbohydrates || 0, profile?.macros?.fat || 0, 1);
  const whatsappHref = profile?.whatsapp ? `https://wa.me/${String(profile.whatsapp).replace(/[^\d]/g, '')}` : null;
  const clientSince = profile?.created_at || profile?.starting_date;

  const durationDays = profile?.cycle_start_date && profile?.cycle_end_date
    ? Math.round((new Date(profile.cycle_end_date) - new Date(profile.cycle_start_date)) / 86400000) + 1
    : null;
  const daysRemaining = profile?.cycle_end_date
    ? Math.max(0, Math.round((new Date(profile.cycle_end_date) - new Date(new Date().toDateString())) / 86400000))
    : null;

  if (!subscriptionId) {
    return (
      <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-10 text-center text-gray-400">
        Select a customer from the list to view their profile.
      </div>
    );
  }

  if (loading) {
    return <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-16 text-center text-gray-400 animate-pulse">Loading profile…</div>;
  }

  if (error) {
    return <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-16 text-center text-matter-red">{error}</div>;
  }

  if (!profile) return null;

  return (
    <div>
      {/* Header */}
      <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-6 mb-4 flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3 mb-1 flex-wrap">
            <CustomerTagBadges customer={websiteMetadataCustomer(profile)} />
            <h2 className="font-serif-mgmt text-2xl font-bold text-matter-navy">{profile.name}</h2>
            <CustomerTypeTag customer={websiteMetadataCustomer(profile)} />
            {isCycleEnded(profile.cycle_end_date) && (
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-500 whitespace-nowrap">
                Cycle ended
              </span>
            )}
          </div>
          <p className="text-xs font-mono text-gray-400 mb-3">CUS-{profile.customer_id} · SUB-{profile.subscription_id}</p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-gray-500">
            {profile.email && (
              <span className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px]">mail</span>
                {profile.email}
              </span>
            )}
            {profile.phone && (
              <span className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px]">call</span>
                {profile.phone}
              </span>
            )}
            {clientSince && (
              <span className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px]">calendar_today</span>
                Joined {formatDate(clientSince)}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <ActionIcon href={profile.email ? `mailto:${profile.email}` : null} icon="mail" title="Email" />
          <ActionIcon href={profile.phone ? `tel:${profile.phone}` : null} icon="call" title="Call" />
          <ActionIcon href={whatsappHref} icon="chat" title="WhatsApp" />
        </div>
      </div>

      {/* Subscription details + Macro profile */}
      <div className="mb-4"><CustomerMatterDetails customer={websiteMetadataCustomer(profile)} /></div>
      <div className="grid grid-cols-12 gap-4 mb-4">
        <div className="col-span-12 lg:col-span-7 bg-white rounded-2xl border border-matter-dust/40 shadow-md p-6">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Subscription</p>
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <h3 className="font-serif-mgmt text-xl font-bold text-matter-navy">{profile.plan?.name || 'No plan'}</h3>
            {profile.breakfast_included && (
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-matter-green/30 text-matter-navy">
                Breakfast included
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-y-4 gap-x-3 mb-4">
            {/* API's total_meals is the meal count for the whole cycle, not a
                daily figure — the per-day count lives at plan.meal_frequency. */}
            <MiniField label="Meal per day" value={profile.plan?.meal_frequency} />
            <MiniField label="Snacks / Day" value={profile.snacks_per_day} />
            <MiniField label="Duration" value={durationDays !== null ? `${durationDays} days` : '—'} />
            <MiniField label="Days Remaining" value={daysRemaining !== null ? daysRemaining : '—'} />
            <MiniField label="Start" value={formatDate(profile.cycle_start_date)} />
            <MiniField label="End" value={formatDate(profile.cycle_end_date)} />
          </div>
          <div className="flex justify-between items-center pt-4 border-t border-gray-100">
            <span className="text-sm text-gray-500">Plan value</span>
            <span className="font-serif-mgmt text-lg font-bold text-matter-navy">{formatMoney(profile.gross_paid, profile.currency)}</span>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Remaining deliveries: {profile.remaining_deliveries ?? '—'} / {profile.total_deliveries ?? '—'}
          </p>
        </div>

        <div className="col-span-12 lg:col-span-5 bg-white rounded-2xl border border-matter-dust/40 shadow-md p-6">
          <div className="flex items-center justify-between mb-4">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">Macro Profile · Daily Target</p>
            {profile.total_calories && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 whitespace-nowrap">
                <span className="material-symbols-outlined text-[14px]">local_fire_department</span>
                {profile.total_calories} kcal
              </span>
            )}
          </div>
          <div className="space-y-3">
            {MACRO_BLOCKS.map((m) => (
              <MacroBlock key={m.key} label={m.label} grams={profile.macros?.[m.key]} max={macroMax} box={m.box} track={m.track} fill={m.fill} text={m.text} />
            ))}
          </div>
          {(websiteExclusions.length > 0 || missingFromWebsite.length > 0) && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-2">
                <span className="material-symbols-outlined text-[14px]">eco</span>
                Dietary Restrictions
              </p>
              <div className="flex flex-wrap gap-1.5">
                {websiteExclusions.map((ex) => (
                  <span key={ex.title} className="text-xs font-medium bg-matter-dust/40 text-matter-charcoal border border-matter-dust rounded-full px-2.5 py-1">
                    {ex.title}
                  </span>
                ))}
                {missingFromWebsite.map((name) => (
                  <span key={name} className="text-xs font-medium bg-gray-100 text-gray-600 border border-gray-200 rounded-full px-2.5 py-1" title="On file internally but not synced to the website subscription">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-2xl border border-matter-dust/40 shadow-md p-5">
        <div className="inline-flex p-1 bg-gray-100 rounded-full mb-5">
          {[
            { key: 'logistics', label: 'Logistics' },
            { key: 'meals', label: 'Meal history' },
            { key: 'financials', label: 'Financials' },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
                activeTab === tab.key ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'logistics' && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div>
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3">Delivery Addresses</p>
                {profile.customer_addresses?.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    {profile.customer_addresses.map((addr) => (
                      <div
                        key={addr.id}
                        className={`rounded-xl p-3.5 border ${addr.status === 'active' ? 'bg-matter-green/25 border-matter-green/50' : 'bg-gray-50 border-gray-100'}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                            <span className="material-symbols-outlined text-[18px] text-gray-700">
                              {addr.type === 'work' ? 'work' : 'home'}
                            </span>
                            {addr.label || addr.type || 'Address'}
                          </span>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {addr.current_delivery_address && (
                              <span
                                className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-amber-400 text-amber-950 whitespace-nowrap"
                                title="Matter's own current_delivery_address flag — this is the address the customer is actually delivered to"
                              >
                                Current
                              </span>
                            )}
                            {addr.emirate && (
                              <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-matter-sky/50 text-matter-navy whitespace-nowrap">
                                {addr.emirate}
                              </span>
                            )}
                            <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full whitespace-nowrap ${addr.status === 'active' ? 'bg-white/70 text-gray-700' : 'bg-white text-gray-500'}`}>
                              {addr.status === 'active' ? 'Active' : 'Previous'}
                            </span>
                          </div>
                        </div>
                        <p className="text-sm text-gray-600 mt-1.5">
                          {[addr.building, addr.unit ? `Unit ${addr.unit}` : null, addr.floor, addr.area, addr.emirate].filter(Boolean).join(', ') || '—'}
                        </p>
                        {addr.area && <p className="text-xs text-gray-500 mt-1">Zone · {addr.area}</p>}
                        {typeof addr.coordinates?.lat === 'number' && typeof addr.coordinates?.lng === 'number' && (
                          <a
                            href={`https://www.google.com/maps?q=${addr.coordinates.lat},${addr.coordinates.lng}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 hover:underline mt-1 w-fit"
                          >
                            <span className="material-symbols-outlined text-[14px]">location_on</span>
                            {addr.coordinates.lat.toFixed(6)}, {addr.coordinates.lng.toFixed(6)}
                          </a>
                        )}
                        {profile.delivery_window && (
                          <p className="flex items-center gap-1 text-xs text-gray-500 mt-1">
                            <span className="material-symbols-outlined text-[14px]">schedule</span>
                            Delivery window · {profile.delivery_window.label}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">No address on file.</p>
                )}

                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3 mt-5">Internal Customer Match</p>
                {matchLoading ? (
                  <p className="text-sm text-gray-400">Checking…</p>
                ) : match?.customer ? (
                  <div className="bg-matter-green/15 border border-matter-green/40 rounded-xl p-3">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-semibold text-gray-900">{match.customer.firstName} {match.customer.lastName}</p>
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-matter-green/30 text-matter-navy">
                        {matchLabels[match.matchedBy] || 'Matched'}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <MiniField label="Internal ID" value={match.customer.customerId} />
                      <MiniField label="Email" value={match.customer.email} />
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowLinkPicker((v) => !v)}
                      className="text-xs text-matter-navy underline underline-offset-2 hover:opacity-70 mt-2"
                    >
                      Not the right customer? Link a different one
                    </button>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm text-gray-400 mb-2">No matching internal customer found — their email and phone don't match anything on file.</p>
                    {!showLinkPicker && (
                      <button
                        type="button"
                        onClick={() => setShowLinkPicker(true)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-matter-sky text-matter-navy rounded-lg text-xs font-semibold hover:opacity-90 transition"
                      >
                        <span className="material-symbols-outlined text-[16px]">link</span>
                        Link a customer manually
                      </button>
                    )}
                  </div>
                )}

                {showLinkPicker && (
                  <div className="mt-3 border border-matter-dust/50 rounded-xl p-3 bg-gray-50">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold text-gray-700">Find the internal customer</p>
                      <button
                        type="button"
                        onClick={() => { setShowLinkPicker(false); setLinkSearch(''); setLinkResults([]); setLinkError(''); }}
                        className="text-gray-400 hover:text-gray-700"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <input
                      type="text"
                      autoFocus
                      value={linkSearch}
                      onChange={(e) => setLinkSearch(e.target.value)}
                      placeholder="Search by name, email, or customer ID…"
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-matter-sky focus:border-matter-sky mb-2"
                    />
                    {linkError && <p className="text-xs text-matter-red mb-2">{linkError}</p>}
                    {linkSearching ? (
                      <p className="text-xs text-gray-400">Searching…</p>
                    ) : linkSearch.trim() && linkResults.length === 0 ? (
                      <p className="text-xs text-gray-400">No internal customers match "{linkSearch.trim()}".</p>
                    ) : (
                      <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto">
                        {linkResults.map((c) => (
                          <div key={c.customerId} className="flex items-center justify-between gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-900 truncate">{c.firstName} {c.lastName}</p>
                              <p className="text-xs text-gray-500 truncate">{c.email || 'No email'} · {c.customerId}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleLinkCustomer(c.customerId)}
                              disabled={linkingId === c.customerId}
                              className="flex-shrink-0 px-3 py-1.5 bg-matter-navy text-white rounded-lg text-xs font-semibold hover:opacity-90 disabled:opacity-50"
                            >
                              {linkingId === c.customerId ? 'Linking…' : 'Link'}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">Delivery Calendar</p>
                  <button
                    type="button"
                    onClick={() => setShowPauseModal(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-matter-sky text-matter-navy rounded-lg text-xs font-semibold hover:opacity-90 transition"
                  >
                    <PauseCircle className="w-3.5 h-3.5" />
                    Pause Delivery
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 pb-4 border-b border-gray-100">
                  <MiniField label="Cycle Start" value={formatDate(profile.cycle_start_date)} />
                  <MiniField label="Cycle End" value={formatDate(profile.cycle_end_date)} />
                  <MiniField label="Next Delivery" value={formatDate(profile.next_delivery_date)} />
                  <MiniField label="Renewal Due" value={profile.renewal_eligible ? formatDate(profile.renewal_due_date) : 'Not eligible'} />
                </div>
                <DeliveryCalendar
                  cycleStartDate={profile.cycle_start_date}
                  pauses={profile.pauses}
                  deliverySchedule={profile.delivery_schedule}
                  customerId={match?.customer?.customerId}
                />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'meals' && (
          !match?.customer ? (
            <p className="text-sm text-gray-400">No internal customer match — meal selections unavailable.</p>
          ) : mealLoading ? (
            <p className="text-sm text-gray-400">Loading meal selections…</p>
          ) : mealError ? (
            <p className="text-sm text-matter-red">{mealError}</p>
          ) : groupedMealDates.length === 0 ? (
            <p className="text-sm text-gray-400">No meal selections found for this customer.</p>
          ) : (
            <div className="space-y-3">
              {groupedMealDates.map(([date, meals]) => (
                <div key={date} className="border border-gray-100 rounded-xl p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-gray-800 mb-3">
                    <span className="material-symbols-outlined text-[18px] text-gray-400">restaurant</span>
                    {formatDate(date)}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {meals.map((meal, idx) => (
                      <span key={`${date}-${idx}`} className="text-sm font-medium bg-matter-dust/40 text-matter-charcoal border border-matter-dust rounded-full px-3 py-1.5">
                        {meal.mealName}{meal.quantity > 1 ? ` ×${meal.quantity}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {activeTab === 'financials' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="border border-gray-100 rounded-xl p-4">
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3">Pricing</p>
              <div className="flex flex-col gap-2 text-sm font-mono mb-3">
                <div className="flex justify-between"><span className="text-gray-500">Base Price</span><span className="text-gray-900">{formatMoney(profile.base_price, profile.currency)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Bag Price</span><span className="text-gray-900">{formatMoney(profile.bag_price, profile.currency)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">VAT ({profile.vat_percentage ?? 0}%)</span><span className="text-gray-900">{formatMoney(profile.vat, profile.currency)}</span></div>
                <div className="flex justify-between pt-2 mt-1 border-t border-gray-100 font-semibold">
                  <span className="text-gray-900">Gross Total</span>
                  <span className="text-matter-navy text-base">{formatMoney(profile.gross_paid, profile.currency)}</span>
                </div>
              </div>
              {invoice ? (
                <div className="flex items-start gap-2 bg-matter-green/15 border border-matter-green/40 text-matter-navy rounded-lg px-3 py-2 text-xs">
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    Invoice {invoice.InvoiceNumber} created in Xero
                    {invoice.InvoiceID && (
                      <>
                        {' · '}
                        <a href={`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${invoice.InvoiceID}`} target="_blank" rel="noreferrer" className="underline font-medium">
                          View in Xero
                        </a>
                      </>
                    )}
                  </span>
                </div>
              ) : (
                <button
                  onClick={handleCreateInvoice}
                  disabled={invoiceLoading}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 bg-matter-sky text-matter-navy rounded-lg text-xs font-semibold hover:opacity-90 disabled:opacity-50 transition"
                >
                  <Receipt className={`w-3.5 h-3.5 ${invoiceLoading ? 'animate-pulse' : ''}`} />
                  {invoiceLoading ? 'Creating invoice…' : 'Create Xero Invoice'}
                </button>
              )}
              {invoiceError && <p className="text-xs text-matter-red mt-2">{invoiceError}</p>}
            </div>

            <div className="border border-gray-100 rounded-xl p-4">
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3">Recent Transactions</p>
              {profile.payments?.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[10px] text-gray-400 uppercase tracking-wide">
                        <th className="text-left font-semibold pb-2">Ref</th>
                        <th className="text-left font-semibold pb-2">Date</th>
                        <th className="text-right font-semibold pb-2">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {profile.payments.slice(0, 6).map((p) => (
                        <tr key={p.id}>
                          <td className="py-2 font-mono text-xs text-gray-700">TRX-{p.transaction_id}</td>
                          <td className="py-2 text-gray-500">{formatDate(p.date)}</td>
                          <td className="py-2 text-right font-mono text-gray-900">{formatMoney(p.amount, p.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-gray-400">No transactions on file.</p>
              )}
            </div>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-300 text-center mt-4">Last updated {formatDate(profile.updated_at)}</p>

      {showPauseModal && (
        <PauseModal
          subscriptionId={subscriptionId}
          cycleEndDate={profile.cycle_end_date}
          onClose={() => setShowPauseModal(false)}
          onSuccess={() => {
            setShowPauseModal(false);
            loadProfile();
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Page: Customer Management                                              */
/* ---------------------------------------------------------------------- */

const WebsiteSubscription = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [profileRefresh, setProfileRefresh] = useState(0);

  const handleSelect = (subscriptionId, opts) => {
    navigate(`/website-subscriptions/${subscriptionId}`, opts);
  };

  return (
    <div className="customer-mgmt min-h-screen p-6">
      <div className="flex items-start justify-between mb-6 pb-6 border-b border-black/10 flex-wrap gap-3">
        <div>
          <h1 className="font-serif-mgmt text-3xl font-bold text-matter-navy">Customer Management</h1>
          <p className="text-gray-500 text-sm mt-1">Every subscriber, their plan, logistics and financial record.</p>
        </div>
        <button
          onClick={() => navigate('/customers')}
          title="Add a new internal customer record"
          className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-matter-sky text-matter-navy rounded-lg text-sm font-semibold hover:opacity-90 transition"
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          New customer
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-5 items-start">
        <CustomerListPanel selectedId={id} onSelect={handleSelect} onRefresh={() => setProfileRefresh(value => value + 1)} />
        <CustomerProfilePanel subscriptionId={id} refreshVersion={profileRefresh} />
      </div>
    </div>
  );
};

export default WebsiteSubscription;
