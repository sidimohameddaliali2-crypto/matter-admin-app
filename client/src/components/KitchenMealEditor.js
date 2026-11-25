import React, { useEffect, useRef, useState } from 'react';
import api from '../utils/api';

const label = meal => `${meal.mealName} (${meal.quantity || 1} portion(s))`;
export default function KitchenMealEditor({ entry, menuId, date, intent, canEdit, onChanged }) {
  const [view, setView] = useState(null), [mode, setMode] = useState(''), [history, setHistory] = useState(null);
  const [target, setTarget] = useState(''), [choice, setChoice] = useState(''), [quantity, setQuantity] = useState(1), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const request = useRef(0);
  const customerId = String(entry.matterCustomerId || '');
  const base = `/menus/${menuId}/kitchen-customers/${customerId}`;
  const open = async (action, mealId = '') => {
    const token = ++request.current;
    setBusy(true); setError(''); setMode(action); setTarget(mealId); setQuantity(1); setChoice(''); setReason(''); setMessage(''); setView(null);
    try {
      const response = await api.get(`${base}/meal-editor`, { params: { date }, timeout: 30000 });
      if (token !== request.current) return;
      if (!response.data?.success) throw new Error('Could not open meal editor.');
      setView(response.data.data);
    } catch (err) { if (token === request.current) setError(err.response?.data?.message || err.message); }
    finally { if (token === request.current) setBusy(false); }
  };
  useEffect(() => { request.current++; setView(null); setMode(''); setHistory(null); setError(''); setBusy(false); setMessage('');
    return () => { request.current++; }; }, [customerId, menuId, date]);
  useEffect(() => { if (intent && customerId) open(intent.action, intent.mealId); /* open captures the current scope; intent is an explicit user action. */
  }, [intent]);
  const readLog = async before => {
    const token = ++request.current; setBusy(true); setError('');
    try {
      const response = await api.get(`${base}/meal-log`, { params: { ...(before ? { before } : {}) }, timeout: 30000 });
      if (token !== request.current) return;
      if (!response.data?.success) throw new Error('Could not load activity log.');
      setHistory(previous => ({ entries: [...(before ? previous?.entries || [] : []), ...response.data.data.entries], next: response.data.data.next }));
    } catch (err) { if (token === request.current) setError(err.response?.data?.message || err.message); }
    finally { if (token === request.current) setBusy(false); }
  };
  const closed = !!view && (!canEdit || !view.canEdit);
  const allergyOnly = mode === 'change' && closed;
  const eligibleMeals = allergyOnly
    ? view.meals.filter(meal => view.allergyReplacementMealIds?.includes(String(meal._id))) : view?.meals;
  const selected = eligibleMeals?.find(meal => String(meal._id) === target);
  const choices = allergyOnly ? view.choices.filter(item => item.mealType === selected?.mealType) : view?.choices;
  const replacement = choices?.find(item => item.id === choice);
  const restore = (entry.kitchenAutoHolds || []).some(hold => hold.date === date);
  const save = async () => {
    const token = ++request.current; setBusy(true); setError('');
    try {
      const response = await api.post(`${base}/meal-editor`, { date, action: mode, mealId: target || undefined, menuItemId: choice || undefined,
        quantity, reason, token: view.token }, { timeout: 30000 });
      if (token !== request.current) return;
      if (!response.data?.success) throw new Error('Could not save the meal change.');
      setMessage(response.data.data.message); setMode(''); setView(null); setHistory(null);
      await onChanged();
    } catch (err) { if (token === request.current) setError(err.response?.data?.message || err.message); }
    finally { if (token === request.current) setBusy(false); }
  };
  if (!/^[1-9]\d*$/.test(customerId) || entry.partner) return null;
  const blocked = busy || !view || (['add', 'delete'].includes(mode) && closed)
    || (['change', 'delete'].includes(mode) && !selected) || (['add', 'change'].includes(mode)
      && (!replacement || replacement.conflicts.length > 0 || replacement.allergyConflicts || replacement.hasMacros === false));
  return <section className="border-t border-slate-200 p-5 space-y-3" aria-label="Kitchen meal controls">
    {entry.kitchenLastMealEdit && <p className="text-sm text-slate-600">Last meal change: <strong>{entry.kitchenLastMealEdit.actorName}</strong> — {entry.kitchenLastMealEdit.summary} — {entry.kitchenLastMealEdit.date}</p>}
    {restore && <p className="text-sm font-semibold text-amber-800">Automatic assignment is paused for this customer on {date}. Deleted portions stay deleted until you restore automatic assignment.</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className="kitchen-button-secondary" disabled={busy || !canEdit} onClick={() => open('add')}>Add meal</button>
      <button type="button" className="kitchen-button-secondary" disabled={busy} onClick={() => readLog()}>Meal activity log</button>
      {restore && <button type="button" className="kitchen-button-secondary" disabled={busy} onClick={() => open('restore')}>Restore automatic assignment</button>}
    </div>
    {!canEdit && <p className="text-xs text-slate-500">After cutoff, only meals with a verified allergy conflict can be changed.</p>}
    {mode && <div role="dialog" aria-label={`${mode} meal confirmation`} className="rounded-xl border border-slate-300 p-4 space-y-3">
      <strong>{mode === 'delete' ? 'Confirm meal deletion' : mode === 'restore' ? 'Restore automatic assignment' : mode === 'add' ? 'Add a meal' : 'Change a meal'} — {entry.customerName || entry.matterName || entry.email} — {date}</strong>
      {view && <>
        {['change', 'delete'].includes(mode) && <label className="block text-sm">Current meal<select aria-label="Current meal" className="block w-full rounded-lg border p-2" value={target} onChange={event => { setTarget(event.target.value); setChoice(''); setQuantity(1); }}>
          <option value="">Choose a saved meal</option>{eligibleMeals.map(meal => <option key={meal._id} value={meal._id}>{label(meal)}</option>)}
        </select></label>}
        {['add', 'change'].includes(mode) && <label className="block text-sm">New dish<select aria-label="New dish" className="block w-full rounded-lg border p-2" value={choice} onChange={event => setChoice(event.target.value)}>
          <option value="">Choose a dish from this date’s menu</option>{choices.map(item => <option key={item.id} value={item.id} disabled={!!item.allergyConflicts}>{item.name} — {item.mealType}{item.conflicts.length ? ` (excluded: ${item.conflicts.join(', ')})` : ''}{item.allergyConflicts && ` (allergy conflict: ${item.allergyConflicts.join(', ')})`}{item.hasMacros === false ? ' (preset macros missing)' : ''}</option>)}
        </select></label>}
        {mode !== 'restore' && <label className="block text-sm">Portions<select aria-label="Portions" className="ml-2 rounded-lg border p-2" value={quantity} onChange={event => setQuantity(Number(event.target.value))}>
          {Array.from({ length: selected ? Math.min(20, selected.quantity || 1) : mode === 'add' ? 20 : 1 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
        </select></label>}
        {mode === 'delete' && selected && <p className="text-sm text-rose-800">Delete {quantity} portion(s) of {selected.mealName}? This can leave meals missing. Automatic assignment for this customer/date will stay paused.</p>}
        {mode === 'change' && selected && replacement && <p className="text-sm">Replace {quantity} × {selected.mealName} with {replacement.name}?</p>}
        {mode === 'restore' && <p className="text-sm">Allow the system to fill missing meals, breakfasts and snacks again after the deadline. Existing choices will be kept.</p>}
        {allergyOnly && <p className="text-sm">{selected
          ? 'After cutoff, the replacement must be from this date’s menu and have the same meal type.'
          : 'Select a meal with a verified allergy conflict. If the case changed, refresh Kitchen List.'}</p>}
        {['add', 'delete'].includes(mode) && closed && <p role="alert">The menu cutoff has passed. Editing is closed.</p>}
        <label className="block text-sm">Reason (optional)<input aria-label="Meal change reason" maxLength={500} className="ml-2 rounded-lg border p-2" value={reason} onChange={event => setReason(event.target.value)} /></label>
        <button type="button" className="kitchen-button-primary" disabled={blocked} onClick={save}>{mode === 'delete' ? 'Confirm delete' : mode === 'restore' ? 'Confirm restore' : 'Confirm meal change'}</button>
      </>}
      <button type="button" className="kitchen-button-secondary ml-2" disabled={busy} onClick={() => { request.current++; setMode(''); setView(null); setError(''); }}>Cancel</button>
    </div>}
    {history && <div aria-label="Meal change history" className="max-h-80 overflow-y-auto space-y-3 rounded-xl bg-slate-50 p-3">
      {!history.entries.length && <p>No staff meal changes recorded.</p>}
      {history.entries.map(row => <div key={row._id} className="border-b pb-2 text-sm"><strong>{row.actorName}</strong> — {row.action} — {row.date}
        <p>{row.summary}</p><p>{new Date(row.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })} (Dubai)</p>{row.reason && <p>Reason: {row.reason}</p>}
      </div>)}
      {history.next && <button type="button" disabled={busy} onClick={() => readLog(history.next)}>Load older changes</button>}
      <button type="button" onClick={() => setHistory(null)}>Close log</button>
    </div>}
    {busy && <p role="status">Loading meal controls…</p>}{error && <p role="alert" className="text-sm text-rose-700">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
