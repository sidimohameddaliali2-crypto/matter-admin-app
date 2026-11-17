import React, { useState } from 'react';
import usePartnerKitchenOrders from '../lib/usePartnerKitchenOrders';

const LABELS = { breakfast: 'Breakfast of the day', main: 'Main', snack: 'Snack', bowl: 'Bowl', 'wraps-buns': 'Wraps/Buns', oats: 'Oats' };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });

export const partnerKitchenCsv = (data, counting) => {
  const rows = counting
    ? [['Delivery date', 'Category', 'Dish', 'Quantity'], ...data.counts.map(item => [data.date, LABELS[item.mealType] || item.mealType, item.name, item.quantity])]
    : [['Delivery date', 'Partner', 'Order', 'Window', 'Category', 'Dish', 'Quantity', 'Notes'], ...data.orders.flatMap(order => order.lines.map(item => [data.date, order.partnerName, order.reference, order.deliveryTime, LABELS[item.mealType] || item.mealType, item.name, item.quantity, order.notes]))];
  return rows.map(row => row.map(value => `"${String(value ?? '').replace(/^[=+@-]/, "'$&").replace(/"/g, '""')}"`).join(',')).join('\r\n');
};

// Both kitchen pages read the same date-scoped production feed. No copying
// partner quantities into customer selections or applying customer macros.
export default function PartnerKitchenOrders({ date, counting = false }) {
  const [localDate, setLocalDate] = useState(today);
  const selectedDate = date || localDate;
  const { data, refresh, ...state } = usePartnerKitchenOrders(selectedDate);
  const exportCsv = () => {
    if (!data || state.loading || state.error) return;
    const url = URL.createObjectURL(new Blob(['\ufeff', partnerKitchenCsv(data, counting)], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url; link.download = `partner-kitchen-${counting ? 'counting' : 'list'}-${selectedDate}.csv`; link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section aria-label={counting ? 'Partner kitchen counting' : 'Partner kitchen orders'} className="rounded-2xl border border-lime-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">{counting ? 'Partner cook counts' : 'Partner orders for the kitchen'}</h2>
          <p className="text-sm text-slate-600">Submitted orders are ready for preparation. Quantities use the partner recipe portions.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!date && <label className="text-sm text-slate-700">Partner delivery date <input type="date" aria-label="Partner delivery date" value={localDate} onChange={e => { if (e.target.value) setLocalDate(e.target.value); }} className="rounded-lg border p-2" /></label>}
          <button type="button" onClick={refresh} className="rounded-lg border px-3 py-2 text-sm">Refresh partner orders</button>
          <button type="button" disabled={!data?.orderCount || state.loading || !!state.error} onClick={exportCsv} className="rounded-lg bg-lime-200 px-3 py-2 text-sm font-semibold disabled:opacity-50">Export partner {counting ? 'counts' : 'list'} CSV</button>
        </div>
      </div>
      <p className="mt-2 text-sm text-slate-600">Delivery: {selectedDate}{data ? ` · ${data.orderCount} order(s) · ${data.totalQuantity} portion(s)` : ''}</p>
      {state.error && <p role="alert" className="mt-3 text-sm text-red-700">{state.error}</p>}
      {(state.loading || state.date !== selectedDate) && <p className="mt-3 text-sm text-slate-500">Loading partner orders…</p>}
      {data && !data.orderCount && <p className="mt-3 text-sm text-slate-500">No submitted partner orders for this date.</p>}
      {data && counting && data.counts.length > 0 && <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr className="border-b"><th className="p-2">Category</th><th className="p-2">Dish</th><th className="p-2 text-right">Partner portions</th></tr></thead>
        <tbody>{data.counts.map(item => <tr key={item.itemId} className="border-b"><td className="p-2">{LABELS[item.mealType] || item.mealType}</td><td className={`p-2 ${item.needsReview ? 'text-red-700' : ''}`}>{item.name}</td><td className="p-2 text-right font-bold">{item.quantity}</td></tr>)}</tbody>
      </table></div>}
      {data && !counting && <div className="mt-4 grid gap-3 md:grid-cols-2">{data.orders.map(order => <article key={order.id} className="rounded-xl border border-slate-200 p-4">
        <h3 className="font-bold text-slate-900">{order.partnerName}</h3>
        <p className="text-xs text-slate-500">{order.reference}{order.deliveryTime ? ` · ${order.deliveryTime}` : ''}</p>
        <ul className="mt-2 space-y-1 text-sm">{order.lines.map(item => <li key={item.itemId} className={item.needsReview ? 'text-red-700' : ''}><strong>{item.quantity} ×</strong> {item.name} <span className="text-slate-500">({LABELS[item.mealType] || item.mealType})</span></li>)}</ul>
        {!order.lines.length && <p className="text-sm text-red-700">No order items — review this order.</p>}
        {order.notes && <p className="mt-2 text-sm text-amber-800">Notes: {order.notes}</p>}
      </article>)}</div>}
    </section>
  );
}


export function PartnerKitchenCounts({ state }) {
  const { data, loading, error } = state;
  return <section aria-label="Partner order" className="kitchen-count-group mt-5">
    <div className="kitchen-group-heading" style={{gridTemplateColumns: '1fr'}}><div><h3>Partner order</h3><strong>{data?.totalQuantity || 0}</strong><span>portions</span></div></div>
    {loading && <p role="status" className="p-5 text-sm">Loading partner orders…</p>}
    {error && <p role="alert" className="p-5 text-sm text-red-700">{error}</p>}
    {data && !data.counts.length && <p className="p-5 text-sm">No submitted partner orders for this date.</p>}
    {data?.counts.map(item => <div key={item.itemId} className="grid grid-cols-[80px_1fr] items-center gap-4 border-b p-5">
      <strong className="kitchen-portion-number">{item.quantity}</strong><div className="kitchen-count-dish">{item.name}<div className="text-xs text-slate-500">{LABELS[item.mealType] || item.mealType}</div></div>
    </div>)}
  </section>;
}
