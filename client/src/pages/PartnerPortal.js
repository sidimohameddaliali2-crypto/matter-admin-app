import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import jsPDF from 'jspdf';
import { partnerLogout } from '../store/slices/partnerAuthSlice';
import partnerApi from '../utils/partnerApi';
import { FIXED_SELECTION_DEADLINES, isPastSelectionDeadline } from '../utils/selectionDeadlines';
import { groupExclusions } from '../constants/exclusionList';

/*  MATTER — Partner portal
 *  Dark navy / lime brand. Design source: "MATTER Partner.dc.html" (mobile)
 *  and "MATTER Partner Desktop.dc.html" (>= lg: sidebar + main + checkout rail).
 *  Wired to the real partner API (/partner/menu, /partner/orders, /partner/reports).
 *
 *  Render helpers below are plain functions (renderX()), not nested components,
 *  so they don't remount the subtree on every parent render.
 */

// ─── helpers ────────────────────────────────────────────────────────────────
const AB = { fontFamily: "'Archivo Black', sans-serif" };
const SANS = { fontFamily: "'Archivo', system-ui, sans-serif" };

const fmtAED = (n) => {
  const v = Number(n || 0);
  return Number.isInteger(v)
    ? v.toLocaleString('en-US')
    : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const toISO = (d) => d.toLocaleDateString('en-CA');           // YYYY-MM-DD, local
const fmtDay = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const initials = (s = '') =>
  s.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'M';
// Menu item name display: every word capitalised ("Title Case")
const titleCase = (s = '') => String(s).trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
// Category display order: Oats, Wraps/Buns, Snack, Bowl, Main (Bowl wasn't
// in the list given — placed just before Main since it's not mentioned).
const MEAL_TYPE_LABEL = { oats: 'Oats', 'wraps-buns': 'Wraps/Buns', snack: 'Snack', bowl: 'Bowl', main: 'Main' };
// Main meals are further split by protein (the category tag set by the Menu
// Selection sync) so a partner can jump straight to chicken/beef/fish.
const MAIN_PROTEIN_ORDER = ['Chicken', 'Beef', 'Fish'];
const abbr = (s = '') => {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || parts[0]?.[1] || '')).toUpperCase() || '·';
};

// Available delivery windows — partner picks one per order.
const DELIVERY_WINDOWS = ['Morning · 5–6am', 'Morning · 7–10am'];

const buildCalendar = (year, month) => {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Mon = 0
  const nDays = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= nDays; d++) cells.push(new Date(year, month, d));
  return cells;
};

// No deliveries on Sunday
const isSunday = (iso) => new Date(iso + 'T00:00:00').getDay() === 0;

// Use the same Dubai-time calculation as customer Menu Selection.
const isPastOrderDeadline = (iso) => isPastSelectionDeadline(iso, FIXED_SELECTION_DEADLINES);

// earliest orderable date — the first day (not Sunday, not past its own deadline)
const firstOrderableISO = () => {
  const d = new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' })}T00:00:00`);
  let iso = toISO(d);
  while (isSunday(iso) || isPastOrderDeadline(iso)) { d.setDate(d.getDate() + 1); iso = toISO(d); }
  return iso;
};

const STATUS = {
  submitted: { label: 'Scheduled', bg: '#bcf679', color: '#051747' },
  draft: { label: 'Draft', bg: '#12275e', color: '#a8ccf5' },
  locked: { label: 'Locked', bg: '#12275e', color: '#a8ccf5' },
  delivered: { label: 'Delivered', bg: '#12275e', color: '#a8ccf5' },
  cancelled: { label: 'Cancelled', bg: 'rgba(255,59,0,.16)', color: '#ff8a66' },
};
const statusOf = (s) => STATUS[s] || { label: s || '—', bg: '#12275e', color: '#a8ccf5' };

const orderTotal = (o) =>
  (o.lines || []).reduce((s, l) => s + (Number(l.unitPrice ?? l.menuItem?.price) || 0) * l.quantity, 0);
const orderItemsLine = (o) =>
  (o.lines || []).map((l) => `${l.quantity}× ${titleCase(l.menuItem?.name || l.itemName) || 'Item'}`).join(', ') || 'No items';

const NAV_ICON = {
  order: 'M3 5h18v16H3zM3 10h18M8 3v4M16 3v4',
  orders: 'M4 7h16M4 12h16M4 17h10',
  members: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M17 11a3 3 0 1 0-2-5.2M21 20a6 6 0 0 0-6-6',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
};
const TABS = ['order', 'orders', 'members', 'profile'];
const CATEGORY_LABEL = { retail: 'MATTER RETAIL', member: 'MATTER MEMBER', partner: 'MATTER PARTNER' };
const TITLE = { order: 'New Order', orders: 'My Orders', members: 'Members', profile: 'Profile' };
const NAV_LABEL = { order: 'New Order', orders: 'My Orders', members: 'Members', profile: 'Profile' };

