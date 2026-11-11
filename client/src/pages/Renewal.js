import React, { useState, useEffect, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';
import {
  RefreshCw, Download, Search, AlertCircle, CheckCircle,
  Phone, MessageSquare, X, ChevronUp, ChevronDown
} from 'lucide-react';
import api from '../utils/api';

const fmt = (n) => Number(n || 0).toFixed(0);

const URGENCY = [
  { key: 'all',         label: 'All',         color: 'indigo' },
  { key: 'not_renewed', label: 'Not Renewed',  color: 'rose'   },
  { key: 'expired',     label: '0 days left',  color: 'red'    },
  { key: 'critical',    label: '1–3 days',     color: 'orange' },
  { key: 'warning',     label: '4–6 days',     color: 'yellow' },
];

const urgencyStyle = (remaining, notRenewed) => {
  if (notRenewed)      return { badge: 'bg-rose-100 text-rose-700',    row: 'bg-rose-50/30' };
  if (remaining <= 0)  return { badge: 'bg-red-100 text-red-700',      row: 'bg-red-50/40' };
  if (remaining <= 3)  return { badge: 'bg-orange-100 text-orange-700', row: 'bg-orange-50/30' };
  return                      { badge: 'bg-yellow-100 text-yellow-700', row: '' };
};

export default function Renewal() {
  const [customers,      setCustomers]      = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState(null);
  const [search,         setSearch]         = useState('');
  const [filter,         setFilter]         = useState('all');
  const [sort,           setSort]           = useState({ key: 'remaining', dir: 'asc' });
  const [waState,        setWaState]        = useState({});
  const [lastUpdated,    setLastUpdated]    = useState(null);
  const [monthFilter,    setMonthFilter]    = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [custRes, usageRes] = await Promise.all([
        api.get('/customers', { params: { limit: 10000 } }),
        api.get('/deliveries/renewal-usage'),
      ]);

      const dbCustomers = custRes.data?.data || [];
      const usageByCustomer = new Map(
        (usageRes.data?.data || []).map(row => [row.customerId, row])
      );

      const map = new Map();

      dbCustomers.forEach(c => {
        const id = c.customerId || c._id;
        const usage = usageByCustomer.get(id);
        map.set(id, {
          customerId:    id,
          customerName:  `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unknown',
          phone:         c.phone || '',
          mealPlan:      c.mealPlan || '',
          planStartDate: c.planStartDate || null,
          cycleDuration: c.cycleDuration || 0,
          amountPaid:    c.amountPaid || '',
          discount:      c.discount || '',
          totalDeliveries: usage?.used || 0,
          lastDeliveryDate: usage?.lastScheduledTime || null,
        });
      });

      const today = new Date(); today.setHours(0, 0, 0, 0);

      const renewal = Array.from(map.values())
        .filter(c => {
          const total = Number(c.cycleDuration) || 0;
          if (!total) return false;
          const remaining = total - c.totalDeliveries;
          // Include customers whose cycle has ended (not renewed) OR those with ≤6 days left
          if (remaining > 6) return false;
          return true;
        })
        .map(c => {
          const total = Number(c.cycleDuration) || 0;
          const remaining = total - c.totalDeliveries;
          let notRenewed = false;
          if (c.planStartDate) {
            const end = new Date(new Date(c.planStartDate).getTime() + total * 86400000);
            if (end < today) notRenewed = true;
          } else if (remaining === 0) {
            notRenewed = true;
          }
          // displayDate = the date shown in the "Last Day" column
          let displayDate = null;
          if (notRenewed) {
            displayDate = c.lastDeliveryDate || null;
          } else {
            const d = new Date();
            d.setDate(d.getDate() + remaining);
            displayDate = d.toISOString();
          }
          return { ...c, remaining, notRenewed, displayDate };
        });

      setCustomers(renewal);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e.response?.data?.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // KPI counts
  const counts = useMemo(() => ({
    all:         customers.length,
    not_renewed: customers.filter(c => c.notRenewed).length,
    expired:     customers.filter(c => !c.notRenewed && c.remaining <= 0).length,
    critical:    customers.filter(c => !c.notRenewed && c.remaining >= 1 && c.remaining <= 3).length,
    warning:     customers.filter(c => !c.notRenewed && c.remaining >= 4 && c.remaining <= 6).length,
  }), [customers]);

  // Derive available months from lastDeliveryDate across all customers
  const availableMonths = useMemo(() => {
    const seen = new Set();
    customers.forEach(c => {
      if (c.displayDate) {
        const d = new Date(c.displayDate);
        seen.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
      }
    });
    return Array.from(seen).sort().reverse();
  }, [customers]);

  // Filter + search + sort
  const filtered = useMemo(() => {
    let list = [...customers];
    if (filter === 'not_renewed') list = list.filter(c => c.notRenewed);
    if (filter === 'expired')     list = list.filter(c => !c.notRenewed && c.remaining <= 0);
    if (filter === 'critical')    list = list.filter(c => !c.notRenewed && c.remaining >= 1 && c.remaining <= 3);
    if (filter === 'warning')     list = list.filter(c => !c.notRenewed && c.remaining >= 4 && c.remaining <= 6);
    if (monthFilter) {
      list = list.filter(c => {
        if (!c.displayDate) return false;
        const d = new Date(c.displayDate);
        const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        return m === monthFilter;
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c =>
        c.customerName.toLowerCase().includes(q) ||
        c.customerId?.toLowerCase().includes(q) ||
        c.phone?.includes(q)
      );
    }
    list.sort((a, b) => {
      let av = a[sort.key], bv = b[sort.key];
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return list;
  }, [customers, filter, search, sort, monthFilter]);

  const toggleSort = (key) => setSort(s =>
    s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
  );

  const lastDayOf = (remaining) => {
    const d = new Date();
    d.setDate(d.getDate() + remaining);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  const handleWhatsApp = async (c, e) => {
    e.stopPropagation();
    const id = c.customerId;
    setWaState(p => ({ ...p, [id]: 'sending' }));
    try {
      await api.post('/customers/send-whatsapp-reminder', {
        customerId:    id,
        customerName:  c.customerName,
        mealPlan:      c.mealPlan || 'Standard',
        lastDeliveryDate: c.notRenewed ? (c.lastDeliveryDate || null) : (c.displayDate || null),
        remaining:     c.remaining,
        discount:      c.discount || '0',
        phone:         c.phone,
      });
      setWaState(p => ({ ...p, [id]: 'sent' }));
    } catch {
      setWaState(p => ({ ...p, [id]: 'error' }));
    }
  };

  const exportExcel = () => {
    const rows = [
      ['Due for Renewal Report'],
      [`Generated: ${new Date().toLocaleDateString()}`],
      [],
      ['#', 'Customer Name', 'Customer ID', 'Phone', 'Cycle (days)', 'Used', 'Days Left', 'Last Delivery Date'],
    ];
    filtered.forEach((c, i) => {
      rows.push([
        i + 1,
        c.customerName,
        c.customerId,
        c.phone || '—',
        c.cycleDuration,
        c.totalDeliveries,
        c.remaining,
        lastDayOf(c.remaining),
      ]);
    });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [5, 28, 18, 16, 14, 10, 10, 20].map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Due for Renewal');
    const arr = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const url = URL.createObjectURL(new Blob([arr], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `renewal-${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const SortIcon = ({ k }) => {
    if (sort.key !== k) return <ChevronUp className="w-3 h-3 opacity-20" />;
    return sort.dir === 'asc'
      ? <ChevronUp className="w-3 h-3 text-indigo-500" />
      : <ChevronDown className="w-3 h-3 text-indigo-500" />;
  };

  const Th = ({ k, children, className = '', title }) => (
    <th
      title={title}
      onClick={() => toggleSort(k)}
      className={`px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer select-none hover:text-gray-700 ${className}`}
    >
      <span className="inline-flex items-center gap-1">{children}<SortIcon k={k} /></span>
    </th>
  );

  const kpiColor = {
    all:         'border-indigo-200 bg-indigo-50',
    not_renewed: 'border-rose-200   bg-rose-50',
    expired:     'border-red-200    bg-red-50',
    critical:    'border-orange-200 bg-orange-50',
    warning:     'border-yellow-200 bg-yellow-50',
  };
  const kpiText = {
    all:         'text-indigo-700',
    not_renewed: 'text-rose-700',
    expired:     'text-red-700',
    critical:    'text-orange-700',
    warning:     'text-yellow-700',
  };

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Renewal</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Customers due for renewal or who have not renewed
            {lastUpdated && (
              <span className="ml-2 text-gray-400">
                · updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchData} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button onClick={exportExcel} disabled={!filtered.length}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 transition-colors">
            <Download className="w-4 h-4" />
            Export Excel
          </button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
        {URGENCY.map(u => (
          <button key={u.key} onClick={() => setFilter(u.key)}
            className={`rounded-xl border p-4 text-left transition-all ${kpiColor[u.key]} ${filter === u.key ? 'ring-2 ring-offset-1 ring-indigo-400' : 'hover:opacity-80'}`}>
            <p className="text-xs font-semibold text-gray-500 mb-1">{u.label}</p>
            <p className={`text-3xl font-bold ${kpiText[u.key]}`}>{counts[u.key]}</p>
            {filter === u.key && counts[u.key] > 0 && (
              <p className="text-xs text-gray-400 mt-0.5">showing {filtered.length}</p>
            )}
          </button>
        ))}
      </div>

      {/* Search + filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, ID or phone…"
            className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Month filter */}
        <select value={monthFilter} onChange={e => setMonthFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:ring-2 focus:ring-indigo-500 focus:outline-none">
          <option value="">All months</option>
          {availableMonths.map(m => {
            const [y, mo] = m.split('-');
            const label = new Date(Number(y), Number(mo) - 1, 1)
              .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
            return <option key={m} value={m}>{label}</option>;
          })}
        </select>

        {(filter !== 'all' || monthFilter) && (
          <button onClick={() => { setFilter('all'); setMonthFilter(''); }}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 border border-gray-300 rounded-lg px-3 py-2 bg-white">
            <X className="w-3.5 h-3.5" />
            Clear filters
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-gray-400">
            <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <CheckCircle className="w-10 h-10 mb-3 text-green-300" />
            <p className="font-medium">No customers due for renewal</p>
            <p className="text-sm mt-1">Everyone has more than 6 deliveries remaining</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-10">#</th>
                  <Th k="customerName">Customer</Th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Phone</th>
                  <Th k="cycleDuration" className="text-right">Cycle</Th>
                  <Th k="totalDeliveries" className="text-right" title="Non-cancelled deliveries counted toward the cycle. Not proof of handover.">Used</Th>
                  <Th k="remaining" className="text-right">Days Left</Th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Last Day</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((c, i) => {
                  const { badge, row } = urgencyStyle(c.remaining, c.notRenewed);
                  const wa = waState[c.customerId];
                  return (
                    <tr key={c.customerId} className={`hover:bg-gray-50 transition-colors ${row}`}>
                      <td className="px-4 py-3 text-gray-400 text-xs">{i + 1}</td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-gray-900">{c.customerName}</p>
                        <p className="text-xs text-gray-400">{c.customerId}</p>
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {c.phone ? (
                          <a href={`tel:${c.phone}`} className="flex items-center gap-1 hover:text-indigo-600">
                            <Phone className="w-3 h-3" /> {c.phone}
                          </a>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600 font-medium">{c.cycleDuration || '—'}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{c.totalDeliveries}</td>
                      <td className="px-4 py-3 text-right">
                        {c.notRenewed ? (
                          <span className="inline-block px-2.5 py-1 rounded-lg font-semibold text-xs bg-rose-100 text-rose-700">
                            Not Renewed
                          </span>
                        ) : (
                          <span className={`inline-block px-2.5 py-1 rounded-lg font-bold text-base ${badge}`}>
                            {c.remaining}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-sm whitespace-nowrap">
                        {c.notRenewed
                          ? c.lastDeliveryDate
                            ? new Date(c.lastDeliveryDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                            : '—'
                          : lastDayOf(c.remaining)}
                      </td>
                      <td className="px-4 py-3">
                        {c.phone && (
                          <button onClick={(e) => handleWhatsApp(c, e)}
                            disabled={wa === 'sending' || wa === 'sent'}
                            title="Send WhatsApp reminder"
                            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50
                              ${wa === 'sent'   ? 'bg-green-100 text-green-700' :
                                wa === 'error'  ? 'bg-red-100 text-red-700' :
                                wa === 'sending'? 'bg-gray-100 text-gray-500' :
                                'bg-green-50 text-green-700 hover:bg-green-100'}`}>
                            <MessageSquare className="w-3.5 h-3.5" />
                            {wa === 'sent' ? 'Sent' : wa === 'error' ? 'Failed' : wa === 'sending' ? '…' : 'WhatsApp'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer count */}
        {!loading && filtered.length > 0 && (
          <div className="px-4 py-3 border-t border-gray-100 text-xs text-gray-400 bg-gray-50">
            Showing {filtered.length} of {customers.length} customer{customers.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>
    </div>
  );
}
