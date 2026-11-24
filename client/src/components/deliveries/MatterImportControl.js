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

export const canImportMatter = role => ['admin', 'super_admin', 'dispatcher', 'manager'].includes(role);
const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 60000;
const isActiveImport = status => ['queued', 'running'].includes(status);

export default function MatterImportControl(props) {
  // Unmount the polling effect if the staff role is absent or revoked.
  return canImportMatter(props.role) ? <AuthorizedMatterImportControl {...props} /> : null;
}

function AuthorizedMatterImportControl({ date, formattedDate, onComplete }) {
  const [job, setJob] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const completed = useRef(null);
  const dateRef = useRef(date);
  const wakePolling = useRef(null);
  dateRef.current = date;
  useEffect(() => {
    let cancelled = false;
    let timer;
    let request = 0;
    let denied = false;
    let lastStatus;
    let inFlight = false;
    setJob(null);
    setError('');
    completed.current = null;
    const schedule = () => {
      clearTimeout(timer);
      if (!cancelled && !denied) timer = setTimeout(poll, isActiveImport(lastStatus) ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    const poll = async () => {
      const current = ++request;
      inFlight = true;
      try {
        const response = await api.get('/matter/import-deliveries/status', { params: { date }, timeout: 15000 });
        if (cancelled || current !== request) return;
        const saved = response.data.data;
        lastStatus = saved?.status;
        setJob(saved);
        setError('');
        if (saved && ['completed', 'incomplete', 'failed'].includes(saved.status) && completed.current !== saved.id) {
          completed.current = saved.id;
          onComplete(saved);
        }
      } catch (e) {
        if (cancelled || current !== request) return;
        denied = [401, 403].includes(e.response?.status);
        if (!cancelled) setError(denied ? 'You do not have permission to view Matter import progress.' : 'Progress is temporarily unavailable. The import may still be running; do not start another copy.');
      } finally {
        inFlight = false;
        schedule();
      }
    };
    wakePolling.current = saved => {
      // A new local submission must not wait for the old idle timer. Ignore
      // an earlier status read that could overwrite the accepted queued job.
      request++;
      lastStatus = saved?.status || 'queued';
      denied = false;
      clearTimeout(timer);
      if (!inFlight) schedule();
    };
    if (date) poll();
    return () => { cancelled = true; clearTimeout(timer); wakePolling.current = null; };
  }, [date, onComplete]);

  const start = async () => {
    if (!window.confirm(`Import deliveries for ${formattedDate} from Matter in the background?`)) return;
    const requestedDate = date;
    setStarting(true);
    setError('');
    try {
      const response = await api.post('/matter/import-deliveries', { date }, { timeout: 15000 });
      if (dateRef.current === requestedDate) {
        setJob(response.data.data);
        wakePolling.current?.(response.data.data);
      }
    } catch (e) {
      if (dateRef.current === requestedDate) {
        setError(e.response?.data?.message || 'Could not confirm the import request. Progress will refresh automatically; it may already be queued.');
        if (![401, 403].includes(e.response?.status)) wakePolling.current?.();
      }
    } finally { setStarting(false); }
  };
  const active = job && ['queued', 'running'].includes(job.status);
  const progress = importProgress(job);
  const s = job?.result;
  const interrupted = job?.status === 'failed' && job.progress;
  const savedProgress = interrupted ? importProgress({ ...job, status: 'running' }) : null;
  const savedCounts = interrupted ? [
    ['created', 'created'], ['alreadyExisted', 'already imported'], ['alreadyHadOtherDelivery', 'already scheduled'],
    ['failed', 'failed'], ['noCurrentAddress', 'without a resolved address'], ['noDeliveryWindow', 'without a delivery window'],
    ['customersCreated', 'customer records created'], ['writeFailed', 'delivery write failures'], ['discoveryFailed', 'discovery failures']
  ].filter(([key]) => Number.isFinite(job.progress[key])).map(([key, label]) => `${job.progress[key]} ${label}`) : [];
  return <div className="flex flex-col gap-2 max-w-md" aria-live="polite">
    <button onClick={start} disabled={starting || active || !date}
      className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">
      <span className={`material-symbols-outlined text-[18px] ${active || starting ? 'animate-spin' : ''}`}>{active || starting ? 'progress_activity' : 'cloud_download'}</span>
      {starting ? 'Queuing…' : active ? 'Import running…' : job && ['incomplete', 'failed'].includes(job.status) ? 'Retry Matter import' : 'Import from Matter'}
    </button>
    {job && <div className="text-xs text-gray-700 border rounded p-2 bg-gray-50">
      <p className="font-semibold">Matter import · {job.date}</p>
      <p>{progress.text}</p>
      {interrupted && <div className="mt-1 text-amber-900">
        <p>Last saved progress: {savedProgress.text}</p>
        {savedCounts.length > 0 && <p>Last saved counts: {savedCounts.join(' · ')}.</p>}
        <p>A write just before interruption may not be included in these counts. Retrying checks stored deliveries.</p>
      </div>}
      {active && <><progress className="w-full" value={progress.percent} max="100" aria-label="Matter import progress" /><p>You can leave this page. Progress is saved.</p></>}
      {s && <p>{s.created || 0} created · {s.alreadyExisted || 0} already imported · {s.alreadyHadOtherDelivery || 0} already scheduled · {s.failed || 0} failed · {s.noCurrentAddress || 0} without a resolved address · {s.noDeliveryWindow || 0} without a delivery window.</p>}
      {s?.requiresReview && <p className="text-amber-800">Some deliveries need review. An import finishing does not resolve address or schedule conflicts.</p>}
      {s?.errors?.length > 0 && <details><summary>Failure details</summary><ul>{s.errors.slice(0, 10).map((e, i) => <li key={i}>Subscription {e.subscription_id || e.subscriptionId || 'unknown'}: {e.message}</li>)}</ul></details>}
      {job.status === 'completed' && new Date(`${job.date}T12:00:00Z`).getUTCDay() === 0 && <p>Sunday meals may appear on Saturday’s combined dispatch view.</p>}
    </div>}
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
  </div>;
}