const useIsDesktop = () => {
  const q = '(min-width: 1024px)';
  const [is, setIs] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(q).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = (e) => setIs(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return is;
};

// ════════════════════════════════════════════════════════════════════════════
const PartnerPortal = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const partner = useSelector((state) => state.partnerAuth.partner);
  const minOrder = partner?.minimumOrder ?? 0;
  const isDesktop = useIsDesktop();

  const [tab, setTab] = useState('order');

  // order flow
  const now = useMemo(() => new Date(), []);
  const [calY, setCalY] = useState(now.getFullYear());
  const [calM, setCalM] = useState(now.getMonth());
  const [selectedDates, setSelectedDates] = useState(() => new Set([firstOrderableISO()])); // always exactly one day — single-day ordering only
  const [cart, setCart] = useState({}); // { [menuItemId]: qty }
  const [editing, setEditing] = useState(null); // { id, date, ref, originalIds } while editing an existing order
  const [deliveryWindow, setDeliveryWindow] = useState(DELIVERY_WINDOWS[0]);
  const [sheet, setSheet] = useState(null); // null | 'checkout'  (mobile only)
  const [placing, setPlacing] = useState(false);
  const [orderErr, setOrderErr] = useState('');
  const [done, setDone] = useState(null);

  // data
  const [menu, setMenu] = useState([]);
  const [menuLoading, setMenuLoading] = useState(false);
  const [menuTypeFilter, setMenuTypeFilter] = useState('all');
  const [orders, setOrders] = useState([]);
  const [ordersView, setOrdersView] = useState('up'); // 'up' | 'past'
  const [reports, setReports] = useState(null);
  const [copied, setCopied] = useState(false);

  // members
  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [invite, setInvite] = useState(null); // { inviteToken, joinUrl }
  const [linkCopied, setLinkCopied] = useState(false);
  const qrRef = useRef(null);

  const todayISO = toISO(new Date());

  // ── loaders ───────────────────────────────────────────────────────────────
  const loadMenu = useCallback(async (date) => {
    setMenuLoading(true);
    try {
      const res = await partnerApi.get(`/partner/menu?date=${date}`);
      setMenu(res.data.data || []);
    } catch {
      setMenu([]);
    } finally {
      setMenuLoading(false);
    }
  }, []);

  const loadOrders = useCallback(async () => {
    try {
      const res = await partnerApi.get('/partner/orders');
      setOrders(res.data.data || []);
    } catch {
      /* silent */
    }
  }, []);

  const loadReports = useCallback(async () => {
    try {
      const res = await partnerApi.get('/partner/reports');
      setReports(res.data.data);
    } catch {
      /* silent */
    }
  }, []);

  const loadMembers = useCallback(async () => {
    setMembersLoading(true);
    try {
      const [mRes, tRes] = await Promise.all([
        partnerApi.get('/partner/members'),
        partnerApi.get('/partner/members/invite-token'),
      ]);
      setMembers(mRes.data.data || []);
      let inviteData = tRes.data.data;
      if (!inviteData?.inviteToken) {
        const cRes = await partnerApi.post('/partner/members/invite-token');
        inviteData = cRes.data.data;
      }
      setInvite(inviteData);
    } catch {
      /* silent */
    } finally {
      setMembersLoading(false);
    }
  }, []);

  // The one selected delivery day (a Set for symmetry with how it's stored/
  // compared elsewhere, but ordering only ever has a single day selected).
  const sortedSelected = useMemo(() => Array.from(selectedDates).sort(), [selectedDates]);
  const anchorDate = sortedSelected[0] || firstOrderableISO();

  useEffect(() => { loadOrders(); }, [loadOrders]);
  useEffect(() => { if (tab === 'order') loadMenu(anchorDate); }, [tab, anchorDate, loadMenu]);
  useEffect(() => { if (tab === 'profile' && !reports) loadReports(); }, [tab, reports, loadReports]);
  useEffect(() => { if (tab === 'members') loadMembers(); }, [tab, loadMembers]);

  // ── derived ───────────────────────────────────────────────────────────────
  const ordersByDate = useMemo(() => {
    const map = {};
    orders.forEach((o) => {
      if (o.status === 'cancelled') return;
      const key = toISO(new Date(o.deliveryDate));
      (map[key] = map[key] || []).push(o);
    });
    return map;
  }, [orders]);

  const subtotal = useMemo(
    () => menu.reduce((t, m) => t + (cart[m._id] || 0) * (Number(m.price) || 0), 0),
    [menu, cart]
  );
  const count = useMemo(() => Object.values(cart).reduce((a, b) => a + b, 0), [cart]);
  const cartLines = useMemo(
    () => menu.filter((m) => cart[m._id]).map((m) => ({ ...m, qty: cart[m._id], line: cart[m._id] * (Number(m.price) || 0) })),
    [menu, cart]
  );

  const upcoming = useMemo(
    () =>
      orders
        .filter((o) => toISO(new Date(o.deliveryDate)) >= todayISO && o.status !== 'cancelled')
        .sort((a, b) => new Date(a.deliveryDate) - new Date(b.deliveryDate)),
    [orders, todayISO]
  );
  const past = useMemo(
    () =>
      orders
        .filter((o) => toISO(new Date(o.deliveryDate)) < todayISO || o.status === 'cancelled')
        .sort((a, b) => new Date(b.deliveryDate) - new Date(a.deliveryDate)),
    [orders, todayISO]
  );
  const orderList = ordersView === 'up' ? upcoming : past;
  const existingDays = useMemo(() => sortedSelected.filter((d) => ordersByDate[d]?.length), [sortedSelected, ordersByDate]);
  const monthLabel = new Date(calY, calM, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  // ── actions ───────────────────────────────────────────────────────────────
  const prevMonth = () => (calM === 0 ? (setCalY(calY - 1), setCalM(11)) : setCalM(calM - 1));
  const nextMonth = () => (calM === 11 ? (setCalY(calY + 1), setCalM(0)) : setCalM(calM + 1));
  const toggleDay = (iso) => {
    if (editing) return; // an existing order is edited on its own day
    if (isSunday(iso) || isPastOrderDeadline(iso)) return; // no deliveries on Sunday, or past that day's deadline
    setOrderErr('');
    setSelectedDates(new Set([iso]));
  };
  const inc = (id) => { setOrderErr(''); setCart((c) => ({ ...c, [id]: (c[id] || 0) + 1 })); };
  const dec = (id) =>
    setCart((c) => {
      const q = Math.max(0, (c[id] || 0) - 1);
      const next = { ...c };
      if (q === 0) delete next[id]; else next[id] = q;
      return next;
    });

  // Load an existing order's meals into the cart so the partner can change them
  const startEdit = (o) => {
    const date = toISO(new Date(o.deliveryDate));
    const next = {};
    (o.lines || []).forEach((l) => {
      const id = l.menuItem?._id || l.menuItem;
      if (id && l.quantity > 0) next[id] = l.quantity;
    });
    setEditing({ id: o._id, date, ref: `PO-${String(o._id).slice(-4).toUpperCase()}`, originalIds: Object.keys(next) });
    setSelectedDates(new Set([date]));
    setCart(next);
    setDeliveryWindow(DELIVERY_WINDOWS.includes(o.deliveryTime) ? o.deliveryTime : DELIVERY_WINDOWS[0]);
    setOrderErr('');
    setSheet(null);
    setTab('order');
  };
  const cancelEdit = () => {
    setEditing(null);
    setCart({});
    setDeliveryWindow(DELIVERY_WINDOWS[0]);
    setOrderErr('');
  };
  const cancelOrder = async (o) => {
    if (!window.confirm(`Cancel order PO-${String(o._id).slice(-4).toUpperCase()}?`)) return;
    try {
      await partnerApi.post(`/partner/orders/${o._id}/cancel`);
      if (editing?.id === o._id) cancelEdit();
      loadOrders();
      setReports(null);
    } catch (e) {
      window.alert(e.response?.data?.message || 'Could not cancel the order.');
    }
  };

  // Client-side invoice PDF from the partner invoice detail
  const downloadInvoice = async (o) => {
    try {
      const res = await partnerApi.get(`/partner/invoices/${o.invoice._id}`);
      const inv = res.data.data;
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const right = 555;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(22);
      doc.text('MATTER', 40, 56);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.text('Partner invoice', 40, 72);
      doc.text(`Invoice no: ${inv.invoiceNumber}`, right, 56, { align: 'right' });
      doc.text(`Order: PO-${String(o._id).slice(-4).toUpperCase()}`, right, 72, { align: 'right' });
      doc.text(`Delivery date: ${fmtDay(toISO(new Date(o.deliveryDate)))}`, right, 88, { align: 'right' });
      doc.text(`Billed to: ${partner?.businessName || ''}`, 40, 120);

      let y = 160;
      doc.setFont('helvetica', 'bold');
      doc.text('Item', 40, y);
      doc.text('Qty', 360, y, { align: 'right' });
      doc.text('Unit (AED)', 440, y, { align: 'right' });
      doc.text('Amount (AED)', right, y, { align: 'right' });
      y += 8;
      doc.line(40, y, right, y);
      y += 18;
      doc.setFont('helvetica', 'normal');
      (inv.lines || []).forEach((l) => {
        doc.text(titleCase(l.itemName) || 'Item', 40, y);
        doc.text(String(l.quantity), 360, y, { align: 'right' });
        doc.text(fmtAED(l.unitPrice), 440, y, { align: 'right' });
        doc.text(fmtAED(l.lineRevenue), right, y, { align: 'right' });
        y += 18;
      });
      y += 6;
      doc.line(40, y, right, y);
      y += 20;
      doc.setFont('helvetica', 'bold');
      doc.text('Total', 440, y, { align: 'right' });
      doc.text(`AED ${fmtAED(inv.totalRevenue)}`, right, y, { align: 'right' });

      doc.save(`${inv.invoiceNumber}.pdf`);
    } catch (e) {
      window.alert(e.response?.data?.message || 'Could not download the invoice.');
    }
  };

  const openCheckout = () => {
    if (subtotal < minOrder) {
      setOrderErr(`Minimum order is AED ${fmtAED(minOrder)} — you're at AED ${fmtAED(subtotal)}.`);
      return;
    }
    setOrderErr('');
    setSheet('checkout');
  };

  const placeOrder = async () => {
    if (subtotal < minOrder) {
      setOrderErr(`Minimum order is AED ${fmtAED(minOrder)} — you're at AED ${fmtAED(subtotal)}.`);
      return;
    }
    setPlacing(true);
    setOrderErr('');
    const lines = menu.filter((m) => cart[m._id]).map((m) => ({ menuItemId: m._id, quantity: cart[m._id] }));
    // Meals removed while editing are sent as quantity 0 so the server drops them
    if (editing) {
      editing.originalIds.forEach((id) => {
        if (!cart[id] && !lines.some((l) => l.menuItemId === id)) lines.push({ menuItemId: id, quantity: 0 });
      });
    }
    const results = [];
    const dates = editing ? [editing.date] : sortedSelected;
    for (const date of dates) {
      try {
        const r = await partnerApi.post('/partner/orders', {
          deliveryDate: date,
          lines,
          notes: '',
          deliveryTime: deliveryWindow,
        });
        try {
          await partnerApi.post(`/partner/orders/${r.data.data._id}/submit`);
        } catch (e) {
          const msg = e.response?.data?.message || '';
          if (!/already submitted/i.test(msg)) throw e;
        }
        results.push({ date, ok: true });
      } catch (e) {
        results.push({ date, ok: false, message: e.response?.data?.message || 'Failed' });
      }
    }
    setPlacing(false);

    const okResults = results.filter((r) => r.ok);
    const failResults = results.filter((r) => !r.ok);
    if (okResults.length > 0) {
      setDone({
        count: okResults.length,
        days: okResults.map((r) => fmtDay(r.date)),
        win: deliveryWindow,
        perDay: subtotal,
        total: subtotal * okResults.length,
        failed: failResults.map((r) => `${fmtDay(r.date)}: ${r.message}`),
      });
      setCart({});
      setEditing(null);
      setDeliveryWindow(DELIVERY_WINDOWS[0]);
      setSheet(null);
      loadOrders();
      setReports(null);
    } else {
      setOrderErr(failResults.map((r) => `${fmtDay(r.date)}: ${r.message}`).join(' · ') || 'Could not place the order. Try again.');
    }
  };

  const copyCode = () => {
    try { navigator.clipboard?.writeText(partner?.email || ''); } catch { /* noop */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const logout = () => { dispatch(partnerLogout()); navigate('/partner/login'); };

  const card = 'bg-[#051747] border border-[#12275e] rounded-[20px]';

  // ── render helpers (plain functions) ──────────────────────────────────────
  const renderCalendar = ({ cellH = 46, radius = 14 }) => (
    <>
      <div className="flex items-center gap-2">
        <button onClick={prevMonth} aria-label="Previous month"
          className="w-9 h-9 rounded-full bg-[#0a1230] border-[1.5px] border-[#12275e] text-[#ede5de] text-[15px] hover:border-[#bcf679] transition-colors">‹</button>
        <div className="flex-1 text-center text-[15px]" style={AB}>{monthLabel}</div>
        <button onClick={nextMonth} aria-label="Next month"
          className="w-9 h-9 rounded-full bg-[#0a1230] border-[1.5px] border-[#12275e] text-[#ede5de] text-[15px] hover:border-[#bcf679] transition-colors">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 mt-3.5 text-center text-[10px] font-bold tracking-[0.1em] text-[#a8ccf5]">
        {['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].map((d) => <div key={d}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1 mt-1.5">
        {buildCalendar(calY, calM).map((d, i) => {
          if (!d) return <div key={i} style={{ height: cellH }} />;
          const iso = toISO(d);
          const disabled = isSunday(iso) || isPastOrderDeadline(iso);
          const isSel = selectedDates.has(iso);
          const isToday = iso === todayISO;
          const has = !!ordersByDate[iso];
          return (
            <button key={i} disabled={disabled} onClick={() => toggleDay(iso)}
              className="relative border-[1.5px] font-bold transition-colors disabled:cursor-default"
              style={{
                height: cellH,
                borderRadius: radius,
                fontSize: cellH >= 44 ? 14 : 12.5,
                borderColor: isSel ? '#bcf679' : isToday ? '#a8ccf5' : '#12275e',
                background: isSel ? '#bcf679' : '#051747',
                color: isSel ? '#051747' : '#ede5de',
                opacity: disabled ? 0.35 : 1,
              }}>
              {d.getDate()}
              <span className="absolute left-1/2 bottom-[4px] -translate-x-1/2 w-[4px] h-[4px] rounded-full"
                style={{ background: has ? (isSel ? '#051747' : '#bcf679') : 'transparent' }} />
            </button>
          );
        })}
      </div>
    </>
  );

  const renderDeliverOn = ({ dark = false } = {}) => (
    <div className={`flex flex-col gap-2.5 rounded-[16px] px-3.5 py-3 ${dark ? 'bg-[#0a1230] border-[1.5px] border-[#12275e]' : card}`}>
      <div>
        <div className="text-[9.5px] font-bold tracking-[0.12em] uppercase text-[#a8ccf5]">Deliver on</div>
        <div className="text-sm font-bold mt-0.5">{fmtDay(anchorDate)}</div>
      </div>
      <div>
        <div className="text-[9.5px] font-bold tracking-[0.12em] uppercase text-[#a8ccf5] mb-1.5">Window</div>
        <div className="flex gap-1.5">
          {DELIVERY_WINDOWS.map((w) => {
            const on = deliveryWindow === w;
            return (
              <button key={w} type="button" onClick={() => setDeliveryWindow(w)}
                className="flex-1 rounded-full px-3 py-2 text-[12px] font-bold border-[1.5px] transition-colors"
                style={{
                  borderColor: on ? '#bcf679' : '#12275e',
                  background: on ? '#bcf679' : (dark ? '#051747' : '#0a1230'),
                  color: on ? '#051747' : '#ede5de',
                }}>
                {w}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );

  const renderExistingBanner = () =>
    editing ? (
      <div className="mt-2.5 flex items-center gap-2.5 rounded-[14px] px-3 py-2.5 text-[11.5px] leading-snug"
        style={{ background: 'rgba(188,246,121,.1)', border: '1.5px solid #bcf679' }}>
        <span className="w-[7px] h-[7px] rounded-full bg-[#bcf679] flex-none" />
        <span className="flex-1">Editing {editing.ref} on {fmtDay(editing.date)}. Save to update it.</span>
        <button onClick={cancelEdit} className="font-bold text-[#bcf679] underline">Stop editing</button>
      </div>
    ) : existingDays.length > 0 ? (
      <div className="mt-2.5 flex items-start gap-2.5 rounded-[14px] px-3 py-2.5 text-[11.5px] leading-snug"
        style={{ background: 'rgba(188,246,121,.1)', border: '1.5px solid #bcf679' }}>
        <span className="w-[7px] h-[7px] rounded-full bg-[#bcf679] flex-none mt-1" />
        {existingDays.length === 1
          ? <>You already have {ordersByDate[existingDays[0]].length} order{ordersByDate[existingDays[0]].length > 1 ? 's' : ''} on {fmtDay(existingDays[0])} — new items merge into it.</>
          : <>You already have orders on {existingDays.length} of your {sortedSelected.length} selected days ({existingDays.map(fmtDay).join(', ')}) — new items merge into them.</>}
      </div>
    ) : null;

  const renderMenuCard = (m) => {
    const q = cart[m._id] || 0;
    return (
      <div key={m._id} className="flex items-center gap-3 bg-[#051747] rounded-[18px] px-3.5 py-3.5 border-[1.5px]"
        style={{ borderColor: q ? '#bcf679' : '#12275e' }}>
        <div className="w-[42px] h-[42px] rounded-[13px] flex items-center justify-center flex-none text-[14px]"
          style={{ background: q ? '#bcf679' : '#12275e', color: q ? '#051747' : '#a8ccf5', ...AB }}>
          {abbr(m.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-bold truncate">{titleCase(m.name)}</div>
          {m.mealType && (
            <div className="inline-block mt-1 rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide"
              style={{ background: '#12275e', color: '#a8ccf5' }}>
              {MEAL_TYPE_LABEL[m.mealType] || m.mealType}
            </div>
          )}
          {(m.description || m.category) && (
            <div className="text-[11px] text-[#a8ccf5] mt-0.5 line-clamp-2">{m.description || m.category}</div>
          )}
          <div className="text-[12px] font-bold text-[#bcf679] mt-1">
            {m.price != null ? `AED ${fmtAED(m.price)}` : 'Price TBD'}
          </div>
        </div>
        <div className="flex items-center gap-0.5 bg-[#0a1230] rounded-full p-0.5 flex-none">
          <button onClick={() => dec(m._id)} aria-label="Remove one"
            className="w-[30px] h-[30px] rounded-full text-[#ede5de] text-[17px] hover:bg-[#12275e] transition-colors">−</button>
          <span className="min-w-[18px] text-center text-[13px] font-bold" style={{ color: q ? '#bcf679' : '#a8ccf5' }}>{q}</span>
          <button onClick={() => inc(m._id)} aria-label="Add one" disabled={m.price == null}
            className="w-[30px] h-[30px] rounded-full bg-[#bcf679] text-[#051747] text-[17px] hover:opacity-90 transition-opacity disabled:opacity-40">+</button>
        </div>
      </div>
    );
  };

  // Shared by both the desktop and mobile layouts (just a different `cols`),
  // so organizing it by category here covers both at once.
  // Filter chips above the menu — All plus one per meal type actually
  // available that day, each with a live count.
  const renderMenuFilters = () => {
    if (menuLoading || menu.length === 0) return null;
    const chips = [['all', 'All', menu.length], ...Object.keys(MEAL_TYPE_LABEL)
      .map((t) => [t, MEAL_TYPE_LABEL[t], menu.filter((m) => m.mealType === t).length])
      .filter(([, , n]) => n > 0)];
    return (
      <div className="flex flex-wrap gap-1.5 mb-3.5">
        {chips.map(([t, label, n]) => {
          const on = menuTypeFilter === t;
          return (
            <button key={t} onClick={() => setMenuTypeFilter(t)}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-bold transition-colors"
              style={{ background: on ? '#bcf679' : '#0a1230', color: on ? '#051747' : '#a8ccf5', border: '1.5px solid', borderColor: on ? '#bcf679' : '#12275e' }}>
              {label}
              <span className="rounded-full px-1.5 text-[10px]" style={{ background: on ? 'rgba(5,23,71,.15)' : 'rgba(255,255,255,.08)' }}>{n}</span>
            </button>
          );
        })}
      </div>
    );
  };

  const renderMenuGrid = (cols) => {
    if (menuLoading) return <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 animate-spin text-[#bcf679]" /></div>;
    if (menu.length === 0)
      return <div className={`${card} px-4 py-10 text-center text-[13px] text-[#a8ccf5]`}>No menu items available for {fmtDay(anchorDate)}.</div>;

    const typeGroups = Object.keys(MEAL_TYPE_LABEL)
      .filter((t) => menuTypeFilter === 'all' || menuTypeFilter === t)
      .map((t) => ({ type: t, label: MEAL_TYPE_LABEL[t], items: menu.filter((m) => m.mealType === t) }))
      .filter((g) => g.items.length > 0);

    return (
      <div className="flex flex-col gap-5">
        {typeGroups.map((g) => (
          <div key={g.type}>
            <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-[#a8ccf5] mb-2.5">{g.label}</div>
            {g.type === 'main' ? (
              <div className="flex flex-col gap-4">
                {MAIN_PROTEIN_ORDER.map((catName) => {
                  const items = g.items.filter((m) => m.category === catName);
                  if (!items.length) return null;
                  return (
                    <div key={catName}>
                      <div className="flex items-center gap-1.5 mb-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#bcf679]" />
                        <div className="text-[10px] font-bold tracking-[0.1em] uppercase text-[#bcf679]">{catName}</div>
                      </div>
                      <div className={`grid ${cols} gap-3`}>{items.map(renderMenuCard)}</div>
                    </div>
                  );
                })}
                {(() => {
                  const other = g.items.filter((m) => !MAIN_PROTEIN_ORDER.includes(m.category));
                  return other.length ? <div className={`grid ${cols} gap-3`}>{other.map(renderMenuCard)}</div> : null;
                })()}
              </div>
            ) : (
              <div className={`grid ${cols} gap-3`}>{g.items.map(renderMenuCard)}</div>
            )}
          </div>
        ))}
      </div>
    );
  };

  const renderOrderCard = (o) => {
    const st = statusOf(o.status);
    return (
      <div key={o._id} className="bg-[#051747] rounded-[18px] px-4 py-4 border-[1.5px] border-[#12275e]">
        <div className="flex items-center gap-2.5">
          <div className="text-xs font-bold text-[#a8ccf5]">PO-{String(o._id).slice(-4).toUpperCase()}</div>
          <span className="ml-auto rounded-full px-2.5 py-1 text-[11px] font-bold" style={{ background: st.bg, color: st.color }}>{st.label}</span>
        </div>
        <div className="text-[14.5px] font-bold mt-2">
          {fmtDay(toISO(new Date(o.deliveryDate)))}{o.deliveryTime ? ` · ${o.deliveryTime}` : ''}
        </div>
        <div className="text-[12px] text-[#a8ccf5] mt-1 leading-relaxed">{orderItemsLine(o)}</div>
        <div className="flex items-center gap-2 mt-2.5 text-[13px] font-bold">
          <span>AED {fmtAED(orderTotal(o))}</span>
          <span className="text-[#a8ccf5] font-medium">· {o.lines?.length || 0} line{(o.lines?.length || 0) !== 1 ? 's' : ''}</span>
        </div>
        {(o.editable || o.invoice) && (
          <div className="flex flex-wrap gap-2 mt-3">
            {o.editable && (
              <button onClick={() => startEdit(o)}
                className="rounded-full px-3.5 py-2 text-[12px] font-bold uppercase tracking-wide border-[1.5px] border-[#bcf679] text-[#bcf679] hover:bg-[#bcf679]/10 transition-colors">
                Edit meals
              </button>
            )}
            {o.editable && (
              <button onClick={() => cancelOrder(o)}
                className="rounded-full px-3.5 py-2 text-[12px] font-bold uppercase tracking-wide border-[1.5px] border-[#ff3b00] text-[#ff8a66] hover:bg-[#ff3b00]/10 transition-colors">
                Cancel order
              </button>
            )}
            {o.invoice && (
              <button onClick={() => downloadInvoice(o)}
                className="rounded-full px-3.5 py-2 text-[12px] font-bold bg-[#bcf679] text-[#051747] hover:opacity-90 transition-opacity">
                Download invoice · {o.invoice.invoiceNumber}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderOrdersToggle = (w = 'w-full') => (
    <div className={`flex gap-1 bg-[#0a1230] border-[1.5px] border-[#12275e] rounded-full p-1 ${w}`}>
      {[['up', 'Upcoming'], ['past', 'Past']].map(([v, label]) => {
        const on = ordersView === v;
        return (
          <button key={v} onClick={() => setOrdersView(v)}
            className="flex-1 py-2.5 rounded-full text-[13px] font-bold transition-colors"
            style={{ background: on ? '#bcf679' : 'transparent', color: on ? '#051747' : '#a8ccf5' }}>
            {label}
          </button>
        );
      })}
    </div>
  );

  const renderOrdersList = (grid) => (
    <div className={grid}>
      {orderList.length === 0 && (
        <div className={`${card} px-4 py-12 text-center text-[13px] text-[#a8ccf5]`}>
          {ordersView === 'up' ? 'No upcoming orders.' : 'No past orders yet.'}
        </div>
      )}
      {orderList.map(renderOrderCard)}
    </div>
  );

  const perfStats = [
    { label: 'Orders placed', value: reports ? reports.orderCount ?? 0 : '—', color: '#ede5de' },
    { label: 'Total spent', value: reports ? `AED ${fmtAED(reports.totalSpend)}` : '—', color: '#bcf679' },
    { label: 'Invoices', value: reports ? reports.invoiceCount ?? 0 : '—', color: '#ede5de' },
    { label: 'Upcoming', value: upcoming.length, color: '#ede5de' },
  ];

  const renderProfileContent = (perfCols) => (
    <>
      <div className="flex items-center gap-3.5">
        {partner?.profilePicture
          ? <img src={partner.profilePicture} alt="" className="w-[60px] h-[60px] rounded-full object-cover flex-none" />
          : (
            <div className="w-[60px] h-[60px] rounded-full bg-[#12275e] text-[#bcf679] flex items-center justify-center flex-none text-[22px]" style={AB}>
              {initials(partner?.businessName)}
            </div>
          )}
        <div className="min-w-0">
          <div className="text-[18px]" style={AB}>{partner?.businessName || 'Partner'}</div>
          {partner?.address && <div className="text-[12.5px] text-[#a8ccf5] mt-0.5">{partner.address}</div>}
          <div className="text-[12.5px] text-[#a8ccf5]">
            {[partner?.contactName, partner?.phone].filter(Boolean).join(' · ') || partner?.email}
          </div>
        </div>
      </div>

      <div className="mt-4 bg-[#051747] border-[1.5px] border-[#12275e] rounded-[22px] px-[18px] py-4 max-w-[640px]">
        <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-[#a8ccf5]">Account</div>
        <div className="flex items-center gap-2.5 mt-2">
          <div className="text-[20px] truncate" style={{ ...AB, color: '#bcf679' }}>{partner?.email}</div>
          <button onClick={copyCode}
            className="ml-auto flex-none rounded-full px-3.5 py-2 text-[12.5px] font-bold border-[1.5px] transition-colors"
            style={{
              background: copied ? '#bcf679' : '#0a1230',
              borderColor: copied ? '#bcf679' : '#12275e',
              color: copied ? '#051747' : '#ede5de',
            }}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <div className="flex gap-2 mt-3.5">
          <div className="flex-1 bg-[#0a1230] rounded-[14px] px-3 py-2.5">
            <div className="text-[10px] font-bold tracking-[0.1em] uppercase text-[#a8ccf5]">Min. order</div>
            <div className="text-[19px] font-bold mt-0.5">AED {fmtAED(minOrder)}</div>
          </div>
          <div className="flex-1 bg-[#0a1230] rounded-[14px] px-3 py-2.5">
            <div className="text-[10px] font-bold tracking-[0.1em] uppercase text-[#a8ccf5]">Type</div>
            <div className="text-[19px] font-bold mt-0.5 capitalize">{partner?.businessType || '—'}</div>
          </div>
        </div>
      </div>

      <div className="flex justify-between items-baseline mt-6 mb-2.5">
        <div className="text-[13px] tracking-[0.12em] uppercase text-[#a8ccf5]">Performance</div>
        <div className="text-[12.5px] text-[#a8ccf5]">All time</div>
      </div>
      <div className={`grid ${perfCols} gap-2.5 max-w-[900px]`}>
        {perfStats.map((s) => (
          <div key={s.label} className="bg-[#051747] border-[1.5px] border-[#12275e] rounded-[18px] px-4 py-3.5">
            <div className="text-[10px] font-bold tracking-[0.1em] uppercase text-[#a8ccf5]">{s.label}</div>
            <div className="text-[21px] mt-1.5" style={{ ...AB, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {reports?.topItems?.length > 0 && (
        <>
          <div className="text-[13px] tracking-[0.12em] uppercase text-[#a8ccf5] mt-6 mb-2.5">Top items</div>
          <div className={`${card} px-4 py-3.5 flex flex-col gap-2 max-w-[640px]`}>
            {reports.topItems.slice(0, 5).map((it, i) => (
              <div key={i} className="flex justify-between text-[13px]">
                <span className="text-[#ede5de]">{it._id}</span>
                <span className="font-bold text-[#a8ccf5]">{it.totalQty} units</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );

  const downloadQR = () => {
    const canvas = qrRef.current?.querySelector('canvas');
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'member-join-qr.png';
    a.click();
  };

  const copyJoinLink = () => {
    if (!invite?.joinUrl) return;
    try { navigator.clipboard?.writeText(invite.joinUrl); } catch { /* noop */ }
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1600);
  };

  const renderMembers = () => (
    <div className="max-w-[640px]">
      <div className="text-[13px] tracking-[0.12em] uppercase text-[#a8ccf5] mb-2.5">Invite link</div>
      {membersLoading && !invite ? (
        <div className="flex justify-center py-12"><Loader2 className="w-7 h-7 animate-spin text-[#bcf679]" /></div>
      ) : (
        <div className={`${card} p-[18px] flex flex-col sm:flex-row gap-4 items-start`}>
          <div ref={qrRef} className="bg-white rounded-[14px] p-2.5 flex-none">
            {invite?.joinUrl && <QRCodeCanvas value={invite.joinUrl} size={160} includeMargin={false} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] text-[#a8ccf5] leading-relaxed">
              Clients scan this code to join {partner?.businessName || 'you'} as a member. It stays the same — print it or share the link.
            </div>
            <div className="mt-3 bg-[#0a1230] border-[1.5px] border-[#12275e] rounded-[12px] px-3 py-2 text-[11.5px] text-[#ede5de] break-all">
              {invite?.joinUrl || '—'}
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={copyJoinLink}
                className="rounded-full px-3.5 py-2 text-[12.5px] font-bold border-[1.5px] transition-colors"
                style={{
                  background: linkCopied ? '#bcf679' : '#0a1230',
                  borderColor: linkCopied ? '#bcf679' : '#12275e',
                  color: linkCopied ? '#051747' : '#ede5de',
                }}>
                {linkCopied ? 'Copied ✓' : 'Copy link'}
              </button>
              <button onClick={downloadQR}
                className="rounded-full px-3.5 py-2 text-[12.5px] font-bold border-[1.5px] border-[#12275e] text-[#ede5de] hover:border-[#bcf679] transition-colors">
                Download QR
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-between items-baseline mt-6 mb-2.5">
        <div className="text-[13px] tracking-[0.12em] uppercase text-[#a8ccf5]">Members</div>
        <div className="text-[12.5px] text-[#a8ccf5]">{members.length} joined</div>
      </div>
      {members.length === 0 ? (
        <div className={`${card} px-4 py-10 text-center text-[13px] text-[#a8ccf5]`}>No members yet.</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {members.map((m) => {
            const chips = groupExclusions(m.dietaryExclusions || '');
            return (
              <div key={m._id} className="flex items-start gap-3 bg-[#051747] rounded-[18px] px-4 py-3.5 border-[1.5px] border-[#12275e]">
                <div className="w-11 h-11 rounded-[14px] flex items-center justify-center flex-none text-[14px]"
                  style={{ background: m.isActive ? '#bcf679' : '#12275e', color: m.isActive ? '#051747' : '#a8ccf5', ...AB }}>
                  {initials(m.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5">
                    <div className="text-[14px] font-bold truncate">{m.name}</div>
                    {!m.isActive && (
                      <span className="rounded-full px-2 py-0.5 text-[10px] font-bold flex-none" style={{ background: 'rgba(255,59,0,.16)', color: '#ff8a66' }}>Inactive</span>
                    )}
                    <span className="ml-auto text-[11.5px] text-[#a8ccf5] flex-none">
                      {m.createdAt ? new Date(m.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}
                    </span>
                  </div>
                  <div className="text-[12px] text-[#a8ccf5] mt-0.5 truncate">{m.email}</div>
                  {chips.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {chips.map((c) => (
                        <span key={c} className="bg-[rgba(188,246,121,.15)] text-[#bcf679] px-2 py-0.5 rounded-full text-[10px] font-bold">{c}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  // checkout body — shared by the mobile sheet and the desktop rail
  const renderCheckoutBody = () => (
    <>
      <div className="flex flex-col gap-2">
        {cartLines.map((l) => (
          <div key={l._id} className="flex gap-2.5 text-[13px]">
            <span className="text-[#a8ccf5] font-bold min-w-[26px]">{l.qty}×</span>
            <span className="flex-1">{titleCase(l.name)}</span>
            <span className="font-bold">AED {fmtAED(l.line)}</span>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-1.5 text-[13px]">
        <div className="flex justify-between text-[#a8ccf5]"><span>{sortedSelected.length > 1 ? 'Per day' : 'Subtotal'}</span><span>AED {fmtAED(subtotal)}</span></div>
        {sortedSelected.length > 1 && (
          <div className="flex justify-between text-[#a8ccf5]"><span>Days</span><span>× {sortedSelected.length}</span></div>
        )}
        <div className="flex justify-between text-[#a8ccf5]"><span>Delivery</span><span className="text-[#bcf679] font-bold">Free · partner</span></div>
        <div className="flex justify-between items-baseline mt-1.5 pt-2.5 border-t border-[#12275e]">
          <span className="font-bold text-[15px]">Total</span>
          <span className="text-[23px]" style={AB}>AED {fmtAED(subtotal * sortedSelected.length)}</span>
        </div>
      </div>

      {orderErr && <p className="text-[#ff8a66] text-[12.5px] mt-3">{orderErr}</p>}

      <button onClick={placeOrder} disabled={placing}
        className="w-full mt-4 bg-[#bcf679] text-[#051747] rounded-full py-4 text-[15px] font-bold hover:opacity-90 transition-opacity disabled:opacity-60 flex items-center justify-center gap-2">
        {placing && <Loader2 className="w-4 h-4 animate-spin" />}
        {placing
          ? 'Placing…'
          : `Place ${sortedSelected.length > 1 ? `${sortedSelected.length} orders` : 'order'} · AED ${fmtAED(subtotal * sortedSelected.length)}`}
      </button>
    </>
  );

  const doneOverlay = (
    <AnimatePresence>
      {done && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] bg-[rgba(5,15,43,.94)] flex flex-col items-center justify-center px-8 text-center">
          <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 0.05 }}
            className="w-[88px] h-[88px] rounded-full bg-[#bcf679] text-[#051747] flex items-center justify-center">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7" />
            </svg>
          </motion.div>
          <div className="text-[28px] mt-5" style={AB}>{done.count > 1 ? `${done.count} orders placed` : 'Order placed'}</div>
          <div className="text-[14.5px] text-[#a8ccf5] mt-2 leading-relaxed">
            {done.sameWindow ? (
              <>{done.days.join(', ')}<br />{done.win}</>
            ) : (
              done.winByDate.map((d) => <div key={d.day}>{d.day} · {d.win}</div>)
            )}
            <br />
            {done.count > 1 ? `AED ${fmtAED(done.perDay)}/day · AED ${fmtAED(done.total)} total` : `AED ${fmtAED(done.total)}`}
          </div>
          {done.failed?.length > 0 && (
            <div className="mt-3 text-[12px] text-[#ff8a66] leading-relaxed">Couldn’t place for: {done.failed.join(' · ')}</div>
          )}
          <div className="flex gap-2.5 mt-8 w-full max-w-[360px]">
            <button onClick={() => { setDone(null); setTab('orders'); setOrdersView('up'); }}
              className="flex-1 border-[1.5px] border-[#12275e] text-[#ede5de] rounded-full py-3.5 text-sm font-bold hover:border-[#bcf679] transition-colors">
              View orders
            </button>
            <button onClick={() => { setDone(null); setTab('order'); }}
              className="flex-1 bg-[#bcf679] text-[#051747] rounded-full py-3.5 text-sm font-bold hover:opacity-90 transition-opacity">
              New order
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  // ════════════════════ DESKTOP ════════════════════
  if (isDesktop) {
    return (
      <div className="h-screen overflow-hidden bg-[#050f2b] text-[#ede5de] flex" style={SANS}>
        {/* sidebar */}
        <aside className="flex-none w-[236px] bg-[#051747] border-r border-[#12275e] flex flex-col px-4 py-[22px]">
          <div className="flex items-center gap-2.5 px-1.5">
            {partner?.profilePicture
              ? <img src={partner.profilePicture} alt="" className="w-9 h-9 rounded-[11px] object-cover flex-none" />
              : <div className="w-9 h-9 rounded-[11px] bg-[#bcf679] text-[#051747] flex items-center justify-center flex-none text-[18px]" style={AB}>{initials(partner?.businessName)}</div>}
            <div className="min-w-0 flex-1"><div className="truncate" style={AB}>{partner?.businessName || 'Partner'}</div><div className="text-[10px] font-bold tracking-[0.1em] text-[#bcf679] mt-0.5">{CATEGORY_LABEL[partner?.accountCategory] || 'MATTER PARTNER'}</div></div>
          </div>

          <nav className="flex flex-col gap-[3px] mt-[30px]">
            {TABS.map((id) => {
              const on = tab === id;
              return (
                <button key={id} onClick={() => setTab(id)}
                  className="flex items-center gap-3 text-left rounded-[14px] px-3 py-[11px] text-sm font-bold transition-colors hover:bg-[rgba(188,246,121,.1)]"
                  style={{ background: on ? 'rgba(188,246,121,.14)' : 'transparent', color: on ? '#bcf679' : '#a8ccf5' }}>
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="flex-none">
                    <path d={NAV_ICON[id]} />
                  </svg>
                  {NAV_LABEL[id]}
                </button>
              );
            })}
          </nav>
        </aside>

        {/* content-wrap */}
        <div className="flex flex-1 min-w-0 max-[1100px]:flex-col max-[1100px]:overflow-y-auto">
          {/* main */}
          <main className="flex-1 min-w-0 overflow-y-auto px-[34px] py-[30px] max-[1100px]:overflow-visible">
            {tab === 'order' && (
              <div>
                <div className="flex items-baseline gap-3">
                  <div className="text-[24px]" style={AB}>Plan your delivery</div>
                  <div className="text-[13px] text-[#a8ccf5]">
                    {count ? `${count} item${count > 1 ? 's' : ''} selected` : 'Add items to start'}
                  </div>
                </div>
                <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-[22px] mt-[22px] items-start">
                  <div className="bg-[#051747] border-[1.5px] border-[#12275e] rounded-[22px] p-[18px]">
                    {renderCalendar({ cellH: 36, radius: 11 })}
                    <div className="mt-4">{renderDeliverOn({ dark: true })}</div>
                    {renderExistingBanner()}
                  </div>
                  <div>
                    <div className="text-[12.5px] tracking-[0.12em] uppercase text-[#a8ccf5] mb-2.5">Menu</div>
                    {renderMenuFilters()}
                    {renderMenuGrid('grid-cols-1 2xl:grid-cols-2')}
                  </div>
                </div>
              </div>
            )}

            {tab === 'orders' && (
              <div>
                <div className="text-[24px]" style={AB}>My Orders</div>
                <div className="mt-[18px]">{renderOrdersToggle('w-[260px]')}</div>
                <div className="mt-4">{renderOrdersList('grid grid-cols-1 2xl:grid-cols-2 gap-3')}</div>
              </div>
            )}

            {tab === 'members' && (
              <div>
                <div className="text-[24px]" style={AB}>Members</div>
                <div className="mt-[18px]">{renderMembers()}</div>
              </div>
            )}

            {tab === 'profile' && (
              <div>
                {renderProfileContent('grid-cols-2 xl:grid-cols-4')}
                <button onClick={logout}
                  className="mt-6 rounded-full border-[1.5px] border-[#12275e] text-[#a8ccf5] px-6 py-3 text-sm font-bold hover:border-[#ff3b00] hover:text-[#ff8a66] transition-colors">
                  Sign out
                </button>
              </div>
            )}
          </main>

          {/* right rail */}
          <aside className="flex-none w-[340px] bg-[#051747] border-l border-[#12275e] overflow-y-auto px-6 py-[26px] max-[1100px]:w-full max-[1100px]:border-l-0 max-[1100px]:border-t max-[1100px]:overflow-visible">
            {tab === 'order' ? (
              count > 0 ? (
                <>
                  <div className="text-[19px]" style={AB}>Checkout</div>
                  <div className="text-[12px] text-[#a8ccf5] mt-1">
                    {fmtDay(anchorDate)} · {deliveryWindow}
                  </div>
                  <div className="mt-4">{renderCheckoutBody()}</div>
                </>
              ) : (
                <div className="flex flex-col items-center text-center pt-[60px] px-2.5 text-[#a8ccf5]">
                  <div className="w-[52px] h-[52px] rounded-full bg-[#0a1230] border-[1.5px] border-[#12275e] flex items-center justify-center">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d={NAV_ICON.order} />
                    </svg>
                  </div>
                  <div className="text-sm font-bold text-[#ede5de] mt-3.5">No items yet</div>
                  <div className="text-[12.5px] mt-1.5 leading-relaxed">Add menu items on the left — checkout appears here.</div>
                </div>
              )
            ) : (
              <>
                <div className="text-[17px]" style={AB}>Account snapshot</div>
                <div className="mt-3.5 bg-[#0a1230] border-[1.5px] border-[#12275e] rounded-[18px] px-4 py-3.5">
                  <div className="text-[10.5px] font-bold tracking-[0.12em] uppercase text-[#a8ccf5]">Signed in as</div>
                  <div className="text-[16px] mt-1.5 truncate" style={{ ...AB, color: '#bcf679' }}>{partner?.email}</div>
                  <div className="text-[12px] text-[#a8ccf5] mt-1.5">Min order · AED {fmtAED(minOrder)}</div>
                </div>
                <div className="flex gap-2 mt-2.5">
                  <div className="flex-1 bg-[#0a1230] rounded-[14px] px-3 py-2.5">
                    <div className="text-[10px] font-bold tracking-[0.1em] uppercase text-[#a8ccf5]">Orders</div>
                    <div className="text-[18px] font-bold mt-0.5">{reports ? reports.orderCount ?? 0 : '—'}</div>
                  </div>
                  <div className="flex-1 bg-[#0a1230] rounded-[14px] px-3 py-2.5">
                    <div className="text-[10px] font-bold tracking-[0.1em] uppercase text-[#a8ccf5]">Spent</div>
                    <div className="text-[18px] font-bold mt-0.5">{reports ? fmtAED(reports.totalSpend) : '—'}</div>
                  </div>
                </div>
                <button onClick={logout}
                  className="w-full mt-4 rounded-full border-[1.5px] border-[#12275e] text-[#a8ccf5] py-3 text-[13px] font-bold hover:border-[#ff3b00] hover:text-[#ff8a66] transition-colors">
                  Sign out
                </button>
              </>
            )}
          </aside>
        </div>

        {doneOverlay}
      </div>
    );
  }

  // ════════════════════ MOBILE ════════════════════
  return (
    <div className="h-screen overflow-hidden bg-[#04102b] text-[#ede5de]" style={SANS}>
      <div className="mx-auto w-full max-w-[430px] h-screen flex flex-col bg-[#050f2b] sm:border-x sm:border-[#12275e]">

        {/* header */}
        <header className="flex-none bg-[#051747] px-[18px] pt-3 pb-3.5 border-b border-[#12275e] flex items-center gap-3">
          {partner?.profilePicture
            ? <img src={partner.profilePicture} alt="" className="w-[34px] h-[34px] rounded-[11px] object-cover flex-none" />
            : <div className="w-[34px] h-[34px] rounded-[11px] bg-[#bcf679] text-[#051747] flex items-center justify-center flex-none text-[17px]" style={AB}>{initials(partner?.businessName)}</div>}
          <div className="min-w-0">
            <div className="text-[15.5px] leading-tight truncate" style={AB}>{TITLE[tab]}</div>
            <div className="text-[11.5px] text-[#a8ccf5] mt-0.5 truncate">{partner?.businessName || 'Partner'} · {CATEGORY_LABEL[partner?.accountCategory] || 'MATTER PARTNER'}</div>
          </div>
          <button onClick={() => setTab('profile')} aria-label="Profile"
            className="ml-auto w-[38px] h-[38px] rounded-full bg-[#0a1230] border-[1.5px] border-[#12275e] text-[#a8ccf5] flex items-center justify-center hover:border-[#bcf679] transition-colors">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d={NAV_ICON.profile} />
            </svg>
          </button>
        </header>

        {/* ORDER */}
        {tab === 'order' && (
          <div className="flex-1 min-h-0 overflow-y-auto px-[18px] pt-4 pb-[210px]">
            {renderCalendar({ cellH: 46, radius: 14 })}
            <div className="mt-3.5">{renderDeliverOn()}</div>
            {renderExistingBanner()}

            <div className="flex justify-between items-baseline mt-6 mb-2.5">
              <div className="text-[13px] tracking-[0.12em] uppercase text-[#a8ccf5]">Menu</div>
              <div className="text-[12.5px] text-[#a8ccf5]">{count ? `${count} item${count > 1 ? 's' : ''} selected` : 'Tap + to add'}</div>
            </div>
            {renderMenuFilters()}
            {renderMenuGrid('grid-cols-1')}

            {orderErr && <p className="text-[#ff8a66] text-[12.5px] mt-4">{orderErr}</p>}
          </div>
        )}

        {/* cart bar */}
        {tab === 'order' && count > 0 && !sheet && !done && (
          <div className="fixed left-0 right-0 mx-auto max-w-[430px] px-3.5 z-30" style={{ bottom: 92 }}>
            <div className="bg-[#bcf679] text-[#051747] rounded-[24px] pl-[18px] pr-3 py-3 flex items-center gap-3 shadow-[0_18px_40px_rgba(0,0,0,.5)]">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-bold tracking-[0.1em] uppercase opacity-75">
                  {count} item{count > 1 ? 's' : ''} · {sortedSelected.length > 1 ? `${sortedSelected.length} days` : fmtDay(anchorDate)}
                </div>
                <div className="text-[19px] mt-px" style={AB}>AED {fmtAED(subtotal * sortedSelected.length)}</div>
              </div>
              <button onClick={openCheckout}
                className="flex-none bg-[#051747] text-[#ede5de] rounded-full px-5 py-3.5 text-sm font-bold hover:opacity-90 transition-opacity">
                Checkout →
              </button>
            </div>
          </div>
        )}

        {/* ORDERS */}
        {tab === 'orders' && (
          <div className="flex-1 min-h-0 overflow-y-auto px-[18px] pt-4 pb-[100px]">
            {renderOrdersToggle()}
            <div className="mt-3.5">{renderOrdersList('flex flex-col gap-2.5')}</div>
          </div>
        )}

        {tab === 'members' && (
          <div className="flex-1 min-h-0 overflow-y-auto px-[18px] pt-4 pb-[100px]">
            {renderMembers()}
          </div>
        )}

        {/* PROFILE */}
        {tab === 'profile' && (
          <div className="flex-1 min-h-0 overflow-y-auto px-[18px] pt-4 pb-[100px]">
            {renderProfileContent('grid-cols-2')}
            <button onClick={logout}
              className="w-full mt-6 rounded-full border-[1.5px] border-[#12275e] text-[#a8ccf5] py-3.5 text-sm font-bold hover:border-[#ff3b00] hover:text-[#ff8a66] transition-colors">
              Sign out
            </button>
          </div>
        )}

        {/* bottom tabs — fixed to the viewport, never scrolls with content */}
        <nav className="fixed left-0 right-0 bottom-0 z-30 mx-auto max-w-[430px] flex bg-[#051747] border-t border-[#12275e] px-3.5 pt-2.5 pb-5 sm:border-x sm:border-b-0">
          {TABS.map((id) => {
            const on = tab === id;
            return (
              <button key={id} onClick={() => setTab(id)}
                className="flex-1 flex flex-col items-center gap-1 py-1.5 text-[10.5px] font-bold"
                style={{ color: on ? '#bcf679' : '#a8ccf5' }}>
                <span className="w-9 h-7 rounded-full flex items-center justify-center"
                  style={{ background: on ? 'rgba(188,246,121,.14)' : 'transparent' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d={NAV_ICON[id]} />
                  </svg>
                </span>
                {NAV_LABEL[id]}
              </button>
            );
          })}
        </nav>
      </div>

      {/* checkout sheet */}
      <AnimatePresence>
        {sheet === 'checkout' && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setSheet(null)} className="fixed inset-0 bg-[rgba(4,16,43,.7)] z-40" />
            <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 32, stiffness: 320 }}
              className="fixed left-0 right-0 bottom-0 mx-auto max-w-[430px] max-h-[92%] z-50 flex flex-col bg-[#051747] rounded-t-[32px] border-t-[1.5px] border-[#12275e] shadow-[0_-20px_60px_rgba(0,0,0,.6)]">
              <div className="w-11 h-[5px] rounded-full bg-[#12275e] mx-auto mt-2.5" />
              <div className="overflow-y-auto px-5 pt-3.5 pb-6">
                <div className="flex items-center gap-2.5">
                  <div className="text-[19px]" style={AB}>Checkout</div>
                  <button onClick={() => setSheet(null)} aria-label="Close"
                    className="ml-auto w-9 h-9 rounded-full bg-[#0a1230] text-[#a8ccf5] hover:text-[#ff3b00] transition-colors">✕</button>
                </div>
                <div className="text-[12.5px] text-[#a8ccf5] mt-1">
                  {fmtDay(anchorDate)} · {deliveryWindow}
                </div>
                <div className="mt-3.5">{renderCheckoutBody()}</div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {doneOverlay}
    </div>
  );
};

export default PartnerPortal;
