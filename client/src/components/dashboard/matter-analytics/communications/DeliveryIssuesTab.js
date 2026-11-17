import React, { useState, useEffect, useCallback } from 'react';
import { useSelector } from 'react-redux';
import api from '../../../../utils/api';
import { ISSUE_TYPE_LABELS, PRIORITY_CONFIG, formatDate } from './constants';
import ReportIssueForm from './ReportIssueForm';
import ResolveModal from './ResolveModal';
import { recordActivityChange } from '../../../../utils/activityCapture';

function DeliveryIssuesTab() {
  const { user } = useSelector(state => state.auth);
  const canResolve = user && ['admin', 'super_admin', 'dispatcher', 'manager'].includes(user.role);

  const [issues, setIssues] = useState([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [filter, setFilter] = useState('all');
  const [resolveTarget, setResolveTarget] = useState(null);
  const selectIssue = (issue, element) => {recordActivityChange({field:'Selected delivery issue',before:resolveTarget?._id||'',after:issue?._id||'',form:'Delivery issues',element,private:true});setResolveTarget(issue);};

  const fetchIssues = useCallback(async () => {
    setLoadingIssues(true);
    try {
      const params = filter !== 'all' ? `?status=${filter}` : '';
      const res = await api.get(`/delivery-issues${params}`);
      setIssues(res.data?.issues || []);
    } catch {
      setIssues([]);
    } finally {
      setLoadingIssues(false);
    }
  }, [filter]);

  useEffect(() => { fetchIssues(); }, [fetchIssues]);

  const filteredIssues = issues.filter(i => filter === 'all' || i.status === filter);

  return (
    <div className="p-6">
      {resolveTarget && (
        <ResolveModal issue={resolveTarget} onClose={() => selectIssue(null)} onResolved={() => { setResolveTarget(null); fetchIssues(); }} />
      )}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Delivery Issues</h2>
          <p className="text-sm text-gray-500 mt-1">Report and track delivery issues per customer</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Issue List */}
        <div className="lg:col-span-2">
          <div className="flex gap-1 mb-4 bg-gray-100 rounded-lg p-1">
            {['all', 'open', 'resolved'].map(f => (
              <button key={f} onClick={event => {const label=value=>value[0].toUpperCase()+value.slice(1);recordActivityChange({field:'Delivery issue filter',before:label(filter),after:label(f),form:'Delivery issues',element:event.currentTarget});setFilter(f);}} className={`flex-1 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${filter === f ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                {f === 'all' ? `All (${issues.length})` : f === 'open' ? `Open (${issues.filter(i => i.status === 'open').length})` : `Resolved (${issues.filter(i => i.status === 'resolved').length})`}
              </button>
            ))}
          </div>
          <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
            {loadingIssues ? (
              <div className="text-center py-8 text-gray-400"><span className="material-symbols-outlined animate-spin">progress_activity</span></div>
            ) : filteredIssues.length === 0 ? (
              <div className="text-center py-10 text-gray-400">
                <span className="material-symbols-outlined text-3xl mb-2 opacity-40">description</span>
                <p className="text-sm">No issues found</p>
              </div>
            ) : (
              filteredIssues.map(issue => (
                <div key={issue._id} onClick={event => canResolve && selectIssue(issue,event.currentTarget)} className={`bg-white border border-gray-200 rounded-lg p-3 hover:border-blue-300 ${canResolve ? 'cursor-pointer' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 text-sm truncate">{issue.customerName}</p>
                      <p className="text-xs text-gray-500">{ISSUE_TYPE_LABELS[issue.issueType] || issue.issueType}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${issue.status === 'resolved' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>{issue.status === 'resolved' ? 'Resolved' : 'Open'}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${PRIORITY_CONFIG[issue.priority]?.cls}`}>{PRIORITY_CONFIG[issue.priority]?.label}</span>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 mt-1.5 line-clamp-2">{issue.description}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {formatDate(issue.createdAt)}{issue.reportedByName && ` · ${issue.reportedByName}`}
                  </p>
                  {canResolve && <p className="text-xs text-blue-500 mt-1">Click to {issue.status === 'resolved' ? 're-open' : 'resolve'}</p>}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Create Form */}
        <div className="lg:col-span-3">
          <ReportIssueForm onSubmitted={fetchIssues} />
        </div>
      </div>
    </div>
  );
}

export default DeliveryIssuesTab;
