import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, Eye, Download, RefreshCw, MapPin, Phone, Mail, Calendar, Package, CheckCircle, Clock, AlertCircle, TrendingUp, Upload, DollarSign, UserPlus, X, Send, ChevronLeft, ChevronRight } from 'lucide-react';
import * as XLSX from 'xlsx';
import { useLocation } from 'react-router-dom';
import api from '../utils/api';
import MealPreferences from '../components/MealPreferences';
import { EXCLUSION_LIST } from '../constants/exclusionList';

const ISSUE_TYPE_LABELS = {
  wrong_item: 'Wrong Item',
  missing_item: 'Missing Item',
  late_delivery: 'Late Delivery',
  damaged: 'Damaged',
  not_delivered: 'Not Delivered',
  other: 'Other',
};

const ISSUE_PRIORITY_CLS = {
  low: 'bg-green-100 text-green-700',
  medium: 'bg-yellow-100 text-yellow-700',
  high: 'bg-red-100 text-red-700',
};

function CustomerIssues({ customerId }) {
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const fetchIssues = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/delivery-issues?customerId=${customerId}`);
      setIssues(res.data?.issues || []);
      setFetched(true);
    } catch {
      setIssues([]);
      setFetched(true);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  const handleToggle = () => {
    if (!fetched) fetchIssues();
    setExpanded(e => !e);
  };

  const openCount = issues.filter(i => i.status === 'open').length;

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between p-6 text-left hover:bg-gray-50"
      >
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-red-500" />
          Delivery Issues
          {fetched && issues.length > 0 && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ml-1 ${openCount > 0 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
              {openCount > 0 ? `${openCount} open` : `${issues.length} total`}
            </span>
          )}
        </h2>
        <span className="text-sm text-gray-400">{expanded ? 'Hide' : 'Show'}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-200">
          {loading ? (
            <div className="p-6 text-center text-gray-400 text-sm">Loading issues…</div>
          ) : issues.length === 0 ? (
            <div className="p-6 text-center text-gray-400 text-sm">No delivery issues logged for this customer</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {issues.map(issue => (
                <div key={issue._id} className="px-6 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="text-sm font-medium text-gray-900">{ISSUE_TYPE_LABELS[issue.issueType] || issue.issueType}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${ISSUE_PRIORITY_CLS[issue.priority] || 'bg-gray-100 text-gray-600'}`}>
                          {issue.priority?.charAt(0).toUpperCase() + issue.priority?.slice(1)}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${issue.status === 'resolved' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                          {issue.status === 'resolved' ? 'Resolved' : 'Open'}
                        </span>
                      </div>
                      <p className="text-sm text-gray-700">{issue.description}</p>
                      {issue.resolvedNotes && (
                        <p className="text-xs text-green-700 mt-1 bg-green-50 rounded px-2 py-1">Resolution: {issue.resolvedNotes}</p>
                      )}
                    </div>
                    {issue.photoUrl && (
                      <a href={issue.photoUrl} target="_blank" rel="noreferrer">
                        <img src={issue.photoUrl} alt="Issue" className="w-14 h-14 object-cover rounded-lg border border-gray-200 flex-shrink-0" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-2">
                    Reported {new Date(issue.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    {issue.reportedByName && ` by ${issue.reportedByName}`}
                    {issue.status === 'resolved' && issue.resolvedByName && ` · Resolved by ${issue.resolvedByName}`}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const MEAL_PLANS = ['Standard','Customized','Premium','Vegan','Keto','Paleo','Bodybuilder'];

const MACRO_PLAN_MAP = [
  { C: 70,  P: 60,  F: 31,  plan: 'Lean 2 Meal' },
  { C: 115, P: 90,  F: 42,  plan: 'Lean 3 Meal' },
  { C: 130, P: 80,  F: 40,  plan: 'Thrive 2 Meal' },
  { C: 180, P: 120, F: 67,  plan: 'Thrive 3 Meal' },
  { C: 180, P: 100, F: 66,  plan: 'Perform 2 Meal' },
  { C: 225, P: 150, F: 100, plan: 'Perform 3 Meal' },
];

function getMealPlanFromMacros(C, P, F) {
  const c = Math.round(Number(C) || 0);
  const p = Math.round(Number(P) || 0);
  const f = Math.round(Number(F) || 0);
  if (!c && !p && !f) return null;
  const match = MACRO_PLAN_MAP.find(m => m.C === c && m.P === p && m.F === f);
  return match ? match.plan : 'Customized';
}

const AddCustomerModal = ({ onClose, onSubmit, isSubmitting, submitError }) => {
  const [form, setForm] = useState({ customerName: '', customerId: 'CUST-', email: '', mealPerDay: 1, mealPlan: 'Standard', breakfastInclude: false, snackCount: 0, mealExclusion: '' });
  const [exclusionSearch, setExclusionSearch] = useState('');
  const set = (field) => (e) => setForm(p => ({ ...p, [field]: e.target.value }));

  const selected = new Set(
    (form.mealExclusion ? form.mealExclusion.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [])
  );
  const filteredExclusions = exclusionSearch.trim()
    ? EXCLUSION_LIST.filter(p => p.toLowerCase().includes(exclusionSearch.trim().toLowerCase()))
    : EXCLUSION_LIST;
  const toggleExclusion = (phrase) => {
    const key = phrase.toLowerCase();
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    const newVal = EXCLUSION_LIST.filter(p => next.has(p.toLowerCase())).join(',');
    setForm(p => ({ ...p, mealExclusion: newVal }));
  };
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 max-h-screen overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-bold text-gray-900">Add Customer</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); onSubmit(form); }} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Customer Name <span className="text-red-500">*</span></label>
            <input type="text" required value={form.customerName} onChange={set('customerName')} placeholder="Full name" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Customer ID <span className="text-red-500">*</span></label>
            <input type="text" required value={form.customerId} onChange={e => { const v = e.target.value; setForm(p => ({ ...p, customerId: v.startsWith('CUST-') ? v : 'CUST-' })); }} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email <span className="text-red-500">*</span></label>
            <input type="email" required value={form.email} onChange={set('email')} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <hr className="border-gray-200" />
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Meal Preferences</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Meals Per Day</label>
              <input type="number" min="1" max="10" value={form.mealPerDay} onChange={set('mealPerDay')} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Meal Plan</label>
              <select value={form.mealPlan} onChange={set('mealPlan')} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {MEAL_PLANS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input type="checkbox" id="acm-breakfast" checked={form.breakfastInclude} onChange={e => setForm(p => ({ ...p, breakfastInclude: e.target.checked }))} className="w-4 h-4 accent-blue-600" />
            <label htmlFor="acm-breakfast" className="text-sm font-medium text-gray-700">Breakfast Included</label>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Snack Count</label>
            <input type="number" min="0" value={form.snackCount} onChange={set('snackCount')} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Meal Exclusions</label>
            <div className="border border-gray-300 rounded-lg overflow-hidden">
              <input
                type="text"
                value={exclusionSearch}
                onChange={e => setExclusionSearch(e.target.value)}
                placeholder="Search exclusions..."
                className="w-full px-3 py-2 border-b border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="max-h-44 overflow-y-auto p-2 grid grid-cols-2 gap-1">
                {filteredExclusions.map(phrase => (
                  <label key={phrase} className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-gray-50 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.has(phrase.toLowerCase())}
                      onChange={() => toggleExclusion(phrase)}
                      className="h-4 w-4 rounded accent-blue-600"
                    />
                    <span>{phrase}</span>
                  </label>
                ))}
              </div>
              {selected.size > 0 && (
                <div className="border-t border-gray-200 px-3 py-2 flex flex-wrap gap-1">
                  {EXCLUSION_LIST.filter(p => selected.has(p.toLowerCase())).map(p => (
                    <span key={p} className="bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full text-xs font-semibold">{p}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
          {submitError && <p className="text-sm text-red-600">{submitError}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-60">{isSubmitting ? 'Adding...' : 'Add Customer'}</button>
          </div>
        </form>
      </div>
    </div>
  );
};

const EditCustomerModal = ({ customer, onClose, onSubmit, isSubmitting, submitError }) => {
  const [form, setForm] = useState({
    customerId: customer.customerId || '',
    customerName: customer.customerName && customer.customerName !== 'Unknown' ? customer.customerName : '',
    email: customer.email && customer.email !== 'N/A' ? customer.email : '',
    phone: customer.phone && customer.phone !== 'N/A' ? customer.phone : '',
    company: customer.company && customer.company !== 'N/A' ? customer.company : '',
    address: customer.address && customer.address !== 'N/A' ? customer.address : '',
  });
  const set = (field) => (e) => setForm(p => ({ ...p, [field]: e.target.value }));
  const customerIdChanged = form.customerId.trim() !== customer.customerId;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 max-h-screen overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-bold text-gray-900">Edit Customer</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); onSubmit(form); }} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Customer ID</label>
            <input type="text" required value={form.customerId} onChange={set('customerId')} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {customerIdChanged && (
              <p className="text-xs text-amber-600 mt-1">
                Changing this updates every delivery, bag note, communication and past menu selection on file for this customer — it's safe, but can't be undone with a click.
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Customer Name <span className="text-red-500">*</span></label>
            <input type="text" required value={form.customerName} onChange={set('customerName')} placeholder="Full name" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input type="email" value={form.email} onChange={set('email')} placeholder="customer@example.com" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
            <input type="text" value={form.phone} onChange={set('phone')} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Company</label>
            <input type="text" value={form.company} onChange={set('company')} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
            <textarea rows={2} value={form.address} onChange={set('address')} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          {submitError && <p className="text-sm text-red-600 whitespace-pre-line">{submitError}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-60">{isSubmitting ? 'Saving...' : 'Save Changes'}</button>
          </div>
        </form>
      </div>
    </div>
  );
};

const Customers = () => {
  const location = useLocation();
  const [customers, setCustomers] = useState([]);
  const [filteredCustomers, setFilteredCustomers] = useState([]);
  // The Dashboard's "Find account" link passes a name via router state.
  const [searchTerm, setSearchTerm] = useState(location.state?.search || '');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [customerDeliveries, setCustomerDeliveries] = useState([]);
  const [isLoadingDeliveries, setIsLoadingDeliveries] = useState(false);
  const [deliveriesError, setDeliveriesError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [customerProfile, setCustomerProfile] = useState(null); // Athleat profile data
  const [filemakerLayoutsData, setFilemakerLayoutsData] = useState(null);
  const [filemakerLayoutsLoading, setFilemakerLayoutsLoading] = useState(false);
  const [filemakerLayoutsError, setFilemakerLayoutsError] = useState(null);
  const [isEditingEmail, setIsEditingEmail] = useState(false);
  const [editEmailValue, setEditEmailValue] = useState('');
  const [emailSaveLoading, setEmailSaveLoading] = useState(false);
  const [isUploadingEmails, setIsUploadingEmails] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('');
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [addCustomerError, setAddCustomerError] = useState(null);
  const [isAddingCustomer, setIsAddingCustomer] = useState(false);
  const [showEditCustomerModal, setShowEditCustomerModal] = useState(false);
  const [editCustomerError, setEditCustomerError] = useState(null);
  const [isSavingCustomer, setIsSavingCustomer] = useState(false);
  const [isEditingPlanStart, setIsEditingPlanStart] = useState(false);
  const [planStartValue, setPlanStartValue] = useState('');
  const [planStartSaving, setPlanStartSaving] = useState(false);
  const [isEditingCycleDuration, setIsEditingCycleDuration] = useState(false);
  const [cycleDurationValue, setCycleDurationValue] = useState('');
  const [cycleDurationSaving, setCycleDurationSaving] = useState(false);
  const [showRenewalModal, setShowRenewalModal] = useState(false);
  const [whatsappSending, setWhatsappSending] = useState({});
  const [calendarViewMonth, setCalendarViewMonth] = useState(null);
  const [showCycleCalendar, setShowCycleCalendar] = useState(false);
  const [customerFilter, setCustomerFilter] = useState('all');
  const [planFilter, setPlanFilter] = useState('');

  const handleAddCustomer = async (formData) => {
    setAddCustomerError(null);
    setIsAddingCustomer(true);
    try {
      const nameParts = formData.customerName.trim().split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      const { data } = await api.post('/customers', {
        customerId: formData.customerId,
        firstName,
        lastName,
        email: formData.email,
      });
      const savedId = data?.data?.customerId || formData.customerId;
      await api.post(`/menus/customers/${savedId}/meal-profile`, {
        mealPerDay: Number(formData.mealPerDay),
        mealPlan: formData.mealPlan,
        breakfastInclude: formData.breakfastInclude,
        snackCount: Number(formData.snackCount) || 0,
        mealExclusion: formData.mealExclusion,
      });
      const savedCustomer = data?.data;
      const newEntry = {
        customerId: savedCustomer?.customerId || formData.customerId,
        customerName: formData.customerName.trim() || 'Unknown',
        company: 'N/A',
        address: 'N/A',
        phone: 'N/A',
        email: formData.email,
        totalDeliveries: 0,
        completedDeliveries: 0,
        pendingDeliveries: 0,
        lateDeliveries: 0,
        totalLateMinutes: 0,
        dataSource: 'ManualEntry'
      };
      setCustomers(prev => [newEntry, ...prev]);
      setFilteredCustomers(prev => [newEntry, ...prev]);
      setShowAddCustomerModal(false);
      setAddCustomerError(null);
    } catch (err) {
      setAddCustomerError(err.response?.data?.message || 'Failed to add customer');
    } finally {
      setIsAddingCustomer(false);
    }
  };

  const handleEditCustomer = async (formData) => {
    if (!selectedCustomer) return;
    setEditCustomerError(null);
    setIsSavingCustomer(true);
    try {
      const trimmedName = formData.customerName.trim();
      if (!trimmedName) {
        setEditCustomerError('Customer name is required');
        return;
      }
      const trimmedCustomerId = formData.customerId.trim();
      if (!trimmedCustomerId) {
        setEditCustomerError('Customer ID is required');
        return;
      }

      // Rename first, on the OLD customerId — cascades to every other
      // collection that stores it as a string (see PATCH .../rename-id).
      // Done before the regular field PATCH below so a rename failure
      // (e.g. that ID is already taken) stops here instead of silently
      // saving the other fields under a mismatched ID.
      let activeCustomerId = selectedCustomer.customerId;
      if (trimmedCustomerId !== selectedCustomer.customerId) {
        await api.patch(`/customers/${selectedCustomer.customerId}/rename-id`, {
          newCustomerId: trimmedCustomerId
        });
        activeCustomerId = trimmedCustomerId;
      }

      const nameParts = trimmedName.split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      const payload = {
        firstName,
        lastName,
        email: formData.email.trim(),
        phone: formData.phone.trim(),
        company: formData.company.trim(),
        address: formData.address.trim(),
      };

      const { data } = await api.patch(`/customers/${activeCustomerId}`, payload);
      const saved = data?.data || {};

      const merged = {
        ...selectedCustomer,
        customerId: activeCustomerId,
        customerName: `${saved.firstName || firstName} ${saved.lastName || lastName}`.trim() || 'Unknown',
        email: saved.email || payload.email || 'N/A',
        phone: saved.phone || payload.phone || 'N/A',
        company: saved.company || payload.company || 'N/A',
        address: saved.address || payload.address || 'N/A',
      };

      setSelectedCustomer(merged);
      setCustomers(prev => prev.map(c => c.customerId === selectedCustomer.customerId ? { ...c, ...merged } : c));
      setFilteredCustomers(prev => prev.map(c => c.customerId === selectedCustomer.customerId ? { ...c, ...merged } : c));
      setShowEditCustomerModal(false);
    } catch (err) {
      setEditCustomerError(err.response?.data?.message || 'Failed to update customer');
    } finally {
      setIsSavingCustomer(false);
    }
  };

  // Extract unique customers from all deliveries
  const fetchCustomers = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Fetch all customers from database (includes imported ones)
      const customersResponse = await api.get('/customers', { params: { limit: 10000 } });
      const dbCustomers = customersResponse.data?.data || [];

      // Fetch customers from deliveries
      const deliveriesResponse = await api.get('/deliveries', {
        params: {
          page: 1,
          limit: 5000
        }
      });

      if (!deliveriesResponse.data?.success) {
        throw new Error('Failed to load deliveries');
      }

      const deliveries = deliveriesResponse.data?.data?.deliveries || [];
      
      // Create a map of customers from both sources
      const customerMap = new Map();

      // Add customers from database first (includes imported customers)
      dbCustomers.forEach(dbCustomer => {
        const customerId = dbCustomer.customerId || dbCustomer._id;
        customerMap.set(customerId, {
          customerId: customerId,
          customerName: `${dbCustomer.firstName || ''} ${dbCustomer.lastName || ''}`.trim() || dbCustomer.firstName || 'Unknown',
          company: dbCustomer.company || 'N/A',
          address: dbCustomer.address || 'N/A',
          phone: dbCustomer.phone || 'N/A',
          email: dbCustomer.email || 'N/A',
          cpf: dbCustomer.cpf || null,
          macros: dbCustomer.macros || { C: 0, P: 0, F: 0 },
          totalDeliveries: 0,
          completedDeliveries: 0,
          pendingDeliveries: 0,
          lateDeliveries: 0,
          totalLateMinutes: 0,
          lastDeliveryDate: null,
          dataSource: dbCustomer.dataSource,
          planStartDate: dbCustomer.planStartDate || null,
          cycleDuration: dbCustomer.cycleDuration || 0,
          amountPaid: dbCustomer.amountPaid || '',
          discount: dbCustomer.discount || ''
        });
      });

      // Add/update customers from deliveries
      deliveries.forEach(delivery => {
        if (delivery.customerId) {
          const existing = customerMap.get(delivery.customerId);
          if (existing) {
            // The Customer record is the source of truth (kept current via uploads/edits).
            // Only fill in fields it didn't already provide — don't let stale info
            // snapshotted on old delivery records override a customer's current details.
            if (existing.customerName === 'Unknown' && delivery.customerName) existing.customerName = delivery.customerName;
            if (existing.company === 'N/A' && delivery.company) existing.company = delivery.company;
            if (existing.address === 'N/A' && delivery.address) existing.address = delivery.address;
            if (existing.phone === 'N/A' && delivery.phone) existing.phone = delivery.phone;
            if (existing.email === 'N/A' && delivery.email) existing.email = delivery.email;
          } else {
            // Add new customer from delivery
            customerMap.set(delivery.customerId, {
              customerId: delivery.customerId,
              customerName: delivery.customerName || 'Unknown',
              company: delivery.company || 'N/A',
              address: delivery.address || 'N/A',
              phone: delivery.phone || 'N/A',
              email: delivery.email || 'N/A',
              totalDeliveries: 0,
              completedDeliveries: 0,
              pendingDeliveries: 0,
              lateDeliveries: 0,
              totalLateMinutes: 0,
              lastDeliveryDate: null,
            });
          }
        }
      });

      // Calculate statistics from deliveries (cancelled deliveries do not count toward totalDeliveries)
      deliveries.forEach(delivery => {
        const customer = customerMap.get(delivery.customerId);
        if (customer) {
          if (delivery.status !== 'cancelled') customer.totalDeliveries++;
          if (delivery.scheduledTime) {
            const dt = new Date(delivery.scheduledTime);
            if (!customer.lastDeliveryDate || dt > new Date(customer.lastDeliveryDate)) {
              customer.lastDeliveryDate = delivery.scheduledTime;
            }
          }
          if (delivery.status === 'delivered') {
            customer.completedDeliveries++;
          } else if (delivery.status === 'pending' || delivery.status === 'assigned' || delivery.status === 'picked_up') {
            customer.pendingDeliveries++;
          }
          if (delivery.lateMinutes && delivery.lateMinutes > 0) {
            customer.lateDeliveries++;
            customer.totalLateMinutes += delivery.lateMinutes;
          }
        }
      });

      const customersList = Array.from(customerMap.values()).sort((a, b) => 
        a.customerName.localeCompare(b.customerName)
      );

      setCustomers(customersList);
      setLastUpdated(new Date().toISOString());
    } catch (error) {
      console.error('Error fetching customers:', error);
      setError(error.response?.data?.message || 'Failed to load customers');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch deliveries for selected customer
  const fetchCustomerDeliveries = useCallback(async (customerId, customerEmail) => {
    try {
      setIsLoadingDeliveries(true);
      setDeliveriesError(null);

      // Fetch only this customer's deliveries server-side (avoids 500-record global cap)
      const deliveriesResponse = await api.get('/deliveries', {
        params: {
          customerId,
          page: 1,
          limit: 500
        }
      });

      if (!deliveriesResponse.data?.success) {
        throw new Error('Failed to load deliveries');
      }

      const filtered = deliveriesResponse.data?.data?.deliveries || [];
      setCustomerDeliveries(filtered);

      // Fetch customer profile from Athleat (with email for sync)
      try {
        const profileUrl = customerEmail && customerEmail !== 'N/A'
          ? `/menus/customers/${customerId}/meal-profile?email=${encodeURIComponent(customerEmail)}`
          : `/menus/customers/${customerId}/meal-profile`;
        
        const profileResponse = await api.get(profileUrl);
        if (profileResponse.data?.success) {
          setCustomerProfile(profileResponse.data.data);
        }
      } catch (profileError) {
        console.error('Error fetching customer profile:', profileError);
        // Don't fail if profile fetch fails
        setCustomerProfile(null);
      }
    } catch (error) {
      console.error('Error fetching customer deliveries:', error);
      setDeliveriesError(error.response?.data?.message || 'Failed to load deliveries');
    } finally {
      setIsLoadingDeliveries(false);
    }
  }, []);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  // Filter customers based on search, active filter, and plan filter
  useEffect(() => {
    let filtered = customers;

    if (customerFilter === 'active') {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      filtered = filtered.filter(c => {
        const total = Number(c.cycleDuration) || 0;
        if (!total) return false;
        const remaining = total - (c.totalDeliveries || 0);
        if (remaining <= 0) return false;
        if (c.planStartDate) {
          const endDate = new Date(new Date(c.planStartDate).getTime() + total * 24 * 60 * 60 * 1000);
          if (endDate < today) return false;
        }
        return true;
      });
    }

    if (planFilter) {
      filtered = filtered.filter(c => {
        const derived = getMealPlanFromMacros(c.macros?.C, c.macros?.P, c.macros?.F);
        const plan = derived || c.mealPlan || '';
        return plan === planFilter;
      });
    }

    if (searchTerm) {
      filtered = filtered.filter(customer =>
        customer.customerName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        customer.customerId?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        customer.company?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        customer.phone?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        customer.email?.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    setFilteredCustomers(filtered);
  }, [customers, searchTerm, customerFilter, planFilter]);

  const handleSelectCustomer = (customer) => {
    setSelectedCustomer(customer);
    setCustomerProfile(null);
    setFilemakerLayoutsData(null);
    setFilemakerLayoutsError(null);
    setCalendarViewMonth(null);
    setShowCycleCalendar(false);
    fetchCustomerDeliveries(customer.customerId, customer.email);
  };

  const handleCloseDetail = () => {
    setSelectedCustomer(null);
    setCustomerDeliveries([]);
    setCustomerProfile(null);
    setFilemakerLayoutsData(null);
    setFilemakerLayoutsError(null);
    setIsEditingEmail(false);
    setEditEmailValue('');
    setIsEditingPlanStart(false);
    setPlanStartValue('');
    setIsEditingCycleDuration(false);
    setCycleDurationValue('');
    setShowEditCustomerModal(false);
    setEditCustomerError(null);
  };

  const handleEditEmail = () => {
    setIsEditingEmail(true);
    setEditEmailValue(customerProfile?.email || selectedCustomer.email || '');
  };

  const handleSaveEmail = async () => {
    if (!editEmailValue || !editEmailValue.includes('@')) {
      alert('Please enter a valid email address');
      return;
    }

    try {
      setEmailSaveLoading(true);

      // Update customer profile with new email
      const response = await api.post(
        `/menus/customers/${selectedCustomer.customerId}/meal-profile`,
        { email: editEmailValue }
      );

      if (response.data?.success) {
        // Refresh customer profile to get synced data
        const profileUrl = `/menus/customers/${selectedCustomer.customerId}/meal-profile?email=${encodeURIComponent(editEmailValue)}`;
        const profileResponse = await api.get(profileUrl);
        
        if (profileResponse.data?.success) {
          setCustomerProfile(profileResponse.data.data);
          // Update selected customer email in the list
          setSelectedCustomer(prev => ({ ...prev, email: editEmailValue }));
        }
        
        setIsEditingEmail(false);
      }
    } catch (error) {
      console.error('Error updating email:', error);
      alert(error.response?.data?.message || 'Failed to update email');
    } finally {
      setEmailSaveLoading(false);
    }
  };

  const handleCancelEditEmail = () => {
    setIsEditingEmail(false);
    setEditEmailValue('');
  };

  const handleFetchFilemakerLayouts = async () => {
    const email = customerProfile?.email || selectedCustomer?.email;
    if (!email || email === 'N/A' || !email.includes('@')) {
      alert('Please add a valid email before fetching FileMaker layouts');
      return;
    }

    try {
      setFilemakerLayoutsLoading(true);
      setFilemakerLayoutsError(null);

      const response = await api.get(
        `/menus/customers/${selectedCustomer.customerId}/filemaker-layouts`,
        { params: { email } }
      );

      if (response.data?.success) {
        setFilemakerLayoutsData(response.data.data);
      } else {
        setFilemakerLayoutsData(null);
        setFilemakerLayoutsError('Failed to fetch FileMaker layout data');
      }
    } catch (error) {
      console.error('Error fetching FileMaker layouts:', error);
      setFilemakerLayoutsData(null);
      setFilemakerLayoutsError(error.response?.data?.message || 'Failed to fetch FileMaker layout data');
    } finally {
      setFilemakerLayoutsLoading(false);
    }
  };

  const handleSavePlanStart = async () => {
    try {
      setPlanStartSaving(true);
      await api.patch(`/customers/${selectedCustomer.customerId}`, {
        planStartDate: planStartValue || null
      });
      setSelectedCustomer(prev => ({ ...prev, planStartDate: planStartValue ? new Date(planStartValue) : null }));
      setCustomers(prev => prev.map(c =>
        c.customerId === selectedCustomer.customerId ? { ...c, planStartDate: planStartValue ? new Date(planStartValue) : null } : c
      ));
      setIsEditingPlanStart(false);
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to save plan start date');
    } finally {
      setPlanStartSaving(false);
    }
  };

  const handleSaveCycleDuration = async () => {
    const val = parseInt(cycleDurationValue) || 0;
    try {
      setCycleDurationSaving(true);
      await api.patch(`/customers/${selectedCustomer.customerId}`, { cycleDuration: val });
      setSelectedCustomer(prev => ({ ...prev, cycleDuration: val }));
      setCustomers(prev => prev.map(c =>
        c.customerId === selectedCustomer.customerId ? { ...c, cycleDuration: val } : c
      ));
      setIsEditingCycleDuration(false);
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to save cycle duration');
    } finally {
      setCycleDurationSaving(false);
    }
  };

  const handleSendWhatsAppReminder = async (customer, e) => {
    e.stopPropagation();
    const id = customer.customerId;
    setWhatsappSending(prev => ({ ...prev, [id]: 'sending' }));
    try {
      const total = Number(customer.cycleDuration) || 0;
      const remaining = Math.max(0, total - (customer.totalDeliveries || 0));
      await api.post('/customers/send-whatsapp-reminder', {
        customerId: id,
        customerName: customer.customerName,
        mealPlan: customer.mealPlan || 'Standard',
        planStartDate: customer.planStartDate || null,
        cycleDuration: total,
        remaining,
        discount: customer.discount || '0',
        phone: customer.phone,
      });
      setWhatsappSending(prev => ({ ...prev, [id]: 'sent' }));
    } catch (err) {
      console.error('WhatsApp reminder failed:', err);
      setWhatsappSending(prev => ({ ...prev, [id]: 'error' }));
    }
  };

  // Parse combined customer Excel/CSV (13 columns)
  const parseExcelCustomers = async (file) => {
    return new Promise((resolve, reject) => {
      const fileExtension = file.name.split('.').pop().toLowerCase();
      
      // Handle XLSX/XLS files
      if (['xlsx', 'xls'].includes(fileExtension)) {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const data = new Uint8Array(e.target.result);
            // Do NOT use cellDates — Excel's locale may already misinterpret MM/DD.
            // Instead use raw:false + dateNF so SheetJS formats every date cell as
            // "MM/DD/YYYY" text regardless of Excel's regional settings.
            const workbook = XLSX.read(data, { type: 'array' });
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];

            if (!worksheet) {
              reject(new Error('No data found in Excel file'));
              return;
            }

            // raw:false formats all cell values as their display text.
            // dateNF forces date cells to output as MM/DD/YYYY strings.
            const rows = XLSX.utils.sheet_to_json(worksheet, {
              header: 1,
              raw: false,
              dateNF: 'mm/dd/yyyy',
              defval: '',
            });
            if (!rows || rows.length === 0) {
              reject(new Error('No data found in Excel file'));
              return;
            }

            const firstRow = rows[0];
            const isHeader = Array.isArray(firstRow) && firstRow.some(c =>
              typeof c === 'string' && /id|name|email|meal|date/i.test(c)
            );
            const startIdx = isHeader ? 1 : 0;

            const customers = [];
            const errors = [];
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

            for (let i = startIdx; i < rows.length; i++) {
              const cells = rows[i];
              if (!cells || cells.every(c => c === '' || c === null || c === undefined)) continue;

              const customerId = String(cells[0] ?? '').trim();
              const name       = String(cells[1] ?? '').trim();

              // Date comes as "MM/DD/YYYY" string thanks to dateNF above
              const starterDate = String(cells[3] ?? '').trim();

              const macroC       = String(cells[4] ?? '0').trim();
              const macroP       = String(cells[5] ?? '0').trim();
              const macroF       = String(cells[6] ?? '0').trim();
              // Derive meal plan from macros; fall back to the spreadsheet column value
              const mealPlan = getMealPlanFromMacros(macroC, macroP, macroF)
                             || String(cells[2] ?? 'Standard').trim() || 'Standard';
              const exclusions   = String(cells[7] ?? '').trim();
              const noOfMeals    = String(cells[8] ?? '1').trim();
              const breakfast    = String(cells[9] ?? '').trim().toLowerCase();
              const phone        = String(cells[10] ?? '').trim();
              const email        = String(cells[11] ?? '').trim();
              const cycleDuration = String(cells[12] ?? '0').trim();
              const amountPaid   = String(cells[13] ?? '').trim();
              const discount     = String(cells[14] ?? '').trim();
              const snackCount   = String(cells[15] ?? '0').trim();

              if (!customerId) { errors.push(`Row ${i + 1}: Missing Customer ID`); continue; }
              if (!name)       { errors.push(`Row ${i + 1}: Missing Name`); continue; }
              if (!email)      { errors.push(`Row ${i + 1}: Missing Email`); continue; }
              if (!emailRegex.test(email)) { errors.push(`Row ${i + 1}: Invalid email: ${email}`); continue; }

              customers.push({
                customerId,
                name,
                mealPlan,
                starterDate,
                macroC: Number(macroC) || 0,
                macroP: Number(macroP) || 0,
                macroF: Number(macroF) || 0,
                exclusions,
                noOfMeals: parseInt(noOfMeals) || 1,
                breakfast: breakfast === 'yes' || breakfast === 'true' || breakfast === '1',
                phone,
                email,
                cycleDuration: parseInt(cycleDuration) || 0,
                amountPaid,
                discount,
                snackCount: parseInt(snackCount) || 0,
              });
            }

            if (customers.length === 0 && errors.length > 0) {
              reject(new Error(`No valid data found. Errors:\n${errors.slice(0, 5).join('\n')}${errors.length > 5 ? `\n...and ${errors.length - 5} more` : ''}`));
              return;
            }
            resolve({ customers, errors });
          } catch (error) {
            reject(new Error(`Failed to parse Excel file: ${error.message}`));
          }
        };
        reader.onerror = () => reject(new Error('Failed to read Excel file'));
        reader.readAsArrayBuffer(file);
        return;
      }
      
      // Handle CSV/TXT files
      if (['csv', 'txt'].includes(fileExtension)) {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const csvData = e.target.result;
            parseCSVData(csvData, reject, resolve);
          } catch (error) {
            reject(error);
          }
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsText(file);
        return;
      }
      
      reject(new Error(`Unsupported file type: ${fileExtension}. Please use CSV, TXT, XLSX, or XLS`));
    });
    
    // Columns: Customer ID, Name, Meal Plan, Starter Date, C, P, F, Exclusion,
    //          No. Meal, Breakfast, Phone, Email, Cycle Duration, Amount Paid, Discount, Snack Count
    function parseCSVData(csvData, reject, resolve) {
      try {
        const lines = csvData.split(/\r?\n/).filter(line => line.trim());
        if (lines.length === 0) { reject(new Error('File is empty')); return; }

        const firstLine = lines[0];
        let delimiter = ',';
        if (firstLine.includes('\t')) delimiter = '\t';
        else if ((firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length) delimiter = ';';

        const splitCells = (line) => {
          const cells = [];
          let cur = '', inQ = false;
          for (const ch of line) {
            if (ch === '"') inQ = !inQ;
            else if (ch === delimiter && !inQ) { cells.push(cur.trim().replace(/^"|"$/g, '')); cur = ''; }
            else cur += ch;
          }
          cells.push(cur.trim().replace(/^"|"$/g, ''));
          return cells;
        };

        const firstLower = lines[0].toLowerCase();
        const startIndex = (firstLower.includes('id') || firstLower.includes('name') || firstLower.includes('email')) ? 1 : 0;

        const customers = [];
        const errors = [];
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        for (let i = startIndex; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const cells = splitCells(line);

          const customerId    = cells[0]?.trim() || '';
          const name          = cells[1]?.trim() || '';
          const starterDate   = cells[3]?.trim() || '';
          const macroC        = cells[4]?.trim() || '0';
          const macroP        = cells[5]?.trim() || '0';
          const macroF        = cells[6]?.trim() || '0';
          // Derive meal plan from macros; fall back to the spreadsheet column value
          const mealPlan = getMealPlanFromMacros(macroC, macroP, macroF)
                         || cells[2]?.trim() || 'Standard';
          const exclusions    = cells[7]?.trim() || '';
          const noOfMeals     = cells[8]?.trim() || '1';
          const breakfast     = (cells[9]?.trim() || '').toLowerCase();
          const phone         = cells[10]?.trim() || '';
          const email         = cells[11]?.trim() || '';
          const cycleDuration = cells[12]?.trim() || '0';
          const amountPaid    = cells[13]?.trim() || '';
          const discount      = cells[14]?.trim() || '';
          const snackCount    = cells[15]?.trim() || '0';

          if (!customerId) { errors.push(`Row ${i + 1}: Missing Customer ID`); continue; }
          if (!name)       { errors.push(`Row ${i + 1}: Missing Name`); continue; }
          if (!email)      { errors.push(`Row ${i + 1}: Missing Email`); continue; }
          if (!emailRegex.test(email)) { errors.push(`Row ${i + 1}: Invalid email: ${email}`); continue; }

          customers.push({
            customerId,
            name,
            mealPlan,
            starterDate,
            macroC: Number(macroC) || 0,
            macroP: Number(macroP) || 0,
            macroF: Number(macroF) || 0,
            exclusions,
            noOfMeals: parseInt(noOfMeals) || 1,
            breakfast: breakfast === 'yes' || breakfast === 'true' || breakfast === '1',
            phone,
            email,
            cycleDuration: parseInt(cycleDuration) || 0,
            amountPaid,
            snackCount: parseInt(snackCount) || 0,
            discount,
          });
        }

        if (customers.length === 0 && errors.length > 0) {
          reject(new Error(`No valid data found. Errors:\n${errors.slice(0, 5).join('\n')}${errors.length > 5 ? `\n...and ${errors.length - 5} more` : ''}`));
          return;
        }
        resolve({ customers, errors });
      } catch (error) {
        reject(error);
      }
    }
  };



  // Handle create customer form submission
  // REMOVED - No longer needed
  
  // Handle Excel file upload
  const handleEmailsUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setIsUploadingEmails(true);
      setUploadError(null);
      setUploadProgress(0);
      setUploadStatus('Reading file...');

      // Validate file type
      const fileExtension = file.name.split('.').pop().toLowerCase();
      if (!['csv', 'txt', 'xlsx', 'xls'].includes(fileExtension)) {
        setUploadError('Invalid file type. Please upload a CSV, TXT, XLSX, or XLS file');
        return;
      }

      // Parse customers from Excel/CSV
      setUploadProgress(20);
      const parseResult = await parseExcelCustomers(file);
      const { customers, errors } = parseResult;
      
      if (customers.length === 0) {
        const errorMsg = errors && errors.length > 0
          ? `No valid customer data found.\n\nRequired columns: Customer ID, Name, Meal Plan, Starter Date, C, P, F, Exclusion, No. Meal, Breakfast, Phone, Email, Cycle Duration, Amount Paid, Discount, Snack Count\n\nErrors found:\n${errors.slice(0, 3).join('\n')}${errors.length > 3 ? '\n...and ' + (errors.length - 3) + ' more' : ''}`
          : 'No valid customer data found. Please use the template format.';
        setUploadError(errorMsg);
        return;
      }

      setUploadProgress(40);
      setUploadStatus(`Parsed ${customers.length} customers. Uploading...`);

      // Send to backend with new endpoint
      const response = await api.post('/customers/upload-bulk', {
        customers: customers
      });

      setUploadProgress(80);
      setUploadStatus('Processing results...');

      if (response.data?.success) {
        setUploadProgress(100);
        setUploadStatus('Complete!');
        
        const resultMsg = `✅ Successfully processed ${customers.length} customers\n\n` +
          `Created: ${response.data.created || 0}\n` +
          `Updated: ${response.data.updated || 0}` +
          (response.data.conflicts?.length > 0
            ? `\n\n⚠️ Needs review — ${response.data.conflicts.length} row(s) NOT applied because their customer ID doesn't match the one on file (nothing was renamed):\n` +
              response.data.conflicts.slice(0, 3).map((c) => `• ${c.customerId} (${c.email}): ${c.reason}`).join('\n') +
              (response.data.conflicts.length > 3 ? `\n...and ${response.data.conflicts.length - 3} more` : '') +
              `\nTo change a customer's ID on purpose, use Rename ID on the customer.`
            : '') +
          (response.data.errors?.length > 0 ? `\n\nPartial errors (${response.data.errors.length}): ${response.data.errors.slice(0, 2).join(', ')}` : '') +
          (errors.length > 0 ? `\n\n⚠️ Skipped ${errors.length} invalid rows` : '');
        
        alert(resultMsg);
        
        // Refresh customers list
        setTimeout(() => {
          fetchCustomers();
          setUploadProgress(0);
          setUploadStatus('');
        }, 1000);
      } else {
        setUploadError(response.data?.message || 'Failed to upload customers');
      }
    } catch (error) {
      console.error('Error uploading customers:', error);
      const errorMessage = error.message || error.response?.data?.message || 'Failed to upload customers. Please check the file format.';
      setUploadError(errorMessage);
    } finally {
      setIsUploadingEmails(false);
      // Reset file input
      if (event.target) {
        event.target.value = '';
      }
    }
  };

  const downloadReport = (customer) => {
    // Prepare CSV data
    const headers = ['Delivery ID', 'Customer Name', 'Customer ID', 'Company', 'Status', 'Scheduled Time', 'Delivered Time', 'Late Minutes', 'Proof'];
    const rows = customerDeliveries.map(delivery => [
      delivery._id || 'N/A',
      delivery.customerName || 'N/A',
      delivery.customerId || 'N/A',
      delivery.company || 'N/A',
      delivery.status || 'N/A',
      delivery.scheduledTime ? new Date(delivery.scheduledTime).toLocaleString() : 'N/A',
      delivery.deliveredTime ? new Date(delivery.deliveredTime).toLocaleString() : 'N/A',
      delivery.lateMinutes || 0,
      delivery.proof?.images?.length > 0 ? 'Yes' : 'No'
    ]);

    // Create CSV content
    const csvContent = [
      [`Report for Customer: ${customer.customerName} (${customer.customerId})`],
      [`Report Date: ${new Date().toLocaleString()}`],
      [`Total Deliveries: ${customer.totalDeliveries}`],
      [`Completed: ${customer.completedDeliveries}`],
      [`Late Deliveries: ${customer.lateDeliveries}`],
      [`Average Late Time: ${customer.lateDeliveries > 0 ? Math.round(customer.totalLateMinutes / customer.lateDeliveries) : 0} minutes`],
      [],
      [headers.join(',')],
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    // Create blob and download
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `customer_report_${customer.customerId}_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  const formatDuration = (minutes = 0) => {
    const value = Math.abs(Math.round(minutes));
    if (value < 60) {
      return `${value}m`;
    }
    const hours = Math.floor(value / 60);
    const mins = value % 60;
    return `${hours}h:${mins.toString().padStart(2, '0')}m`;
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    try {
      return new Date(dateString).toLocaleString();
    } catch {
      return 'Invalid date';
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'pending': return 'bg-yellow-100 text-yellow-800';
      case 'assigned': return 'bg-blue-100 text-blue-800';
      case 'picked_up': return 'bg-purple-100 text-purple-800';
      case 'delivered': return 'bg-green-100 text-green-800';
      case 'failed': return 'bg-red-100 text-red-800';
      case 'cancelled': return 'bg-gray-100 text-gray-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center h-64">
          <div className="flex items-center space-x-2">
            <RefreshCw className="w-5 h-5 animate-spin" />
            <span>Loading customers...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center">
            <div className="text-red-600 font-medium">Error loading customers</div>
            <button
              onClick={fetchCustomers}
              className="ml-auto flex items-center px-3 py-1 text-sm bg-red-100 text-red-700 rounded"
            >
              <RefreshCw className="w-4 h-4 mr-1" />
              Retry
            </button>
          </div>
          <div className="text-red-600 text-sm mt-1">{error}</div>
        </div>
      </div>
    );
  }

  if (selectedCustomer) {
    return (
      <div className="p-6 space-y-6">
        {/* Customer Detail Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{selectedCustomer.customerName}</h1>
            <p className="text-gray-600 text-sm mt-1">Customer ID: {selectedCustomer.customerId}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { setEditCustomerError(null); setShowEditCustomerModal(true); }}
              className="flex items-center px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            >
              <UserPlus className="w-4 h-4 mr-2" />
              Edit
            </button>
            <button
              onClick={() => downloadReport(selectedCustomer)}
              className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Download className="w-4 h-4 mr-2" />
              Download Report
            </button>
            <button
              onClick={handleCloseDetail}
              className="flex items-center px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
            >
              Back
            </button>
          </div>
        </div>

        {/* Customer Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm">Total Deliveries</p>
                <p className="text-2xl font-bold text-blue-600">{selectedCustomer.totalDeliveries}</p>
              </div>
              <Package className="w-8 h-8 text-blue-300" />
            </div>
          </div>

          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm">Completed</p>
                <p className="text-2xl font-bold text-green-600">{selectedCustomer.completedDeliveries}</p>
              </div>
              <CheckCircle className="w-8 h-8 text-green-300" />
            </div>
          </div>

          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm">Pending</p>
                <p className="text-2xl font-bold text-yellow-600">{selectedCustomer.pendingDeliveries}</p>
              </div>
              <Clock className="w-8 h-8 text-yellow-300" />
            </div>
          </div>

          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-600 text-sm">Late Deliveries</p>
                <p className="text-2xl font-bold text-red-600">{selectedCustomer.lateDeliveries}</p>
              </div>
              <AlertCircle className="w-8 h-8 text-red-300" />
            </div>
          </div>
        </div>

        {/* Cycle Balance */}
        {(() => {
          const total = Number(selectedCustomer.cycleDuration) || 0;
          const startDate = selectedCustomer.planStartDate ? new Date(selectedCustomer.planStartDate) : null;
          const used = startDate
            ? customerDeliveries.filter(d => new Date(d.scheduledTime) >= startDate).length
            : customerDeliveries.length;
          const remaining = Math.max(0, total - used);
          return (
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-5 text-center relative">
                <p className="text-xs font-semibold text-indigo-500 uppercase tracking-wide mb-2">Per Month</p>
                {isEditingCycleDuration ? (
                  <div className="flex flex-col items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      value={cycleDurationValue}
                      onChange={e => setCycleDurationValue(e.target.value)}
                      className="w-24 text-center border border-indigo-300 rounded-lg px-2 py-1 text-xl font-bold text-indigo-700 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                      disabled={cycleDurationSaving}
                      autoFocus
                    />
                    <div className="flex gap-1">
                      <button onClick={handleSaveCycleDuration} disabled={cycleDurationSaving}
                        className="px-2 py-1 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50">
                        {cycleDurationSaving ? '…' : 'Save'}
                      </button>
                      <button onClick={() => setIsEditingCycleDuration(false)} disabled={cycleDurationSaving}
                        className="px-2 py-1 bg-gray-200 text-gray-700 rounded text-xs hover:bg-gray-300 disabled:opacity-50">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-4xl font-bold text-indigo-700">{total || '—'}</p>
                    <button
                      onClick={() => { setCycleDurationValue(total ? String(total) : ''); setIsEditingCycleDuration(true); }}
                      className="text-xs text-indigo-500 hover:text-indigo-700 mt-1 underline underline-offset-2">
                      {total ? 'edit' : 'set allocation'}
                    </button>
                  </>
                )}
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-5 text-center">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Days Used</p>
                <p className="text-4xl font-bold text-gray-700">{used}</p>
                <p className="text-xs text-gray-400 mt-1">{startDate ? `since ${startDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}` : 'all time'}</p>
              </div>
              <div className={`rounded-xl p-5 text-center border ${remaining === 0 ? 'bg-red-50 border-red-200' : remaining <= 5 ? 'bg-orange-50 border-orange-200' : 'bg-green-50 border-green-200'}`}>
                <p className={`text-xs font-semibold uppercase tracking-wide mb-2 ${remaining === 0 ? 'text-red-500' : remaining <= 5 ? 'text-orange-500' : 'text-green-600'}`}>Remaining</p>
                <p className={`text-4xl font-bold ${remaining === 0 ? 'text-red-700' : remaining <= 5 ? 'text-orange-600' : 'text-green-700'}`}>{total ? remaining : '—'}</p>
                <p className={`text-xs mt-1 ${remaining === 0 ? 'text-red-400' : remaining <= 5 ? 'text-orange-400' : 'text-green-500'}`}>{total ? 'days left' : 'no cycle set'}</p>
              </div>
            </div>
          );
        })()}

        {/* Customer Info */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Contact Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {customerProfile?.firstName && customerProfile?.lastName && (
              <div className="md:col-span-2">
                <p className="text-gray-600 text-sm">Full Name</p>
                <p className="text-gray-900 font-medium">
                  {customerProfile.firstName} {customerProfile.lastName}
                </p>
              </div>
            )}
            <div className="md:col-span-2">
              <div className="flex items-center justify-between mb-1">
                <p className="text-gray-600 text-sm">Email</p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleFetchFilemakerLayouts}
                    disabled={filemakerLayoutsLoading}
                    className="text-indigo-600 hover:text-indigo-700 text-sm font-medium disabled:opacity-60"
                  >
                    {filemakerLayoutsLoading ? 'Fetching layouts...' : 'Preview FileMaker Layouts (Read-only)'}
                  </button>
                  {!isEditingEmail && (
                    <button
                      onClick={handleEditEmail}
                      className="text-blue-600 hover:text-blue-700 text-sm flex items-center gap-1"
                    >
                      <Mail className="w-3 h-3" />
                      {(customerProfile?.email || selectedCustomer.email === 'N/A') ? 'Edit' : 'Add Email'}
                    </button>
                  )}
                </div>
              </div>
              {isEditingEmail ? (
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={editEmailValue}
                    onChange={(e) => setEditEmailValue(e.target.value)}
                    placeholder="customer@example.com"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    disabled={emailSaveLoading}
                  />
                  <button
                    onClick={handleSaveEmail}
                    disabled={emailSaveLoading}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {emailSaveLoading ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={handleCancelEditEmail}
                    disabled={emailSaveLoading}
                    className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <p className="text-gray-900 font-medium">
                  {customerProfile?.email || selectedCustomer.email || 'N/A'}
                </p>
              )}
            </div>
            <div>
              <p className="text-gray-600 text-sm">Phone</p>
              <p className="text-gray-900 font-medium">
                {customerProfile?.phone || selectedCustomer.phone}
              </p>
            </div>
            {(customerProfile?.cpf || selectedCustomer.cpf) && (
              <div>
                <p className="text-gray-600 text-sm">CPF</p>
                <p className="text-gray-900 font-medium">
                  {customerProfile?.cpf || selectedCustomer.cpf}
                </p>
              </div>
            )}
            {((customerProfile?.macros?.C || customerProfile?.macros?.P || customerProfile?.macros?.F) ||
              (selectedCustomer.macros?.C || selectedCustomer.macros?.P || selectedCustomer.macros?.F)) && (
              <div className="md:col-span-2">
                <p className="text-gray-600 text-sm">Target Macros</p>
                <div className="flex flex-wrap gap-4 mt-1 text-gray-900 font-medium">
                  {(() => {
                    const C = customerProfile?.macros?.C ?? selectedCustomer.macros?.C ?? 0;
                    const P = customerProfile?.macros?.P ?? selectedCustomer.macros?.P ?? 0;
                    const F = customerProfile?.macros?.F ?? selectedCustomer.macros?.F ?? 0;
                    const plan = getMealPlanFromMacros(C, P, F);
                    return (
                      <>
                        <span>C: {C}g</span>
                        <span>P: {P}g</span>
                        <span>F: {F}g</span>
                        {plan && (
                          <span className="ml-2 px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-xs font-semibold">
                            {plan}
                          </span>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
            <div>
              <p className="text-gray-600 text-sm">Company</p>
              <p className="text-gray-900 font-medium">
                {selectedCustomer.company}
              </p>
            </div>
            <div className="md:col-span-2">
              <p className="text-gray-600 text-sm">Address</p>
              <p className="text-gray-900 font-medium flex items-start">
                <MapPin className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                {selectedCustomer.address}
              </p>
            </div>
            {customerProfile?.athleatId && (
              <div className="md:col-span-2 pt-2 border-t">
                <p className="text-gray-600 text-sm">Athleat ID</p>
                <p className="text-gray-900 font-mono text-xs">
                  {customerProfile.athleatId}
                </p>
                {customerProfile.athleatSyncedAt && (
                  <p className="text-gray-500 text-xs mt-1">
                    Last synced: {new Date(customerProfile.athleatSyncedAt).toLocaleString()}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {(filemakerLayoutsError || filemakerLayoutsData) && (
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-gray-900">FileMaker Layout Results</h2>
              {filemakerLayoutsData?.email && (
                <span className="text-xs text-gray-500">Email: {filemakerLayoutsData.email}</span>
              )}
            </div>

            {filemakerLayoutsData?.readOnly && (
              <div className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg p-3 mb-3">
                {filemakerLayoutsData?.note || 'Read-only preview. This action does not update customer/profile records.'}
              </div>
            )}

            {filemakerLayoutsError && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
                {filemakerLayoutsError}
              </div>
            )}

            {filemakerLayoutsData?.summary && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
                <div className="bg-blue-50 border border-blue-100 rounded p-2 text-xs">Customer: {filemakerLayoutsData.summary.customerCount}</div>
                <div className="bg-green-50 border border-green-100 rounded p-2 text-xs">Leads: {filemakerLayoutsData.summary.leadCount}</div>
                <div className="bg-yellow-50 border border-yellow-100 rounded p-2 text-xs">Orders: {filemakerLayoutsData.summary.orderCount}</div>
                <div className="bg-orange-50 border border-orange-100 rounded p-2 text-xs">Schedule: {filemakerLayoutsData.summary.orderScheduleCount}</div>
                <div className="bg-purple-50 border border-purple-100 rounded p-2 text-xs">Menu: {filemakerLayoutsData.summary.menuItemCount}</div>
              </div>
            )}

            {filemakerLayoutsData && (
              <div className="space-y-3">
                {[
                  ['Customer: Web Data', filemakerLayoutsData.customerLayout],
                  ['Leads: Web Data', filemakerLayoutsData.leadLayout],
                  ['Order: Web Data', filemakerLayoutsData.orderLayout],
                  ['Order: Schedule Meal - Web Data', filemakerLayoutsData.orderScheduleLayout],
                  ['Menu: Item - Web Data', filemakerLayoutsData.menuItemLayout]
                ].map(([label, rows]) => (
                  <details key={label} className="border border-gray-200 rounded-lg" open>
                    <summary className="px-3 py-2 cursor-pointer text-sm font-medium text-gray-800 bg-gray-50">
                      {label} ({Array.isArray(rows) ? rows.length : 0})
                    </summary>
                    <pre className="text-xs bg-white p-3 overflow-auto max-h-72 border-t border-gray-200">
                      {JSON.stringify(rows, null, 2)}
                    </pre>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Subscription */}
        {(() => {
          const total = Number(selectedCustomer.cycleDuration) || 0;
          const startDate = selectedCustomer.planStartDate ? new Date(selectedCustomer.planStartDate) : null;
          const used = startDate
            ? customerDeliveries.filter(d => new Date(d.scheduledTime) >= startDate).length
            : customerDeliveries.length;
          const remaining = Math.max(0, total - used);
          const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
          return (
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 mb-4">
                <DollarSign className="w-5 h-5 text-purple-600" />
                Subscription
              </h2>
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-center">
                    <p className="text-xs text-gray-500 mb-1">Cycle Duration</p>
                    <p className="text-2xl font-bold text-blue-600">{total || '—'}</p>
                  </div>
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
                    <p className="text-xs text-gray-500 mb-1">Discount</p>
                    <p className="text-2xl font-bold text-green-600">{selectedCustomer.discount || '—'}</p>
                  </div>
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-center">
                    <p className="text-xs text-gray-500 mb-1">Amount Paid</p>
                    <p className="text-2xl font-bold text-yellow-600">{selectedCustomer.amountPaid || '—'}</p>
                  </div>
                </div>
                {/* Cycle Calendar */}
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  {/* Header row — always visible, click to toggle */}
                  <button
                    onClick={() => setShowCycleCalendar(v => !v)}
                    className="w-full flex items-center justify-between px-4 py-2.5 bg-white hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-indigo-500" />
                      <span className="text-sm font-semibold text-gray-700">Cycle</span>
                      {selectedCustomer.planStartDate && (
                        <span className="text-xs text-gray-400">
                          {new Date(selectedCustomer.planStartDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {!isEditingPlanStart && (
                        <span
                          role="button"
                          onClick={e => { e.stopPropagation(); const d = selectedCustomer.planStartDate; setPlanStartValue(d ? new Date(d).toLocaleDateString('en-CA') : ''); setIsEditingPlanStart(true); setShowCycleCalendar(true); }}
                          className="text-xs text-indigo-500 hover:text-indigo-700 font-medium px-1">
                          {selectedCustomer.planStartDate ? 'Edit' : 'Set date'}
                        </span>
                      )}
                      <ChevronRight className={`w-4 h-4 text-gray-400 transition-transform ${showCycleCalendar ? 'rotate-90' : ''}`} />
                    </div>
                  </button>

                  {/* Edit date — shown when editing */}
                  {isEditingPlanStart && (
                    <div className="px-4 py-2 bg-indigo-50 border-t border-indigo-100 flex items-center gap-2 flex-wrap">
                      <input
                        type="date"
                        value={planStartValue}
                        onChange={e => setPlanStartValue(e.target.value)}
                        className="border border-gray-300 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none bg-white"
                        disabled={planStartSaving}
                      />
                      <button onClick={handleSavePlanStart} disabled={planStartSaving}
                        className="px-3 py-1 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50">
                        {planStartSaving ? '…' : 'Save'}
                      </button>
                      <button onClick={() => setIsEditingPlanStart(false)} disabled={planStartSaving}
                        className="px-3 py-1 bg-white border border-gray-200 text-gray-600 rounded text-xs hover:bg-gray-50 disabled:opacity-50">
                        Cancel
                      </button>
                    </div>
                  )}

                  {/* Collapsible calendar body */}
                  {showCycleCalendar && (() => {
                    const deliveryDatesSet = new Set(customerDeliveries.map(d => {
                      const dt = new Date(d.scheduledTime);
                      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
                    }));

                    const now = new Date();
                    let baseDate;
                    if (calendarViewMonth) {
                      baseDate = new Date(calendarViewMonth.year, calendarViewMonth.month, 1);
                    } else if (selectedCustomer.planStartDate) {
                      const s = new Date(selectedCustomer.planStartDate);
                      baseDate = new Date(s.getFullYear(), s.getMonth(), 1);
                    } else {
                      baseDate = new Date(now.getFullYear(), now.getMonth(), 1);
                    }

                    const year = baseDate.getFullYear();
                    const month = baseDate.getMonth();
                    const firstDow = new Date(year, month, 1).getDay();
                    const startOffset = (firstDow + 6) % 7;
                    const daysInMonth = new Date(year, month + 1, 0).getDate();
                    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                    const monthLabel = baseDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

                    const prevMonth = () => setCalendarViewMonth({ year: month === 0 ? year - 1 : year, month: month === 0 ? 11 : month - 1 });
                    const nextMonth = () => setCalendarViewMonth({ year: month === 11 ? year + 1 : year, month: month === 11 ? 0 : month + 1 });

                    const cells = [];
                    for (let i = 0; i < startOffset; i++) cells.push(null);
                    for (let d = 1; d <= daysInMonth; d++) cells.push(d);

                    return (
                      <div className="border-t border-gray-200 bg-white p-3">
                        {/* Month navigation */}
                        <div className="flex items-center justify-between mb-2">
                          <button onClick={prevMonth} className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500 transition-colors">
                            <ChevronLeft className="w-4 h-4" />
                          </button>
                          <span className="text-xs font-bold text-gray-700 tracking-wide">{monthLabel}</span>
                          <button onClick={nextMonth} className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500 transition-colors">
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        </div>

                        {/* Day headers */}
                        <div className="grid grid-cols-7 border border-gray-200 rounded-t-md overflow-hidden">
                          {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => (
                            <div key={d} className="text-center text-[10px] font-semibold text-gray-500 bg-gray-50 py-1 border-r border-gray-200 last:border-r-0">{d}</div>
                          ))}
                        </div>

                        {/* Day cells */}
                        <div className="grid grid-cols-7 border-l border-r border-b border-gray-200 rounded-b-md overflow-hidden">
                          {cells.map((day, idx) => {
                            if (!day) return <div key={`e-${idx}`} className="border-r border-b border-gray-100 h-8 last:border-r-0 bg-gray-50/50" />;
                            const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                            const hasDelivery = deliveryDatesSet.has(dateKey);
                            const isToday = dateKey === todayKey;
                            return (
                              <div key={dateKey} className={`border-r border-b border-gray-100 last:border-r-0 h-8 flex items-center justify-center
                                ${hasDelivery ? 'bg-indigo-50' : 'bg-white hover:bg-gray-50'}`}>
                                <span className={`
                                  w-6 h-6 flex items-center justify-center rounded-full text-xs font-semibold
                                  ${hasDelivery
                                    ? 'bg-indigo-500 text-white shadow-sm'
                                    : isToday
                                    ? 'ring-2 ring-indigo-400 text-indigo-700 bg-indigo-50'
                                    : 'text-gray-700'}
                                `}>
                                  {day}
                                </span>
                              </div>
                            );
                          })}
                        </div>

                        {/* Footer */}
                        <div className="flex items-center justify-between mt-2">
                          <div className="flex items-center gap-1.5">
                            <div className="w-3 h-3 rounded-full bg-indigo-500" />
                            <span className="text-[10px] text-gray-500">Delivery day</span>
                          </div>
                          <span className="text-[10px] font-semibold text-indigo-600">{deliveryDatesSet.size} deliveries total</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
                {total > 0 && (
                  <div className="border border-gray-200 rounded-lg p-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Delivery Balance</p>
                    <div className="grid grid-cols-3 gap-3 mb-3">
                      <div className="text-center">
                        <p className="text-xs text-gray-500 mb-1">Allocated</p>
                        <p className="text-xl font-bold text-blue-600">{total}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-gray-500 mb-1">Used</p>
                        <p className="text-xl font-bold text-gray-700">{used}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-gray-500 mb-1">Remaining</p>
                        <p className={`text-xl font-bold ${remaining === 0 ? 'text-red-600' : remaining <= 5 ? 'text-orange-500' : 'text-green-600'}`}>{remaining}</p>
                      </div>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-3">
                      <div className={`h-3 rounded-full transition-all ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-orange-400' : 'bg-green-500'}`}
                        style={{ width: `${pct}%` }} />
                    </div>
                    <p className="text-xs text-gray-400 mt-1 text-right">{pct}% used</p>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Meal Preferences */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <MealPreferences 
            customerId={selectedCustomer.customerId} 
            customerEmail={customerProfile?.email || (selectedCustomer.email !== 'N/A' ? selectedCustomer.email : null)}
          />
        </div>

        {/* Deliveries List */}
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Delivery History ({customerDeliveries.length})</h2>
          </div>

          {isLoadingDeliveries ? (
            <div className="p-6 text-center">
              <RefreshCw className="w-5 h-5 animate-spin mx-auto text-gray-400" />
            </div>
          ) : deliveriesError ? (
            <div className="p-6 text-center text-red-600">{deliveriesError}</div>
          ) : customerDeliveries.length === 0 ? (
            <div className="p-6 text-center text-gray-500">No deliveries found</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-600 uppercase">Date</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-600 uppercase">Status</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-600 uppercase">Late</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-600 uppercase">Proof</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {customerDeliveries.map((delivery) => (
                    <tr key={delivery._id} className="hover:bg-gray-50">
                      <td className="px-6 py-3 text-gray-900">
                        {formatDate(delivery.scheduledTime)}
                      </td>
                      <td className="px-6 py-3">
                        <span className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(delivery.status)}`}>
                          {delivery.status?.replace('_', ' ') || 'Unknown'}
                        </span>
                      </td>
                      <td className="px-6 py-3">
                        <span className={delivery.lateMinutes && delivery.lateMinutes > 0 ? 'text-red-600 font-semibold' : 'text-gray-400'}>
                          {delivery.lateMinutes && delivery.lateMinutes > 0 ? `+${formatDuration(delivery.lateMinutes)}` : '—'}
                        </span>
                      </td>
                      <td className="px-6 py-3">
                        {delivery.proof?.images?.length > 0 ? (
                          <span className="text-green-600 font-semibold">✓</span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Delivery Issues */}
        <CustomerIssues customerId={selectedCustomer.customerId} />

        {showEditCustomerModal && (
          <EditCustomerModal
            customer={{
              ...selectedCustomer,
              customerName: customerProfile?.firstName
                ? `${customerProfile.firstName} ${customerProfile.lastName || ''}`.trim()
                : selectedCustomer.customerName,
              email: customerProfile?.email || selectedCustomer.email,
              phone: customerProfile?.phone || selectedCustomer.phone,
            }}
            onClose={() => { setShowEditCustomerModal(false); setEditCustomerError(null); }}
            onSubmit={handleEditCustomer}
            isSubmitting={isSavingCustomer}
            submitError={editCustomerError}
          />
        )}
      </div>
    );
  }

  return (
    <>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Customers</h1>
            <p className="text-gray-600 text-sm">
              Manage and view customer delivery records ({filteredCustomers.length} of {customers.length})
            </p>
            {lastUpdated && (
              <p className="text-xs text-gray-400">
                Updated {new Date(lastUpdated).toLocaleTimeString()}
              </p>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            {(() => {
              const today = new Date(); today.setHours(0, 0, 0, 0);
              const renewalCount = customers.filter(c => {
                const total = Number(c.cycleDuration) || 0;
                if (!total) return false;
                const remaining = total - (c.totalDeliveries || 0);
                if (remaining > 6) return false;
                if (c.planStartDate) {
                  const endDate = new Date(new Date(c.planStartDate).getTime() + total * 24 * 60 * 60 * 1000);
                  if (endDate < today) return false;
                }
                return true;
              }).length;
              return (
                <button
                  onClick={() => setShowRenewalModal(true)}
                  className="flex items-center px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg relative"
                >
                  <AlertCircle className="w-5 h-5 mr-2" />
                  Due for Renewal
                  {renewalCount > 0 && (
                    <span className="ml-2 bg-white text-orange-600 text-xs font-bold px-1.5 py-0.5 rounded-full">{renewalCount}</span>
                  )}
                </button>
              );
            })()}
            <button
              onClick={() => { setAddCustomerError(null); setShowAddCustomerModal(true); }}
              className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <UserPlus className="w-5 h-5 mr-2" />
              Add Customer
            </button>
            <label className="flex items-center px-4 py-2 text-gray-600 bg-green-100 text-green-700 rounded-lg hover:bg-green-200 cursor-pointer">
              <Upload className="w-5 h-5 mr-2" />
              Upload Customers
              <input
                type="file"
                accept=".csv,.xlsx,.xls,.txt"
                onChange={handleEmailsUpload}
                disabled={isUploadingEmails}
                className="hidden"
              />
            </label>
            <button
              onClick={() => {
                const headers = ['Customer ID', 'Name', 'Meal Plan', 'Starter Date', 'C', 'P', 'F', 'Exclusion', 'No. Meal', 'Breakfast', 'Phone', 'Email', 'Cycle Duration', 'Amount Paid', 'Discount', 'Snack Count'];
                const example = ['CUST-001', 'John Doe', 'Standard', '2026-07-01', '250', '180', '70', '', '2', 'No', '+971501234567', 'john@example.com', '30', '1500', '10%', '1'];
                const ws = XLSX.utils.aoa_to_sheet([headers, example]);
                ws['!cols'] = headers.map(() => ({ wch: 18 }));
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, 'Customers');
                XLSX.writeFile(wb, 'customer_upload_template.xlsx');
              }}
              className="flex items-center px-4 py-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200"
            >
              <Download className="w-5 h-5 mr-2" />
              Template
            </button>
            <button
              onClick={fetchCustomers}
              className="flex items-center px-4 py-2 text-gray-600 bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              <RefreshCw className="w-5 h-5 mr-2" />
              Refresh
            </button>
          </div>
        </div>

        {/* Renewal Modal */}
        {showRenewalModal && (() => {
          const today = new Date(); today.setHours(0, 0, 0, 0);
          const renewalList = customers
            .filter(c => {
              const total = Number(c.cycleDuration) || 0;
              if (!total) return false;
              const remaining = total - (c.totalDeliveries || 0);
              if (remaining > 6) return false;
              if (c.planStartDate) {
                const endDate = new Date(new Date(c.planStartDate).getTime() + total * 24 * 60 * 60 * 1000);
                if (endDate < today) return false;
              }
              return true;
            })
            .map(c => ({
              ...c,
              remaining: Math.max(0, (Number(c.cycleDuration) || 0) - (c.totalDeliveries || 0))
            }))
            .sort((a, b) => a.remaining - b.remaining);

          const exportRenewalExcel = () => {
            if (!renewalList.length) return;
            const sheetData = [
              ['Due for Renewal Report'],
              [`Generated: ${new Date().toLocaleDateString()}`],
              [],
              ['#', 'Customer Name', 'Customer ID', 'Last Delivery Date', 'Days Left'],
            ];
            renewalList.forEach((r, i) => {
              const lastDateObj = new Date();
              lastDateObj.setDate(lastDateObj.getDate() + r.remaining);
              const lastDate = lastDateObj.toLocaleDateString('en-GB');
              sheetData.push([i + 1, r.customerName, r.customerId, lastDate, r.remaining]);
            });
            const ws = XLSX.utils.aoa_to_sheet(sheetData);
            ws['!cols'] = [5, 28, 18, 20, 12].map(w => ({ wch: w }));
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Due for Renewal');
            const arr = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
            const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `due-for-renewal-${new Date().toISOString().slice(0,10)}.xlsx`;
            a.click(); URL.revokeObjectURL(url);
          };

          return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
                <div className="flex items-center justify-between p-5 border-b border-gray-200">
                  <div>
                    <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                      <AlertCircle className="w-5 h-5 text-orange-500" />
                      Due for Renewal
                    </h2>
                    <p className="text-xs text-gray-500 mt-0.5">{renewalList.length} customer{renewalList.length !== 1 ? 's' : ''} with 6 or fewer deliveries remaining</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {renewalList.length > 0 && (
                      <button
                        onClick={exportRenewalExcel}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700 transition"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download Excel
                      </button>
                    )}
                    <button onClick={() => { setShowRenewalModal(false); setWhatsappSending({}); }} className="text-gray-400 hover:text-gray-600">
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </div>
                <div className="overflow-y-auto flex-1">
                  {renewalList.length === 0 ? (
                    <div className="p-8 text-center text-gray-400">No customers due for renewal</div>
                  ) : (
                    <div className="divide-y divide-gray-100">
                      {renewalList.map(c => {
                        const waState = whatsappSending[c.customerId];
                        return (
                          <div
                            key={c.customerId}
                            className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 cursor-pointer"
                            onClick={() => { setShowRenewalModal(false); handleSelectCustomer(c); }}
                          >
                            <div className="min-w-0">
                              <p className="font-medium text-gray-900 truncate">{c.customerName}</p>
                              <p className="text-xs text-gray-400">{c.customerId}</p>
                              {c.phone && <p className="text-xs text-gray-400">{c.phone}</p>}
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                              <div className="text-right mr-1">
                                <p className="text-xs text-gray-400">Allocated</p>
                                <p className="text-sm font-semibold text-gray-600">{c.cycleDuration}</p>
                              </div>
                              <div className={`text-center px-3 py-1.5 rounded-lg min-w-[52px] ${c.remaining === 0 ? 'bg-red-100 text-red-700' : c.remaining <= 3 ? 'bg-orange-100 text-orange-700' : 'bg-yellow-100 text-yellow-700'}`}>
                                <p className="text-xs font-medium">Left</p>
                                <p className="text-lg font-bold leading-tight">{c.remaining}</p>
                              </div>
                              {/* WhatsApp reminder button */}
                              <button
                                onClick={(e) => handleSendWhatsAppReminder(c, e)}
                                disabled={waState === 'sending' || waState === 'sent'}
                                title={waState === 'sent' ? 'Reminder sent!' : waState === 'error' ? 'Failed — click to retry' : 'Send WhatsApp reminder'}
                                className={`flex items-center justify-center w-9 h-9 rounded-lg transition-all ${
                                  waState === 'sent'
                                    ? 'bg-green-100 text-green-600 cursor-default'
                                    : waState === 'error'
                                    ? 'bg-red-100 text-red-600 hover:bg-red-200'
                                    : waState === 'sending'
                                    ? 'bg-gray-100 text-gray-400 cursor-wait'
                                    : 'bg-green-50 text-green-600 hover:bg-green-100'
                                }`}
                              >
                                {waState === 'sending' ? (
                                  <RefreshCw className="w-4 h-4 animate-spin" />
                                ) : waState === 'sent' ? (
                                  <CheckCircle className="w-4 h-4" />
                                ) : waState === 'error' ? (
                                  <AlertCircle className="w-4 h-4" />
                                ) : (
                                  <Send className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Add Customer Modal */}
      {showAddCustomerModal && (
        <AddCustomerModal
          onClose={() => { setShowAddCustomerModal(false); setAddCustomerError(null); }}
          onSubmit={handleAddCustomer}
          isSubmitting={isAddingCustomer}
          submitError={addCustomerError}
        />
      )}

      {/* Upload Progress Bar */}
        {isUploadingEmails && uploadProgress > 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-blue-700 text-sm font-medium">{uploadStatus}</div>
              <div className="text-blue-600 text-sm font-semibold">{uploadProgress}%</div>
            </div>
            <div className="w-full bg-blue-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Upload Error Alert */}
        {uploadError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div className="text-red-700 text-sm whitespace-pre-wrap">{uploadError}</div>
              <button
                onClick={() => setUploadError(null)}
                className="text-red-500 text-sm font-medium ml-4 flex-shrink-0"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Search + Filter */}
        <div className="flex flex-col sm:flex-row gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              type="text"
              placeholder="Search by name, ID, company, or phone..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg outline-none"
              autoComplete="off"
            />
          </div>
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 self-start sm:self-auto">
            <button
              onClick={() => setCustomerFilter('all')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${customerFilter === 'all' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
            >
              All
              <span className={`ml-1.5 text-xs font-bold px-1.5 py-0.5 rounded-full ${customerFilter === 'all' ? 'bg-gray-100 text-gray-600' : 'bg-gray-200 text-gray-500'}`}>
                {customers.length}
              </span>
            </button>
            <button
              onClick={() => setCustomerFilter('active')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${customerFilter === 'active' ? 'bg-white text-green-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
            >
              Active
              <span className={`ml-1.5 text-xs font-bold px-1.5 py-0.5 rounded-full ${customerFilter === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'}`}>
                {(() => {
                  const today = new Date(); today.setHours(0, 0, 0, 0);
                  return customers.filter(c => {
                    const total = Number(c.cycleDuration) || 0;
                    if (!total) return false;
                    const remaining = total - (c.totalDeliveries || 0);
                    if (remaining <= 0) return false;
                    if (c.planStartDate) {
                      const endDate = new Date(new Date(c.planStartDate).getTime() + total * 24 * 60 * 60 * 1000);
                      if (endDate < today) return false;
                    }
                    return true;
                  }).length;
                })()}
              </span>
            </button>
          </div>

          {/* Plan filter dropdown */}
          {(() => {
            const planCounts = {};
            customers.forEach(c => {
              const plan = getMealPlanFromMacros(c.macros?.C, c.macros?.P, c.macros?.F) || c.mealPlan || '';
              if (plan) planCounts[plan] = (planCounts[plan] || 0) + 1;
            });
            const plans = Object.keys(planCounts).sort();
            if (plans.length === 0) return null;
            return (
              <div className="relative self-start sm:self-auto">
                <select
                  value={planFilter}
                  onChange={e => setPlanFilter(e.target.value)}
                  className={`pl-3 pr-8 py-2 text-sm rounded-lg border appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-colors
                    ${planFilter ? 'border-indigo-400 bg-indigo-50 text-indigo-700 font-medium' : 'border-gray-300 bg-white text-gray-600'}`}
                >
                  <option value="">All Plans</option>
                  {plans.map(p => (
                    <option key={p} value={p}>{p} ({planCounts[p]})</option>
                  ))}
                </select>
                <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            );
          })()}
        </div>

        {/* Customers Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCustomers.length === 0 ? (
            <div className="col-span-full text-center py-12">
              <div className="text-gray-400 text-lg">No customers found</div>
            </div>
          ) : (
            filteredCustomers.map((customer) => (
              <div
                key={customer.customerId}
                className="bg-white rounded-lg border border-gray-200 p-4 hover:shadow-lg transition-shadow cursor-pointer"
                onClick={() => handleSelectCustomer(customer)}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 truncate">{customer.customerName}</h3>
                    <p className="text-xs text-gray-500">{customer.customerId}</p>
                  </div>
                  <Eye className="w-4 h-4 text-gray-400 flex-shrink-0 ml-2" />
                </div>

                <div className="space-y-2 mb-4 text-sm">
                  <p className="text-gray-600 truncate">
                    <span className="text-gray-500">Company:</span> {customer.company}
                  </p>
                  <p className="text-gray-600 truncate">
                    <span className="text-gray-500">Phone:</span> {customer.phone}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-4 border-t border-gray-100">
                  <div className="text-center">
                    <p className="text-2xl font-bold text-blue-600">{customer.totalDeliveries}</p>
                    <p className="text-xs text-gray-600">Total</p>
                  </div>
                  <div className="text-center">
                    <p className={`text-2xl font-bold ${customer.lateDeliveries > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {customer.lateDeliveries}
                    </p>
                    <p className="text-xs text-gray-600">Late</p>
                  </div>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    downloadReport(customer);
                  }}
                  className="w-full mt-3 flex items-center justify-center px-3 py-2 bg-blue-50 text-blue-600 rounded text-sm hover:bg-blue-100 transition-colors"
                >
                  <Download className="w-4 h-4 mr-1" />
                  Download
                </button>
              </div>
            ))
          )}
        </div>
      </div>

    </>
  );
};

export default Customers;
