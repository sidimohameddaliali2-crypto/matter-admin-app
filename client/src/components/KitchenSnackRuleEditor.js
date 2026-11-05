import React, { useEffect, useRef, useState } from 'react';
import api from '../utils/api';

export default function KitchenSnackRuleEditor({ entry, menuId, date, onSaved, onReplaced }) {
  const customerId = String(entry.matterCustomerId || '');
  const [open, setOpen] = useState(false), [data, setData] = useState(null);
  const [selected, setSelected] = useState([]), [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const request = useRef(0);
  useEffect(() => { request.current++; setOpen(false); setData(null); setError(''); setMessage(''); setBusy(false); setQuery('');
    return () => { request.current++; }; }, [customerId, menuId, date]);
  const conflict = (entry.selectedMeals || []).some(meal => meal.snackRuleConflict);
  const read = async () => {
    setOpen(true); setError(''); setBusy(true);
    const token = ++request.current;
    try {
      const response = await api.get(`/menus/kitchen-snack-rules/${customerId}`, { timeout: 30000 });
      if (token !== request.current) return;
      if (!response.data?.success || !Array.isArray(response.data.data?.catalogue)) throw new Error('Snack rules could not be loaded.');
      setData(response.data.data); setSelected(response.data.data.blockedSnacks.map(item => item.key));
    } catch (err) { if (token === request.current) setError(err.response?.data?.message || err.message); }
    finally { if (token === request.current) setBusy(false); }
  };
  const save = async () => {
    const token = ++request.current;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await api.put(`/menus/kitchen-snack-rules/${customerId}`, { blockedSnackKeys: selected, version: data.version }, { timeout: 30000 });
      if (token !== request.current) return;
      if (!response.data?.success) throw new Error('Snack rules could not be saved.');
      setData({ ...data, ...response.data.data });
      onSaved(customerId, response.data.data);
      setMessage('Rules saved. Existing assignments were kept; review any flagged auto-assigned snacks.');
    } catch (err) { if (token === request.current) setError(err.response?.data?.message || err.message); }
    finally { if (token === request.current) setBusy(false); }
  };
  const replace = async () => {
    const token = ++request.current;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await api.post(`/menus/${menuId}/kitchen-snack-rules/${customerId}/replace`, { date, version: data.version }, { timeout: 30000 });
      if (token !== request.current) return;
      if (!response.data?.success) throw new Error('Snacks could not be replaced.');
      setMessage(`Replaced ${response.data.data.replaced} blocked auto-assigned snack portion(s).`);
      await onReplaced();
    } catch (err) { if (token === request.current) setError(err.response?.data?.message || err.message); }
    finally { if (token === request.current) setBusy(false); }
  };
  if (!/^[1-9]\d*$/.test(customerId)) return <p className="px-5 py-2 text-xs text-slate-500">Link the permanent Matter customer ID to manage snack rules.</p>;
  const dirty = data && JSON.stringify([...selected].sort()) !== JSON.stringify(data.blockedSnacks.map(item => item.key).sort());
  const choices = data ? [...data.catalogue, ...data.blockedSnacks.filter(item => !data.catalogue.some(option => option.key === item.key))] : [];
  return <section className="border-t border-slate-200 p-5" aria-label="Customer snack rules">
    <button type="button" className="kitchen-button-secondary" disabled={busy} aria-expanded={open}
      onClick={() => open ? setOpen(false) : read()}>Blocked snacks ({data?.blockedSnacks?.length ?? entry.snackRule?.blockedSnacks?.length ?? 0})</button>
    {open && <div className="mt-3 space-y-3">
      <p className="text-sm text-slate-600">Do not auto-assign these snacks. Dietary restrictions still apply. Rules follow this customer across subscription renewals.</p>
      <p className="text-xs text-slate-500">Matter customer ID: {customerId}</p>
      {data && <>
        <input aria-label="Search snacks to block" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search snacks" className="rounded-lg border p-2" />
        <div className="max-h-60 overflow-y-auto space-y-2" aria-label="Snack choices">
          {choices.filter(item => item.name.toLowerCase().includes(query.toLowerCase())).map((item, index) => <label key={`${item.key}:${index}`} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(item.key)} disabled={busy} onChange={e => setSelected(current => e.target.checked ? [...current, item.key] : current.filter(key => key !== item.key))} />
            {item.name}{item.hasMacros === false ? ' — preset macros missing' : ''}
          </label>)}
        </div>
        <button type="button" className="kitchen-button-primary" disabled={busy || !dirty} onClick={save}>Save snack rules</button>
        {conflict && <div className="rounded-lg bg-amber-50 p-3 text-sm">
          <p>This date has a blocked auto-assigned snack. Review the saved rules, then replace only the affected auto-assigned snacks. Customer choices and other dates are preserved.</p>
          <button type="button" className="kitchen-button-secondary mt-2" disabled={busy || dirty} onClick={replace}>Replace blocked auto-snacks for this date</button>
        </div>}
      </>}
      {busy && <p role="status">Updating snack rules…</p>}
      {error && <p role="alert" className="text-sm text-rose-700">{error} <button type="button" disabled={busy} onClick={read}>Reload rules</button></p>}
      {message && <p role="status" className="text-sm text-slate-600">{message}</p>}
    </div>}
  </section>;
}
