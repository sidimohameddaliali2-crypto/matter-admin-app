import React, { useState, useEffect, useRef } from 'react';
import api from '../../../../utils/api';
import { ISSUE_TYPES, PRIORITY_CONFIG } from './constants';
import { recordActivityChange } from '../../../../utils/activityCapture';

const inputCls = 'w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:bg-white transition-colors';

function ReportIssueForm({ onSubmitted }) {
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [issueType, setIssueType] = useState('');
  const [priority, setPriority] = useState('medium');
  const [description, setDescription] = useState('');
  const [photoPreview, setPhotoPreview] = useState(null);
  const [photoUrl, setPhotoUrl] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');

  const searchRef = useRef(null);
  const formRef = useRef(null);
  const recordCustomer = next => recordActivityChange({field:'Selected customer',before:selectedCustomer?.customerId||'',after:next?.customerId||'',form:'Report New Issue',element:formRef.current,private:true});

  useEffect(() => {
    if (!customerSearch.trim() || customerSearch.length < 2) { setCustomerResults([]); setSearchOpen(false); return; }
    const timer = setTimeout(async () => {
      try {
        const res = await api.get(`/customers?search=${encodeURIComponent(customerSearch)}&limit=10`);
        const list = res.data?.data || [];
        setCustomerResults(list);
        setSearchOpen(list.length > 0);
      } catch { setCustomerResults([]); }
    }, 300);
    return () => clearTimeout(timer);
  }, [customerSearch]);

  useEffect(() => {
    const handler = (e) => { if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handlePhotoChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setPhotoPreview(URL.createObjectURL(file));
    setUploadingPhoto(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const res = await api.post('/upload/delivery-photo', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      setPhotoUrl(res.data?.url || '');
    } catch {
      setFormError('Photo upload failed. You can still submit without a photo.');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleSubmit = async () => {
    setFormError(''); setFormSuccess('');
    const nameToUse = selectedCustomer
      ? ([selectedCustomer.firstName, selectedCustomer.lastName].filter(Boolean).join(' ') || selectedCustomer.customerId)
      : customerSearch.trim();
    const idToUse = selectedCustomer?.customerId || customerSearch.trim();
    if (!nameToUse) return setFormError('Please enter or select a customer.');
    if (!issueType) return setFormError('Please select an issue type.');
    if (!description.trim()) return setFormError('Please enter a description.');
    if (uploadingPhoto) return setFormError('Please wait for the photo to finish uploading.');
    setSubmitting(true);
    try {
      const res = await api.post('/delivery-issues', { customerId: idToUse, customerName: nameToUse, issueType, description: description.trim(), photoUrl: photoUrl || undefined, priority });
      setFormSuccess('Issue reported successfully.');
      setSelectedCustomer(null); setCustomerSearch(''); setIssueType(''); setPriority('medium');
      setDescription(''); setPhotoPreview(null); setPhotoUrl('');
      onSubmitted?.(res.data?.issue);
    } catch {
      setFormError('Failed to submit issue. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div ref={formRef} role="form" aria-label="Report New Issue" className="bg-gray-50 border border-gray-200 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-gray-800 mb-4 flex items-center gap-2">
        <span className="material-symbols-outlined text-[18px]">add</span>
        Report New Issue
      </h3>

      <div className="mb-4" ref={searchRef}>
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Customer *</label>
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-gray-400">search</span>
          <input
            type="text"
            aria-label="Customer search"
            data-activity-private="true"
            value={selectedCustomer ? ([selectedCustomer.firstName, selectedCustomer.lastName].filter(Boolean).join(' ') || selectedCustomer.customerId) : customerSearch}
            onChange={e => { recordCustomer(null);setSelectedCustomer(null); setCustomerSearch(e.target.value); }}
            placeholder="Type name or search…"
            className={`${inputCls} pl-9 pr-9 ${selectedCustomer ? 'border-blue-300 bg-blue-50' : ''}`}
          />
          {selectedCustomer && (
            <button aria-label="Clear selected customer" onClick={() => { recordCustomer(null);recordActivityChange({field:'Customer search',before:customerSearch,after:'',form:'Report New Issue',element:formRef.current,private:true});setSelectedCustomer(null); setCustomerSearch(''); }} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-100 rounded">
              <span className="material-symbols-outlined text-[16px] text-gray-400">close</span>
            </button>
          )}
          {searchOpen && customerResults.length > 0 && (
            <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-48 overflow-y-auto">
              {customerResults.map(c => (
                <button key={c.customerId} onClick={() => { recordCustomer(c);recordActivityChange({field:'Customer search',before:customerSearch,after:'',form:'Report New Issue',element:formRef.current,private:true});setSelectedCustomer(c); setCustomerSearch(''); setSearchOpen(false); }} className="w-full text-left px-4 py-2 hover:bg-gray-50 border-b border-gray-100 last:border-b-0">
                  <p className="text-sm font-medium">{[c.firstName, c.lastName].filter(Boolean).join(' ') || c.customerId}</p>
                  <p className="text-xs text-gray-400">{c.customerId}</p>
                </button>
              ))}
            </div>
          )}
        </div>
        {selectedCustomer && <p className="text-xs text-blue-500 mt-1">ID: {selectedCustomer.customerId}</p>}
      </div>

      <div className="mb-4">
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Issue Type *</label>
        <select aria-label="Issue type" value={issueType} onChange={e => setIssueType(e.target.value)} className={`${inputCls} text-blue-600 font-medium`}>
          <option value="">Select issue type…</option>
          {ISSUE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      <div className="mb-4">
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Priority *</label>
        <div className="grid grid-cols-3 gap-2">
          {Object.entries(PRIORITY_CONFIG).map(([val, { label }]) => (
            <button
              key={val}
              type="button"
              onClick={event => {recordActivityChange({field:'Priority',before:PRIORITY_CONFIG[priority]?.label||'',after:label,form:'Report New Issue',element:event.currentTarget});setPriority(val);}}
              className={`py-2 rounded-lg text-sm font-semibold border transition-colors ${
                priority === val ? 'border-blue-600 bg-blue-50 text-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4">
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Description *</label>
        <textarea aria-label="Issue description" data-activity-private="true" value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Describe the delivery issue in detail…" className={`${inputCls} resize-none`} />
      </div>

      <div className="mb-5">
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Photo <span className="text-gray-400 normal-case">(optional)</span></label>
        {photoPreview ? (
          <div className="flex items-center gap-3 border border-gray-200 rounded-lg p-3">
            <img src={photoPreview} alt="preview" className="w-16 h-16 object-cover rounded-lg border border-gray-200" />
            <div className="flex flex-col gap-1 flex-1 min-w-0">
              {uploadingPhoto && <span className="text-xs text-blue-600">Uploading…</span>}
              {!uploadingPhoto && photoUrl && <span className="text-xs text-emerald-600">Uploaded</span>}
              <button onClick={event => {recordActivityChange({field:'Selected files',before:photoPreview?1:0,after:0,form:'Report New Issue',element:event.currentTarget});setPhotoPreview(null); setPhotoUrl(''); }} className="text-xs text-red-500 hover:text-red-700 self-start">Remove</button>
            </div>
          </div>
        ) : (
          <label className="flex items-center gap-2 border-2 border-dashed border-gray-200 rounded-lg px-4 py-3 cursor-pointer hover:border-blue-400 hover:bg-blue-50/40 transition-colors">
            <span className="material-symbols-outlined text-gray-400">upload_file</span>
            <span className="text-sm text-gray-500">Click to attach a photo</span>
            <input type="file" aria-label="Selected files" data-activity-label="Selected files" accept="image/*" onChange={handlePhotoChange} className="hidden" />
          </label>
        )}
      </div>

      {formError && (
        <div className="mb-3 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <span className="material-symbols-outlined text-[18px] flex-shrink-0">error</span>{formError}
        </div>
      )}
      {formSuccess && (
        <div className="mb-3 flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          <span className="material-symbols-outlined text-[18px] flex-shrink-0">check_circle</span>{formSuccess}
        </div>
      )}

      <button onClick={handleSubmit} disabled={submitting || uploadingPhoto} className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-semibold transition-colors">
        {submitting && <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>}
        {submitting ? 'Submitting…' : 'Submit Issue'}
      </button>
    </div>
  );
}

export default ReportIssueForm;
