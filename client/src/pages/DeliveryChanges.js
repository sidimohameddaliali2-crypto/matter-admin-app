import React, { useState, useEffect, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileText,
  CheckCircle,
  XCircle,
  Clock,
  X
} from 'lucide-react';
import { fetchDeliveryChanges } from '../store/slices/deliveryChangeSlice';
import api from '../utils/api';

const DeliveryChanges = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { changes, isLoading, error } = useSelector(state => state.deliveryChange);

  const [filters, setFilters] = useState({
    status: '',
    startDate: '',
    endDate: '',
    customerId: ''
  });

  useEffect(() => {
    loadChanges();
  }, []);

  const loadChanges = () => {
    // customerId is matched client-side (visibleGroups) since the backend only
    // supports an exact customerId match, not a name/partial search.
    const { status, startDate, endDate } = filters;
    dispatch(fetchDeliveryChanges({ status, startDate, endDate }));
  };

 const handleApplyChange = async (changeId) => {
  try {
    // The apply endpoint performs the existence/status checks. Diagnostics
    // are admin-only and are not part of the dispatcher workflow.
    const response = await api.post(`/delivery-changes/${changeId}/apply`);
    
    if (response.data.success) {
      alert('Changes applied successfully!');
      loadChanges(); // Refresh the list
    } else {
      throw new Error(response.data.message);
    }
  } catch (error) {
    console.error('Failed to apply change:', error);
    
    if (error.response?.data?.message) {
      alert(`Failed to apply changes: ${error.response.data.message}`);
    } else {
      alert('Failed to apply changes. Please check the console for details.');
    }
  }
};
  const getStatusBadge = (status) => {
    const statusConfig = {
      pending: { color: 'bg-yellow-100 text-yellow-800', icon: Clock },
      applied: { color: 'bg-green-100 text-green-800', icon: CheckCircle },
      failed: { color: 'bg-red-100 text-red-800', icon: XCircle },
      cancelled: { color: 'bg-gray-100 text-gray-800', icon: XCircle }
    };

    const config = statusConfig[status] || statusConfig.pending;
    const Icon = config.icon;

    return (
      <span className={`px-2 py-1 text-xs font-medium rounded-full flex items-center w-fit ${config.color}`}>
        <Icon className="w-3 h-3 mr-1" />
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    );
  };

  const formatChangeValue = (value, fieldKey = '') => {
    if (value === null || value === undefined) {
      return '—';
    }
    
    // Special formatting for specific fields
    if (fieldKey === 'scheduledTime' && typeof value === 'string') {
      try {
        const date = new Date(value);
        return date.toLocaleString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          second: undefined,
          hour12: true,
          timeZone: 'UTC'
        });
      } catch (e) {
        return String(value);
      }
    }
    
    if (typeof value === 'object') {
      // Handle driver objects - show firstName or driver name
      if (fieldKey === 'driver') {
        if (value.profile && value.profile.firstName) {
          return value.profile.firstName;
        }
        if (value.firstName) return value.firstName;
        if (value.name) return value.name;
        // If it's just an ID, return it
        return JSON.stringify(value).substring(0, 20) + '...';
      }
      
      // Handle nested objects with old/new values
      if (value.newValue !== undefined && value.oldValue !== undefined) {
        // Format based on field type
        const oldFormatted = formatChangeValue(value.oldValue, fieldKey);
        const newFormatted = formatChangeValue(value.newValue, fieldKey);
        return `${oldFormatted} → ${newFormatted}`;
      }
      
      // Try to extract meaningful properties
      if (value.name) return value.name;
      if (value.firstName && value.lastName) return `${value.firstName} ${value.lastName}`;
      if (value.firstName) return value.firstName;
      
      // Last resort - stringify but keep it readable
      const str = JSON.stringify(value);
      return str.length > 50 ? str.substring(0, 47) + '...' : str;
    }
    
    return String(value);
  };

  const getDateStatus = (change) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = change.scheduledDate ? new Date(change.scheduledDate) : null;
    const end = change.endDate ? new Date(change.endDate) : start;
    if (start) start.setHours(0, 0, 0, 0);
    if (end) end.setHours(0, 0, 0, 0);
    if (start && today < start) return { label: 'Upcoming', cls: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500' };
    if (end && today > end) return { label: 'Completed', cls: 'bg-gray-100 text-gray-600 border-gray-200', dot: 'bg-gray-400' };
    return { label: 'Active', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' };
  };

  // Every change a customer has requested — address, zone, timing, whatever —
  // belongs on one card per customer, not one card per request or per date.
  const groupedChanges = useMemo(() => {
    const groups = new Map();
    changes.forEach((change) => {
      const key = change.customerId || change.customerName || change._id;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          customerId: change.customerId,
          customerName: change.customerName,
          instances: []
        });
      }
      groups.get(key).instances.push(change);
    });
    return Array.from(groups.values()).map((group) => {
      const sorted = [...group.instances].sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate));
      return { ...group, instances: sorted };
    });
  }, [changes]);

  // Which single request should "represent" the card face, and what date
  // status drives its badge — an Active request always wins (something is
  // happening right now); otherwise the soonest Upcoming request wins even if
  // other requests on the card have already Completed; only when every
  // request has passed does the card read as Completed.
  const getFeaturedInstance = (group) => {
    const withStatus = group.instances.map((instance) => ({ instance, status: getDateStatus(instance) }));
    const active = withStatus.find((entry) => entry.status.label === 'Active');
    if (active) return active;
    const upcoming = withStatus
      .filter((entry) => entry.status.label === 'Upcoming')
      .sort((a, b) => new Date(a.instance.scheduledDate) - new Date(b.instance.scheduledDate))[0];
    if (upcoming) return upcoming;
    return [...withStatus].sort((a, b) => new Date(b.instance.scheduledDate) - new Date(a.instance.scheduledDate))[0];
  };

  const [dateStatusFilter, setDateStatusFilter] = useState('');

  const visibleGroups = useMemo(() => {
    let result = groupedChanges;
    if (dateStatusFilter) {
      result = result.filter((group) => getFeaturedInstance(group).status.label.toLowerCase() === dateStatusFilter);
    }
    const term = filters.customerId.trim().toLowerCase();
    if (term) {
      result = result.filter((group) =>
        (group.customerName || '').toLowerCase().includes(term) ||
        (group.customerId || '').toLowerCase().includes(term)
      );
    }
    return result;
  }, [groupedChanges, dateStatusFilter, filters.customerId]);

  const [selectedGroup, setSelectedGroup] = useState(null);

  const openSlideOut = (group) => setSelectedGroup(group);
  const closeSlideOut = () => setSelectedGroup(null);

  // Mobile accordion cards + compact filter disclosure
  const [expandedCards, setExpandedCards] = useState({});
  const toggleCard = (key) => setExpandedCards((prev) => ({ ...prev, [key]: !prev[key] }));
  const [showMobileDateFilter, setShowMobileDateFilter] = useState(false);

  const mobileStatusMeta = {
    Active: { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: null, dotCls: 'bg-emerald-500' },
    Upcoming: { cls: 'bg-amber-50 text-amber-700 border-amber-200', icon: 'schedule', dotCls: null },
    Completed: { cls: 'bg-gray-100 text-gray-600 border-gray-200', icon: 'task_alt', dotCls: null }
  };

  const instanceStatusPill = {
    pending: 'text-gray-600 bg-gray-100 border-gray-200',
    applied: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    failed: 'text-red-700 bg-red-50 border-red-200',
    cancelled: 'text-gray-500 bg-gray-100 border-gray-200'
  };

  return (
    <div className="matter-analytics min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Delivery Changes</h1>
            <p className="text-gray-500 text-sm mt-1">Manage temporary and permanent delivery modifications.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => navigate('/delivery-changes/add')}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              <span className="material-symbols-outlined text-[18px]">edit_calendar</span>
              Add Change
            </button>
          </div>
      </div>

      {/* Mobile: search, compact filters, accordion list */}
      <div className="lg:hidden -mx-4 md:-mx-6">
        <div className="sticky top-0 z-30 bg-gray-50/95 backdrop-blur-md px-4 py-3 space-y-3 border-b border-gray-200/70">
          <div className="relative w-full">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[20px]">search</span>
            <input
              type="text"
              value={filters.customerId}
              onChange={(e) => setFilters({ ...filters, customerId: e.target.value })}
              placeholder="Search ID or customer..."
              className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setShowMobileDateFilter((v) => !v)}
              className="flex-1 flex items-center justify-center gap-2 py-2 px-3 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <span className="material-symbols-outlined text-gray-500 text-[18px]">calendar_today</span>
              <span className="text-xs font-semibold text-gray-600 truncate">
                {filters.startDate || filters.endDate
                  ? `${filters.startDate || '…'} - ${filters.endDate || '…'}`
                  : 'All Dates'}
              </span>
            </button>
            <button
              onClick={() => setFilters({ status: '', startDate: '', endDate: '', customerId: '' })}
              className="flex items-center justify-center p-2 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors text-gray-500"
              title="Clear filters"
            >
              <span className="material-symbols-outlined text-[20px]">tune</span>
            </button>
          </div>

          {showMobileDateFilter && (
            <div className="flex gap-2 items-center">
              <input
                type="date"
                value={filters.startDate}
                onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
                className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <input
                type="date"
                value={filters.endDate}
                onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
                className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <button
                onClick={() => { loadChanges(); setShowMobileDateFilter(false); }}
                className="flex-shrink-0 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Go
              </button>
            </div>
          )}

          <div className="flex gap-2 overflow-x-auto no-scrollbar">
            {[
              { key: '', label: 'All' },
              { key: 'active', label: 'Active' },
              { key: 'upcoming', label: 'Upcoming' },
              { key: 'completed', label: 'Completed' }
            ].map((opt) => (
              <button
                key={opt.key || 'all'}
                onClick={() => setDateStatusFilter(opt.key)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                  dateStatusFilter === opt.key
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'bg-white border-gray-200 text-gray-600'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="px-4 py-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-gray-500 tracking-widest uppercase">
              {dateStatusFilter ? `${dateStatusFilter} Changes` : 'All Changes'}
            </h2>
            <span className="text-xs font-mono text-gray-500 bg-gray-200 px-2 py-0.5 rounded-full">{visibleGroups.length}</span>
          </div>

          <div className="space-y-4">
            {visibleGroups.map((group) => {
              const featured = getFeaturedInstance(group);
              const featuredInstance = featured.instance;
              const groupStatus = featured.status;
              const changeEntries = Object.entries(featuredInstance.changes || {});
              const addressEntry = changeEntries.find(([key]) => key === 'address');
              const otherEntries = changeEntries.filter(([key]) => key !== 'address');
              const statusMeta = mobileStatusMeta[groupStatus.label] || mobileStatusMeta.Completed;
              const isExpanded = !!expandedCards[group.key];
              const fmtRange = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: '2-digit' }) : '');

              return (
                <article key={group.key} className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
                  <div
                    className="p-4 cursor-pointer active:bg-gray-50 transition-colors"
                    onClick={() => toggleCard(group.key)}
                  >
                    <div className="flex justify-between items-start mb-3 gap-2">
                      <div className="min-w-0">
                        <h3 className="text-base font-semibold text-gray-900 truncate">{group.customerName}</h3>
                        <p className="font-mono text-xs text-gray-500 mt-0.5">{group.customerId}</p>
                      </div>
                      <span className={`flex-shrink-0 px-2 py-1 rounded text-xs font-semibold flex items-center gap-1 border ${statusMeta.cls}`}>
                        {statusMeta.dotCls ? <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dotCls}`} /> : (
                          <span className="material-symbols-outlined text-[14px]">{statusMeta.icon}</span>
                        )}
                        {groupStatus.label.toUpperCase()}
                      </span>
                    </div>

                    {addressEntry ? (
                      <div className="flex items-center gap-3 bg-gray-50 p-3 rounded-lg border border-gray-100 relative">
                        <div className="flex-1 w-0">
                          <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-1 truncate">Original Dest.</p>
                          <p className="text-sm text-gray-500 italic truncate">Current on file</p>
                        </div>
                        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center w-8 h-8 rounded-full bg-white border border-gray-200 shadow-sm z-10">
                          <span className="material-symbols-outlined text-blue-600 text-[18px]">double_arrow</span>
                        </div>
                        <div className="flex-1 w-0 pl-4 text-right">
                          <p className="text-[11px] text-blue-600 uppercase tracking-wider mb-1 truncate">Temporary Dest.</p>
                          <p className="text-sm text-blue-700 font-medium truncate">{formatChangeValue(addressEntry[1], 'address')}</p>
                        </div>
                      </div>
                    ) : otherEntries.length > 0 ? (
                      <div className="flex flex-wrap gap-2 bg-gray-50 p-3 rounded-lg border border-gray-100">
                        {otherEntries.map(([key, value]) => (
                          <span key={key} className="text-xs bg-white border border-gray-200 rounded px-2 py-1">
                            <span className="text-gray-500 capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}:</span>{' '}
                            <span className="font-medium text-gray-900">{formatChangeValue(value, key)}</span>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-gray-50 p-3 rounded-lg border border-gray-100 text-sm text-gray-400">No field changes recorded</div>
                    )}

                    <div className="flex justify-between items-center mt-4 pt-3 border-t border-gray-100">
                      <div className="flex items-center gap-1.5 text-gray-500">
                        <span className="material-symbols-outlined text-[16px]">event</span>
                        <span className="text-xs font-medium">
                          {fmtRange(featuredInstance.scheduledDate)}
                          {featuredInstance.endDate && featuredInstance.endDate !== featuredInstance.scheduledDate ? ` - ${fmtRange(featuredInstance.endDate)}` : ''}
                        </span>
                      </div>
                      <span className={`material-symbols-outlined text-gray-400 transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`}>
                        expand_more
                      </span>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="bg-gray-50 border-t border-gray-100 p-4">
                      <h4 className="text-xs text-gray-500 uppercase mb-3 tracking-wider flex items-center gap-2">
                        <span className="material-symbols-outlined text-[16px]">calendar_month</span>
                        Affected Deliveries ({group.instances.length})
                      </h4>
                      <ul className="space-y-2">
                        {group.instances.map((instance) => (
                          <li key={instance._id} className="flex justify-between items-center bg-white px-3 py-2.5 rounded-lg border border-gray-200">
                            <div className="flex items-center gap-3 min-w-0">
                              <span className="material-symbols-outlined text-[20px] text-gray-400">local_shipping</span>
                              <div className="min-w-0">
                                <span className="text-sm text-gray-900 block">
                                  {new Date(instance.scheduledDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                </span>
                                {instance.reason && <span className="text-[11px] text-gray-400 capitalize block truncate">{instance.reason}</span>}
                              </div>
                            </div>
                            <span className={`flex-shrink-0 text-[11px] font-semibold px-2.5 py-1 rounded-full border capitalize ${instanceStatusPill[instance.status] || instanceStatusPill.pending}`}>
                              {instance.status}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </article>
              );
            })}

            {visibleGroups.length === 0 && !isLoading && (
              <div className="text-center py-16 bg-white border border-gray-200 rounded-xl">
                <FileText className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                <p className="text-gray-600 font-medium">No delivery changes found</p>
                <p className="text-gray-500 text-sm mt-1">
                  {changes.length === 0 ? 'Add manual changes to get started' : 'Try a different status filter'}
                </p>
              </div>
            )}

            {isLoading && (
              <div className="text-center py-16 bg-white border border-gray-200 rounded-xl">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
                <p className="text-gray-600 mt-4">Loading changes...</p>
              </div>
            )}

            {error && (
              <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg font-medium text-sm">
                {error}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="hidden lg:flex bg-white rounded-lg border border-gray-200 p-3 flex-col lg:flex-row gap-3 lg:items-center">
        <div className="relative flex-1 max-w-md">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[20px]">search</span>
          <input
            type="text"
            value={filters.customerId}
            onChange={(e) => setFilters({ ...filters, customerId: e.target.value })}
            placeholder="Search Customer Name or ID..."
            className="w-full pl-10 pr-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <div className="flex flex-wrap gap-3 items-center">
          <input
            type="date"
            value={filters.startDate}
            onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <input
            type="date"
            value={filters.endDate}
            onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />

          <div className="flex bg-gray-100 border border-gray-200 rounded-lg p-1">
            {[
              { key: '', label: 'All' },
              { key: 'active', label: 'Active' },
              { key: 'upcoming', label: 'Upcoming' },
              { key: 'completed', label: 'Completed' }
            ].map((opt) => (
              <button
                key={opt.key || 'all'}
                onClick={() => setDateStatusFilter(opt.key)}
                className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                  dateStatusFilter === opt.key ? 'bg-white shadow-sm text-gray-900 border border-gray-200' : 'text-gray-500 hover:text-gray-800'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            onClick={loadChanges}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity whitespace-nowrap"
          >
            Apply Filters
          </button>
        </div>
      </div>

      {/* Changes List */}
      <div className="hidden lg:flex flex-col gap-3">
        {visibleGroups.map((group) => {
          const featured = getFeaturedInstance(group);
          const featuredInstance = featured.instance;
          const groupStatus = featured.status;
          const changeEntries = Object.entries(featuredInstance.changes || {});
          const addressEntry = changeEntries.find(([key]) => key === 'address');
          const otherEntries = changeEntries.filter(([key]) => key !== 'address');

          return (
            <div
              key={group.key}
              onClick={() => openSlideOut(group)}
              className="bg-white border border-gray-200 rounded-lg p-4 sm:p-5 hover:border-blue-300 transition-colors cursor-pointer group flex flex-col lg:flex-row gap-4 lg:items-center relative overflow-hidden"
            >
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-600 opacity-0 group-hover:opacity-100 transition-opacity" />

              <div className="flex-1 min-w-[180px]">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="font-semibold text-gray-900">{group.customerName}</span>
                  <span className="font-mono text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">{group.customerId}</span>
                  {group.instances.length > 1 && (
                    <span className="text-xs text-gray-400">{group.instances.length} requests</span>
                  )}
                </div>
                {featuredInstance.reason && <div className="text-sm text-gray-500 capitalize">{featuredInstance.reason}</div>}
              </div>

              <div className="flex-[2] flex flex-col sm:flex-row items-center gap-3 w-full lg:w-auto bg-gray-50 p-3 rounded-lg border border-gray-100">
                {addressEntry ? (
                  <>
                    <div className="flex-1 min-w-0 w-full">
                      <div className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                        <span className="material-symbols-outlined text-[14px]">location_on</span> Original Route
                      </div>
                      <div className="text-sm text-gray-500 italic">Current address on file</div>
                    </div>
                    <div className="text-blue-600 flex-shrink-0">
                      <span className="material-symbols-outlined">arrow_forward</span>
                    </div>
                    <div className="flex-1 min-w-0 w-full">
                      <div className="text-xs text-blue-600 mb-1 flex items-center gap-1">
                        <span className="material-symbols-outlined text-[14px]">share_location</span> Temporary Route
                      </div>
                      <div className="text-sm font-medium text-gray-900">{formatChangeValue(addressEntry[1], 'address')}</div>
                    </div>
                  </>
                ) : otherEntries.length > 0 ? (
                  <div className="flex-1 flex flex-wrap gap-2">
                    {otherEntries.map(([key, value]) => (
                      <span key={key} className="text-xs bg-white border border-gray-200 rounded px-2 py-1">
                        <span className="text-gray-500 capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}:</span>{' '}
                        <span className="font-medium text-gray-900">{formatChangeValue(value, key)}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-sm text-gray-400">No field changes recorded</span>
                )}
              </div>

              <div className="flex flex-row lg:flex-col justify-between items-center lg:items-end w-full lg:w-auto gap-3 min-w-[150px]">
                <div className="text-right">
                  <div className="text-xs text-gray-500 mb-1">{groupStatus.label === 'Upcoming' ? 'Next Date' : 'Date'}</div>
                  <div className="font-mono text-sm text-gray-900 whitespace-nowrap">
                    {new Date(featuredInstance.scheduledDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </div>
                </div>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border ${groupStatus.cls}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${groupStatus.dot}`} />
                  {groupStatus.label}
                </span>
              </div>
            </div>
          );
        })}

        {visibleGroups.length === 0 && !isLoading && (
          <div className="text-center py-16 bg-white border border-gray-200 rounded-lg">
            <FileText className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-600 font-medium">No delivery changes found</p>
            <p className="text-gray-500 text-sm mt-1">
              {changes.length === 0 ? 'Add manual changes or upload a CSV file to get started' : 'Try a different status filter'}
            </p>
          </div>
        )}

        {isLoading && (
          <div className="text-center py-16 bg-white border border-gray-200 rounded-lg">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
            <p className="text-gray-600 mt-4">Loading changes...</p>
          </div>
        )}
      </div>

      {error && (
        <div className="hidden lg:block p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg font-medium">
          {error}
        </div>
      )}
      </div>

      {/* Slide-out Detail Panel (desktop) */}
      <AnimatePresence>
        {selectedGroup && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
              onClick={closeSlideOut}
            />
            <motion.aside
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'tween', duration: 0.25 }}
              className="fixed right-0 top-0 h-full w-full sm:w-[450px] bg-white shadow-xl z-50 flex flex-col border-l border-gray-200"
            >
              <div className="p-5 border-b border-gray-100 flex justify-between items-start bg-gray-50 flex-shrink-0">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 mb-1">Change Details</h2>
                  <div className="flex items-center gap-2 text-sm text-gray-500 flex-wrap">
                    <span>{selectedGroup.customerName}</span>
                    <span className="w-1 h-1 rounded-full bg-gray-300" />
                    <span className="font-mono text-xs">{selectedGroup.customerId}</span>
                  </div>
                </div>
                <button onClick={closeSlideOut} className="text-gray-400 hover:text-gray-700 transition-colors p-1 rounded hover:bg-gray-100 flex-shrink-0">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-5 bg-white">
                <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <span className="material-symbols-outlined text-gray-400 text-[20px]">event_note</span>
                  Requests ({selectedGroup.instances.length})
                </h3>
                <div className="space-y-3">
                  {selectedGroup.instances.map((instance) => {
                    const instanceDateStatus = getDateStatus(instance);
                    const dt = new Date(instance.scheduledDate);
                    const instanceChangeEntries = Object.entries(instance.changes || {});
                    return (
                      <div key={instance._id} className="p-3 bg-gray-50 border border-gray-100 rounded-lg">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-10 h-10 rounded bg-white flex flex-col items-center justify-center border border-gray-200 flex-shrink-0">
                              <span className="text-[10px] uppercase text-gray-500 leading-none">{dt.toLocaleDateString('en-US', { month: 'short' })}</span>
                              <span className="font-bold text-gray-900 leading-none mt-0.5">{dt.getDate()}</span>
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className={`w-1.5 h-1.5 rounded-full ${instanceDateStatus.dot}`} />
                                <span className="text-sm font-medium text-gray-900">{instanceDateStatus.label}</span>
                              </div>
                              {getStatusBadge(instance.status)}
                            </div>
                          </div>
                          {instance.status === 'pending' && (
                            <button
                              onClick={() => handleApplyChange(instance._id)}
                              className="flex-shrink-0 px-3 py-1 bg-blue-100 text-blue-600 rounded hover:bg-blue-200 font-medium transition-colors text-xs"
                            >
                              Apply
                            </button>
                          )}
                        </div>
                        <div className="space-y-1.5">
                          {instanceChangeEntries.map(([key, value]) => (
                            <div key={key} className="text-xs bg-white p-2 rounded border border-gray-200">
                              <span className="font-medium text-gray-700 capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}:</span>{' '}
                              <span className="text-gray-900 break-words">{formatChangeValue(value, key)}</span>
                            </div>
                          ))}
                          {instanceChangeEntries.length === 0 && (
                            <p className="text-xs text-gray-400">No field changes recorded</p>
                          )}
                        </div>
                        {instance.reason && (
                          <p className="text-xs text-gray-500 mt-2 capitalize">
                            <span className="font-medium">Reason:</span> {instance.reason}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="p-4 border-t border-gray-100 bg-white flex justify-end gap-3 flex-shrink-0">
                <button onClick={closeSlideOut} className="px-4 py-2 bg-white border border-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors">
                  Close
                </button>
                {selectedGroup.instances.some((instance) => instance.status === 'pending') && (
                  <button
                    onClick={async () => {
                      const pending = selectedGroup.instances.filter((instance) => instance.status === 'pending');
                      for (const instance of pending) {
                        // eslint-disable-next-line no-await-in-loop
                        await handleApplyChange(instance._id);
                      }
                      closeSlideOut();
                    }}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity"
                  >
                    Apply All Pending
                  </button>
                )}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  );
};

export default DeliveryChanges;
