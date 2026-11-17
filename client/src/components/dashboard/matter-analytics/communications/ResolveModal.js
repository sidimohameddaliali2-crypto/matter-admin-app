import React, { useState } from 'react';
import api from '../../../../utils/api';
import { ISSUE_TYPE_LABELS, PRIORITY_CONFIG } from './constants';

function ResolveModal({ issue, onClose, onResolved }) {
  const [resolveNotes, setResolveNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const reopening = issue.status === 'resolved';

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await api.patch(`/delivery-issues/${issue._id}`, {
        status: reopening ? 'open' : 'resolved',
        resolvedNotes: resolveNotes.trim() || undefined,
      });
      onResolved();
    } catch {
      // keep modal open on error
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[200] p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-bold text-gray-900">{reopening ? 'Re-open Issue' : 'Resolve Issue'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
            <div><span className="font-medium text-gray-500 text-xs">Customer: </span><span className="font-semibold">{issue.customerName}</span></div>
            <div><span className="font-medium text-gray-500 text-xs">Type: </span><span>{ISSUE_TYPE_LABELS[issue.issueType] || issue.issueType}</span></div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-gray-500 text-xs">Priority: </span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${PRIORITY_CONFIG[issue.priority]?.cls}`}>{PRIORITY_CONFIG[issue.priority]?.label}</span>
            </div>
            <div><span className="font-medium text-gray-500 text-xs">Description: </span><p className="mt-1 text-gray-700">{issue.description}</p></div>
            {issue.photoUrl && <a href={issue.photoUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">View photo →</a>}
          </div>
          {!reopening && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Resolution notes <span className="text-gray-400">(optional)</span></label>
              <textarea aria-label="Resolution notes" data-activity-private="true" value={resolveNotes} onChange={e => setResolveNotes(e.target.value)} rows={3} placeholder="Describe how the issue was resolved…" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
          <button onClick={handleSubmit} disabled={submitting} className={`px-4 py-2 text-sm font-semibold text-white rounded-lg flex items-center gap-2 disabled:opacity-50 transition-colors ${reopening ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
            {submitting && <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>}
            {reopening ? 'Re-open Issue' : 'Mark Resolved'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ResolveModal;
