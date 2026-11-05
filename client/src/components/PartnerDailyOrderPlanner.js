import React, { useEffect, useRef, useState } from 'react';
import partnerApi from '../utils/partnerApi';
import PartnerOrderCalendar from './PartnerOrderCalendar';
import PartnerDailyMenu from './PartnerDailyMenu';
import { DELIVERY_WINDOWS, deliveryDays, makePlanDay, dayTotal, dayQuantity, assertDayReady, quotePlanDay, submitPlanDay, dateClosed } from '../utils/partnerDailyPlan';

const heading = { fontFamily: "'Archivo Black', sans-serif" };
const box = 'rounded-2xl border border-[#12275e] bg-[#051747] p-4';
const primary = 'rounded-full bg-[#bcf679] text-[#051747] px-5 py-3 font-bold disabled:opacity-40';
const secondary = 'rounded-full border border-[#a8ccf5] px-4 py-2 text-sm disabled:opacity-40';
const fmt = date => new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const money = value => Number(value || 0).toFixed(2);
const initial = earliest => ({ version: 1, phase: 'dates', from: earliest, to: earliest, selectedDates: [earliest], days: [], index: 0 });

const validDeliveryDate = date => {
  try { return typeof date === 'string' && deliveryDays(date, date).length === 1; }
  catch { return false; }
};

function restore(key, earliest) {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved?.version === 1 && ['dates', 'days', 'review'].includes(saved.phase) && Array.isArray(saved.days)
      && saved.days.length > 0 && saved.days.length <= 90 && saved.days.every(d => d && validDeliveryDate(d.date) && d.items && typeof d.items === 'object')
      && Number.isInteger(saved.index) && saved.index >= 0 && saved.index < saved.days.length) {
      let selectedDates;
      if (Array.isArray(saved.selectedDates) && saved.selectedDates.every(validDeliveryDate)) {
        selectedDates = saved.selectedDates;
      } else {
        // Older drafts can contain an unfinished date-range edit. Recover the
        // saved carts when that range is invalid, without evaluating it in JSX.
        try { selectedDates = deliveryDays(saved.from, saved.to); }
        catch { selectedDates = saved.days.map(day => day.date); }
      }
      return { ...saved, selectedDates: [...new Set(selectedDates)].sort() };
    }
  } catch { /* A missing or corrupt local draft starts a new plan. */ }
  return initial(earliest);
}

