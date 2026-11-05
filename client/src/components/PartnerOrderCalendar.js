import React, { useState } from 'react';
import { dateClosed } from '../utils/partnerDailyPlan';

// Keep the original partner calendar's month navigation, lime selections and
// existing-order dots. Use UTC dates so travelling never shifts a delivery day.
export default function PartnerOrderCalendar({ earliestDate, selectedDates, orders, onChange }) {
  const [month, setMonth] = useState(() => (selectedDates[0] || earliestDate).slice(0, 7));
  const first = new Date(month + '-01T00:00:00Z');
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const moveMonth = delta => {
    const next = new Date(first);
    next.setUTCMonth(next.getUTCMonth() + delta);
    setMonth(next.toISOString().slice(0, 7));
  };
  return <div className="max-w-lg" aria-label="Delivery calendar">
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => moveMonth(-1)} aria-label="Previous month"
        className="w-9 h-9 rounded-full bg-[#0a1230] border-[1.5px] border-[#12275e] hover:border-[#bcf679]">‹</button>
      <div className="flex-1 text-center text-[15px] font-bold" aria-live="polite">
        {first.toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' })}
      </div>
      <button type="button" onClick={() => moveMonth(1)} aria-label="Next month"
        className="w-9 h-9 rounded-full bg-[#0a1230] border-[1.5px] border-[#12275e] hover:border-[#bcf679]">›</button>
    </div>
    <div className="grid grid-cols-7 gap-1 mt-3.5 text-center text-[10px] font-bold tracking-[0.1em] text-[#a8ccf5]">
      {['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].map(day => <div key={day}>{day}</div>)}
    </div>
    <div className="grid grid-cols-7 gap-1 mt-1.5">
      {Array.from({ length: lead }, (_, i) => <div key={'blank-' + i} />)}
      {Array.from({ length: count }, (_, i) => {
        const number = i + 1;
        const date = month + '-' + String(number).padStart(2, '0');
        const selected = selectedDates.includes(date);
        const disabled = new Date(date + 'T00:00:00Z').getUTCDay() === 0 || date < earliestDate || dateClosed(date);
        const hasOrder = orders.some(order => String(order.deliveryDate).slice(0, 10) === date && order.status !== 'cancelled');
        return <button key={date} type="button" aria-label={'Delivery ' + date} aria-pressed={selected} disabled={disabled}
          onClick={() => onChange(selected ? selectedDates.filter(d => d !== date) : [...selectedDates, date].sort())}
          className="relative border-[1.5px] font-bold transition-colors disabled:cursor-default h-11 sm:h-[46px]"
          style={{ borderRadius: 14, borderColor: selected ? '#bcf679' : date === today ? '#a8ccf5' : '#12275e',
            background: selected ? '#bcf679' : '#051747', color: selected ? '#051747' : '#ede5de', opacity: disabled ? 0.35 : 1 }}>
          {number}
          {hasOrder && <span aria-label="Existing order" className="absolute left-1/2 bottom-[4px] -translate-x-1/2 w-[4px] h-[4px] rounded-full"
            style={{ background: selected ? '#051747' : '#bcf679' }} />}
        </button>;
      })}
    </div>
    <p className="mt-3 text-sm text-[#a8ccf5]">{selectedDates.length} delivery day(s) selected · Dots mark existing orders</p>
  </div>;
}
