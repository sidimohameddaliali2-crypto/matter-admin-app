import React, { useEffect, useState } from 'react';
import api from '../utils/api';

export default function DeliveryOrderModal({ date, drivers, onClose }) {
  const [driverId, setDriverId] = useState('');
  const [rows, setRows] = useState([]);
  const [revision, setRevision] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setRows([]); setRevision(null); setMessage('');
    if (!driverId) { setLoading(false); return; }
    setLoading(true);
    api.get('/deliveries/delivery-order', { params: { driverId, date } }).then(({ data }) => {
      if (active) { setRows(data.data.deliveries); setRevision(data.data.revision); }
    }).catch(error => { if (active) setMessage(error.response?.data?.message || 'Could not load the route. Please retry.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [driverId, date, reload]);
  const move = (index, delta) => {
    setMessage('');
    setRows(previous => {
      const next = [...previous];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      return next;
    });
  };
  const save = async () => {
    setSaving(true); setMessage('');
    try {
      await api.put('/deliveries/delivery-order', { driverId, date, revision, deliveryIds: rows.map(d => d._id) });
      setRevision(null);
      setMessage('Saved. The driver will see this order when they refresh deliveries or reopen the Route tab.');
    } catch (error) {
      setMessage(error.response?.data?.message || 'Could not save. Reload the route and try again.');
      setRevision(null);
    } finally { setSaving(false); }
  };
  return <div className="fixed inset-0 z-50 normal-case tracking-normal text-gray-900 bg-black/50 flex items-center justify-center p-3">
    <section role="dialog" aria-modal="true" aria-label="Delivery order" className="bg-white rounded-2xl p-4 w-full max-w-lg max-h-[90vh] flex flex-col">
      <div className="flex justify-between items-center mb-3"><h2 className="font-bold text-lg">Delivery order</h2>
        <button type="button" disabled={saving} onClick={onClose} className="p-3">Close</button></div>
      <p className="text-sm text-gray-600 mb-3">{date} · Choose a driver, then move stops up or down. All assigned stops are included.</p>
      <label className="text-sm">Driver<select aria-label="Driver" value={driverId} disabled={saving} onChange={e => setDriverId(e.target.value)} className="block w-full border rounded-lg p-3 mb-3">
        <option value="">Choose a driver</option>{drivers.map(d => <option key={d._id} value={d._id}>{[d.profile?.firstName, d.profile?.lastName].filter(Boolean).join(' ') || d.name || d.email}</option>)}
      </select></label>
      {loading && <p role="status">Loading route…</p>}
      <div className="overflow-y-auto flex-1"><ol>{rows.map((d, index) => <li key={d._id} className="flex items-center gap-2 border-b py-3">
        <span className="font-bold">{index + 1}.</span><div className="flex-1 min-w-0"><p className="font-semibold break-words">{d.customerName || 'Customer'}</p><p className="text-xs text-gray-600 break-words">{d.address}</p><p className="text-xs">{d.status}</p></div>
        <button type="button" aria-label={`Move stop ${index + 1} up`} disabled={saving || index === 0 || !revision} onClick={() => move(index, -1)} className="p-3 border rounded disabled:opacity-30">↑</button>
        <button type="button" aria-label={`Move stop ${index + 1} down`} disabled={saving || index === rows.length - 1 || !revision} onClick={() => move(index, 1)} className="p-3 border rounded disabled:opacity-30">↓</button>
      </li>)}</ol></div>
      {driverId && !loading && revision && !rows.length && <p>No deliveries assigned for this date.</p>}
      {message && <p role="status" className="my-3 text-sm">{message}</p>}
      <div className="flex gap-3 mt-3"><button type="button" disabled={saving || loading || !driverId} onClick={() => setReload(v => v + 1)} className="border rounded-lg p-3">Reload</button>
        <button type="button" disabled={saving || loading || !revision || rows.length < 2} onClick={save} className="flex-1 bg-blue-600 text-white rounded-lg p-3 disabled:opacity-40">{saving ? 'Saving…' : 'Save order'}</button></div>
    </section>
  </div>;
}