export default function PartnerDailyOrderPlanner({ partner, earliestDate, orders = [], onPlaced, onViewOrders }) {
  const storageKey = 'partner-daily-plan:' + (partner?._id || partner?.id || partner?.email || 'unknown');
  const [plan, setPlan] = useState(() => restore(storageKey, earliestDate));
  const [menuState, setMenuState] = useState({ date: '', items: [], loading: false, error: '' });
  const [error, setError] = useState('');
  const [placing, setPlacing] = useState(false);
  const [reload, setReload] = useState(0);
  const submitting = useRef(false);
  const minimum = Number(partner?.minimumOrder) || 0;
  const active = plan.days[plan.index];
  const currentMenu = menuState.date === active?.date ? menuState.items : [];
  const menuReady = menuState.date === active?.date && !menuState.loading && !menuState.error;
  const existing = active && orders.find(o => String(o.deliveryDate).slice(0, 10) === active.date
    && o.status !== 'cancelled' && String(o._id) !== String(active.orderId || ''));
  const previousIndex = plan.days.reduce((last, d, i) => i < plan.index && !d.placed ? i : last, -1);
  const ordered = plan.days.filter(d => !d.skipped);
  const total = ordered.reduce((sum, d) => sum + dayTotal(d), 0);

  useEffect(() => {
    try {
      if ((plan.phase === 'dates' && !plan.days.length) || plan.phase === 'complete') localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(plan));
    } catch { /* Ordering remains usable when browser storage is unavailable. */ }
  }, [plan, storageKey]);

  useEffect(() => {
    if (plan.phase !== 'days' || !active) return undefined;
    let alive = true;
    const date = active.date;
    setMenuState({ date, items: [], loading: true, error: '' });
    partnerApi.get('/partner/menu?date=' + date).then(response => {
      if (!response.data?.success || !Array.isArray(response.data.data)) throw new Error('Could not verify this day’s menu.');
      if (alive) setMenuState({ date, items: response.data.data, loading: false, error: '' });
    }).catch(err => {
      if (alive) setMenuState({ date, items: [], loading: false, error: err.response?.data?.message || err.message || 'Could not load menu.' });
    });
    return () => { alive = false; };
  }, [active?.date, plan.phase, reload]);

  const updateDay = patch => {
    setError('');
    setPlan(p => ({ ...p, days: p.days.map((d, i) => i === p.index ? { ...d, ...patch, reviewed: false, skipped: false, error: '' } : d) }));
  };
  const start = () => {
    try {
      const dates = [...new Set(plan.selectedDates)].sort();
      if (!dates.length) throw new Error('Choose at least one delivery day on the calendar.');
      deliveryDays(dates[0], dates[dates.length - 1]);
      const closed = dates.find(dateClosed);
      if (closed) throw new Error(fmt(closed) + ': cutoff has passed. Choose a later start date.');
      setPlan(p => {
        const days = dates.map(date => p.days.find(d => d.date === date) || makePlanDay(date));
        const next = days.findIndex(d => !d.reviewed);
        return { ...p, days, index: Math.max(0, next), phase: next < 0 ? 'review' : 'days' };
      });
      setError('');
    } catch (err) { setError(err.message); }
  };
  const confirmDay = skip => {
    try {
      if (!skip && !menuReady) throw new Error('Wait for this day’s menu, or retry loading it.');
      let day = skip ? { ...active, items: {}, skipped: true } : quotePlanDay(active, currentMenu);
      assertDayReady(day, minimum);
      day = { ...day, reviewed: true, error: '' };
      const days = plan.days.map((d, i) => i === plan.index ? day : d);
      const next = days.findIndex(d => !d.reviewed);
      setPlan(p => ({ ...p, days, index: next < 0 ? p.index : next, phase: next < 0 ? 'review' : 'days' }));
      setError('');
    } catch (err) { setError(err.message); }
  };
  const changeQuantity = (item, delta) => {
    const items = { ...active.items };
    const quantity = Math.max(0, (items[item._id]?.quantity || 0) + delta);
    if (quantity) items[item._id] = { id: item._id, name: item.name, price: Number(item.price), quantity };
    else delete items[item._id];
    updateDay({ items });
  };
  const editDay = index => { setError(''); setPlan(p => ({ ...p, index, phase: 'days' })); };
  const checkout = async () => {
    if (submitting.current) return;
    if (!plan.days.every(d => d.reviewed)) { setError('Review every delivery day before checking out.'); return; }
    if (!ordered.length) { setError('Choose items for at least one day before checking out.'); return; }
    submitting.current = true; setPlacing(true); setError('');
    let days = plan.days.map(d => ({ ...d, error: '' }));
    try {
      // Verify all remaining days before the first write. Checkout sends one
      // order per delivery day; accepted days are retained on a partial failure.
      const existingResponse = await partnerApi.get('/partner/orders');
      if (!existingResponse.data?.success || !Array.isArray(existingResponse.data.data)) throw new Error('Could not verify existing orders. Please retry.');
      const pending = days.filter(d => !d.skipped && !d.placed);
      for (const day of pending) {
        assertDayReady(day, minimum);
        if (existingResponse.data.data.some(o => String(o.deliveryDate).slice(0, 10) === day.date
          && o.status !== 'cancelled' && String(o._id) !== String(day.orderId || ''))) {
          throw new Error(fmt(day.date) + ': an order already exists. Edit this day to keep the existing order, or use My Orders.');
        }
      }
      const quotes = await Promise.all(pending.map(async day => {
        const result = (await partnerApi.get('/partner/menu?date=' + day.date)).data;
        if (!result?.success || !Array.isArray(result.data)) throw new Error('Could not verify the menu for ' + fmt(day.date) + '.');
        return quotePlanDay(day, result.data);
      }));
      let priceChanged = false;
      days = days.map(day => {
        const quote = quotes.find(q => q.date === day.date);
        if (!quote) return day;
        if (dayTotal(quote) !== dayTotal(day)) priceChanged = true;
        return quote;
      });
      setPlan(p => ({ ...p, days }));
      if (priceChanged) throw new Error('Prices have changed. Review the updated daily totals and check out again.');
      days.filter(d => !d.skipped && !d.placed).forEach(d => assertDayReady(d, minimum));
      for (let index = 0; index < days.length; index++) {
        const day = days[index];
        if (day.skipped || day.placed) continue;
        try {
          const id = await submitPlanDay(partnerApi, day, orderId => {
            days[index] = { ...days[index], orderId };
            setPlan(p => ({ ...p, days: days.map(d => ({ ...d })) }));
          });
          days[index] = { ...days[index], placed: true, orderId: id };
        } catch (err) {
          days[index] = { ...days[index], error: err.response?.data?.message || err.message || 'Could not place this day’s order.' };
        }
        setPlan(p => ({ ...p, days: days.map(d => ({ ...d })) }));
      }
      const complete = days.every(d => d.skipped || d.placed);
      setPlan(p => ({ ...p, days, phase: complete ? 'complete' : 'review' }));
      if (!complete) setError('Some days could not be placed. Accepted orders are saved; retry will send only the remaining days.');
      onPlaced?.();
    } catch (err) { setError(err.response?.data?.message || err.message || 'Checkout failed. Please retry.'); }
    finally { submitting.current = false; setPlacing(false); }
  };

  return <section aria-label="Daily order planner" className="space-y-4 text-[#ede5de]" style={{ fontFamily: "'Archivo', system-ui, sans-serif" }}>
    <h2 style={heading} className="text-2xl font-bold">Plan daily orders</h2>
    <p className="text-sm text-[#a8ccf5]">Choose your dates, review every delivery day, then check out once. Each day has its own items and delivery window. Sundays have no deliveries.</p>
    {plan.phase !== 'dates' && plan.phase !== 'complete' && !plan.days.some(d => d.placed) && <button type="button" className={secondary} disabled={placing} onClick={() => { setError(''); setPlan(p => ({ ...p, phase: 'dates' })); }}>Change dates</button>}
    {error && <p role="alert" className="rounded-xl border border-[#ff8a66] p-3 text-sm text-[#ff8a66]">{error}</p>}
    {plan.phase === 'dates' && <div className={box + ' space-y-4'}>
      <PartnerOrderCalendar earliestDate={earliestDate} orders={orders}
        selectedDates={plan.selectedDates}
        onChange={selectedDates => { setError(''); setPlan(p => ({ ...p, selectedDates })); }} />
      <p className="text-sm text-[#a8ccf5]">Select your delivery days on the calendar, up to 90 calendar days apart. Confirm an order or explicitly skip each selected day.</p>
      <button type="button" className={primary} onClick={start}>Start daily orders</button>
    </div>}
    {plan.days.length > 0 && ['days', 'review'].includes(plan.phase) && <div className="flex flex-wrap gap-2" aria-label="Daily progress">{plan.days.map((d, i) => <span key={d.date} className={'rounded-full px-3 py-1 text-xs ' + (d.reviewed ? 'bg-[#bcf679] text-[#051747]' : 'bg-[#12275e] text-[#a8ccf5]')}>{i + 1}. {fmt(d.date)} · {d.placed ? 'Placed' : d.skipped ? 'Skipped' : d.reviewed ? 'Reviewed' : 'To review'}</span>)}</div>}
    {plan.phase === 'days' && active && <div className="space-y-4">
      <div className={box + ' space-y-3'}>
        <h3 style={heading} className="text-lg font-bold">Day {plan.index + 1} of {plan.days.length} — {fmt(active.date)}</h3>
        {existing && <p className="text-sm text-[#bcf679]">An order already exists for this day. Keep it below, or edit it in My Orders.</p>}
        <div role="group" aria-label="Delivery window" className="max-w-lg">
          <p className="text-[9.5px] font-bold tracking-[0.12em] uppercase text-[#a8ccf5] mb-1.5">Delivery window</p>
          <div className="flex gap-1.5">{DELIVERY_WINDOWS.map(window => <button key={window} type="button" aria-pressed={active.window === window}
            disabled={!!existing || active.placed} onClick={() => updateDay({ window })}
            className="flex-1 rounded-full px-3 py-2 text-[12px] font-bold border-[1.5px] transition-colors disabled:opacity-40"
            style={{borderColor: active.window === window ? '#bcf679' : '#12275e', background: active.window === window ? '#bcf679' : '#0a1230', color: active.window === window ? '#051747' : '#ede5de'}}>{window}</button>)}</div>
        </div>
        <p className="text-sm">Day total: <strong>AED {money(dayTotal(active))}</strong> · {dayQuantity(active)} item(s){minimum > 0 ? ' · Minimum AED ' + money(minimum) + ' per delivery' : ''}</p>
      </div>
      {!existing && <>
        {!menuReady && !menuState.error && <p role="status">Loading this day’s menu…</p>}
        {menuState.date === active.date && menuState.error && <div role="alert"><p>{menuState.error}</p><button type="button" className={secondary} onClick={() => setReload(n => n + 1)}>Retry menu</button></div>}
        {menuReady && !currentMenu.length && <p>No items are available for this day. You can explicitly skip it.</p>}
        {menuReady && Object.values(active.items).filter(item => !currentMenu.some(m => m._id === item.id)).map(item => <div key={item.id} className={box}>
          <p className="text-sm text-[#ff8a66]">{item.name} is no longer available for this day.</p>
          <button type="button" className={secondary} onClick={() => changeQuantity({ _id: item.id }, -item.quantity)}>Remove unavailable {item.name}</button>
        </div>)}
        <PartnerDailyMenu key={active.date} items={currentMenu} cart={active.items} placed={active.placed} onQuantityChange={changeQuantity} />
      </>}
      <div className="flex flex-wrap gap-3">
        {previousIndex >= 0 && <button type="button" className={secondary} onClick={() => editDay(previousIndex)}>Previous day</button>}
        {!existing && <button type="button" className={primary} disabled={!menuReady || active.placed} onClick={() => confirmDay(false)}>Confirm day &amp; continue</button>}
        <button type="button" className={secondary} disabled={active.placed || (!existing && !menuReady)} onClick={() => confirmDay(true)}>{existing ? 'Keep existing order & continue' : 'Skip this day & continue'}</button>
      </div>
      <p className="text-xs text-[#a8ccf5]">Nothing is submitted to the kitchen until final checkout.</p>
    </div>}
    {plan.phase === 'review' && <div className="space-y-4">
      <h3 style={heading} className="text-xl font-bold">Final checkout</h3><p className="text-sm text-[#a8ccf5]">All {plan.days.length} delivery days reviewed. Check every daily order below.</p>
      {plan.days.map((day, index) => <article key={day.date} className={box}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-bold">{fmt(day.date)} — {day.placed ? 'Placed' : day.skipped ? 'No new order' : 'AED ' + money(dayTotal(day))}</h4>
          {!day.placed && !placing && <button type="button" className={secondary} onClick={() => editDay(index)}>Edit {fmt(day.date)}</button>}</div>
        {!day.skipped && <><p className="mt-1 text-sm text-[#a8ccf5]">{day.window}</p><ul className="mt-2 space-y-1 text-sm">{Object.values(day.items).map(item => <li key={item.id}>{item.quantity} × {item.name} · AED {money(item.quantity * item.price)}</li>)}</ul></>}
        {day.error && <p role="alert" className="mt-2 text-sm text-[#ff8a66]">{day.error}</p>}
      </article>)}
      <div className={box}><p className="text-lg font-bold">{ordered.length} daily order(s) · Combined total AED {money(total)}</p><p className="mt-2 text-sm text-[#a8ccf5]">Each order keeps its own delivery date and minimum order requirement.</p>
        <button type="button" className={primary + ' mt-4'} disabled={placing || !ordered.length || !plan.days.every(d => d.reviewed)} onClick={checkout}>{placing ? 'Placing daily orders…' : plan.days.some(d => d.placed) ? 'Retry remaining orders' : 'Place all daily orders'}</button></div>
    </div>}
    {plan.phase === 'complete' && <div className={box + ' space-y-4'}>
      <h3 style={heading} className="text-xl font-bold">Your daily orders are placed</h3>
      <p>{ordered.length} order(s) · AED {money(total)} total</p>
      <ul className="space-y-1 text-sm">{ordered.map(d => <li key={d.date}>{fmt(d.date)} · {d.window} · AED {money(dayTotal(d))}</li>)}</ul>
      <div className="flex flex-wrap gap-3"><button type="button" className={primary} onClick={onViewOrders}>View my orders</button><button type="button" className={secondary} onClick={() => { setPlan(initial(earliestDate)); setError(''); }}>Start another plan</button></div>
    </div>}
  </section>;
}
