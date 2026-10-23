import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSelector } from 'react-redux';
import { motion, AnimatePresence } from 'framer-motion';
import jsPDF from 'jspdf';
import 'jspdf-autotable';
import {
  Plus, X, Edit, Trash2, ChevronDown, ChevronUp, Building2, Search,
  Loader, CheckCircle, XCircle, ClipboardList, Calendar, UtensilsCrossed,
  ToggleLeft, ToggleRight, Lock, FileText, BarChart2, Leaf, Download,
  DollarSign, AlertCircle, RefreshCw, Users, CheckCheck
} from 'lucide-react';
import api from '../utils/api';
import { partnerAdminOrderStatus, canInvoicePartnerOrder } from '../utils/partnerOrderStatus';
import { groupExclusions } from '../constants/exclusionList';

/*  MATTER Admin — Partner operations
 *  Design source: "MATTER Partner Admin.dc.html" (cream/navy MATTER brand,
 *  Archivo / Archivo Black). All data below is real, wired to the existing
 *  /api/admin/partners/* endpoints — nothing here is sample data.
 *
 *  Deliberate trims vs. the design (no backing data / out of scope — see the
 *  chat response for the full list): no referral "code"/"uses" columns, no
 *  WhatsApp "Numbers" tab (folded into the existing Members panel, which is
 *  the real equivalent — partner self-service join links), no per-row order
 *  total (accurate pricing needs a SpacePrice join the list route doesn't do),
 *  acknowledging an order doesn't gate locking it.
 */

const fmt = (n) => Number(n || 0).toFixed(2);
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const initials = (name = '') => name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '·';
const marginPct = (price, cost) => (price > 0 ? Math.round(((price - cost) / price) * 100) : 0);
const marginColor = (m) => (m >= 50 ? '#3f8500' : m >= 35 ? '#0b1a3f' : '#ff3b00');

// Category display order: Oats, Wraps/Buns, Snack, Bowl, Main (Bowl wasn't
// in the list given — placed just before Main since it's not mentioned).
const MEAL_TYPES = ['oats', 'wraps-buns', 'snack', 'bowl', 'main'];
const MEAL_TYPE_LABEL = { oats: 'Oats', 'wraps-buns': 'Wraps/Buns', snack: 'Snack', bowl: 'Bowl', main: 'Main' };
const TYPE_BADGE = { cafe: '#fff2d9', gym: '#e3edff', restaurant: '#e3f3d9', other: '#f1ebe2' };
const WASTE_REASONS = ['over-order', 'spoilage', 'returns', 'prep-error'];

const AB = { fontFamily: "'Archivo Black', sans-serif" };
const SANS = { fontFamily: "'Archivo', system-ui, sans-serif" };
const card = 'bg-white border-[1.5px] border-[#e3d9ca] rounded-[22px]';
const inputCls = 'w-full border-[1.5px] border-[#e3d9ca] rounded-full px-3.5 py-2 text-sm text-[#0b1a3f] bg-white focus:outline-none focus:ring-2 focus:ring-[#bcf679]';
const pillBtn = 'rounded-full px-4 py-2 text-sm font-bold transition-colors';

