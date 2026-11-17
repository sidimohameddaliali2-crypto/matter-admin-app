import React, { useState } from 'react';
import api from '../../../../utils/api';
import { ISSUE_TYPES } from './constants';
import { recordActivityChange } from '../../../../utils/activityCapture';

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
];

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function QuickReportForm({ onSubmitted, onCancel }) {
  const [customerName, setCustomerName] = useState('');
  const [issueType, setIssueType] = useState(ISSUE_TYPES[0].value);
  const [priority, setPriority] = useState('low');
  const [description, setDescription] = useState('');
  const [photoPreview, setPhotoPreview] = useState(null);
  const [photoUrl, setPhotoUrl] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

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
    setFormError('');
    const name = customerName.trim();
    if (!name) return setFormError('Please enter a customer name.');
    if (!description.trim()) return setFormError('Please enter a description.');
    if (uploadingPhoto) return setFormError('Please wait for the photo to finish uploading.');
    setSubmitting(true);
    try {
      const res = await api.post('/delivery-issues', {
        customerId: name,
        customerName: name,
        issueType,
        description: description.trim(),
        photoUrl: photoUrl || undefined,
        priority,
      });
      onSubmitted?.(res.data?.issue);
    } catch {
      setFormError('Failed to submit communication. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = 'w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:bg-white transition-colors';

  return (
    <div role="form" aria-label="New communication" className="space-y-4">
      <Field label="Customer Name">
        <input
          type="text"
          aria-label="Customer name"
          data-activity-private="true"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
          placeholder="Enter name"
          className={inputCls}
        />
      </Field>

      <Field label="Issue Type">
        <select aria-label="Issue type" value={issueType} onChange={(e) => setIssueType(e.target.value)} className={`${inputCls} text-blue-600 font-medium`}>
          {ISSUE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </Field>

      <Field label="Priority">
        <div className="grid grid-cols-3 gap-2">
          {PRIORITY_OPTIONS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={event => {recordActivityChange({field:'Priority',before:PRIORITY_OPTIONS.find(option=>option.value===priority)?.label||'',after:p.label,form:'New communication',element:event.currentTarget});setPriority(p.value);}}
              className={`py-2 rounded-lg text-sm font-semibold border transition-colors ${
                priority === p.value
                  ? 'border-blue-600 bg-blue-50 text-blue-600'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Description">
        <textarea
          aria-label="Communication description"
          data-activity-private="true"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="Describe the issue…"
          className={`${inputCls} resize-none`}
        />
      </Field>

      <Field label="Attachments">
        {photoPreview ? (
          <div className="flex items-center gap-3 border border-gray-200 rounded-lg p-3">
            <img src={photoPreview} alt="preview" className="w-12 h-12 object-cover rounded-lg border border-gray-200" />
            <div className="flex flex-col gap-1 flex-1 min-w-0">
              {uploadingPhoto && <span className="text-xs text-blue-600">Uploading…</span>}
              {!uploadingPhoto && photoUrl && <span className="text-xs text-emerald-600">Uploaded</span>}
              <button
                type="button"
                onClick={event => {recordActivityChange({field:'Selected files',before:photoPreview?1:0,after:0,form:'New communication',element:event.currentTarget});setPhotoPreview(null); setPhotoUrl(''); }}
                className="text-xs text-red-500 hover:text-red-700 self-start"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <label className="flex flex-col items-center justify-center gap-1.5 border-2 border-dashed border-gray-200 rounded-lg py-6 cursor-pointer hover:border-blue-400 hover:bg-blue-50/40 transition-colors">
            <span className="material-symbols-outlined text-gray-400">upload_file</span>
            <span className="text-sm text-gray-500">Click to upload images</span>
            <input type="file" aria-label="Selected files" data-activity-label="Selected files" accept="image/*" onChange={handlePhotoChange} className="hidden" />
          </label>
        )}
      </Field>

      {formError && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{formError}</div>
      )}

      <div className="flex gap-3 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 py-2.5 bg-gray-100 text-gray-700 rounded-lg text-sm font-semibold hover:bg-gray-200 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || uploadingPhoto}
          className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Sending…' : 'Send Communication'}
        </button>
      </div>
    </div>
  );
}

export default QuickReportForm;
