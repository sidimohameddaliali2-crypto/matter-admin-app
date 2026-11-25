import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Package, RefreshCw, Truck, CheckCircle2 } from 'lucide-react';
import api from '../../utils/api';
import { recordActivityChange } from '../../utils/activityCapture';
import YellowblockBulkAssignment from './YellowblockBulkAssignment';

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const monthLabel = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});
const shortDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const asDate = (key) => new Date(`${key}T00:00:00Z`);
const asKey = (date) => date.toISOString().slice(0, 10);
const deliveryCount = (count) => `${count} ${count === 1 ? 'delivery' : 'deliveries'}`;

function getMonthDays(month) {
  const firstDay = asDate(`${month}-01`);
  const year = firstDay.getUTCFullYear();
  const monthIndex = firstDay.getUTCMonth();
  const leadingDays = (firstDay.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const cells = Math.ceil((leadingDays + daysInMonth) / 7) * 7;

  return Array.from({ length: cells }, (_, index) => {
    const day = index - leadingDays + 1;
    return day > 0 && day <= daysInMonth ? asKey(new Date(Date.UTC(year, monthIndex, day))) : null;
  });
}

export default function YellowblockDeliveryCalendar({ onViewOrder, allowAssignment = false }) {
  const [schedule, setSchedule] = useState(null);
  const [month, setMonth] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checkedIds, setCheckedIds] = useState(() => new Set());
  const [showAssignment, setShowAssignment] = useState(false);
  const [assignmentNotice, setAssignmentNotice] = useState('');
  const requestRef = useRef(null);
  const ordersRef = useRef(null);

  const ordersByDate = useMemo(() => {
    const byDate = new Map();
    for (const order of schedule?.deliveries || []) {
      if (!byDate.has(order.date)) byDate.set(order.date, []);
      byDate.get(order.date).push(order);
    }
    return byDate;
  }, [schedule]);

  const loadSchedule = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const { data: { data: nextSchedule } } = await api.get('/yellowblock/delivery-schedule', { signal: controller.signal });
      if (controller.signal.aborted) return;
      const currentMonth = nextSchedule.today.slice(0, 7);
      setSchedule(nextSchedule);
      setMonth(current => current && current >= currentMonth ? current : currentMonth);
      setSelectedDate(current => current && current >= nextSchedule.today ? current : null);
      const available = new Set(nextSchedule.deliveries.map(order => String(order.id)));
      setCheckedIds(current => new Set([...current].filter(id => available.has(id))));
    } catch (requestError) {
      if (!controller.signal.aborted) {
        setError(requestError.response?.data?.message || 'Could not load deliveries from Shopify.');
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSchedule();
    return () => requestRef.current?.abort();
  }, [loadSchedule]);

  const changeMonth = (offset) => {
    const firstDay = asDate(`${month}-01`);
    firstDay.setUTCMonth(firstDay.getUTCMonth() + offset);
    const nextMonth = asKey(firstDay).slice(0, 7);
    recordActivityChange({ field: 'Month', form: 'Yellow Block delivery calendar', before: month, after: nextMonth });
    setMonth(nextMonth);
    setSelectedDate(null);
  };

  const selectDate = (date) => {
    recordActivityChange({ field: 'Delivery date', form: 'Yellow Block delivery calendar', before: visibleDate, after: date });
    setSelectedDate(date);
    ordersRef.current?.scrollIntoView?.({ block: 'nearest' });
  };

  const visibleDate = selectedDate || (month === schedule?.today.slice(0, 7) ? schedule.today : null);
  const selectedOrders = ordersByDate.get(visibleDate) || [];
  const checkedOrders = schedule?.deliveries.filter(order => checkedIds.has(String(order.id))) || [];
  const allForDateChecked = selectedOrders.length > 0 && selectedOrders.every(order => checkedIds.has(String(order.id)));
  const days = month ? getMonthDays(month) : [];
  const upcomingDates = [...ordersByDate.keys()].filter(date => date >= schedule?.today).sort();
  const nextDelivery = upcomingDates[0];
  const endOfWeek = schedule ? asDate(schedule.today) : null;
  if (endOfWeek) endOfWeek.setUTCDate(endOfWeek.getUTCDate() + 7);
  const weekEnd = endOfWeek ? asKey(endOfWeek) : null;
  const dueThisWeek = upcomingDates.reduce((sum, date) => date < weekEnd ? sum + ordersByDate.get(date).length : sum, 0);
  const summary = schedule && [
    { label: 'Due today', value: ordersByDate.get(schedule.today)?.length || 0, Icon: Package, color: 'peach' },
    { label: 'Next 7 days', value: dueThisWeek, Icon: CalendarDays, color: 'lilac' },
    { label: 'Next scheduled delivery', value: nextDelivery ? (nextDelivery === schedule.today ? 'Today' : shortDate.format(asDate(nextDelivery))) : 'None scheduled', Icon: Truck, color: 'yellow' },
  ];

  const setChecked = (orders, checked) => {
    setAssignmentNotice('');
    const next = new Set(checkedIds);
    for (const order of orders) {
      const id = String(order.id);
      if (checked) next.add(id);
      else next.delete(id);
    }
    recordActivityChange({ field: 'Selected orders', form: 'Yellow Block courier assignment', before: [...checkedIds], after: [...next] });
    setCheckedIds(next);
  };

  const handleAssignmentResult = ({ courier, assigned, failed }) => {
    if (assigned.length) {
      const assignedIds = new Set(assigned);
      setCheckedIds(current => new Set([...current].filter(id => !assignedIds.has(id))));
      setAssignmentNotice(`Assigned ${assigned.length} ${assigned.length === 1 ? 'order' : 'orders'} to ${courier}.`);
    }
    if (!failed.length) setShowAssignment(false);
  };

  return (
    <section className="yb-orders mx-auto w-full max-w-7xl">
      <header className="yb-order-hero">
        <div className="yb-order-hero-copy">
          <p className="yb-overline"><CalendarDays size={15} aria-hidden="true" /> Shopify delivery schedule</p>
          <h1>Orders</h1>
          <p>See what’s scheduled and assign orders for delivery.</p>
        </div>
        <div className="yb-order-hero-image">
          <img src="/images/yellowblock-og-board.webp" alt="" width="533" height="711" />
        </div>
      </header>

      {summary && (
        <dl className="yb-order-summary" aria-label="Delivery summary">
          {summary.map(({ label, value, Icon, color }) => (
            <div className="yb-summary-card" key={label}>
              <span className={`yb-summary-icon yb-summary-icon-${color}`}><Icon size={19} aria-hidden="true" /></span>
              <div><dt>{label}</dt><dd>{value}</dd></div>
            </div>
          ))}
        </dl>
      )}

      <div className="yb-calendar-heading">
        <div><h2>Delivery calendar</h2><p><Clock3 size={13} aria-hidden="true" /> Dubai time</p></div>
        <button type="button" onClick={loadSchedule} disabled={loading} className="yb-button yb-button-secondary">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /> Refresh
        </button>
      </div>

      {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}{schedule && ' Showing the last loaded schedule.'}</p>}
      {!schedule && loading && <p role="status" className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-600">Loading deliveries…</p>}

      {allowAssignment && schedule && (
        <div className="yb-panel yb-assignment-bar">
          <div>
            <p aria-live="polite" className="text-sm font-bold">{checkedOrders.length} selected</p>
            <p className="text-xs text-gray-600">{checkedOrders.length > 50 ? 'Select no more than 50 orders at a time.' : 'Select orders from one or more dates.'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {checkedOrders.length > 0 && <button type="button" className="yb-button yb-button-secondary" onClick={() => setChecked(checkedOrders, false)}>Clear</button>}
            <button type="button" className="yb-button yb-button-primary" disabled={!checkedOrders.length || checkedOrders.length > 50 || loading}
              onClick={() => { setAssignmentNotice(''); setShowAssignment(true); }}>
              <Truck size={16} aria-hidden="true" /> Assign selected
            </button>
          </div>
        </div>
      )}
      {assignmentNotice && <p role="status" className="yb-assignment-notice"><CheckCircle2 size={17} aria-hidden="true" />{assignmentNotice}</p>}

      {schedule && month && (
        <div className="yb-calendar-layout grid items-start gap-4">
          <div className="yb-panel overflow-hidden">
            <div className="flex items-center justify-between gap-2 p-3 sm:p-4">
              <h3 className="font-semibold text-gray-900" aria-live="polite">{monthLabel.format(asDate(`${month}-01`))}</h3>
              <div className="flex gap-1">
                <button type="button" aria-label="Previous month" onClick={() => changeMonth(-1)}
                  disabled={month <= schedule.today.slice(0, 7)}
                  className="rounded-lg p-2 text-gray-700 hover:bg-orange-50 disabled:text-gray-300">
                  <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                </button>
                <button type="button" aria-label="Next month" onClick={() => changeMonth(1)}
                  className="rounded-lg p-2 text-gray-700 hover:bg-orange-50">
                  <ChevronRight className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="yb-calendar-weekdays grid grid-cols-7 text-center text-xs font-semibold">
              {weekdays.map(day => <div key={day} className="py-2">{day}</div>)}
            </div>
            <div className="yb-calendar-grid grid grid-cols-7 gap-px pt-px">
              {days.map((date, index) => {
                if (!date) return <div key={`blank-${index}`} className="yb-calendar-past" />;
                const count = ordersByDate.get(date)?.length || 0;
                const isSelected = visibleDate === date;
                const isPast = date < schedule.today;

                if (isPast) return <div key={date} className="yb-calendar-past p-1.5 text-xs sm:p-2 sm:text-sm">{Number(date.slice(-2))}</div>;

                return (
                  <button type="button" key={date} onClick={() => selectDate(date)} aria-pressed={isSelected}
                    aria-current={date === schedule.today ? 'date' : undefined}
                    aria-label={`${dayLabel.format(asDate(date))}, ${deliveryCount(count)}`}
                    className="yb-calendar-day flex min-w-0 flex-col items-center gap-1 p-1.5 text-xs focus-visible:z-10 sm:items-start sm:p-2 sm:text-sm">
                    <span className={date === schedule.today ? 'font-bold text-[#a23119]' : 'font-medium'}>{Number(date.slice(-2))}</span>
                    {!!count && <span className="yb-calendar-count rounded-full px-1.5 py-0.5 text-xs tabular-nums">
                      {count}<span className="yb-calendar-count-label"> {count === 1 ? 'delivery' : 'deliveries'}</span>
                    </span>}
                  </button>
                );
              })}
            </div>
          </div>

          <section ref={ordersRef} aria-labelledby="yellowblock-delivery-orders" className="yb-panel yb-daily-orders overflow-hidden">
            <div className="yb-daily-header p-4" aria-live="polite">
              <span className="yb-summary-icon yb-summary-icon-lilac mb-3"><CalendarDays size={19} aria-hidden="true" /></span>
              <h3 id="yellowblock-delivery-orders" className="font-semibold text-gray-900">
                {visibleDate ? dayLabel.format(asDate(visibleDate)) : 'Orders by date'}
              </h3>
              <p className="mt-1 text-sm text-gray-600">{visibleDate ? deliveryCount(selectedOrders.length) : 'Select a date to view its orders.'}</p>
            </div>
            {visibleDate && (selectedOrders.length ? (
              <>
                {allowAssignment && <button type="button" className="yb-select-date" onClick={() => setChecked(selectedOrders, !allForDateChecked)}>
                  {allForDateChecked ? 'Deselect all for this date' : 'Select all for this date'}
                </button>}
                <ul className="divide-y divide-gray-100">
                  {selectedOrders.map(order => (
                    <li key={order.id} className="yb-delivery-row">
                      {allowAssignment && <label className="yb-delivery-check">
                        <input type="checkbox" aria-label={`Select order ${order.name}`} checked={checkedIds.has(String(order.id))}
                          onChange={event => setChecked([order], event.target.checked)} />
                      </label>}
                      <button type="button" onClick={() => onViewOrder(order.id)}
                        className="flex w-full items-center justify-between gap-3 p-4 text-left hover:bg-orange-50">
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-gray-900">{order.name}</span>
                          {order.customerName && <span className="block break-words text-sm text-gray-700">{order.customerName}</span>}
                          {order.address && <span className="block break-words text-xs text-gray-600">{order.address}</span>}
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : <p className="p-4 text-sm text-gray-600">No deliveries scheduled for this date.</p>)}
          </section>
        </div>
      )}
      {showAssignment && <YellowblockBulkAssignment orders={checkedOrders} onClose={() => setShowAssignment(false)} onResult={handleAssignmentResult} />}
    </section>
  );
}
