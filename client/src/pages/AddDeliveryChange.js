import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { createDeliveryChange } from '../store/slices/deliveryChangeSlice';
import api from '../utils/api';
import { recordActivityChange } from '../utils/activityCapture';

const dateLabel = date => date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : '';

const AddDeliveryChange = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const [manualForm, setManualForm] = useState({
    customerId: '',
    customerName: '',
    scheduledDate: '',
    endDate: '',
    address: '',
    zone: '',
    scheduledTime: '',
    notes: '',
    reason: 'address change' // 'address change' or 'timing change'
  });

  const [dateRange, setDateRange] = useState({ from: undefined, to: undefined });
  const [selectionMode, setSelectionMode] = useState('range'); // 'range' | 'multiple'
  const [selectedDates, setSelectedDates] = useState([]); // for multiple-date selection
  const changeDateRange = next => {
    const labels = range => [range?.from, range?.to].filter(Boolean).map(dateLabel);
    recordActivityChange({ field: 'Delivery date range', form: 'Add delivery change', before: labels(dateRange), after: labels(next) });
    setDateRange(next);
  };
  const changeDates = next => {
    recordActivityChange({ field: 'Delivery dates', form: 'Add delivery change', before: selectedDates.map(dateLabel).sort(), after: (next || []).map(dateLabel).sort() });
    setSelectedDates(next || []);
  };
  const changeSelectionMode = next => {
    recordActivityChange({ field: 'Date selection mode', form: 'Add delivery change', before: selectionMode, after: next });
    setSelectionMode(next);
  };

  // Customer registry search for Section 1
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false);
  const [manualCustomerEntry, setManualCustomerEntry] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (manualCustomerEntry) return;
    const term = customerSearch.trim();
    if (term.length < 2) {
      setCustomerResults([]);
      return;
    }
    let active = true;
    setCustomerSearchLoading(true);
    const handle = setTimeout(() => {
      api.get('/customers', { params: { search: term, limit: 8 } })
        .then((res) => { if (active) setCustomerResults(res.data?.data || []); })
        .catch(() => { if (active) setCustomerResults([]); })
        .finally(() => { if (active) setCustomerSearchLoading(false); });
    }, 300);
    return () => { active = false; clearTimeout(handle); };
  }, [customerSearch, manualCustomerEntry]);

  const handleSelectCustomer = (customer) => {
    recordActivityChange({ field: 'Customer', form: 'Add delivery change', before: manualForm.customerName || 'Not selected', after: `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || customer.customerId || 'Customer' });
    setManualForm((prev) => ({
      ...prev,
      customerId: customer.customerId || prev.customerId,
      customerName: `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || customer.customerId || prev.customerName
    }));
    setCustomerSearch('');
    setCustomerResults([]);
  };

  const handleClearCustomer = () => {
    recordActivityChange({ field: 'Customer', form: 'Add delivery change', before: manualForm.customerName || 'Not selected', after: 'Not selected' });
    setManualForm((prev) => ({ ...prev, customerId: '', customerName: '' }));
  };

  // Keep dateRange and manualForm in sync
  useEffect(() => {
    if (selectionMode !== 'range') return;
    if (!dateRange || !dateRange.from) return;
    const fmt = (d) => (d ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10) : '');
    const startDate = fmt(dateRange.from);
    const endDate = dateRange.to ? fmt(dateRange.to) : startDate; // If no end date, use start date
    setManualForm((prev) => ({
      ...prev,
      scheduledDate: startDate,
      endDate: endDate
    }));
  }, [dateRange, selectionMode]);

  // Sync manualForm when multiple dates are selected: set to earliest date for validation/display
  useEffect(() => {
    if (selectionMode !== 'multiple') return;
    if (!Array.isArray(selectedDates) || selectedDates.length === 0) {
      setManualForm((prev) => ({ ...prev, scheduledDate: '', endDate: '' }));
      return;
    }
    const sorted = [...selectedDates].sort((a, b) => a - b);
    const first = sorted[0];
    const fmt = (d) => (d ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10) : '');
    const firstStr = fmt(first);
    setManualForm((prev) => ({ ...prev, scheduledDate: firstStr, endDate: firstStr }));
  }, [selectedDates, selectionMode]);

  const handleManualFormChange = (e) => {
    const { name, value } = e.target;
    setManualForm(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleManualSubmit = async (e) => {
    e.preventDefault();

    if (!manualForm.customerId?.trim()) {
      alert('Please enter Customer ID');
      return;
    }
    if (!manualForm.customerName?.trim()) {
      alert('Please enter Customer Name');
      return;
    }
    if (!manualForm.scheduledDate) {
      alert('Please select a schedule date');
      return;
    }

    setIsSubmitting(true);
    try {
      const baseChanges = {};
      if (manualForm.address) baseChanges.address = manualForm.address;
      if (manualForm.zone) baseChanges.zone = manualForm.zone;
      if (manualForm.scheduledTime) baseChanges.scheduledTime = manualForm.scheduledTime;
      if (manualForm.notes) baseChanges.notes = manualForm.notes;

      const fmt = (d) => (d ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10) : '');

      if (selectionMode === 'multiple' && Array.isArray(selectedDates) && selectedDates.length > 0) {
        const sorted = [...selectedDates].sort((a, b) => a - b);
        for (const d of sorted) {
          const dateStr = fmt(d);
          const changeData = {
            customerId: manualForm.customerId,
            customerName: manualForm.customerName,
            scheduledDate: dateStr,
            endDate: dateStr,
            changes: { ...baseChanges },
            reason: manualForm.reason
          };
          // eslint-disable-next-line no-await-in-loop
          await dispatch(createDeliveryChange(changeData)).unwrap();
        }
      } else {
        const changeData = {
          customerId: manualForm.customerId,
          customerName: manualForm.customerName,
          scheduledDate: manualForm.scheduledDate,
          endDate: manualForm.endDate || manualForm.scheduledDate,
          changes: { ...baseChanges },
          reason: manualForm.reason
        };
        await dispatch(createDeliveryChange(changeData)).unwrap();
      }

      alert('Delivery change created successfully!');
      navigate('/delivery-changes');
    } catch (error) {
      console.error('Failed to create manual change:', error);
      alert(error.response?.data?.message || 'Failed to create delivery change');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="matter-analytics p-3 sm:p-6 max-w-5xl mx-auto w-full pb-28 lg:pb-6">
      {/* Desktop header */}
      <div className="hidden lg:flex mb-4 sm:mb-6 items-center justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Add Delivery Change</h1>
          <p className="text-sm text-gray-500 mt-1 hidden sm:block">Submit a modification request for an existing scheduled delivery.</p>
        </div>
        <button
          onClick={() => navigate('/delivery-changes')}
          className="flex items-center gap-1.5 px-3 py-2 text-gray-500 hover:text-gray-800 transition-colors"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
          Cancel
        </button>
      </div>

      {/* Mobile header */}
      <div className="lg:hidden mb-6 flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate('/delivery-changes')}
          className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors flex-shrink-0"
        >
          <span className="material-symbols-outlined text-gray-700">arrow_back</span>
        </button>
        <h1 className="text-xl font-semibold text-gray-900">Add Delivery Change</h1>
      </div>

      <form id="add-delivery-change-form" onSubmit={handleManualSubmit}>
        {/* Hidden required inputs to allow browser validation */}
        <input type="hidden" name="scheduledDate" value={manualForm.scheduledDate || ''} required />
        <input type="hidden" name="customerIdHidden" value={manualForm.customerId || ''} required />
        <input type="hidden" name="customerNameHidden" value={manualForm.customerName || ''} required />

      {/* Desktop layout */}
      <div className="hidden lg:block bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        {/* Section 1: Select Customer */}
        <div className="p-5 border-b border-gray-100">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-7 h-7 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs font-bold flex-shrink-0">1</div>
            <h3 className="text-base font-semibold text-gray-900">Select Customer</h3>
          </div>

          {manualForm.customerId && manualForm.customerName && !manualCustomerEntry ? (
            <div className="max-w-xl p-3 border-2 border-blue-200 bg-blue-50/50 rounded-lg flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded bg-white flex items-center justify-center text-blue-600 font-semibold border border-gray-200 flex-shrink-0">
                  {manualForm.customerName.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">{manualForm.customerName}</div>
                  <div className="font-mono text-xs text-gray-500">{manualForm.customerId}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button type="button" onClick={handleClearCustomer} className="text-xs font-medium text-blue-600 hover:underline">Change</button>
                <span className="material-symbols-outlined text-blue-600">check_circle</span>
              </div>
            </div>
          ) : manualCustomerEntry ? (
            <div className="max-w-xl grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Customer ID *</label>
                <div className="flex items-center">
                  <span className="px-3 py-2 bg-gray-100 border border-gray-300 rounded-l-lg text-gray-600 text-sm">CUST-</span>
                  <input
                    type="text"
                    value={(manualForm.customerId || '').replace(/^CUST-?/i, '')}
                    onChange={(e) => setManualForm((prev) => ({ ...prev, customerId: `CUST-${(e.target.value || '').replace(/\D+/g, '')}` }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-r-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="001"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Customer Name *</label>
                <input
                  type="text"
                  value={manualForm.customerName}
                  onChange={(e) => setManualForm((prev) => ({ ...prev, customerName: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="John Doe"
                />
              </div>
              <div className="md:col-span-2">
                <button type="button" onClick={() => setManualCustomerEntry(false)} className="text-xs font-medium text-blue-600 hover:underline">
                  Search the customer registry instead
                </button>
              </div>
            </div>
          ) : (
            <div className="max-w-xl">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Search Registry</label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[20px]">search</span>
                <input
                  type="text"
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Enter customer name, ID, or email..."
                  autoComplete="off"
                  className="w-full pl-10 pr-4 py-2 bg-white border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              {customerSearchLoading && <p className="text-xs text-gray-400 mt-2">Searching…</p>}
              {!customerSearchLoading && customerResults.length > 0 && (
                <div className="mt-2 border border-gray-200 rounded-lg divide-y divide-gray-100 overflow-hidden">
                  {customerResults.map((customer) => (
                    <button
                      type="button"
                      key={customer._id || customer.customerId}
                      onClick={() => handleSelectCustomer(customer)}
                      className="w-full flex items-center gap-3 p-3 text-left hover:bg-gray-50 transition-colors"
                    >
                      <div className="w-9 h-9 rounded bg-gray-100 flex items-center justify-center text-gray-600 text-xs font-semibold flex-shrink-0">
                        {(customer.firstName || customer.customerId || '?').slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">{customer.firstName} {customer.lastName}</div>
                        <div className="text-xs text-gray-500 font-mono">{customer.customerId} {customer.company ? `· ${customer.company}` : ''}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {!customerSearchLoading && customerSearch.trim().length >= 2 && customerResults.length === 0 && (
                <p className="text-xs text-gray-400 mt-2">No matching customers found.</p>
              )}
              <button type="button" onClick={() => setManualCustomerEntry(true)} className="text-xs font-medium text-blue-600 hover:underline mt-2 inline-block">
                Can't find them? Enter manually
              </button>
            </div>
          )}
        </div>

        {/* Section 2: Choose Dates */}
        <div className="p-5 border-b border-gray-100 bg-gray-50/50">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-7 h-7 rounded-full bg-gray-200 text-gray-600 flex items-center justify-center text-xs font-bold flex-shrink-0">2</div>
            <h3 className="text-base font-semibold text-gray-900">Choose Dates</h3>
          </div>

          <div className="inline-flex p-1 bg-gray-100 rounded-lg mb-4 border border-gray-200">
            <button
              type="button"
              onClick={() => changeSelectionMode('multiple')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${selectionMode === 'multiple' ? 'bg-white shadow-sm border border-gray-200 text-gray-900' : 'text-gray-500 hover:text-gray-800'}`}
            >
              Select Dates
            </button>
            <button
              type="button"
              onClick={() => changeSelectionMode('range')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${selectionMode === 'range' ? 'bg-white shadow-sm border border-gray-200 text-gray-900' : 'text-gray-500 hover:text-gray-800'}`}
            >
              Date Range
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white border border-gray-200 rounded-lg p-3 flex justify-center">
              {selectionMode === 'range' ? (
                <DayPicker mode="range" selected={dateRange} onSelect={changeDateRange} numberOfMonths={1} weekStartsOn={1} showOutsideDays />
              ) : (
                <DayPicker mode="multiple" selected={selectedDates} onSelect={changeDates} numberOfMonths={1} weekStartsOn={1} showOutsideDays />
              )}
            </div>
            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium text-gray-700">
                {selectionMode === 'multiple' ? `Selected Dates (${selectedDates.length})` : 'Selected Range'}
              </label>
              {selectionMode === 'multiple' ? (
                Array.isArray(selectedDates) && selectedDates.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {[...selectedDates].sort((a, b) => a - b).map((d) => (
                      <span key={d.toISOString()} className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-50 border border-blue-200 rounded-full text-blue-700 text-xs font-mono">
                        {d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}
                        <button type="button" onClick={() => changeDates(selectedDates.filter((x) => x.getTime() !== d.getTime()))} className="hover:text-blue-900">
                          <span className="material-symbols-outlined text-[14px]">close</span>
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">No dates selected</p>
                )
              ) : dateRange?.from ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center px-3 py-1 bg-blue-50 border border-blue-200 rounded-full text-blue-700 text-xs font-mono">
                    {manualForm.scheduledDate}
                  </span>
                  {manualForm.endDate && manualForm.endDate !== manualForm.scheduledDate && (
                    <>
                      <span className="text-gray-400">→</span>
                      <span className="inline-flex items-center px-3 py-1 bg-blue-50 border border-blue-200 rounded-full text-blue-700 text-xs font-mono">
                        {manualForm.endDate}
                      </span>
                    </>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-400">No date selected</p>
              )}
              <p className="text-xs text-gray-500 mt-auto">
                {selectionMode === 'multiple'
                  ? 'Click dates on the calendar to add or remove them from your delivery schedule.'
                  : 'Click a start date, then an end date, to select a continuous range.'}
              </p>
            </div>
          </div>
        </div>

        {/* Section 3: New Delivery Info */}
        <div className="p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-7 h-7 rounded-full bg-gray-200 text-gray-600 flex items-center justify-center text-xs font-bold flex-shrink-0">3</div>
            <h3 className="text-base font-semibold text-gray-900">New Delivery Info</h3>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">New Destination Address</label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[20px]">location_on</span>
                <input
                  type="text"
                  name="address"
                  value={manualForm.address}
                  onChange={handleManualFormChange}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="e.g., 123 Industrial Pkwy, Suite 400... (leave blank if unchanged)"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Zone</label>
              <input
                type="text"
                name="zone"
                value={manualForm.zone}
                onChange={handleManualFormChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Enter zone (optional)"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">New Scheduled Time</label>
              <input
                type="time"
                name="scheduledTime"
                value={manualForm.scheduledTime}
                onChange={handleManualFormChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Reason for Change *</label>
              <select
                name="reason"
                value={manualForm.reason}
                onChange={handleManualFormChange}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="address change">Address Change</option>
                <option value="timing change">Timing Change</option>
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Additional Notes &amp; Instructions</label>
              <textarea
                name="notes"
                value={manualForm.notes}
                onChange={handleManualFormChange}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y"
                placeholder="Gate codes, specific dock approach instructions, contact person on site..."
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-5 bg-gray-50 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => navigate('/delivery-changes')}
            className="w-full sm:w-auto px-5 py-2 rounded-lg bg-white border border-gray-200 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <span className="material-symbols-outlined text-[18px]">save</span>
            {isSubmitting ? 'Saving…' : 'Save Change Request'}
          </button>
        </div>
      </div>

      {/* Mobile layout */}
      <div className="lg:hidden space-y-5">
        {/* Section 1: Select Customer */}
        <section className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h2 className="text-base font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <span className="material-symbols-outlined text-blue-600 text-[20px]">person_search</span>
            1. Select Customer
          </h2>

          {manualForm.customerId && manualForm.customerName && !manualCustomerEntry ? (
            <div className="p-4 border-2 border-blue-200 bg-blue-50/50 rounded-lg flex gap-3 items-start relative">
              <div className="absolute top-2 right-2">
                <span className="material-symbols-outlined text-blue-600 text-[20px]">check_circle</span>
              </div>
              <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-semibold flex-shrink-0">
                {manualForm.customerName.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-base font-semibold text-gray-900 leading-tight">{manualForm.customerName}</p>
                <p className="font-mono text-xs text-gray-500 mt-1">ID: {manualForm.customerId}</p>
                <button type="button" onClick={handleClearCustomer} className="text-xs font-medium text-blue-600 hover:underline mt-2 inline-block">Change</button>
              </div>
            </div>
          ) : manualCustomerEntry ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Customer ID *</label>
                <div className="flex items-center">
                  <span className="h-12 flex items-center px-3 bg-gray-100 border border-gray-300 rounded-l-lg text-gray-600 text-sm">CUST-</span>
                  <input
                    type="text"
                    value={(manualForm.customerId || '').replace(/^CUST-?/i, '')}
                    onChange={(e) => setManualForm((prev) => ({ ...prev, customerId: `CUST-${(e.target.value || '').replace(/\D+/g, '')}` }))}
                    className="w-full h-12 px-3 border border-gray-300 rounded-r-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="001"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Customer Name *</label>
                <input
                  type="text"
                  value={manualForm.customerName}
                  onChange={(e) => setManualForm((prev) => ({ ...prev, customerName: e.target.value }))}
                  className="w-full h-12 px-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="John Doe"
                />
              </div>
              <button type="button" onClick={() => setManualCustomerEntry(false)} className="text-xs font-medium text-blue-600 hover:underline">
                Search the customer registry instead
              </button>
            </div>
          ) : (
            <div>
              <div className="relative mb-4">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[20px]">search</span>
                <input
                  type="text"
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Search Customer ID or Name"
                  autoComplete="off"
                  className="w-full h-12 pl-10 pr-4 rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
              </div>
              {customerSearchLoading && <p className="text-xs text-gray-400">Searching…</p>}
              {!customerSearchLoading && customerResults.length > 0 && (
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 overflow-hidden">
                  {customerResults.map((customer) => (
                    <button
                      type="button"
                      key={customer._id || customer.customerId}
                      onClick={() => handleSelectCustomer(customer)}
                      className="w-full flex items-center gap-3 p-3 text-left hover:bg-gray-50 transition-colors"
                    >
                      <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 text-xs font-semibold flex-shrink-0">
                        {(customer.firstName || customer.customerId || '?').slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">{customer.firstName} {customer.lastName}</div>
                        <div className="text-xs text-gray-500 font-mono">{customer.customerId} {customer.company ? `· ${customer.company}` : ''}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {!customerSearchLoading && customerSearch.trim().length >= 2 && customerResults.length === 0 && (
                <p className="text-xs text-gray-400">No matching customers found.</p>
              )}
              <button type="button" onClick={() => setManualCustomerEntry(true)} className="text-xs font-medium text-blue-600 hover:underline mt-3 inline-block">
                Can't find them? Enter manually
              </button>
            </div>
          )}
        </section>

        {/* Section 2: Choose Dates */}
        <section className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h2 className="text-base font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <span className="material-symbols-outlined text-blue-600 text-[20px]">calendar_month</span>
            2. Choose Dates
          </h2>

          <div className="inline-flex p-1 bg-gray-100 rounded-lg mb-4 border border-gray-200">
            <button
              type="button"
              onClick={() => changeSelectionMode('multiple')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${selectionMode === 'multiple' ? 'bg-white shadow-sm border border-gray-200 text-gray-900' : 'text-gray-500'}`}
            >
              Select Dates
            </button>
            <button
              type="button"
              onClick={() => changeSelectionMode('range')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${selectionMode === 'range' ? 'bg-white shadow-sm border border-gray-200 text-gray-900' : 'text-gray-500'}`}
            >
              Date Range
            </button>
          </div>

          <p className="text-sm text-gray-500 mb-4">
            {selectionMode === 'multiple'
              ? 'Select all non-sequential dates for this change request.'
              : 'Tap a start date, then an end date, to select a range.'}
          </p>

          <div className="border border-gray-200 rounded-lg p-3 flex justify-center mb-4">
            {selectionMode === 'range' ? (
              <DayPicker mode="range" selected={dateRange} onSelect={changeDateRange} numberOfMonths={1} weekStartsOn={1} showOutsideDays />
            ) : (
              <DayPicker mode="multiple" selected={selectedDates} onSelect={changeDates} numberOfMonths={1} weekStartsOn={1} showOutsideDays />
            )}
          </div>

          <div className="pt-3 border-t border-gray-200">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Selected Dates</p>
            {selectionMode === 'multiple' ? (
              Array.isArray(selectedDates) && selectedDates.length > 0 ? (
                <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
                  {[...selectedDates].sort((a, b) => a - b).map((d) => (
                    <div key={d.toISOString()} className="flex items-center gap-1.5 bg-blue-50 text-blue-700 px-3 py-1.5 rounded-full border border-blue-200 whitespace-nowrap flex-shrink-0">
                      <span className="text-xs font-mono">{d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}</span>
                      <button type="button" onClick={() => changeDates(selectedDates.filter((x) => x.getTime() !== d.getTime()))} className="hover:text-blue-900">
                        <span className="material-symbols-outlined text-[16px]">close</span>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-400">No dates selected</p>
              )
            ) : dateRange?.from ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-full text-blue-700 text-xs font-mono">
                  {manualForm.scheduledDate}
                </span>
                {manualForm.endDate && manualForm.endDate !== manualForm.scheduledDate && (
                  <>
                    <span className="text-gray-400">→</span>
                    <span className="inline-flex items-center px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-full text-blue-700 text-xs font-mono">
                      {manualForm.endDate}
                    </span>
                  </>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-400">No date selected</p>
            )}
          </div>
        </section>

        {/* Section 3: New Delivery Info */}
        <section className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h2 className="text-base font-semibold text-gray-900 mb-5 flex items-center gap-2">
            <span className="material-symbols-outlined text-blue-600 text-[20px]">edit_document</span>
            3. New Delivery Info
          </h2>

          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Destination Address</label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[20px]">location_on</span>
                <input
                  type="text"
                  name="address"
                  value={manualForm.address}
                  onChange={handleManualFormChange}
                  className="w-full h-12 pl-10 pr-4 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Leave blank if unchanged"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Zone</label>
              <input
                type="text"
                name="zone"
                value={manualForm.zone}
                onChange={handleManualFormChange}
                className="w-full h-12 px-4 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Enter zone (optional)"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">New Scheduled Time</label>
              <input
                type="time"
                name="scheduledTime"
                value={manualForm.scheduledTime}
                onChange={handleManualFormChange}
                className="w-full h-12 px-4 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Reason for Change *</label>
              <div className="relative">
                <select
                  name="reason"
                  value={manualForm.reason}
                  onChange={handleManualFormChange}
                  required
                  className="w-full h-12 pl-4 pr-10 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 appearance-none"
                >
                  <option value="address change">Address Change</option>
                  <option value="timing change">Timing Change</option>
                </select>
                <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-[20px] pointer-events-none">expand_more</span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Additional Notes</label>
              <textarea
                name="notes"
                value={manualForm.notes}
                onChange={handleManualFormChange}
                rows={3}
                className="w-full p-4 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                placeholder="Enter gate codes, specific contact instructions, etc."
              />
            </div>
          </div>
        </section>
      </div>
      </form>

      {/* Mobile fixed bottom actions */}
      <div className="lg:hidden fixed bottom-0 left-0 w-full bg-white border-t border-gray-200 p-4 z-40 shadow-[0_-4px_12px_rgba(0,0,0,0.05)]">
        <div className="flex gap-3 max-w-md mx-auto">
          <button
            type="button"
            onClick={() => navigate('/delivery-changes')}
            className="flex-1 h-12 rounded-full border border-gray-200 bg-white text-gray-700 text-sm font-semibold hover:bg-gray-50 transition-colors active:scale-[0.98]"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="add-delivery-change-form"
            disabled={isSubmitting}
            className="flex-[2] h-12 rounded-full bg-blue-600 text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50 shadow-md transition-opacity active:scale-[0.98] flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-[18px]">save</span>
            {isSubmitting ? 'Saving…' : 'Save Change Request'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddDeliveryChange;
