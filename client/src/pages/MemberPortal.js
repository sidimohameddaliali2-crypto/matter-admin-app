import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, ArrowLeft, Pencil } from 'lucide-react';
import { memberLogout, updateMemberProfile } from '../store/slices/memberAuthSlice';
import memberApi from '../utils/memberApi';
import { groupExclusions } from '../constants/exclusionList';
import MemberExclusionPicker from '../components/MemberExclusionPicker';

/*  MATTER — Member ordering portal
 *  Design source: "Menu Selection Link - Gym Members.dc.html" — à la carte,
 *  per-day cart, weekly date tabs, course sections, exclusion-conflict modal.
 *  White/navy MATTER palette, Caprasimo headings, Figtree body.
 */
const HEAD = { fontFamily: "'Caprasimo', system-ui, sans-serif" };
const BODY = { fontFamily: "'Figtree', system-ui, sans-serif" };

const fmtAED = (n) => {
  const v = Number(n || 0);
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2);
};
const toISO = (d) => d.toLocaleDateString('en-CA');
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtLong = (iso) => {
  const d = new Date(iso + 'T00:00:00');
  return `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`;
};
const initials = (s = '') =>
  s.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'M';
// Menu item name display: every word capitalised ("Title Case")
const titleCase = (s = '') => String(s).trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const DELIVERY_WINDOW = 'Morning · 5–6am';
// No deliveries on Sunday — firstOrderableISO/weekTabs below skip it
const firstOrderableISO = () => {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  while (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return toISO(d);
};
const weekTabs = () => {
  const d = new Date(firstOrderableISO() + 'T00:00:00');
  const out = [];
  while (out.length < 7) {
    if (d.getDay() !== 0) out.push(toISO(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
};

const COURSE_ORDER = ['main', 'bowl', 'wraps-buns', 'oats', 'snack'];
const COURSE_LABEL = { main: 'Main Meal', bowl: 'Bowl', 'wraps-buns': 'Wraps/Buns', oats: 'Oats', snack: 'Snacks' };
const BAG = {
  main: { bg: '#d9eaff', fg: '#143f7a' },
  bowl: { bg: '#eafbd0', fg: '#2a3f13' },
  'wraps-buns': { bg: '#ffe9d9', fg: '#7a3b14' },
  oats: { bg: '#f3e8d2', fg: '#5c4420' },
  snack: { bg: '#eef2f9', fg: '#1e3260' },
};

const STATUS = {
  submitted: { label: 'Scheduled', bg: '#eafbd0', color: '#2a3f13' },
  draft: { label: 'Draft', bg: '#eef2f9', color: '#4a5a7d' },
  locked: { label: 'Locked', bg: '#eef2f9', color: '#4a5a7d' },
  delivered: { label: 'Delivered', bg: '#eef2f9', color: '#4a5a7d' },
  cancelled: { label: 'Cancelled', bg: '#fff2eb', color: '#8c491a' },
};
const statusOf = (s) => STATUS[s] || { label: s || '—', bg: '#eef2f9', color: '#4a5a7d' };
const orderTotal = (o) =>
  (o.lines || []).reduce((s, l) => s + (Number(l.unitPrice ?? l.menuItem?.price) || 0) * l.quantity, 0);
const orderItemsLine = (o) =>
  (o.lines || []).map((l) => `${l.quantity}× ${titleCase(l.menuItem?.name || l.itemName) || 'Item'}`).join(', ') || 'No items';

// ════════════════════════════════════════════════════════════════════════════
const MemberPortal = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const member = useSelector((state) => state.memberAuth.member);
  const partner = member?.partner || {};
  const minOrder = partner?.minimumOrder ?? 0;

  const [view, setView] = useState('menu'); // 'menu' | 'orders'
  const days = useMemo(() => weekTabs(), []);
  const [sel, setSel] = useState(days[0]);

  const [menu, setMenu] = useState([]);
  const [menuLoading, setMenuLoading] = useState(false);
  const [orders, setOrders] = useState([]);
  const [ordersView, setOrdersView] = useState('up');

  const [cart, setCart] = useState({});           // { [iso]: { [menuItemId]: qty } }
  const [acknowledged, setAcknowledged] = useState({}); // { [menuItemId]: true }
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState('');
  const [placing, setPlacing] = useState(false);
  const [orderErr, setOrderErr] = useState('');
  const [done, setDone] = useState(null);

  // profile edit
  const [editingProfile, setEditingProfile] = useState(false);
  const [pName, setPName] = useState(member?.name || '');
  const [pExcl, setPExcl] = useState(member?.dietaryExclusions || '');
  const [savingP, setSavingP] = useState(false);
  useEffect(() => { setPName(member?.name || ''); setPExcl(member?.dietaryExclusions || ''); }, [member?.name, member?.dietaryExclusions]);

  const todayISO = toISO(new Date());

  const flash = (msg) => { setToast(msg); clearTimeout(flash._t); flash._t = setTimeout(() => setToast(''), 2200); };

  // ── loaders ───────────────────────────────────────────────────────────────
  const loadMenu = useCallback(async (date) => {
    setMenuLoading(true);
    try {
      const res = await memberApi.get(`/member/menu?date=${date}`);
      setMenu(res.data.data || []);
    } catch {
      setMenu([]);
    } finally {
      setMenuLoading(false);
    }
  }, []);

  const loadOrders = useCallback(async () => {
    try {
      const res = await memberApi.get('/member/orders');
      setOrders(res.data.data || []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { loadOrders(); }, [loadOrders]);
  useEffect(() => { loadMenu(sel); }, [sel, loadMenu]);

  // ── derived ───────────────────────────────────────────────────────────────
  const exclusions = useMemo(
    () => groupExclusions(member?.dietaryExclusions || '').map((s) => s.toLowerCase()).filter(Boolean),
    [member?.dietaryExclusions]
  );
  const conflictOf = (m) => {
    if (!exclusions.length) return [];
    const hay = `${m.name || ''} ${(m.ingredients || []).join(' ')} ${m.description || ''}`.toLowerCase();
    return exclusions.filter((e) => hay.includes(e));
  };

  const ordersByDate = useMemo(() => {
    const map = {};
    orders.forEach((o) => {
      if (o.status === 'cancelled') return;
      const key = toISO(new Date(o.deliveryDate));
      (map[key] = map[key] || []).push(o);
    });
    return map;
  }, [orders]);

  const cartFor = (iso) => cart[iso] || {};
  const countFor = (iso) => Object.values(cartFor(iso)).reduce((a, b) => a + b, 0);
  const dayCart = cartFor(sel);
  const count = countFor(sel);
  const subtotal = useMemo(
    () => menu.reduce((t, m) => t + (dayCart[m._id] || 0) * (Number(m.price) || 0), 0),
    [menu, dayCart]
  );
  const cartLines = useMemo(
    () => menu.filter((m) => dayCart[m._id]).map((m) => ({ ...m, qty: dayCart[m._id], line: dayCart[m._id] * (Number(m.price) || 0) })),
    [menu, dayCart]
  );

  const upcoming = useMemo(
    () => orders.filter((o) => toISO(new Date(o.deliveryDate)) >= todayISO && o.status !== 'cancelled')
      .sort((a, b) => new Date(a.deliveryDate) - new Date(b.deliveryDate)),
    [orders, todayISO]
  );
  const past = useMemo(
    () => orders.filter((o) => toISO(new Date(o.deliveryDate)) < todayISO || o.status === 'cancelled')
      .sort((a, b) => new Date(b.deliveryDate) - new Date(a.deliveryDate)),
    [orders, todayISO]
  );
  const orderList = ordersView === 'up' ? upcoming : past;
  const existingCount = ordersByDate[sel]?.length || 0;

  // 'lunch'/'dinner'/'breakfast' predate the Bowl/Wraps-Buns/Oats categories
  // and are no longer valid on PartnerMenuItem — normalize here so any menu
  // item still saved under one of those still groups under Main Meal instead
  // of disappearing from every course.
  const normalizeCourseKey = (mealType) => {
    const t = String(mealType || '').toLowerCase();
    return (t === 'lunch' || t === 'dinner' || t === 'breakfast') ? 'main' : (t || 'main');
  };

  const courses = useMemo(() => {
    return COURSE_ORDER
      .map((key) => ({ key, label: COURSE_LABEL[key], meals: menu.filter((m) => normalizeCourseKey(m.mealType) === key) }))
      .filter((c) => c.meals.length > 0);
  }, [menu]);

  // ── actions ───────────────────────────────────────────────────────────────
  const bump = (id, delta) => {
    setOrderErr('');
    setCart((c) => {
      const day = { ...(c[sel] || {}) };
      const next = Math.max(0, (day[id] || 0) + delta);
      if (next === 0) delete day[id]; else day[id] = next;
      return { ...c, [sel]: day };
    });
  };

  const openConflictModal = (m, items) => {
    setModal({
      kicker: 'Against your preferences',
      title: `This meal includes ${items.join(', ')}`,
      body: `${m.name} conflicts with an exclusion on your profile. You can keep it in your selection anyway, or pick something else for this slot.`,
      items,
      onKeep: () => {
        bump(m._id, 1);
        setAcknowledged((a) => ({ ...a, [m._id]: true }));
        setModal(null);
        flash('Added — exclusion acknowledged');
      },
    });
  };

  const tryAdd = (m) => {
    const conflict = conflictOf(m);
    if (conflict.length && !acknowledged[m._id]) return openConflictModal(m, conflict);
    bump(m._id, 1);
  };

  const placeOrder = async () => {
    if (count === 0) { flash('Add at least one meal to order'); return; }
    if (subtotal < minOrder) {
      setOrderErr(`Minimum order is AED ${fmtAED(minOrder)} — you're at AED ${fmtAED(subtotal)}.`);
      return;
    }
    setPlacing(true);
    setOrderErr('');
    try {
      const lines = menu.filter((m) => dayCart[m._id]).map((m) => ({ menuItemId: m._id, quantity: dayCart[m._id] }));
      const r = await memberApi.post('/member/orders', { deliveryDate: sel, lines, notes: '', deliveryTime: DELIVERY_WINDOW });
      try {
        await memberApi.post(`/member/orders/${r.data.data._id}/submit`);
      } catch (e) {
        const msg = e.response?.data?.message || '';
        if (!/already submitted/i.test(msg)) throw e;
      }
      setDone({ date: fmtLong(sel), total: subtotal, lines: cartLines });
      setCart((c) => { const next = { ...c }; delete next[sel]; return next; });
      loadOrders();
    } catch (e) {
      setOrderErr(e.response?.data?.message || 'Could not place the order. Try again.');
    } finally {
      setPlacing(false);
    }
  };

  const saveProfile = async () => {
    setSavingP(true);
    try {
      const res = await memberApi.patch('/member/profile', { name: pName, dietaryExclusions: pExcl });
      dispatch(updateMemberProfile(res.data.data));
      setEditingProfile(false);
      flash('Profile updated');
    } catch { /* silent */ } finally { setSavingP(false); }
  };

  const logout = () => { dispatch(memberLogout()); navigate(localStorage.getItem('memberInvitePath') || '/'); };

  // ── styles ────────────────────────────────────────────────────────────────
  const card = 'bg-white border border-[#dde4f0] rounded-3xl';
  const ghostBtn = 'text-[13px] font-semibold text-[#1b60b4] hover:text-[#143f7a] transition-colors px-2 py-1';

  return (
    <div className="min-h-screen bg-white text-[#051747]" style={BODY}>
      <div className="mx-auto w-full max-w-[520px] min-h-screen flex flex-col sm:border-x sm:border-[#eef2f9]">

        {/* header */}
        <header className="sticky top-0 z-20 bg-white/95 backdrop-blur px-5 py-3.5 border-b border-[#eef2f9] flex items-center justify-between gap-3">
          <img src="/images/matter-logo-navy.svg" alt="MATTER" className="h-[19px]" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          <div className="flex items-center gap-1">
            <button onClick={() => setView(view === 'menu' ? 'orders' : 'menu')} className={ghostBtn}>
              {view === 'menu' ? 'My orders' : '← Menu'}
            </button>
            <button onClick={logout} className="text-[12px] px-2 py-1 rounded-full text-[#4a5a7d] hover:bg-[#f7f9fd] transition-colors">Sign out</button>
          </div>
        </header>

        {view === 'orders' ? (
          <div className="flex-1 px-5 pt-5 pb-10">
            <h2 className="text-[22px] mb-4" style={HEAD}>My orders</h2>
            <div className="flex gap-1 bg-[#f7f9fd] border border-[#dde4f0] rounded-full p-1 mb-4">
              {[['up', 'Upcoming'], ['past', 'Past']].map(([v, label]) => {
                const on = ordersView === v;
                return (
                  <button key={v} onClick={() => setOrdersView(v)}
                    className="flex-1 py-2 rounded-full text-[13px] font-semibold transition-colors"
                    style={{ background: on ? '#051747' : 'transparent', color: on ? '#fff' : '#4a5a7d' }}>
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-col gap-2.5">
              {orderList.length === 0 && (
                <div className={`${card} px-4 py-10 text-center text-[13px] text-[#8e9bb8]`}>
                  {ordersView === 'up' ? 'No upcoming orders.' : 'No past orders yet.'}
                </div>
              )}
              {orderList.map((o) => {
                const st = statusOf(o.status);
                return (
                  <div key={o._id} className={`${card} px-4 py-3.5`}>
                    <div className="flex items-center gap-2">
                      <div className="text-[14px] font-semibold">{fmtLong(toISO(new Date(o.deliveryDate)))}</div>
                      <span className="ml-auto rounded-full px-2.5 py-0.5 text-[11px] font-bold" style={{ background: st.bg, color: st.color }}>{st.label}</span>
                    </div>
                    <div className="text-[12.5px] text-[#4a5a7d] mt-1 leading-relaxed">{orderItemsLine(o)}</div>
                    <div className="text-[13px] font-semibold mt-2" style={{ color: '#1b60b4' }}>AED {fmtAED(orderTotal(o))}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            {/* account card */}
            <div className="px-5 pt-5">
              <div className="rounded-3xl p-5 bg-[#eef5ff] border border-[#b8d9ff]">
                <div className="flex items-center gap-3.5 mb-4">
                  <div className="w-12 h-12 rounded-full bg-[#1b60b4] text-white flex items-center justify-center text-[16px] font-semibold flex-none">
                    {initials(member?.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[19px] truncate" style={HEAD}>{member?.name}</div>
                    <div className="text-[13px] text-[#4a5a7d] truncate">{member?.email}</div>
                  </div>
                  {!editingProfile && (
                    <button onClick={() => setEditingProfile(true)} className="flex-none text-[#1b60b4] p-1.5 rounded-full hover:bg-white transition-colors" aria-label="Edit profile">
                      <Pencil className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {!editingProfile ? (
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="bg-white rounded-2xl px-3.5 py-2.5">
                      <div className="text-[10px] tracking-[0.09em] uppercase text-[#6b7a9b]">Gym</div>
                      <div className="text-[14px] font-semibold mt-0.5 truncate">{partner?.businessName}</div>
                    </div>
                    <div className="bg-white rounded-2xl px-3.5 py-2.5">
                      <div className="text-[10px] tracking-[0.09em] uppercase text-[#6b7a9b]">Min. order</div>
                      <div className="text-[14px] font-semibold mt-0.5">AED {fmtAED(minOrder)}</div>
                    </div>
                    <div className="col-span-2 bg-white rounded-2xl px-3.5 py-2.5">
                      <div className="text-[10px] tracking-[0.09em] uppercase text-[#6b7a9b] mb-1.5">Exclusions &amp; allergens</div>
                      <div className="flex flex-wrap gap-1.5">
                        {groupExclusions(member?.dietaryExclusions || '').length === 0 && (
                          <span className="text-[12px] text-[#8e9bb8]">None on file yet</span>
                        )}
                        {groupExclusions(member?.dietaryExclusions || '').map((f) => (
                          <span key={f} className="text-[11px] px-2.5 py-1 rounded-full bg-[#eef5ff] text-[#1b60b4] font-medium">{f}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="bg-white rounded-2xl p-4">
                    <label className="block text-[12px] text-[#4a5a7d] mb-1.5">Name</label>
                    <input value={pName} onChange={(e) => setPName(e.target.value)}
                      className="w-full rounded-full border border-[#dde4f0] px-3.5 py-2.5 text-[14px] outline-none focus:border-[#1b60b4] mb-3" />
                    <label className="block text-[12px] text-[#4a5a7d] mb-1.5">Exclusions</label>
                    <MemberExclusionPicker light value={pExcl} onChange={setPExcl} />
                    <div className="flex gap-2 mt-3">
                      <button onClick={saveProfile} disabled={savingP}
                        className="rounded-full bg-[#051747] text-white px-4 py-2 text-[13px] font-semibold hover:bg-[#050f2b] transition-colors disabled:opacity-50 inline-flex items-center gap-2">
                        {savingP && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
                      </button>
                      <button onClick={() => { setEditingProfile(false); setPName(member?.name || ''); setPExcl(member?.dietaryExclusions || ''); }}
                        className="rounded-full border border-[#dde4f0] px-4 py-2 text-[13px] font-semibold text-[#4a5a7d] hover:bg-[#f7f9fd] transition-colors">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* delivery date tabs */}
            <div className="px-5 pt-5">
              <h5 className="text-[14px] font-semibold mb-2.5">Delivery date</h5>
              <div className="flex gap-1.5 overflow-x-auto pb-2">
                {days.map((iso) => {
                  const d = new Date(iso + 'T00:00:00');
                  const on = iso === sel;
                  const c = countFor(iso);
                  const placed = ordersByDate[iso]?.some((o) => o.status !== 'cancelled');
                  const hasItems = c > 0;
                  const bg = hasItems ? '#bcf679' : on ? '#1b60b4' : 'transparent';
                  const fg = hasItems ? '#2a3f13' : on ? '#fff' : '#051747';
                  const border = hasItems ? '#bcf679' : on ? '#1b60b4' : '#dde4f0';
                  return (
                    <button key={iso} onClick={() => setSel(iso)}
                      className="flex-none min-w-[54px] rounded-2xl px-1.5 py-2.5 flex flex-col items-center gap-0.5 border transition-colors"
                      style={{ background: bg, color: fg, borderColor: border }}>
                      <span className="text-[10px] tracking-[0.07em] uppercase opacity-85">{DOW[d.getDay()]}</span>
                      <span className="text-[15px] font-semibold">{d.getDate()}</span>
                      <span className="text-[9.5px] opacity-85">{placed ? 'Ordered' : hasItems ? `${c} item${c > 1 ? 's' : ''}` : MON[d.getMonth()]}</span>
                    </button>
                  );
                })}
              </div>
              {existingCount > 0 && (
                <div className="mt-1 flex items-start gap-2 rounded-2xl px-3.5 py-2.5 text-[12px] leading-snug bg-[#f6fde9] text-[#2a3f13]">
                  <span className="w-[6px] h-[6px] rounded-full bg-[#6f9c30] flex-none mt-1.5" />
                  You already have {existingCount} order{existingCount > 1 ? 's' : ''} this day — new items merge into it.
                </div>
              )}
            </div>

            {/* menu */}
            <div className="px-5 pt-5 flex items-center justify-between gap-3">
              <h5 className="text-[14px] font-semibold m-0">Order your meals</h5>
              <span className="text-[12px] text-[#6b7a9b]">{count} item{count !== 1 ? 's' : ''} in order</span>
            </div>
            <p className="px-5 text-[12.5px] text-[#6b7a9b] mt-0.5 mb-1">Browse the menu and add whatever you'd like — priced per item.</p>

            <div className="px-5 pb-8 flex flex-col gap-6 mt-3">
              {menuLoading ? (
                <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 animate-spin text-[#1b60b4]" /></div>
              ) : courses.length === 0 ? (
                <div className={`${card} px-4 py-10 text-center text-[13px] text-[#8e9bb8]`}>No menu items available for {fmtLong(sel)}.</div>
              ) : (
                courses.map((c) => (
                  <div key={c.key}>
                    <div className="flex items-baseline justify-between gap-3 mb-3">
                      <h6 className="text-[13px] font-semibold m-0">{c.label}</h6>
                      <span className="text-[12px] text-[#6b7a9b]">{c.meals.length} option{c.meals.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="flex flex-col gap-3">
                      {c.meals.map((m) => {
                        const qty = dayCart[m._id] || 0;
                        const conflict = conflictOf(m);
                        const warned = conflict.length > 0 && !acknowledged[m._id];
                        const bag = BAG[normalizeCourseKey(m.mealType)] || BAG.main;
                        return (
                          <div key={m._id} className="rounded-3xl border overflow-hidden"
                            style={{ borderColor: qty ? '#4d9eff' : '#dde4f0' }}>
                            <div className="h-11 flex items-center justify-between gap-2.5 px-3" style={{ background: bag.bg }}>
                              <span className="text-[10.5px] font-semibold px-2.5 py-1 rounded-full bg-white" style={{ color: bag.fg }}>
                                {COURSE_LABEL[m.mealType] || 'Meal'}
                              </span>
                              {(qty > 0 || warned) && (
                                <span className="text-[10.5px] font-semibold px-2.5 py-1 rounded-full"
                                  style={warned
                                    ? { background: '#eef2f9', color: '#1e3260' }
                                    : { background: '#1b60b4', color: '#fff' }}>
                                  {warned ? 'Against your plan' : `${qty} selected`}
                                </span>
                              )}
                            </div>
                            <div className="px-4 py-3.5">
                              <div className="flex items-baseline justify-between gap-2.5 mb-1.5">
                                <div className="text-[15.5px] font-semibold leading-tight">{titleCase(m.name)}</div>
                                <div className="flex-none text-[14.5px] font-semibold" style={{ color: '#1b60b4' }}>
                                  {m.price != null ? `AED ${fmtAED(m.price)}` : 'TBD'}
                                </div>
                              </div>
                              {(m.description || m.category) && (
                                <div className="text-[12.5px] text-[#6b7a9b] leading-relaxed mb-3">{m.description || m.category}</div>
                              )}
                              <div className="flex items-center gap-3">
                                <button onClick={() => bump(m._id, -1)} disabled={qty === 0}
                                  className="w-11 h-11 rounded-full border border-[#dde4f0] text-[19px] leading-none disabled:opacity-40 hover:bg-[#f7f9fd] transition-colors">−</button>
                                <div className="flex-1 text-center text-[18px] font-semibold tabular-nums">{qty}</div>
                                <button onClick={() => tryAdd(m)} disabled={m.price == null}
                                  className="w-11 h-11 rounded-full bg-[#051747] text-white text-[19px] leading-none disabled:opacity-40 hover:bg-[#050f2b] transition-colors">+</button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* sticky footer */}
            <div className="sticky bottom-0 mt-auto bg-white border-t border-[#eef2f9] px-5 pt-3.5 pb-5">
              <div className="flex items-center justify-between gap-3 mb-1.5">
                <span className="text-[12.5px] text-[#6b7a9b]">{count} item{count !== 1 ? 's' : ''}</span>
                <span className="text-[15px] font-semibold tabular-nums" style={{ color: '#1b60b4' }}>AED {fmtAED(subtotal)}</span>
              </div>
              <div className="text-[12px] text-[#6b7a9b] mb-2.5">Delivering {fmtLong(sel)}</div>
              {orderErr && <p className="text-[#8c491a] text-[12px] mb-2">{orderErr}</p>}
              <button onClick={placeOrder} disabled={placing}
                className="w-full rounded-full bg-[#051747] text-white py-3.5 text-[15px] font-semibold hover:bg-[#050f2b] transition-colors disabled:opacity-60 flex items-center justify-center gap-2">
                {placing && <Loader2 className="w-4 h-4 animate-spin" />}
                {placing ? 'Placing…' : 'Place order'}
              </button>
            </div>
          </>
        )}
      </div>

      {/* conflict modal */}
      <AnimatePresence>
        {modal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setModal(null)}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-5" style={{ background: 'rgba(5,15,43,.5)' }}>
            <motion.div initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 12, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-[420px] bg-white rounded-[32px] p-6 shadow-2xl">
              <div className="text-[11px] font-semibold tracking-[0.08em] uppercase text-[#6b7a9b] mb-1">{modal.kicker}</div>
              <div className="text-[21px] mb-3" style={HEAD}>{modal.title}</div>
              <p className="text-[14px] text-[#051747] leading-relaxed mb-4">{modal.body}</p>
              {modal.items?.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-5">
                  {modal.items.map((i) => (
                    <span key={i} className="text-[11.5px] px-2.5 py-1 rounded-full bg-[#eef2f9] text-[#1e3260] font-medium">{i}</span>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <button onClick={() => setModal(null)} className="rounded-full border border-[#dde4f0] text-[#051747] px-4 py-2.5 text-[13.5px] font-semibold hover:bg-[#f7f9fd] transition-colors">
                  Replace with another
                </button>
                <button onClick={modal.onKeep} className="rounded-full bg-[#051747] text-white px-4 py-2.5 text-[13.5px] font-semibold hover:bg-[#050f2b] transition-colors">
                  Keep selection
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* toast */}
      <AnimatePresence>
        {toast && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="fixed left-1/2 -translate-x-1/2 bottom-[92px] z-[60] px-[18px] py-2.5 rounded-full bg-[#050f2b] text-white text-[13px] whitespace-nowrap shadow-lg">
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      {/* done overlay */}
      <AnimatePresence>
        {done && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-white flex flex-col justify-center px-8 py-10 overflow-y-auto">
            <div className="mx-auto w-full max-w-[420px]">
              <div className="w-16 h-16 rounded-full bg-[#ddf7b0] flex items-center justify-center text-[28px] text-[#2a3f13] mb-6">✓</div>
              <h2 className="text-[26px] mb-2.5" style={HEAD}>Order placed</h2>
              <p className="text-[#4a5a7d] text-[15px] leading-relaxed mb-6">
                Thanks {member?.name?.split(' ')[0]} — we've got your order, delivering {done.date}. A receipt was emailed to {member?.email}.
              </p>
              <div className={`${card} p-[18px]`}>
                {done.lines.map((l) => (
                  <div key={l._id} className="flex items-baseline justify-between gap-3 py-2 border-b border-[#eef2f9] text-[13.5px]">
                    <span>{titleCase(l.name)} × {l.qty}</span>
                    <span className="text-[#6b7a9b]">AED {fmtAED(l.line)}</span>
                  </div>
                ))}
                <div className="flex items-baseline justify-between gap-3 pt-3">
                  <span className="text-[14px] font-semibold">Total</span>
                  <span className="text-[16px] font-semibold" style={{ color: '#1b60b4' }}>AED {fmtAED(done.total)}</span>
                </div>
              </div>
              <button onClick={() => setDone(null)}
                className="w-full mt-5 rounded-full border border-[#dde4f0] text-[#051747] py-3.5 text-[15px] font-semibold hover:bg-[#f7f9fd] transition-colors flex items-center justify-center gap-2">
                <ArrowLeft className="w-4 h-4" /> Order more
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default MemberPortal;
