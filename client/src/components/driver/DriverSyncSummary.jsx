import React from 'react';

export default function DriverSyncSummary({ syncStatus = {}, isSyncing, onRetry }) {
  const counts = { pending: 0, syncing: 0, failed: 0 };
  Object.values(syncStatus).forEach(info => { if (info?.status in counts) counts[info.status]++; });
  const total = counts.pending + counts.syncing + counts.failed;
  if (!total) return null;
  return <div role="status" className="bg-amber-50 border border-amber-300 rounded-lg p-3 mb-3">
    <p className="text-sm font-semibold text-amber-900">{total} delivery update{total === 1 ? '' : 's'} awaiting server confirmation</p>
    <p className="text-xs text-amber-800 mt-1">{Object.entries(counts).filter(([,count]) => count).map(([status,count]) => `${count} ${status}`).join(', ')}</p>
    <p className="text-xs text-amber-800 mt-1">Keep this app open online to finish uploading. Saved on this device does not mean uploaded.</p>
    <button type="button" disabled={isSyncing} onClick={onRetry} className="mt-2 text-sm underline font-medium disabled:opacity-50">{isSyncing ? 'Syncing uploads…' : 'Retry pending uploads'}</button>
  </div>;
}
