import React, { useEffect, useRef, useState } from 'react';
import api from '../../utils/api';

export function importProgress(job) {
  if (!job) return { percent: 0, text: '' };
  const p = job.progress || {};
  const fraction = p.total > 0 ? Math.min(1, p.completed / p.total) : 0;
  if (job.status === 'queued') return { percent: 0, text: 'Queued — waiting for the import worker.' };
  if (job.status !== 'running') return { percent: job.status === 'completed' ? 100 : 0, text: job.message || job.status };
  const phases = {
    listing: { base: 0, range: 10, label: 'Loading subscription pages' },
    checking: { base: 10, range: 65, label: 'Checking subscription calendars' },
    importing: { base: 75, range: 20, label: 'Importing eligible deliveries' },
    finalizing: { base: 95, range: 0, label: 'Finalizing import' }
  };
  const phase = phases[p.phase] || phases.listing;
  return { percent: Math.round(phase.base + phase.range * fraction),
    text: `${phase.label}${p.total ? `: ${p.completed} / ${p.total}` : '…'}` };
}

export default function MatterImportControl({ date, formattedDate, onComplete }) {
  const [job, setJob] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const completed = useRef(null);
  const dateRef = useRef(date);
  dateRef.current = date;
  useEffect(() => {
    let cancelled = false;
    let timer;
    let request = 0;
    setJob(null);
    setError('');
    completed.current = null;
    const poll = async () => {
      const current = ++request;
      try {
        const response = await api.get('/matter/import-deliveries/status', { params: { date }, timeout: 15000 });
        if (cancelled || current !== request) return;
        const saved = response.data.data;
        setJob(saved);
        setError('');
        if (saved && ['completed', 'incomplete', 'failed'].includes(saved.status) && completed.current !== saved.id) {
          completed.current = saved.id;
          onComplete();
        }
      } catch {
        if (!cancelled) setError('Progress is temporarily unavailable. The import may still be running; do not start another copy.');
      } finally {
        if (!cancelled) timer = setTimeout(poll, 3000);
      }
    };
    if (date) poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [date, onComplete]);

  const start = async () => {
    if (!window.confirm(`Import deliveries for ${formattedDate} from Matter in the background?`)) return;
    const requestedDate = date;
    setStarting(true);
    setError('');
    try {
      const response = await api.post('/matter/import-deliveries', { date }, { timeout: 15000 });
      if (dateRef.current === requestedDate) setJob(response.data.data);
    } catch (e) {
      if (dateRef.current === requestedDate) setError(e.response?.data?.message || 'Could not confirm the import request. Progress will refresh automatically; it may already be queued.');
    } finally { setStarting(false); }
  };
  const active = job && ['queued', 'running'].includes(job.status);
  const progress = importProgress(job);
  const s = job?.result;
  return <div className="flex flex-col gap-2 max-w-md" aria-live="polite">
    <button onClick={start} disabled={starting || active || !date}
      className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">
      <span className={`material-symbols-outlined text-[18px] ${active || starting ? 'animate-spin' : ''}`}>{active || starting ? 'progress_activity' : 'cloud_download'}</span>
      {starting ? 'Queuing…' : active ? 'Import running…' : job && ['incomplete', 'failed'].includes(job.status) ? 'Retry Matter import' : 'Import from Matter'}
    </button>
    {job && <div className="text-xs text-gray-700 border rounded p-2 bg-gray-50">
      <p className="font-semibold">Matter import · {job.date}</p>
      <p>{progress.text}</p>
      {active && <><progress className="w-full" value={progress.percent} max="100" aria-label="Matter import progress" /><p>You can leave this page. Progress is saved.</p></>}
      {s && <p>{s.created || 0} created · {s.alreadyExisted || 0} already imported · {s.alreadyHadOtherDelivery || 0} already scheduled · {s.failed || 0} failed · {s.noCurrentAddress || 0} without a resolved address · {s.noDeliveryWindow || 0} without a delivery window.</p>}
      {s?.requiresReview && <p className="text-amber-800">Some deliveries need review. An import finishing does not resolve address or schedule conflicts.</p>}
      {s?.errors?.length > 0 && <details><summary>Failure details</summary><ul>{s.errors.slice(0, 10).map((e, i) => <li key={i}>Subscription {e.subscription_id || e.subscriptionId || 'unknown'}: {e.message}</li>)}</ul></details>}
      {job.status === 'completed' && new Date(`${job.date}T12:00:00Z`).getUTCDay() === 0 && <p>Sunday meals may appear on Saturday’s combined dispatch view.</p>}
    </div>}
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
  </div>;
}