const exportCsv = (headers, rows, filename) => {
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((r) => r.map(escape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};

// ═══════════════════════════════ MODALS ═══════════════════════════════════════

const Modal = ({ title, onClose, children }) => (
  <div className="fixed inset-0 bg-[#051747]/60 flex items-center justify-center z-50 p-4" onClick={onClose} style={SANS}>
    <div className="bg-white rounded-[22px] shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
      <div className="bg-[#051747] text-[#ede5de] px-6 py-4 rounded-t-[22px] flex items-center justify-between">
        <h3 className="text-lg" style={AB}>{title}</h3>
        <button onClick={onClose} className="hover:bg-white/10 rounded-full p-1.5 transition-colors"><X className="w-5 h-5" /></button>
      </div>
      <div className="p-6">{children}</div>
    </div>
  </div>
);

const PartnerFormModal = ({ onClose, onSaved, initial = null }) => {
  const isEdit = !!initial;
  const [form, setForm] = useState(isEdit
    ? {
        businessName: initial.businessName, businessType: initial.businessType, contactName: initial.contactName,
        phone: initial.phone || '', address: initial.address || '', minimumOrder: initial.minimumOrder ?? 0,
        menuSelectionEnabled: !!initial.menuSelectionEnabled,
        presetMacros: { C: initial.presetMacros?.C ?? 0, P: initial.presetMacros?.P ?? 0, F: initial.presetMacros?.F ?? 0 },
        profilePicture: initial.profilePicture || '', accountCategory: initial.accountCategory || 'partner'
      }
    : {
        businessName: '', businessType: 'cafe', contactName: '', email: '', password: '', phone: '', address: '', minimumOrder: 0,
        menuSelectionEnabled: false, presetMacros: { C: 0, P: 0, F: 0 }, profilePicture: '', accountCategory: 'partner'
      }
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [uploadingPicture, setUploadingPicture] = useState(false);

  const set = (e) => { const { name, value } = e.target; setForm((p) => ({ ...p, [name]: value })); setError(''); };
  const setMacro = (key) => (e) => { const value = e.target.value; setForm((p) => ({ ...p, presetMacros: { ...p.presetMacros, [key]: value } })); };

  const uploadPicture = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingPicture(true); setError('');
    try {
      const fd = new FormData();
      fd.append('image', file);
      const res = await api.post('/admin/partners/upload-picture', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setForm((p) => ({ ...p, profilePicture: res.data.url }));
    } catch (err) { setError(err.response?.data?.message || 'Failed to upload picture'); }
    finally { setUploadingPicture(false); e.target.value = ''; }
  };

  const submit = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      const payload = { ...form, presetMacros: { C: Number(form.presetMacros.C) || 0, P: Number(form.presetMacros.P) || 0, F: Number(form.presetMacros.F) || 0 } };
      const res = isEdit
        ? await api.patch(`/admin/partners/${initial._id}`, payload)
        : await api.post('/admin/partners', payload);
      onSaved(res.data.data); onClose();
    } catch (err) { setError(err.response?.data?.message || 'Failed to save'); }
    finally { setSaving(false); }
  };

  return (
    <Modal title={isEdit ? 'Edit partner' : 'Add partner'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" style={SANS}>
        {error && <div className="bg-[#fff2eb] border border-[#ffd9c2] text-[#ff3b00] rounded-2xl px-4 py-2 text-sm">{error}</div>}
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2 flex items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-[#f1ebe2] border border-[#e3d9ca] flex-shrink-0 overflow-hidden flex items-center justify-center">
              {form.profilePicture
                ? <img src={form.profilePicture} alt="" className="w-full h-full object-cover" />
                : <Building2 className="w-6 h-6 text-[#c9bfae]" />}
            </div>
            <div>
              <label className="block text-sm font-medium text-[#0b1a3f] mb-1">Profile Picture</label>
              <label className="inline-flex items-center gap-2 text-sm text-[#3f8500] hover:text-[#2d6300] font-bold cursor-pointer">
                {uploadingPicture ? <Loader className="w-4 h-4 animate-spin" /> : null}
                {uploadingPicture ? 'Uploading…' : form.profilePicture ? 'Change picture' : 'Upload picture'}
                <input type="file" accept="image/*" className="hidden" onChange={uploadPicture} disabled={uploadingPicture} />
              </label>
              {form.profilePicture && !uploadingPicture && (
                <button type="button" onClick={() => setForm((p) => ({ ...p, profilePicture: '' }))} className="block text-xs text-[#c9bfae] hover:text-[#ff3b00] mt-0.5">
                  Remove
                </button>
              )}
            </div>
          </div>
          <div className="col-span-2">
            <label className="block text-sm font-medium text-[#0b1a3f] mb-1">Account category *</label>
            <select name="accountCategory" value={form.accountCategory} onChange={set} className={inputCls}>
              <option value="retail">MATTER RETAIL</option>
              <option value="member">MATTER MEMBER</option>
              <option value="partner">MATTER PARTNER</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-sm font-medium text-[#0b1a3f] mb-1">Business Name *</label>
            <input name="businessName" required value={form.businessName} onChange={set} className={inputCls} placeholder="Café Bella" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#0b1a3f] mb-1">Type *</label>
            <select name="businessType" value={form.businessType} onChange={set} className={inputCls}>
              {['cafe', 'gym', 'restaurant', 'other'].map((t) => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#0b1a3f] mb-1">Contact Name *</label>
            <input name="contactName" required value={form.contactName} onChange={set} className={inputCls} placeholder="John Smith" />
          </div>
          {!isEdit && <>
            <div>
              <label className="block text-sm font-medium text-[#0b1a3f] mb-1">Email *</label>
              <input name="email" type="email" required value={form.email} onChange={set} className={inputCls} placeholder="partner@cafe.com" />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#0b1a3f] mb-1">Password *</label>
              <input name="password" type="password" required minLength={6} value={form.password} onChange={set} className={inputCls} placeholder="Min. 6 chars" />
            </div>
          </>}
          <div><label className="block text-sm font-medium text-[#0b1a3f] mb-1">Phone</label>
            <input name="phone" value={form.phone} onChange={set} className={inputCls} placeholder="+971 50 000 0000" /></div>
          <div><label className="block text-sm font-medium text-[#0b1a3f] mb-1">Address</label>
            <input name="address" value={form.address} onChange={set} className={inputCls} placeholder="Dubai, UAE" /></div>
          <div className="col-span-2">
            <label className="block text-sm font-medium text-[#0b1a3f] mb-1">Minimum Order (AED)</label>
            <input name="minimumOrder" type="number" min="0" step="0.01" value={form.minimumOrder} onChange={set} className={inputCls} placeholder="0" />
            <p className="text-xs text-[#6b7894] mt-1">Partners must reach this amount before placing an order. Set to 0 for no minimum.</p>
          </div>
          <div className="col-span-2 border-t border-[#e3d9ca] pt-4">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" checked={form.menuSelectionEnabled}
                onChange={(e) => setForm((p) => ({ ...p, menuSelectionEnabled: e.target.checked }))}
                className="mt-0.5 h-4 w-4 rounded accent-[#3f8500]" />
              <span>
                <span className="block text-sm font-medium text-[#0b1a3f]">Menu Selection Partner</span>
                <span className="block text-xs text-[#6b7894] mt-0.5">
                  This partner's members order through the regular Menu Selection flow (weekly menu) instead of
                  the à-la-carte partner menu — no daily meal limit, and a preset macro target below instead of
                  entering their own macros.
                </span>
              </span>
            </label>
            {form.menuSelectionEnabled && (
              <div className="grid grid-cols-3 gap-3 mt-3 bg-[#f1ebe2] rounded-2xl p-3">
                <div>
                  <label className="block text-xs font-medium text-[#6b7894] mb-1">Carbs (C)</label>
                  <input type="number" min="0" value={form.presetMacros.C} onChange={setMacro('C')} className="w-full border-[1.5px] border-[#e3d9ca] rounded-full px-2.5 py-1.5 text-sm bg-white focus:ring-2 focus:ring-[#bcf679]" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6b7894] mb-1">Protein (P)</label>
                  <input type="number" min="0" value={form.presetMacros.P} onChange={setMacro('P')} className="w-full border-[1.5px] border-[#e3d9ca] rounded-full px-2.5 py-1.5 text-sm bg-white focus:ring-2 focus:ring-[#bcf679]" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6b7894] mb-1">Fat (F)</label>
                  <input type="number" min="0" value={form.presetMacros.F} onChange={setMacro('F')} className="w-full border-[1.5px] border-[#e3d9ca] rounded-full px-2.5 py-1.5 text-sm bg-white focus:ring-2 focus:ring-[#bcf679]" />
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-3 pt-2">
          <button type="button" onClick={onClose} className={`${pillBtn} flex-1 border-[1.5px] border-[#e3d9ca] text-[#6b7894] hover:border-[#3f8500] hover:text-[#3f8500]`}>Cancel</button>
          <button type="submit" disabled={saving} className={`${pillBtn} flex-1 bg-[#bcf679] text-[#051747] hover:opacity-90 disabled:opacity-50`}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add partner'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

const toDateInput = (d) => (d ? new Date(d).toISOString().split('T')[0] : '');

const MenuItemModal = ({ onClose, onSaved, initial = null }) => {
  const isEdit = !!initial;
  const [form, setForm] = useState(isEdit
    ? { name: initial.name, mealType: initial.mealType, description: initial.description || '', price: initial.price, category: initial.category || '', isAvailable: initial.isAvailable, availableFrom: toDateInput(initial.availableFrom), availableTo: toDateInput(initial.availableTo), ingredients: (initial.ingredients || []).join(', '), sellingPrice: initial.sellingPrice ?? '' }
    : { name: '', mealType: 'main', description: '', price: '', category: '', isAvailable: true, availableFrom: '', availableTo: '', ingredients: '', sellingPrice: '' }
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (e) => { const { name, value, type, checked } = e.target; setForm((p) => ({ ...p, [name]: type === 'checkbox' ? checked : value })); setError(''); };

  const submit = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        price: Number(form.price),
        sellingPrice: form.sellingPrice === '' ? null : Number(form.sellingPrice),
        availableFrom: form.availableFrom || null,
        availableTo: form.availableTo || null,
        ingredients: form.ingredients ? form.ingredients.split(',').map((s) => s.trim()).filter(Boolean) : [],
      };
      const res = isEdit
        ? await api.patch(`/admin/partners/menu/${initial._id}`, payload)
        : await api.post('/admin/partners/menu', payload);
      onSaved(res.data.data); onClose();
    } catch (err) { setError(err.response?.data?.message || 'Failed to save'); }
    finally { setSaving(false); }
  };

  return (
    <Modal title={isEdit ? 'Edit item' : 'Add menu item'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" style={SANS}>
        {error && <div className="bg-[#fff2eb] border border-[#ffd9c2] text-[#ff3b00] rounded-2xl px-4 py-2 text-sm">{error}</div>}
        {initial?.source === 'menu-selection' && (
          <div className="bg-[#eafbd0] border border-[#cdeb9e] text-[#2a3f13] rounded-2xl px-4 py-2.5 text-[12.5px] leading-snug">
            Auto-synced from the Menu Selection weekly menu. Its price and availability window are kept in sync automatically each time next week's menu is published — edits here will be overwritten the next time that dish appears.
          </div>
        )}
        <div><label className="block text-sm font-medium text-[#0b1a3f] mb-1">Item Name *</label>
          <input name="name" required value={form.name} onChange={set} className={inputCls} placeholder="Grilled Chicken Bowl" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-sm font-medium text-[#0b1a3f] mb-1">Meal Type *</label>
            <select name="mealType" value={form.mealType} onChange={set} className={inputCls}>
              {MEAL_TYPES.map((t) => <option key={t} value={t}>{MEAL_TYPE_LABEL[t]}</option>)}
            </select></div>
          <div><label className="block text-sm font-medium text-[#0b1a3f] mb-1">Selling price (AED)</label>
            <input name="sellingPrice" type="number" min="0" step="0.01" value={form.sellingPrice} onChange={set} className={inputCls} placeholder="Applies to all partners" />
            <p className="text-[11px] text-[#6b7894] mt-1">Used for every partner unless that partner has its own price in their sub-menu.</p></div>
          <div><label className="block text-sm font-medium text-[#0b1a3f] mb-1">Base price (AED) *</label>
            <input name="price" type="number" required min="0" step="0.01" value={form.price} onChange={set} className={inputCls} placeholder="25.00" /></div>
        </div>
        <div><label className="block text-sm font-medium text-[#0b1a3f] mb-1">Category</label>
          <input name="category" value={form.category} onChange={set} className={inputCls} placeholder="High Protein, Vegan…" /></div>
        <div><label className="block text-sm font-medium text-[#0b1a3f] mb-1">Description</label>
          <textarea name="description" rows={2} value={form.description} onChange={set} className="w-full border-[1.5px] border-[#e3d9ca] rounded-2xl px-3.5 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#bcf679]" /></div>
        <div><label className="block text-sm font-medium text-[#0b1a3f] mb-1">Ingredients <span className="text-[#c9bfae] font-normal">(comma-separated)</span></label>
          <textarea name="ingredients" rows={2} value={form.ingredients} onChange={set} className="w-full border-[1.5px] border-[#e3d9ca] rounded-2xl px-3.5 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#bcf679]" placeholder="Chicken, Rice, Olive Oil, Garlic…" /></div>
        <div>
          <label className="block text-sm font-medium text-[#0b1a3f] mb-1">Availability Window <span className="text-[#c9bfae] font-normal">(optional)</span></label>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs text-[#6b7894] mb-1">From</label>
              <input name="availableFrom" type="date" value={form.availableFrom} onChange={set} className={inputCls} /></div>
            <div><label className="block text-xs text-[#6b7894] mb-1">To</label>
              <input name="availableTo" type="date" value={form.availableTo} onChange={set} className={inputCls} /></div>
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" name="isAvailable" checked={form.isAvailable} onChange={set} className="w-4 h-4 accent-[#3f8500] rounded" />
          <span className="text-sm text-[#0b1a3f]">Available for ordering</span>
        </label>
        <div className="flex gap-3 pt-1">
          <button type="button" onClick={onClose} className={`${pillBtn} flex-1 border-[1.5px] border-[#e3d9ca] text-[#6b7894] hover:border-[#3f8500] hover:text-[#3f8500]`}>Cancel</button>
          <button type="submit" disabled={saving} className={`${pillBtn} flex-1 bg-[#bcf679] text-[#051747] hover:opacity-90 disabled:opacity-50`}>
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Add item'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

const Empty = ({ icon: Icon, text }) => (
  <div className="text-center py-16 text-[#c9bfae]"><Icon className="w-12 h-12 mx-auto mb-3 opacity-40" /><p className="text-sm text-[#6b7894]">{text}</p></div>
);

// ═══════════════════════════════ MAIN ═════════════════════════════════════════

const TABS = [
  { id: 'partners', label: 'Partners', icon: Building2, d: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21a8 8 0 0 1 16 0' },
  { id: 'menu', label: 'Menu', icon: UtensilsCrossed, d: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6' },
  { id: 'orders', label: 'Orders', icon: ClipboardList, d: 'M5 4h14v17l-3-2-2 2-2-2-2 2-2-2-3 2zM9 9h6M9 13h6' },
  { id: 'invoices', label: 'Invoices', icon: FileText, d: 'M6 3h9l5 5v13H6zM14 3v6h6M9 14h6M9 18h4' },
  { id: 'waste', label: 'Waste log', icon: Leaf, d: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6' },
  { id: 'reports', label: 'Reports', icon: BarChart2, d: 'M4 20h16M6 16V10M11 16V5M16 16v-7M21 16v-4' },
];

const AdminPartners = () => {
  const currentUser = useSelector((state) => state.auth.user);
  const isKitchen = currentUser?.role === 'kitchen';
  const [tab, setTab] = useState(isKitchen ? 'orders' : 'partners');

  // ── Partners state ──────────────────────────────────────────────────────────
  const [spaces, setSpaces] = useState([]);
  const [spacesLoading, setSpacesLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showAddSpace, setShowAddSpace] = useState(false);
  const [editingSpace, setEditingSpace] = useState(null);
  const [selId, setSelId] = useState('');
  const [selOrders, setSelOrders] = useState({});
  const [selMembers, setSelMembers] = useState({});
  const [showMembers, setShowMembers] = useState(false);

  // ── Master items state ─────────────────────────────────────────────────────
  const [menuItems, setMenuItems] = useState([]);
  const [menuLoading, setMenuLoading] = useState(false);
  const [menuSearch, setMenuSearch] = useState('');
  const [menuTypeFilter, setMenuTypeFilter] = useState('all');
  const [showAddItem, setShowAddItem] = useState(false);
  const [editingItem, setEditingItem] = useState(null);

  // ── Partner sub-menu (was "Space Setup") state ────────────────────────────
  const [setupItems, setSetupItems] = useState([]);
  const [setupLoading, setSetupLoading] = useState(false);
  const [priceEdits, setPriceEdits] = useState({});
  const [costEdits, setCostEdits] = useState({});
  const [setupSaving, setSetupSaving] = useState({});
  const [subMenuSearch, setSubMenuSearch] = useState('');

  // ── Orders state ───────────────────────────────────────────────────────────
  const [allOrders, setAllOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [orderChip, setOrderChip] = useState('all');
  const [orderSpaceFilter, setOrderSpaceFilter] = useState('');
  const [orderFrom, setOrderFrom] = useState('');
  const [orderTo, setOrderTo] = useState('');
  const [expandedOrder, setExpandedOrder] = useState(null);
  const [workingOrder, setWorkingOrder] = useState(null);

  // ── Invoices state ─────────────────────────────────────────────────────────
  const [invoices, setInvoices] = useState([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoiceType, setInvoiceType] = useState('partner');
  const [expandedInvoice, setExpandedInvoice] = useState(null);
  const [invoiceLines, setInvoiceLines] = useState({});

  // ── Waste state ────────────────────────────────────────────────────────────
  const [wasteLogs, setWasteLogs] = useState([]);
  const [wasteLoading, setWasteLoading] = useState(false);
  const [wastePartyFilter, setWastePartyFilter] = useState('');
  const [wasteSpaceFilter, setWasteSpaceFilter] = useState('');
  const [wasteForm, setWasteForm] = useState({ spaceId: '', deliveryDate: '', menuItemId: '', quantity: '', reason: '', note: '' });
  const [wasteSubmitting, setWasteSubmitting] = useState(false);
  const [wasteError, setWasteError] = useState('');

  // ── Reports state ──────────────────────────────────────────────────────────
  const [reports, setReports] = useState(null);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo, setReportTo] = useState('');

  // ── Loaders ────────────────────────────────────────────────────────────────
  const loadSpaces = useCallback(async () => {
    setSpacesLoading(true);
    try {
      const r = await api.get('/admin/partners', { params: { limit: 100 } });
      const list = r.data.data || [];
      setSpaces(list);
      setSelId((prev) => prev || list[0]?._id || '');
    } catch { } finally { setSpacesLoading(false); }
  }, []);

  const loadMenu = useCallback(async () => {
    setMenuLoading(true);
    try { const r = await api.get('/admin/partners/menu'); setMenuItems(r.data.data || []); }
    catch { } finally { setMenuLoading(false); }
  }, []);

  const loadSetupItems = useCallback(async (spaceId) => {
    if (!spaceId) { setSetupItems([]); return; }
    setSetupLoading(true);
    try { const r = await api.get(`/admin/partners/${spaceId}/menu`); setSetupItems(r.data.data || []); }
    catch { } finally { setSetupLoading(false); }
  }, []);

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    try {
      const r = await api.get('/admin/partners/orders/all', { params: {
        spaceId: orderSpaceFilter || undefined,
        from: orderFrom || undefined,
        to: orderTo || undefined
      } });
      setAllOrders((r.data.data || []).filter((o) => o.status !== 'draft'));
    } catch { } finally { setOrdersLoading(false); }
  }, [orderSpaceFilter, orderFrom, orderTo]);

  const loadInvoices = useCallback(async () => {
    setInvoicesLoading(true);
    try { const r = await api.get('/admin/partners/invoices/all', { params: { type: invoiceType } }); setInvoices(r.data.data || []); }
    catch { } finally { setInvoicesLoading(false); }
  }, [invoiceType]);

  const loadWaste = useCallback(async () => {
    setWasteLoading(true);
    try { const r = await api.get('/admin/partners/waste/all', { params: { party: wastePartyFilter || undefined, spaceId: wasteSpaceFilter || undefined } }); setWasteLogs(r.data.data || []); }
    catch { } finally { setWasteLoading(false); }
  }, [wastePartyFilter, wasteSpaceFilter]);

  const loadReports = useCallback(async () => {
    setReportsLoading(true);
    try { const r = await api.get('/admin/partners/reports/consolidated', { params: { from: reportFrom || undefined, to: reportTo || undefined } }); setReports(r.data.data); }
    catch { } finally { setReportsLoading(false); }
  }, [reportFrom, reportTo]);

  useEffect(() => { loadSpaces(); loadMenu(); }, [loadSpaces, loadMenu]);
  useEffect(() => { if (tab === 'orders') loadOrders(); }, [tab, loadOrders]);
  useEffect(() => { if (tab === 'invoices') loadInvoices(); }, [tab, loadInvoices]);
  useEffect(() => { if (tab === 'waste') loadWaste(); }, [tab, loadWaste]);
  useEffect(() => { if (tab === 'reports') loadReports(); }, [tab, loadReports]);
  useEffect(() => { if (tab === 'partners' && selId) { loadSetupItems(selId); setPriceEdits({}); setCostEdits({}); setSelOrders({}); setSelMembers({}); setShowMembers(false); } }, [tab, selId, loadSetupItems]);

  // ── Partner actions ────────────────────────────────────────────────────────
  const toggleActive = async (space) => {
    try {
      const r = await api.patch(`/admin/partners/${space._id}`, { isActive: !space.isActive });
      setSpaces((prev) => prev.map((p) => (p._id === space._id ? r.data.data : p)));
    } catch { alert('Failed to update status'); }
  };

  const deleteSpace = async (space) => {
    if (!window.confirm(`Delete "${space.businessName}"?`)) return;
    try {
      await api.delete(`/admin/partners/${space._id}`);
      setSpaces((prev) => prev.filter((p) => p._id !== space._id));
      if (selId === space._id) setSelId('');
    } catch { alert('Failed to delete'); }
  };

  const loadSelOrders = async () => {
    if (!selId || selOrders.loaded) return;
    try { const r = await api.get(`/admin/partners/${selId}/orders`); setSelOrders({ loaded: true, rows: r.data.data || [] }); }
    catch { setSelOrders({ loaded: true, rows: [] }); }
  };

  const loadSelMembers = async () => {
    setShowMembers((v) => !v);
    if (!selId || selMembers.loaded) return;
    try { const r = await api.get(`/admin/partners/${selId}/members`); setSelMembers({ loaded: true, rows: r.data.data || [] }); }
    catch { setSelMembers({ loaded: true, rows: [] }); }
  };

  const toggleMemberActive = async (member) => {
    try {
      const r = await api.patch(`/admin/partners/${selId}/members/${member._id}`, { isActive: !member.isActive });
      setSelMembers((prev) => ({ loaded: true, rows: (prev.rows || []).map((m) => (m._id === member._id ? { ...m, isActive: r.data.data.isActive } : m)) }));
    } catch (err) { alert(err.response?.data?.message || 'Failed to update member'); }
  };

  // ── Sub-menu (pricing) actions ─────────────────────────────────────────────
  const isAssigned = (menuItemId) => setupItems.some((a) => String(a.menuItem?._id) === String(menuItemId) && a.isActive);

  const toggleAssignment = async (menuItemId, currentlyAssigned) => {
    if (!selId) return;
    try {
      if (currentlyAssigned) await api.delete(`/admin/partners/${selId}/menu/${menuItemId}`);
      else await api.post(`/admin/partners/${selId}/menu`, { menuItemId });
      loadSetupItems(selId);
    } catch (err) { alert(err.response?.data?.message || 'Failed to update assignment'); }
  };

  const savePrice = async (menuItemId, priceValue) => {
    const price = priceValue !== undefined ? priceValue : priceEdits[menuItemId];
    if (price === undefined || price === '') return;
    setSetupSaving((p) => ({ ...p, [menuItemId]: true }));
    try { await api.patch('/admin/partners/prices', { spaceId: selId, menuItemId, price: Number(price) }); loadSetupItems(selId); }
    catch (err) { alert(err.response?.data?.message || 'Failed to set price'); }
    finally { setSetupSaving((p) => ({ ...p, [menuItemId]: false })); }
  };

  // Autosave the sub-menu price as the admin types — debounced so it fires
  // once typing pauses instead of on every keystroke. Passes the typed
  // value straight to savePrice rather than relying on priceEdits state
  // (which wouldn't have committed yet inside the timeout callback).
  const priceTimers = useRef({});
  useEffect(() => () => { Object.values(priceTimers.current).forEach(clearTimeout); }, []);
  const schedulePriceSave = (menuItemId, value) => {
    setPriceEdits((p) => ({ ...p, [menuItemId]: value }));
    clearTimeout(priceTimers.current[menuItemId]);
    if (value === '') return;
    priceTimers.current[menuItemId] = setTimeout(() => savePrice(menuItemId, value), 600);
  };

  const saveCost = async (menuItemId) => {
    const cost = costEdits[menuItemId];
    if (cost === undefined || cost === '') return;
    setSetupSaving((p) => ({ ...p, [`cost_${menuItemId}`]: true }));
    try { await api.post('/admin/partners/costs', { menuItemId, cost: Number(cost) }); loadSetupItems(selId); }
    catch (err) { alert(err.response?.data?.message || 'Failed to set cost'); }
    finally { setSetupSaving((p) => ({ ...p, [`cost_${menuItemId}`]: false })); }
  };

  // ── Order actions ──────────────────────────────────────────────────────────
  const acknowledgeOrder = async (order) => {
    setWorkingOrder(order._id);
    try {
      const r = await api.patch(`/admin/partners/orders/${order._id}/acknowledge`);
      setAllOrders((prev) => prev.map((o) => (o._id === order._id ? { ...o, acknowledgedAt: r.data.data.acknowledgedAt } : o)));
    } catch (err) { alert(err.response?.data?.message || 'Failed to acknowledge order'); }
    finally { setWorkingOrder(null); }
  };

  const lockOrder = async (orderId) => {
    if (!window.confirm('Lock this order and generate invoices? This cannot be undone.')) return;
    setWorkingOrder(orderId);
    try { await api.patch(`/admin/partners/orders/${orderId}/lock`); loadOrders(); }
    catch (err) { alert(err.response?.data?.message || 'Failed to lock order'); }
    finally { setWorkingOrder(null); }
  };

  // ── Invoice actions ────────────────────────────────────────────────────────
  const fetchInvoiceLines = async (invId) => {
    if (invoiceLines[invId]) { setExpandedInvoice(expandedInvoice === invId ? null : invId); return; }
    try {
      const r = await api.get(`/admin/partners/invoices/${invId}`);
      setInvoiceLines((prev) => ({ ...prev, [invId]: r.data.data.lines || [] }));
      setExpandedInvoice(invId);
    } catch { setExpandedInvoice(invId); }
  };

  const downloadInvoicePdf = (inv) => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const m = 15; let y = m;
    const isMatter = inv.type === 'matter';
    doc.setFontSize(20); doc.setFont('helvetica', 'bold');
    doc.setTextColor(isMatter ? 16 : 5, isMatter ? 133 : 23, isMatter ? 83 : 71);
    doc.text('Matter Delivery', m, y); y += 7;
    doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(107, 120, 148);
    doc.text(isMatter ? 'Internal Reconciliation Statement' : 'Partner Invoice', m, y); y += 10;
    doc.setTextColor(11, 26, 63); doc.setFontSize(12); doc.setFont('helvetica', 'bold');
    doc.text(`${isMatter ? 'Statement' : 'Invoice'}: ${inv.invoiceNumber}`, m, y); y += 6;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text(`Partner: ${inv.space?.businessName || ''}`, m, y); y += 5;
    doc.text(`Delivery Date: ${fmtDate(inv.order?.deliveryDate)}`, m, y); y += 8;
    const lines = invoiceLines[inv._id] || [];
    const head = isMatter
      ? [['Item', 'Qty', 'Unit Price', 'Unit Cost', 'Revenue', 'Cost', 'Margin']]
      : [['Item', 'Qty', 'Unit Price (AED)', 'Total (AED)']];
    const body = lines.map((l) => (isMatter
      ? [l.itemName, l.quantity, fmt(l.unitPrice), fmt(l.unitCost), fmt(l.lineRevenue), fmt(l.lineCost), fmt(l.lineMargin)]
      : [l.itemName, l.quantity, fmt(l.unitPrice), fmt(l.lineRevenue)]
    ));
    const foot = isMatter
      ? [['', '', '', '', fmt(inv.totalRevenue), fmt(inv.totalCost), fmt(inv.totalMargin)]]
      : [['', '', 'TOTAL', `${fmt(inv.totalRevenue)} AED`]];
    doc.autoTable({ startY: y, head, body, foot, styles: { fontSize: 9 }, headStyles: { fillColor: isMatter ? [16, 133, 83] : [5, 23, 71] }, footStyles: { fontStyle: 'bold', fillColor: [241, 235, 226] } });
    doc.save(`${inv.invoiceNumber}.pdf`);
  };

  // ── Waste submit ───────────────────────────────────────────────────────────
  const submitWaste = async (e) => {
    e.preventDefault(); setWasteError(''); setWasteSubmitting(true);
    try {
      await api.post('/admin/partners/waste', { ...wasteForm, quantity: Number(wasteForm.quantity) });
      setWasteForm({ spaceId: '', deliveryDate: '', menuItemId: '', quantity: '', reason: '', note: '' });
      loadWaste();
    } catch (err) { setWasteError(err.response?.data?.message || 'Failed to log waste'); }
    finally { setWasteSubmitting(false); }
  };

  // ── Derived ────────────────────────────────────────────────────────────────
  const filteredSpaces = useMemo(() => {
    if (!search) return spaces;
    const q = search.toLowerCase();
    return spaces.filter((p) => p.businessName?.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q) || p.contactName?.toLowerCase().includes(q));
  }, [spaces, search]);

  // Master menu grouped by category (meal type) — mirrors the partner
  // sub-menu's own category grouping, with a chip above to filter to one.
  const masterMenuGroups = useMemo(() => {
    const q = menuSearch.trim().toLowerCase();
    const matchesSearch = (i) => !q || i.name?.toLowerCase().includes(q) || i.category?.toLowerCase().includes(q) || i.mealType?.toLowerCase().includes(q);
    return MEAL_TYPES
      .filter((t) => menuTypeFilter === 'all' || menuTypeFilter === t)
      .map((t) => ({ type: t, label: MEAL_TYPE_LABEL[t] || t, items: menuItems.filter((it) => it.mealType === t && matchesSearch(it)) }))
      .filter((g) => g.items.length > 0);
  }, [menuItems, menuSearch, menuTypeFilter]);

  const menuTypeChips = useMemo(() => {
    const counts = MEAL_TYPES.map((t) => [t, menuItems.filter((i) => i.mealType === t).length]);
    return [['all', 'All', menuItems.length], ...counts];
  }, [menuItems]);

  const sel = useMemo(() => spaces.find((p) => p._id === selId) || null, [spaces, selId]);

  const orderChips = useMemo(() => {
    const statusOf = partnerAdminOrderStatus;
    return [
      ['all', 'All', allOrders.length],
      ['new', 'New', allOrders.filter((o) => statusOf(o) === 'new').length],
      ['acked', 'Acknowledged', allOrders.filter((o) => statusOf(o) === 'acked').length],
      ['invoiced', 'Invoiced', allOrders.filter((o) => statusOf(o) === 'invoiced').length],
      ['locked', 'Awaiting invoice', allOrders.filter((o) => statusOf(o) === 'locked').length],
      ['cancelled', 'Cancelled', allOrders.filter((o) => statusOf(o) === 'cancelled').length],
    ];
  }, [allOrders]);

  const shownOrders = useMemo(() => {
    const statusOf = partnerAdminOrderStatus;
    return orderChip === 'all' ? allOrders : allOrders.filter((o) => statusOf(o) === orderChip);
  }, [allOrders, orderChip]);

  const selSubMenuLine = useMemo(() => {
    const on = setupItems.filter((a) => a.isActive).length;
    const custom = setupItems.filter((a) => a.isActive && a.price != null).length;
    return `${on} of ${menuItems.length} items · ${custom} custom prices`;
  }, [setupItems, menuItems]);

  const subMenuGroups = useMemo(() => {
    const q = subMenuSearch.trim().toLowerCase();
    const filtered = q
      ? menuItems.filter((it) => it.name?.toLowerCase().includes(q) || it.category?.toLowerCase().includes(q) || it.mealType?.toLowerCase().includes(q))
      : menuItems;
    const selected = filtered.filter((it) => isAssigned(it._id));
    const browseGroups = MEAL_TYPES
      .map((t) => ({ type: t, label: MEAL_TYPE_LABEL[t] || t, items: filtered.filter((it) => it.mealType === t && !isAssigned(it._id)) }))
      .filter((g) => g.items.length > 0);
    return selected.length > 0
      ? [{ type: 'selected', label: 'Selected', selected: true, items: selected }, ...browseGroups]
      : browseGroups;
  }, [menuItems, subMenuSearch, setupItems]);

  return (
    <div className="min-h-screen bg-[#f7f2eb]" style={SANS}>
      {/* top nav */}
      <div className="flex items-center gap-5 bg-[#051747] text-[#ede5de] px-7 h-[68px] overflow-x-auto">
        <div className="flex items-center gap-1 flex-1 min-w-0">
          {TABS.filter((t) => !isKitchen || ['orders', 'invoices', 'waste', 'reports'].includes(t.id)).map((t) => {
            const on = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className="flex items-center gap-2 whitespace-nowrap border-none cursor-pointer px-3.5 py-2.5 rounded-full text-[13.5px] font-bold transition-colors"
                style={{ background: on ? '#bcf679' : 'transparent', color: on ? '#051747' : '#ede5de' }}>
                <t.icon className="w-4 h-4 flex-none" />
                {t.label}
                {t.id === 'orders' && orderChips[1][2] > 0 && (
                  <span className="bg-[#ff3b00] text-[#ede5de] rounded-full min-w-[20px] px-1.5 py-0.5 text-[10.5px] text-center">{orderChips[1][2]}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="px-8 py-6 max-w-[1440px] mx-auto">

        {/* ══ PARTNERS TAB ══ */}
        {tab === 'partners' && (
          <>
            <div className="flex items-center justify-between mb-4 gap-3">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#c9bfae]" />
                <input type="text" placeholder="Search partners…" value={search} onChange={(e) => setSearch(e.target.value)}
                  className={`${inputCls} pl-10`} />
              </div>
              {!isKitchen && (
                <button onClick={() => setShowAddSpace(true)} className={`${pillBtn} flex items-center gap-2 bg-[#051747] text-[#ede5de] hover:opacity-90`}>
                  <Plus className="w-4 h-4" />Add partner
                </button>
              )}
            </div>

            {spacesLoading ? <div className="flex justify-center py-16"><Loader className="w-7 h-7 animate-spin text-[#3f8500]" /></div>
              : filteredSpaces.length === 0 ? <Empty icon={Building2} text={search ? 'No partners match your search.' : 'No partners yet. Add the first one.'} />
              : (
                <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-5 items-start">
                  <div className={`${card} overflow-hidden`}>
                    <div className="grid grid-cols-[2fr_.9fr_.9fr_.9fr] gap-3 px-5 py-3 text-[10.5px] font-bold tracking-[0.1em] uppercase text-[#6b7894] border-b-[1.5px] border-[#e3d9ca]">
                      <div>Partner</div><div>Type</div><div>Min. order</div><div>Status</div>
                    </div>
                    {filteredSpaces.map((space) => (
                      <button key={space._id} onClick={() => setSelId(space._id)}
                        className="grid grid-cols-[2fr_.9fr_.9fr_.9fr] gap-3 items-center w-full text-left px-5 py-3.5 border-b border-[#f1ebe2] text-[13.5px] text-[#0b1a3f] transition-colors"
                        style={{ background: space._id === selId ? '#f7f2eb' : '#fff' }}>
                        <div className="flex items-center gap-2.5 min-w-0">
                          {space.profilePicture
                            ? <img src={space.profilePicture} alt="" className="w-[34px] h-[34px] rounded-full object-cover flex-none" />
                            : (
                              <div className="w-[34px] h-[34px] rounded-full flex items-center justify-center font-bold text-xs flex-none"
                                style={{ background: space._id === selId ? '#051747' : '#f1ebe2', color: space._id === selId ? '#bcf679' : '#6b7894' }}>
                                {initials(space.businessName)}
                              </div>
                            )}
                          <div className="min-w-0">
                            <div className="font-bold truncate">{space.businessName}</div>
                            <div className="text-[11.5px] text-[#6b7894] truncate">{space.contactName}{space.menuSelectionEnabled ? ' · Menu Selection' : ''}</div>
                          </div>
                        </div>
                        <div><span className="rounded-full px-2.5 py-1 text-[11px] font-bold capitalize" style={{ background: TYPE_BADGE[space.businessType] || '#f1ebe2', color: '#0b1a3f' }}>{space.businessType}</span></div>
                        <div>{space.minimumOrder > 0 ? `AED ${fmt(space.minimumOrder)}` : '—'}</div>
                        <div>
                          <span className="rounded-full px-2.5 py-1 text-[11px] font-bold" style={{ background: space.isActive ? '#bcf679' : '#f1ebe2', color: space.isActive ? '#051747' : '#6b7894' }}>
                            {space.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>

                  {sel && (
                    <div className={`${card} p-5`}>
                      <div className="flex items-center gap-3">
                        {sel.profilePicture
                          ? <img src={sel.profilePicture} alt="" className="w-12 h-12 rounded-full object-cover flex-none" />
                          : <div className="w-12 h-12 rounded-full bg-[#051747] text-[#bcf679] flex items-center justify-center flex-none text-base" style={AB}>{initials(sel.businessName)}</div>}
                        <div className="min-w-0">
                          <div className="text-[17px] truncate" style={AB}>{sel.businessName}</div>
                          <div className="text-xs text-[#6b7894] mt-0.5 truncate">{sel.address || 'No address on file'}</div>
                          <span className="inline-block mt-1.5 rounded-full px-2.5 py-0.5 text-[10.5px] font-bold tracking-[0.06em]" style={{ background: sel.accountCategory === 'retail' ? '#fff2d9' : sel.accountCategory === 'member' ? '#e3edff' : '#bcf679', color: '#051747' }}>{({ retail: 'MATTER RETAIL', member: 'MATTER MEMBER', partner: 'MATTER PARTNER' })[sel.accountCategory] || 'MATTER PARTNER'}</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 mt-4">
                        <div className="bg-[#f1ebe2] rounded-2xl px-3 py-2.5">
                          <div className="text-[10px] font-bold tracking-[0.1em] uppercase text-[#6b7894]">Contact</div>
                          <div className="text-[13px] font-bold mt-0.5 truncate">{sel.contactName}</div>
                        </div>
                        <div className="bg-[#f1ebe2] rounded-2xl px-3 py-2.5">
                          <div className="text-[10px] font-bold tracking-[0.1em] uppercase text-[#6b7894]">Phone</div>
                          <div className="text-[13px] font-bold mt-0.5 truncate">{sel.phone || '—'}</div>
                        </div>
                      </div>

                      {!isKitchen && (
                        <div className="flex gap-2 mt-3">
                          <button onClick={() => setEditingSpace(sel)} className={`${pillBtn} flex-1 border-[1.5px] border-[#e3d9ca] text-[#0b1a3f] hover:border-[#3f8500] flex items-center justify-center gap-1.5 text-xs py-2`}>
                            <Edit className="w-3.5 h-3.5" />Edit
                          </button>
                          <button onClick={() => toggleActive(sel)} className={`${pillBtn} flex-1 border-[1.5px] text-xs py-2`}
                            style={{ borderColor: sel.isActive ? '#ffd9c2' : '#e3d9ca', color: sel.isActive ? '#ff3b00' : '#3f8500' }}>
                            {sel.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                          <button onClick={() => deleteSpace(sel)} className="flex-none p-2 text-[#c9bfae] hover:text-[#ff3b00] hover:bg-[#fff2eb] rounded-full transition-colors"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      )}

                      {/* orders */}
                      <button onClick={loadSelOrders} className="w-full flex items-center gap-1.5 text-xs text-[#3f8500] hover:text-[#2d6300] font-bold mt-4">
                        <ClipboardList className="w-3.5 h-3.5" />Recent orders
                        {selOrders.loaded ? (selOrders.rows?.length ? <ChevronUp className="w-3.5 h-3.5 ml-auto" /> : null) : <ChevronDown className="w-3.5 h-3.5 ml-auto" />}
                      </button>
                      {selOrders.loaded && selOrders.rows?.length > 0 && (
                        <div className="mt-2 flex flex-col gap-1.5 max-h-40 overflow-y-auto">
                          {selOrders.rows.slice(0, 8).map((o) => (
                            <div key={o._id} className="flex items-center justify-between text-xs bg-[#f7f2eb] rounded-full px-3 py-1.5">
                              <span className="text-[#6b7894]">{fmtDate(o.deliveryDate)}</span>
                              <span className="font-bold capitalize">{o.status}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* members */}
                      <button onClick={loadSelMembers} className="w-full flex items-center gap-1.5 text-xs text-[#3f8500] hover:text-[#2d6300] font-bold mt-3">
                        <Users className="w-3.5 h-3.5" />Members
                        {showMembers ? <ChevronUp className="w-3.5 h-3.5 ml-auto" /> : <ChevronDown className="w-3.5 h-3.5 ml-auto" />}
                      </button>
                      {showMembers && (
                        <div className="mt-2 flex flex-col gap-1.5 max-h-48 overflow-y-auto">
                          {!selMembers.loaded ? <div className="text-xs text-[#6b7894] flex items-center gap-1.5"><Loader className="w-3 h-3 animate-spin" />Loading…</div>
                            : selMembers.rows.length === 0 ? <p className="text-xs text-[#6b7894] italic">No members have joined via the QR link yet.</p>
                            : selMembers.rows.map((m) => {
                              const chips = groupExclusions(m.dietaryExclusions || '');
                              return (
                                <div key={m._id} className="bg-[#f7f2eb] rounded-2xl px-3 py-2">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-bold text-xs">{m.name}</span>
                                    <span className="text-[11px] text-[#6b7894]">{m.email}</span>
                                    {!m.isActive && <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-[#fff2eb] text-[#ff3b00]">Inactive</span>}
                                    {!isKitchen && (
                                      <button onClick={() => toggleMemberActive(m)} className="ml-auto text-[11px] font-bold" style={{ color: m.isActive ? '#ff3b00' : '#3f8500' }}>
                                        {m.isActive ? 'Deactivate' : 'Activate'}
                                      </button>
                                    )}
                                  </div>
                                  {chips.length > 0 && (
                                    <div className="flex flex-wrap gap-1 mt-1.5">
                                      {chips.map((c) => <span key={c} className="bg-white text-[#3f8500] px-2 py-0.5 rounded-full text-[10px] font-bold">{c}</span>)}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                        </div>
                      )}

                      {/* sub-menu */}
                      <div className="flex items-baseline gap-2 mt-5 mb-2.5">
                        <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-[#6b7894]">Partner sub-menu</div>
                        <div className="ml-auto text-xs text-[#6b7894]">{selSubMenuLine}</div>
                      </div>
                      <div className="relative mb-2.5">
                        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#c9bfae]" />
                        <input type="text" placeholder="Search items…" value={subMenuSearch} onChange={(e) => setSubMenuSearch(e.target.value)}
                          className="w-full border-[1.5px] border-[#e3d9ca] rounded-full pl-9 pr-3.5 py-1.5 text-xs text-[#0b1a3f] bg-white focus:outline-none focus:ring-2 focus:ring-[#bcf679]" />
                      </div>
                      {setupLoading ? <div className="flex justify-center py-6"><Loader className="w-5 h-5 animate-spin text-[#3f8500]" /></div>
                        : subMenuGroups.length === 0 ? <p className="text-xs text-[#6b7894] italic py-4 text-center">No items match your search.</p>
                        : (
                          <div className="flex flex-col gap-3.5 max-h-[340px] overflow-y-auto pr-0.5">
                            {subMenuGroups.map((group) => (
                              <div key={group.type}>
                                <div className="flex items-center gap-1.5 mb-1.5">
                                  {group.selected && <span className="w-1.5 h-1.5 rounded-full bg-[#3f8500]" />}
                                  <div className="text-[10px] font-bold tracking-[0.1em] uppercase" style={{ color: group.selected ? '#3f8500' : '#6b7894' }}>{group.label}</div>
                                </div>
                                <div className="flex flex-col gap-1.5">
                                  {group.items.map((it) => {
                                    const assigned = isAssigned(it._id);
                                    const setupEntry = setupItems.find((a) => String(a.menuItem?._id) === String(it._id));
                                    const price = priceEdits[it._id] !== undefined ? priceEdits[it._id] : (setupEntry?.price ?? it.price);
                                    const cost = costEdits[it._id] !== undefined ? costEdits[it._id] : (setupEntry?.cost ?? '');
                                    const m = marginPct(Number(price) || 0, Number(cost) || 0);
                                    return (
                                      <div key={it._id} className="flex items-center gap-2.5 px-3 py-2 rounded-2xl border-[1.5px]"
                                        style={{ borderColor: assigned ? (setupEntry?.price != null ? '#bcf679' : '#e3d9ca') : '#e3d9ca', background: assigned ? '#fff' : '#f7f2eb' }}>
                                        <input type="checkbox" checked={assigned} onChange={() => toggleAssignment(it._id, assigned)} className="w-[18px] h-[18px] accent-[#3f8500] cursor-pointer flex-none" />
                                        <div className="flex-1 min-w-0">
                                          <div className="text-[13px] font-bold truncate">{it.name}</div>
                                          <div className="text-[10.5px] text-[#6b7894]">Base AED {fmt(it.price)}{setupEntry?.cost != null ? ` · cost ${fmt(setupEntry.cost)}` : ''}</div>
                                        </div>
                                        {assigned && (
                                          <>
                                            <div className="flex items-center gap-1 bg-white border-[1.5px] border-[#e3d9ca] rounded-full px-2 py-1 flex-none">
                                              <span className="text-[10px] text-[#6b7894] font-bold">AED</span>
                                              <input type="number" value={price} onChange={(e) => schedulePriceSave(it._id, e.target.value)}
                                                className="w-11 border-none outline-none bg-transparent text-xs font-bold text-right" />
                                              {setupSaving[it._id] && <Loader className="w-3 h-3 animate-spin text-[#3f8500] flex-none" />}
                                            </div>
                                            <div className="text-[11px] font-bold min-w-[32px] text-right flex-none" style={{ color: marginColor(m) }}>{m}%</div>
                                          </>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                    </div>
                  )}
                </div>
              )}
          </>
        )}

        {/* ══ MENU TAB ══ */}
        {tab === 'menu' && (
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-5 items-start">
            <div>
              <div className="relative mb-3 max-w-sm">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#c9bfae]" />
                <input type="text" placeholder="Search menu items…" value={menuSearch} onChange={(e) => setMenuSearch(e.target.value)}
                  className={`${inputCls} pl-10`} />
              </div>
              <div className="flex flex-wrap gap-1.5 mb-4">
                {menuTypeChips.map(([t, label, count]) => {
                  const on = menuTypeFilter === t;
                  return (
                    <button key={t} onClick={() => setMenuTypeFilter(t)}
                      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-colors"
                      style={{ background: on ? '#051747' : '#f1ebe2', color: on ? '#ede5de' : '#6b7894' }}>
                      {label}
                      <span className="rounded-full px-1.5 text-[10.5px]" style={{ background: on ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.06)' }}>{count}</span>
                    </button>
                  );
                })}
              </div>
              <div className={`${card} overflow-hidden`}>
                <div className="flex items-center justify-between px-5 py-3 border-b-[1.5px] border-[#e3d9ca]">
                  <div className="text-[10.5px] font-bold tracking-[0.1em] uppercase text-[#6b7894]">Master menu</div>
                  {!isKitchen && (
                    <button onClick={() => setShowAddItem(true)} className="flex items-center gap-1.5 text-xs font-bold text-[#3f8500] hover:text-[#2d6300]">
                      <Plus className="w-3.5 h-3.5" />Add item
                    </button>
                  )}
                </div>
                {menuLoading ? <div className="flex justify-center py-16"><Loader className="w-7 h-7 animate-spin text-[#3f8500]" /></div>
                  : masterMenuGroups.length === 0 ? <Empty icon={UtensilsCrossed} text={menuSearch ? 'No items match your search.' : 'No items yet.'} />
                  : masterMenuGroups.map((group) => (
                    <div key={group.type}>
                      <div className="px-5 pt-3.5 pb-1.5 text-[10px] font-bold tracking-[0.12em] uppercase text-[#3f8500] bg-[#f7f2eb]">
                        {group.label} <span className="text-[#6b7894]">· {group.items.length}</span>
                      </div>
                      {group.items.map((it) => (
                        <div key={it._id} className="grid grid-cols-[2fr_1fr_1fr_.7fr] gap-3 items-center px-5 py-3 border-b border-[#f1ebe2] text-[13.5px]">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="w-[34px] h-[34px] rounded-[11px] bg-[#f1ebe2] text-[#6b7894] flex items-center justify-center flex-none text-xs" style={AB}>{it.name.slice(0, 2).toUpperCase()}</div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <div className="font-bold truncate">{it.name}</div>
                                {it.source === 'menu-selection' && (
                                  <span title={`Auto-synced from Menu Selection — available ${it.availableFrom ? fmtDate(it.availableFrom) : '?'}${it.availableTo && it.availableTo !== it.availableFrom ? ` to ${fmtDate(it.availableTo)}` : ''}`}
                                    className="flex-none bg-[#eafbd0] text-[#2a3f13] rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide whitespace-nowrap">
                                    Menu Selection
                                  </span>
                                )}
                              </div>
                              {it.category && <div className="text-[11px] text-[#6b7894] truncate">{it.category}</div>}
                            </div>
                          </div>
                          <div><span className="bg-[#f1ebe2] rounded-full px-2.5 py-1 text-[11px] font-bold text-[#6b7894] capitalize">{MEAL_TYPE_LABEL[it.mealType] || it.mealType}</span></div>
                          <div><div className="font-bold">AED {fmt(it.sellingPrice ?? it.price)}</div><div className="text-[10.5px] text-[#6b7894]">{it.sellingPrice != null ? `base ${fmt(it.price)}` : "selling = base"}</div></div>
                          <div className="flex items-center gap-1.5 justify-end">
                            {!isKitchen && (
                              <>
                                <button onClick={() => setEditingItem(it)} className="p-1.5 text-[#6b7894] hover:text-[#3f8500] rounded-full hover:bg-[#f1ebe2]"><Edit className="w-3.5 h-3.5" /></button>
                                <button onClick={async () => { try { const r = await api.patch(`/admin/partners/menu/${it._id}`, { isAvailable: !it.isAvailable }); setMenuItems((prev) => prev.map((x) => (x._id === it._id ? r.data.data : x))); } catch { } }}
                                  className="p-1.5 rounded-full hover:bg-[#f1ebe2]" style={{ color: it.isAvailable ? '#3f8500' : '#c9bfae' }}>
                                  {it.isAvailable ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                                </button>
                                <button onClick={async () => { if (!window.confirm(`Delete "${it.name}"?`)) return; try { await api.delete(`/admin/partners/menu/${it._id}`); setMenuItems((prev) => prev.filter((x) => x._id !== it._id)); } catch { } }}
                                  className="p-1.5 text-[#c9bfae] hover:text-[#ff3b00] rounded-full hover:bg-[#fff2eb]"><Trash2 className="w-3.5 h-3.5" /></button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
              </div>
            </div>

            {!isKitchen && (
              <div className="flex flex-col gap-4">
                <div className={`${card} p-5`}>
                  <div className="text-base" style={AB}>Open a partner's sub-menu</div>
                  <p className="text-xs text-[#6b7894] mt-1.5 leading-relaxed">Pick a partner, then tick items and set their prices from the Partners tab. Untouched items follow the master price.</p>
                  <select value={selId} onChange={(e) => setSelId(e.target.value)} className={`${inputCls} mt-3.5`}>
                    <option value="">Choose a partner…</option>
                    {spaces.map((s) => <option key={s._id} value={s._id}>{s.businessName}</option>)}
                  </select>
                  <button onClick={() => setTab('partners')} disabled={!selId} className={`${pillBtn} w-full mt-2.5 bg-[#bcf679] text-[#051747] hover:opacity-90 disabled:opacity-40`}>
                    Open sub-menu editor →
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══ ORDERS TAB ══ */}
        {tab === 'orders' && (
          <>
            <div className="flex gap-2 flex-wrap mb-2">
              {orderChips.map(([v, label, count]) => {
                const on = orderChip === v;
                return (
                  <button key={v} onClick={() => setOrderChip(v)}
                    className="flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-bold border-[1.5px] transition-colors"
                    style={{ borderColor: on ? '#051747' : '#e3d9ca', background: on ? '#051747' : '#fff', color: on ? '#ede5de' : '#0b1a3f' }}>
                    {label}
                    <span className="rounded-full min-w-[20px] px-1.5 py-0.5 text-[11px] text-center" style={{ background: on ? '#bcf679' : '#f1ebe2', color: on ? '#051747' : '#6b7894' }}>{count}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap gap-3 mb-4 mt-3 items-end">
              <div>
                <label className="block text-xs text-[#6b7894] mb-1">Partner</label>
                <select value={orderSpaceFilter} onChange={(e) => setOrderSpaceFilter(e.target.value)} className={inputCls}>
                  <option value="">All partners</option>
                  {spaces.map((s) => <option key={s._id} value={s._id}>{s.businessName}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <div><label className="block text-xs text-[#6b7894] mb-1">From</label><input type="date" value={orderFrom} onChange={(e) => setOrderFrom(e.target.value)} className={inputCls} /></div>
                <div><label className="block text-xs text-[#6b7894] mb-1">To</label><input type="date" value={orderTo} onChange={(e) => setOrderTo(e.target.value)} className={inputCls} /></div>
              </div>
              <button onClick={loadOrders} className={`${pillBtn} bg-[#051747] text-[#ede5de] hover:opacity-90`}>Apply</button>
            </div>

            {ordersLoading ? <div className="flex justify-center py-16"><Loader className="w-7 h-7 animate-spin text-[#3f8500]" /></div>
              : shownOrders.length === 0 ? <Empty icon={Calendar} text="No orders found." />
              : (
                <div className="flex flex-col gap-2.5">
                  {shownOrders.map((order) => {
                    const st = {
                      cancelled: { label: 'Cancelled', bg: '#f1ebe2', color: '#6b7894' },
                      invoiced: { label: 'Invoiced', bg: '#bcf679', color: '#051747' },
                      locked: { label: 'Awaiting invoice', bg: '#fff2d9', color: '#7b5210' },
                      acked: { label: 'Acknowledged', bg: '#051747', color: '#ede5de' },
                      new: { label: 'New', bg: '#ff3b00', color: '#ede5de' },
                    }[partnerAdminOrderStatus(order)];
                    return (
                      <div key={order._id} className={`${card} overflow-hidden`}>
                        <div className="px-5 py-3.5 flex items-center gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-bold text-[14.5px]">{order.space?.businessName}</span>
                              <span className="rounded-full px-2.5 py-1 text-[11px] font-bold" style={{ background: st.bg, color: st.color }}>{st.label}</span>
                              {order.isLocked && order.status === 'submitted' && <span className="text-[11px] text-[#c67139] flex items-center gap-1"><Lock className="w-3 h-3" />In lock window</span>}
                            </div>
                            <div className="text-xs text-[#6b7894] mt-1">Delivery {fmtDate(order.deliveryDate)} · {order.lines?.length || 0} items</div>
                          </div>
                          <div className="flex items-center gap-2 flex-none">
                            {order.status === 'submitted' && !order.acknowledgedAt && (
                              <button onClick={() => acknowledgeOrder(order)} disabled={workingOrder === order._id}
                                className={`${pillBtn} flex items-center gap-1.5 bg-[#051747] text-[#ede5de] hover:opacity-90 disabled:opacity-40 text-xs py-2`}>
                                {workingOrder === order._id ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <CheckCheck className="w-3.5 h-3.5" />}Acknowledge
                              </button>
                            )}
                            {canInvoicePartnerOrder(order) && (
                              <button onClick={() => lockOrder(order._id)} disabled={workingOrder === order._id}
                                className={`${pillBtn} flex items-center gap-1.5 bg-[#bcf679] text-[#051747] hover:opacity-90 disabled:opacity-40 text-xs py-2`}>
                                {workingOrder === order._id ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}Lock & invoice
                              </button>
                            )}
                            <button onClick={() => setExpandedOrder(expandedOrder === order._id ? null : order._id)} className="p-1.5 text-[#6b7894] hover:text-[#0b1a3f] rounded-full hover:bg-[#f1ebe2]">
                              {expandedOrder === order._id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                            </button>
                          </div>
                        </div>
                        <AnimatePresence>
                          {expandedOrder === order._id && (
                            <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden">
                              <div className="border-t border-[#f1ebe2] bg-[#f7f2eb] px-5 py-3.5">
                                <table className="w-full text-sm">
                                  <thead><tr className="text-[#6b7894] text-xs"><th className="text-left pb-2">Item</th><th className="text-left pb-2">Type</th><th className="text-center pb-2">Qty</th></tr></thead>
                                  <tbody>
                                    {(order.lines || []).map((l, i) => (
                                      <tr key={i} className="border-t border-[#e3d9ca]">
                                        <td className="py-1.5">{l.menuItem?.name || '—'}</td>
                                        <td className="py-1.5 text-[#6b7894] capitalize">{l.menuItem?.mealType}</td>
                                        <td className="py-1.5 text-center">{l.quantity}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                                {order.notes && <p className="text-xs text-[#6b7894] mt-2">Notes: {order.notes}</p>}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })}
                </div>
              )}
          </>
        )}

        {/* ══ INVOICES TAB ══ */}
        {tab === 'invoices' && (
          <>
            <div className="flex gap-2 mb-4">
              {['partner', 'matter'].map((t) => (
                <button key={t} onClick={() => setInvoiceType(t)} className={`${pillBtn} capitalize`}
                  style={{ background: invoiceType === t ? '#051747' : '#fff', color: invoiceType === t ? '#ede5de' : '#0b1a3f', border: invoiceType === t ? 'none' : '1.5px solid #e3d9ca' }}>
                  {t === 'partner' ? 'Partner invoices' : 'Matter statements'}
                </button>
              ))}
            </div>

            {invoicesLoading ? <div className="flex justify-center py-16"><Loader className="w-7 h-7 animate-spin text-[#3f8500]" /></div>
              : invoices.length === 0 ? <Empty icon={FileText} text={`No ${invoiceType === 'matter' ? 'matter statements' : 'partner invoices'} yet.`} />
              : (
                <div className="flex flex-col gap-2.5">
                  {invoices.map((inv) => (
                    <div key={inv._id} className={`${card} overflow-hidden`}>
                      <div className="px-5 py-3.5 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="font-bold text-[14px]">{inv.invoiceNumber}</div>
                          <div className="text-xs text-[#6b7894] mt-0.5">{inv.space?.businessName} · Delivery {fmtDate(inv.order?.deliveryDate)}</div>
                        </div>
                        <div className="flex items-center gap-3 flex-none">
                          <div className="text-right hidden sm:block">
                            <div className="font-bold text-[#0b1a3f] text-sm">AED {fmt(inv.totalRevenue)}</div>
                            {invoiceType === 'matter' && <div className="text-xs text-[#3f8500] font-bold">Margin AED {fmt(inv.totalMargin)}</div>}
                          </div>
                          <button onClick={() => fetchInvoiceLines(inv._id)} className="p-1.5 text-[#6b7894] hover:text-[#0b1a3f] rounded-full hover:bg-[#f1ebe2]">
                            {expandedInvoice === inv._id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>
                      <AnimatePresence>
                        {expandedInvoice === inv._id && (
                          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden">
                            <div className="border-t border-[#f1ebe2] bg-[#f7f2eb] px-5 py-3.5">
                              <div className="overflow-x-auto">
                                <table className="w-full text-sm min-w-[400px]">
                                  <thead><tr className="text-[#6b7894] text-xs">
                                    <th className="text-left pb-2">Item</th><th className="text-center pb-2">Qty</th><th className="text-right pb-2">Unit price</th>
                                    {invoiceType === 'matter' && <><th className="text-right pb-2">Unit cost</th><th className="text-right pb-2">Margin</th></>}
                                    <th className="text-right pb-2">Total</th>
                                  </tr></thead>
                                  <tbody>
                                    {(invoiceLines[inv._id] || []).map((l, i) => (
                                      <tr key={i} className="border-t border-[#e3d9ca]">
                                        <td className="py-1.5">{l.itemName}</td>
                                        <td className="py-1.5 text-center">{l.quantity}</td>
                                        <td className="py-1.5 text-right">{fmt(l.unitPrice)}</td>
                                        {invoiceType === 'matter' && <><td className="py-1.5 text-right text-[#6b7894]">{fmt(l.unitCost)}</td><td className="py-1.5 text-right text-[#3f8500] font-bold">{fmt(l.lineMargin)}</td></>}
                                        <td className="py-1.5 text-right font-bold">{fmt(l.lineRevenue)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                  <tfoot><tr className="border-t-2 border-[#e3d9ca] font-bold">
                                    <td colSpan={invoiceType === 'matter' ? 5 : 3} className="py-2 text-right">Total</td>
                                    <td className="py-2 text-right">{fmt(inv.totalRevenue)} AED</td>
                                  </tr></tfoot>
                                </table>
                              </div>
                              {invoiceType === 'matter' && (
                                <div className="mt-3 grid grid-cols-3 gap-2.5 text-center">
                                  {[['Revenue', inv.totalRevenue, '#0b1a3f'], ['Cost', inv.totalCost, '#ff3b00'], ['Margin', inv.totalMargin, '#3f8500']].map(([l, v, c]) => (
                                    <div key={l} className="bg-white rounded-2xl border border-[#e3d9ca] p-2.5">
                                      <div className="font-bold text-sm" style={{ color: c }}>{fmt(v)} AED</div>
                                      <div className="text-xs text-[#6b7894]">{l}</div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              <button onClick={() => downloadInvoicePdf(inv)} className="mt-3 flex items-center gap-1.5 text-sm text-[#3f8500] hover:text-[#2d6300] font-bold">
                                <Download className="w-4 h-4" />Download PDF
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  ))}
                </div>
              )}
          </>
        )}

        {/* ══ WASTE TAB ══ */}
        {tab === 'waste' && (
          <div className="space-y-8">
            {!isKitchen && (
              <div>
                <h3 className="text-base mb-3" style={AB}>Log Matter-side waste</h3>
                <form onSubmit={submitWaste} className={`${card} p-5`}>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div><label className="block text-xs font-bold text-[#6b7894] mb-1">Partner *</label>
                      <select value={wasteForm.spaceId} onChange={(e) => setWasteForm((p) => ({ ...p, spaceId: e.target.value }))} className={inputCls}>
                        <option value="">Select partner…</option>
                        {spaces.map((s) => <option key={s._id} value={s._id}>{s.businessName}</option>)}
                      </select></div>
                    <div><label className="block text-xs font-bold text-[#6b7894] mb-1">Delivery date *</label>
                      <input type="date" value={wasteForm.deliveryDate} onChange={(e) => setWasteForm((p) => ({ ...p, deliveryDate: e.target.value }))} className={inputCls} /></div>
                    <div><label className="block text-xs font-bold text-[#6b7894] mb-1">Item *</label>
                      <select value={wasteForm.menuItemId} onChange={(e) => setWasteForm((p) => ({ ...p, menuItemId: e.target.value }))} className={inputCls}>
                        <option value="">Select item…</option>
                        {menuItems.map((i) => <option key={i._id} value={i._id}>{i.name}</option>)}
                      </select></div>
                    <div><label className="block text-xs font-bold text-[#6b7894] mb-1">Quantity *</label>
                      <input type="number" min="1" value={wasteForm.quantity} onChange={(e) => setWasteForm((p) => ({ ...p, quantity: e.target.value }))} className={inputCls} /></div>
                    <div><label className="block text-xs font-bold text-[#6b7894] mb-1">Reason *</label>
                      <select value={wasteForm.reason} onChange={(e) => setWasteForm((p) => ({ ...p, reason: e.target.value }))} className={inputCls}>
                        <option value="">Select reason…</option>
                        {WASTE_REASONS.map((r) => <option key={r} value={r}>{r.replace(/-/g, ' ')}</option>)}
                      </select></div>
                    <div><label className="block text-xs font-bold text-[#6b7894] mb-1">Note</label>
                      <input value={wasteForm.note} onChange={(e) => setWasteForm((p) => ({ ...p, note: e.target.value }))} className={inputCls} placeholder="Optional detail…" /></div>
                  </div>
                  {wasteError && <p className="text-[#ff3b00] text-xs mt-3 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{wasteError}</p>}
                  <button type="submit" disabled={wasteSubmitting} className={`${pillBtn} mt-4 bg-[#051747] text-[#ede5de] hover:opacity-90 disabled:opacity-40 flex items-center gap-2`}>
                    {wasteSubmitting ? <Loader className="w-4 h-4 animate-spin" /> : <Leaf className="w-4 h-4" />}Add to log
                  </button>
                </form>
              </div>
            )}

            <div>
              <div className="flex items-center gap-3 mb-3 flex-wrap">
                <h3 className="text-base flex-1" style={AB}>All waste logs</h3>
                <select value={wastePartyFilter} onChange={(e) => setWastePartyFilter(e.target.value)} className="border-[1.5px] border-[#e3d9ca] rounded-full px-3 py-1.5 text-xs bg-white focus:ring-2 focus:ring-[#bcf679]">
                  <option value="">All parties</option><option value="partner">Partner</option><option value="matter">Matter</option>
                </select>
                <select value={wasteSpaceFilter} onChange={(e) => setWasteSpaceFilter(e.target.value)} className="border-[1.5px] border-[#e3d9ca] rounded-full px-3 py-1.5 text-xs bg-white focus:ring-2 focus:ring-[#bcf679]">
                  <option value="">All partners</option>
                  {spaces.map((s) => <option key={s._id} value={s._id}>{s.businessName}</option>)}
                </select>
                <button onClick={loadWaste} className="text-xs text-[#3f8500] hover:underline font-bold">Refresh</button>
                <button onClick={() => exportCsv(
                  ['Date', 'Partner', 'Item', 'Qty', 'Party', 'Reason', 'Note'],
                  wasteLogs.map((l) => [fmtDate(l.deliveryDate), l.space?.businessName || '', l.itemName, l.quantity, l.party, l.reason, l.note])
                , 'waste-log.csv')} className="flex items-center gap-1 text-xs text-[#3f8500] hover:underline font-bold"><Download className="w-3 h-3" />CSV</button>
              </div>

              {wasteLoading ? <div className="flex justify-center py-8"><Loader className="w-5 h-5 animate-spin text-[#3f8500]" /></div>
                : wasteLogs.length === 0 ? <Empty icon={Leaf} text="No waste entries." />
                : (
                  <div className={`${card} overflow-x-auto`}>
                    <table className="w-full text-sm min-w-[600px]">
                      <thead><tr className="border-b-[1.5px] border-[#e3d9ca]">
                        {['Date', 'Partner', 'Item', 'Qty', 'Party', 'Reason', 'Note'].map((h) => (
                          <th key={h} className="text-left px-4 py-3 font-bold text-[#6b7894] text-[10.5px] tracking-[0.08em] uppercase">{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {wasteLogs.map((l) => (
                          <tr key={l._id} className="border-t border-[#f1ebe2]">
                            <td className="px-4 py-2.5 whitespace-nowrap text-[#6b7894]">{fmtDate(l.deliveryDate)}</td>
                            <td className="px-4 py-2.5 font-bold">{l.space?.businessName || '—'}</td>
                            <td className="px-4 py-2.5">{l.itemName}</td>
                            <td className="px-4 py-2.5 text-center">{l.quantity}</td>
                            <td className="px-4 py-2.5"><span className="px-2 py-0.5 rounded-full text-[11px] font-bold capitalize" style={{ background: l.party === 'matter' ? '#fff2eb' : '#e3edff', color: l.party === 'matter' ? '#ff3b00' : '#1a3fb0' }}>{l.party}</span></td>
                            <td className="px-4 py-2.5 capitalize text-[#6b7894]">{l.reason?.replace(/-/g, ' ')}</td>
                            <td className="px-4 py-2.5 text-[#c9bfae] text-xs">{l.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="px-4 py-2.5 text-[11px] text-[#c9bfae] border-t border-[#f1ebe2]">Waste cost by partner &amp; space is on the Reports tab.</p>
                  </div>
                )}
            </div>
          </div>
        )}

        {/* ══ REPORTS TAB ══ */}
        {tab === 'reports' && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-end gap-3">
              <div><label className="block text-xs text-[#6b7894] mb-1">From</label><input type="date" value={reportFrom} onChange={(e) => setReportFrom(e.target.value)} className={inputCls} /></div>
              <div><label className="block text-xs text-[#6b7894] mb-1">To</label><input type="date" value={reportTo} onChange={(e) => setReportTo(e.target.value)} className={inputCls} /></div>
              <button onClick={loadReports} className={`${pillBtn} bg-[#051747] text-[#ede5de] hover:opacity-90`}>Refresh</button>
            </div>

            {reportsLoading && <div className="flex justify-center py-16"><Loader className="w-7 h-7 animate-spin text-[#3f8500]" /></div>}
            {!reportsLoading && reports && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                  <div className="bg-[#051747] text-[#ede5de] rounded-[22px] p-5">
                    <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-[#a8ccf5]">Total revenue</div>
                    <div className="text-[30px] mt-2" style={AB}>AED {fmt(reports.totals?.revenue)}</div>
                    <div className="text-xs text-[#a8ccf5] mt-1">{reports.totals?.invoices || 0} locked invoices</div>
                  </div>
                  <div className={`${card} p-5`}>
                    <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-[#6b7894]">Total cost</div>
                    <div className="text-[30px] mt-2" style={AB}>AED {fmt(reports.totals?.cost)}</div>
                    <div className="text-xs text-[#6b7894] mt-1">food cost</div>
                  </div>
                  <div className="bg-[#bcf679] text-[#051747] rounded-[22px] p-5">
                    <div className="text-[11px] font-bold tracking-[0.12em] uppercase opacity-70">Total margin</div>
                    <div className="text-[30px] mt-2" style={AB}>AED {fmt(reports.totals?.margin)}</div>
                    <div className="text-xs mt-1 font-bold">{reports.totals?.revenue > 0 ? Math.round((reports.totals.margin / reports.totals.revenue) * 100) : 0}% of revenue</div>
                  </div>
                </div>

                {reports.spaceStats?.length > 0 && (
                  <div className={`${card} p-5`}>
                    <div className="flex items-center justify-between">
                      <div className="text-base" style={AB}>Revenue by partner</div>
                      <button onClick={() => exportCsv(['Partner', 'Revenue (AED)', 'Cost (AED)', 'Margin (AED)', 'Invoices'], reports.spaceStats.map((s) => [s.spaceName, fmt(s.totalRevenue), fmt(s.totalCost), fmt(s.totalMargin), s.count]), 'partner-revenue.csv')}
                        className="flex items-center gap-1 text-xs text-[#3f8500] hover:underline font-bold"><Download className="w-3 h-3" />CSV</button>
                    </div>
                    <div className="flex flex-col gap-3 mt-4">
                      {(() => {
                        const maxRev = Math.max(1, ...reports.spaceStats.map((s) => s.totalRevenue || 0));
                        const totalRev = reports.totals?.revenue || 0;
                        return reports.spaceStats.map((s, i) => (
                          <div key={i}>
                            <div className="flex justify-between text-[13px] mb-1.5">
                              <span className="font-bold">{s.spaceName || '—'}</span>
                              <span className="text-[#6b7894]">AED {fmt(s.totalRevenue)} · <b style={{ color: '#3f8500' }}>{totalRev ? Math.round((s.totalRevenue / totalRev) * 100) : 0}%</b></span>
                            </div>
                            <div className="h-3 rounded-full bg-[#f1ebe2] overflow-hidden"><div className="h-full rounded-full bg-[#051747]" style={{ width: `${((s.totalRevenue || 0) / maxRev) * 100}%` }} /></div>
                          </div>
                        ));
                      })()}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  {reports.topItems?.length > 0 && (
                    <div className={`${card} p-5`}>
                      <div className="text-base mb-3" style={AB}>Top items by quantity</div>
                      <div className="flex flex-col gap-1.5">
                        {reports.topItems.slice(0, 8).map((item, i) => (
                          <div key={i} className="flex items-center gap-3 py-2 border-b border-[#f1ebe2] text-[13.5px]">
                            <span className="w-[26px] h-[26px] rounded-full flex items-center justify-center font-bold text-xs flex-none" style={{ background: i === 0 ? '#bcf679' : '#f1ebe2', color: i === 0 ? '#051747' : '#6b7894' }}>{i + 1}</span>
                            <span className="flex-1 font-bold truncate">{item._id}</span>
                            <span className="min-w-[48px] text-right" style={AB}>{item.totalQty}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {reports.wasteStats?.length > 0 && (
                    <div className={`${card} p-5`}>
                      <div className="text-base mb-3" style={AB}>Waste by partner &amp; party</div>
                      <div className="flex flex-col gap-2">
                        {reports.wasteStats.map((w, i) => (
                          <div key={i} className="flex justify-between text-sm py-1.5 border-b border-[#f1ebe2]">
                            <span>{w.spaceName || 'Unknown'} — <span className="capitalize font-bold" style={{ color: w.party === 'matter' ? '#ff3b00' : '#1a3fb0' }}>{w.party}</span></span>
                            <span className="font-bold">{w.totalQty} units</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Modals */}
      {showAddSpace && <PartnerFormModal onClose={() => setShowAddSpace(false)} onSaved={(s) => { setSpaces((prev) => [s, ...prev]); setSelId(s._id); }} />}
      {editingSpace && <PartnerFormModal initial={editingSpace} onClose={() => setEditingSpace(null)} onSaved={(u) => { setSpaces((prev) => prev.map((p) => (p._id === u._id ? u : p))); setEditingSpace(null); }} />}
      {showAddItem && <MenuItemModal onClose={() => setShowAddItem(false)} onSaved={(item) => setMenuItems((prev) => [...prev, item])} />}
      {editingItem && <MenuItemModal initial={editingItem} onClose={() => setEditingItem(null)} onSaved={(u) => { setMenuItems((prev) => prev.map((i) => (i._id === u._id ? u : i))); setEditingItem(null); }} />}
    </div>
  );
};

export default AdminPartners;
