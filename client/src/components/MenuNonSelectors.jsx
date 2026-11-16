import React, { useEffect, useRef, useState } from 'react';
import api from '../utils/api';

export default function MenuNonSelectors({ menu, onClose }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState('');
  const closeButton = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeButton.current?.focus();
    const escape = event => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('keydown', escape); previous?.focus?.(); };
  }, [onClose]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true); setResult(null); setError('');
    api.get(`/menus/${menu._id}/did-not-select`, { timeout: 180000, signal: controller.signal }).then(response => {
      if (!active) return;
      if (!response.data?.success || !Array.isArray(response.data.data?.customers)) throw new Error('Could not verify the customer list. Please retry.');
      setResult(response.data.data);
    }).catch(err => { if (active) setError(err.response?.data?.message || err.message || 'Could not check customers. Please retry.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [menu._id, refresh]);
  const customers = result?.customers || [];
  const query = search.trim().toLowerCase();
  const visible = customers.filter(customer => [customer.name, customer.email, customer.phone].some(value => String(value || '').toLowerCase().includes(query)));
  const date = value => new Date(`${value}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short' });
  return <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="non-selectors-title" aria-describedby="non-selectors-description" className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col" onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = event.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled)');
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header className="p-5 border-b flex justify-between items-start gap-4">
        <div><h2 id="non-selectors-title" className="text-lg font-bold text-matter-navy">Customers who did not select</h2>
          <p className="text-sm text-matter-neutral-600">{menu.title}</p>
          <p id="non-selectors-description" className="text-sm mt-2">Active deliveries in this menu period, with no customer selections on any menu date. Automatic assignments do not count.</p></div>
        <button ref={closeButton} type="button" onClick={onClose} aria-label="Close customers who did not select" className="px-3 py-2 rounded-lg hover:bg-matter-neutral-100">Close</button>
      </header>
      <div className="p-5 overflow-y-auto" aria-live="polite">
        {loading ? <p role="status">Checking active deliveries with Matter. This may take a few minutes.</p> : error ? <p role="alert" className="text-red-700">{error}</p> : <>
          <p className="font-semibold mb-3">{customers.length} customer{customers.length === 1 ? '' : 's'} · {date(result.startDate)} – {date(result.endDate)}</p>
          {customers.length === 0 ? <p>No customers with active deliveries are missing all selections for this menu.</p> : <>
            <input type="search" aria-label="Search customers who did not select" placeholder="Search name, email or phone" value={search} onChange={event => setSearch(event.target.value)} className="w-full border rounded-lg px-3 py-2 mb-4" />
            <ul className="divide-y">{visible.map(customer => <li key={customer.customerId} className="py-3 grid md:grid-cols-2 gap-2">
              <div className="min-w-0"><p className="font-semibold">{customer.name || customer.email || 'Customer'}</p><p className="text-sm break-all">{customer.email || 'Email unavailable'}</p><p className="text-sm">{customer.phone || 'Phone unavailable'}</p></div>
              <p className="text-sm">Active deliveries: {customer.deliveryDates.map(date).join(', ')}</p>
            </li>)}</ul>
            {visible.length === 0 && <p>No matching customers.</p>}
          </>}
        </>}
      </div>
      <footer className="p-4 border-t flex justify-between items-center gap-3 text-sm">
        <span className="text-matter-neutral-600">{result ? `Checked ${new Date(result.checkedAt).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })} (Dubai)` : 'No reminders are sent by this check.'}</span>
        <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)} className="border rounded-lg px-3 py-2 disabled:opacity-50">{error ? 'Retry' : 'Refresh'}</button>
      </footer>
    </section>
  </div>;
}
