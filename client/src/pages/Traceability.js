import React, { useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, RefreshCw, Search } from 'lucide-react';
import api from '../utils/api';
import { readCaptureStatus } from '../utils/activityCapture';
import './Traceability.css';

const readable = (value = '') =>
  String(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
const person = (event) => event.actor?.name || 'Person not recorded';
const isDraft = (event) => event.stage === 'form_edited' || event.outcome === 'draft';
const outcome = (event) => {
  if (isDraft(event)) return 'Form edit · not saved';
  if (event.stage === 'form_submitted' || event.outcome === 'submitted')
    return 'Submitted · awaiting result';
  if (event.outcome === 'saved' && event.stage !== 'record_saved') return 'Result not confirmed';
  const labels = {
    saved: 'Saved',
    accepted: 'Action accepted',
    failed: 'Did not complete',
    rejected: 'Not accepted',
    uncertain: 'Result not confirmed',
    pending: 'In progress',
  };
  return labels[event.outcome] || 'Result not recorded';
};
const outcomeTone = (event) => {
  if (event.issue || ['failed', 'rejected'].includes(event.outcome)) return 'issue';
  if (event.stage === 'record_saved' && event.outcome === 'saved') return 'saved';
  return 'pending';
};
const summary = (event) =>
  event.summary || `${person(event)} ${event.action || 'performed an action'}`;
const dateParts = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return { date: 'Time not recorded', time: '' };
  return {
    date: date.toLocaleDateString('en-GB', {
      timeZone: 'Asia/Dubai',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }),
    time: date.toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Dubai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
  };
};
const displayValue = (value) => {
  if (value === null || value === '') return 'Empty';
  if (value === undefined) return 'Not recorded';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.map(displayValue).join(', ') : 'Empty';
  if (typeof value === 'object')
    return (
      Object.entries(value)
        .map(([key, item]) => `${readable(key)}: ${displayValue(item)}`)
        .join('; ') || 'Empty'
    );
  return String(value);
};
const formName = (event) =>
  event.form?.title ||
  (event.form?.page && !event.form.page.startsWith('/') ? readable(event.form.page) : null);
const eventKey = (event, index) => event.eventId || `${event.occurredAt}-${index}`;

function ActivityDetail({ event, id }) {
  const when = dateParts(event.occurredAt);
  const draft = isDraft(event);
  const changes = event.changes || [];
  return (
    <section id={id} className="trace-detail" aria-label="Activity details">
      <h2>Activity details</h2>
      <dl className="trace-facts">
        <div>
          <dt>Who</dt>
          <dd>
            {person(event)}
            {event.actor?.role && <span> · {readable(event.actor.role)}</span>}
          </dd>
        </div>
        {event.actor?.id && (
          <div>
            <dt>Account</dt>
            <dd>{event.actor.id}</dd>
          </div>
        )}
        <div>
          <dt>When</dt>
          <dd>
            {when.date}
            {when.time && ` at ${when.time} · Dubai`}
          </dd>
        </div>
        <div>
          <dt>Where</dt>
          <dd>{formName(event) || event.area || 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Outcome</dt>
          <dd>{outcome(event)}</dd>
        </div>
      </dl>
      {event.confirmation && <p className="trace-confirmation">{event.confirmation}</p>}
      {event.issue && (
        <div className="trace-detail-issue">
          <h3>What needs attention</h3>
          <p>{event.issue}</p>
        </div>
      )}
      <div className="trace-changes">
        <h3>{draft ? 'What was edited' : 'What changed'}</h3>
        {draft && (
          <p className="trace-change-note">
            This records an edit to a form. It does not confirm that the change was saved.
          </p>
        )}
        {!draft && event.stage !== 'record_saved' && (
          <p className="trace-change-note">
            Only an activity marked “Saved” confirms a saved change. Values below describe this
            action.
          </p>
        )}
        {event.previousValuesObserved && (
          <p className="trace-change-note">
            Earlier values were observed before saving; simultaneous edits can affect them.
          </p>
        )}
        {changes.length ? (
          <div className="trace-change-list">
            {changes.map((change, index) => (
              <div className="trace-change" key={`${change.field}-${index}`}>
                <h4>{readable(change.field || event.form?.field || 'Field')}</h4>
                <dl>
                  <div>
                    <dt>Before</dt>
                    <dd>{change.redacted ? 'Hidden for privacy' : displayValue(change.before)}</dd>
                  </div>
                  <div>
                    <dt>After</dt>
                    <dd>{change.redacted ? 'Hidden for privacy' : displayValue(change.after)}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        ) : (
          <p className="trace-change-note">
            Before and after values were not recorded for this action.
          </p>
        )}
      </div>
    </section>
  );
}

function Coverage({ activity }) {
  const coverage = activity.coverage || {};
  return (
    <details className="trace-coverage">
      <summary>What is tracked</summary>
      <div>
        <p>
          {coverage.formCapture
            ? 'Form edits and submissions are recorded separately from saved changes.'
            : 'Form edits are not included in this history.'}
        </p>
        <p>
          {coverage.serverChanges
            ? 'Saved changes and action results recorded by the app are included.'
            : 'Saved changes are not included in this history.'}
        </p>
        <p>
          {activity.preview
            ? 'This preview shows fictional examples supplied by the app.'
            : activity.storage?.durable
              ? 'Recorded history is saved and remains available after the app restarts.'
              : 'History storage is not available right now.'}
        </p>
        {coverage.limitations?.length > 0 && (
          <ul>
            {coverage.limitations.map((limitation, index) => (
              <li key={index}>{limitation}</li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function CaptureNotice({ status }) {
  const pending = Number(status?.pendingEvents) || 0;
  const dropped = Number(status?.droppedEvents) || 0;
  if (!pending && !dropped && !status?.queueIssue) return null;
  return (
    <div
      className={`trace-notice trace-capture-notice${dropped || status?.queueIssue || status?.failedBatches ? '' : ' trace-recording'}`}
      role={dropped || status?.queueIssue ? 'alert' : 'status'}
    >
      <AlertCircle size={18} aria-hidden="true" />
      <div>
        {dropped > 0 && (
          <p>
            <strong>
              {dropped} form {dropped === 1 ? 'activity could' : 'activities could'} not be
              recorded.
            </strong>{' '}
            These activities are missing from history.
          </p>
        )}
        {pending > 0 && (
          <p>
            {pending} form {pending === 1 ? 'activity is' : 'activities are'} waiting to be
            recorded.
          </p>
        )}
        {status?.queueIssue && (
          <p>
            This browser cannot reliably keep form activity while it waits to be recorded. Some
            history may be missing.
          </p>
        )}
        {pending > 0 && !status?.durableQueueSupported && (
          <p>Keep this page open until recording finishes.</p>
        )}
      </div>
    </div>
  );
}

export default function Traceability() {
  const [activity, setActivity] = useState(null);
  const [query, setQuery] = useState('');
  const [request, setRequest] = useState({ q: '', issues: false, before: null, revision: 0 });
  const [loadedCriteria, setLoadedCriteria] = useState(null);
  const [captureStatus, setCaptureStatus] = useState(readCaptureStatus);
  const [selection, setSelection] = useState(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const criteria = JSON.stringify([request.q, request.issues]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const q = query.trim();
      setRequest((previous) => (previous.q === q ? previous : { ...previous, q, before: null }));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const update = () => setCaptureStatus(readCaptureStatus());
    window.addEventListener('matter:activity-capture-status', update);
    update();
    return () => window.removeEventListener('matter:activity-capture-status', update);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    const params = {
      limit: 100,
      ...(request.q ? { q: request.q } : {}),
      ...(request.issues ? { issues: '1' } : {}),
      ...(request.before ? { before: request.before } : {}),
    };
    api
      .get('/traceability/activity', { signal: controller.signal, params })
      .then((response) => {
        if (controller.signal.aborted) return;
        const data = response.data?.data;
        if (response.data?.success === false || !Array.isArray(data?.events))
          throw new Error('Activity is unavailable');
        setActivity((previous) => {
          if (!request.before || !previous) return data;
          const known = new Set(previous.events.map((event) => event.eventId));
          const added = data.events.filter((event) => {
            if (event.eventId && known.has(event.eventId)) return false;
            known.add(event.eventId);
            return true;
          });
          return { ...data, events: [...previous.events, ...added] };
        });
        setLoadedCriteria(JSON.stringify([request.q, request.issues]));
        if (!request.before)
          setSelection((current) =>
            data.events.some((event, index) => eventKey(event, index) === current) ? current : null,
          );
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(request.before ? 'older' : 'latest');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [request]);
  const rows = activity?.events || [];
  const filter = request.issues ? 'issues' : 'all';
  const pendingSearch = query.trim() !== request.q;
  const matchingResults = loadedCriteria === criteria;
  const captureFailures = Number(activity?.coverage?.captureFailures) || 0;
  const unavailable = activity?.storage?.kind === 'unavailable';
  const historyIncomplete = unavailable || Boolean(activity?.storage?.issue) || captureFailures > 0;
  const refresh = () =>
    setRequest((previous) => ({
      ...previous,
      q: query.trim(),
      before: null,
      revision: previous.revision + 1,
    }));
  const retry = () => setRequest((previous) => ({ ...previous, revision: previous.revision + 1 }));
  const changeFilter = (issues) =>
    setRequest((previous) => ({ ...previous, q: query.trim(), issues, before: null }));
  const loadOlder = () =>
    setRequest((previous) => ({
      ...previous,
      before: activity.nextCursor,
      revision: previous.revision + 1,
    }));
  return (
    <div className="traceability">
      <header className="trace-header">
        <div>
          <h1>Activity history</h1>
          <p>See who did what, what changed, and anything that needs attention.</p>
        </div>
        <button className="trace-refresh" onClick={refresh} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'trace-refreshing' : ''} aria-hidden="true" />
          {loading ? (activity ? 'Refreshing…' : 'Loading…') : 'Refresh'}
        </button>
      </header>
      {activity?.preview && (
        <p className="trace-notice trace-preview">
          <strong>Preview</strong> · These activities use fictional people and records.
        </p>
      )}
      {unavailable && (
        <p className="trace-notice trace-unavailable" role="status">
          <AlertCircle size={18} aria-hidden="true" />
          <span>
            <strong>History storage is unavailable.</strong> Activity may be missing. Try refreshing
            shortly.
          </span>
        </p>
      )}
      {activity?.storage?.issue && (
        <p className="trace-notice trace-capture-notice" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{activity.storage.issue}</span>
        </p>
      )}
      {captureFailures > 0 && (
        <p className="trace-notice trace-capture-notice" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span>
            <strong>
              {captureFailures} {captureFailures === 1 ? 'activity could' : 'activities could'} not
              be recorded.
            </strong>{' '}
            History is incomplete. This count covers the current running app.
          </span>
        </p>
      )}
      <CaptureNotice status={captureStatus} />
      {error && (
        <div className="trace-notice trace-error" role="alert">
          <p>
            {error === 'older'
              ? 'Older activity could not be loaded. The activities already shown are unchanged.'
              : activity
                ? 'The latest matching activity could not be loaded. The previous results are still shown.'
                : 'Activity history could not be loaded. Please try again.'}
          </p>
          <button onClick={retry} disabled={loading}>
            Try again
          </button>
        </div>
      )}
      {!activity && loading && (
        <p className="trace-empty" role="status">
          Loading activity…
        </p>
      )}
      {activity && (
        <>
          <div className="trace-tools">
            <nav aria-label="Filter activity" className="trace-filters">
              <button aria-pressed={filter === 'all'} onClick={() => changeFilter(false)}>
                All activity
              </button>
              <button aria-pressed={filter === 'issues'} onClick={() => changeFilter(true)}>
                Issues
              </button>
            </nav>
            <label className="trace-search">
              <Search size={17} aria-hidden="true" />
              <span className="trace-sr-only">Search people or actions</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search a person, action or issue"
              />
            </label>
          </div>
          <div className="trace-list-context">
            <p role="status">
              {pendingSearch || (loading && !request.before)
                ? 'Searching recorded history…'
                : !matchingResults
                  ? 'Previous results shown'
                  : `${rows.length} ${filter === 'issues' ? (rows.length === 1 ? 'issue' : 'issues') : rows.length === 1 ? 'activity' : 'activities'} shown`}
            </p>
            <span>Times shown in Dubai</span>
          </div>
          <section
            className="trace-history"
            aria-label="Activity history"
            aria-busy={loading || pendingSearch}
          >
            {!!rows.length && (
              <div className="trace-columns" aria-hidden="true">
                <span>Activity</span>
                <span>When · Dubai</span>
                <span>Outcome</span>
                <span />
              </div>
            )}
            <ol className="trace-events">
              {rows.map((event, index) => {
                const key = eventKey(event, index);
                const expanded = selection === key;
                const when = dateParts(event.occurredAt);
                const detailId = `activity-detail-${index}`;
                return (
                  <li key={key} className={`trace-event${event.issue ? ' trace-event-issue' : ''}`}>
                    <button
                      className="trace-event-button"
                      onClick={() => setSelection(expanded ? null : key)}
                      aria-expanded={expanded}
                      aria-controls={detailId}
                    >
                      <span className="trace-event-main">
                        <strong>{summary(event)}</strong>
                        <span className="trace-event-meta">
                          {[event.area, event.actor?.role && readable(event.actor.role)]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                        {event.issue && (
                          <span className="trace-issue">
                            <AlertCircle size={14} aria-hidden="true" />
                            <span>{event.issue}</span>
                          </span>
                        )}
                      </span>
                      <span className="trace-when">
                        <time dateTime={event.occurredAt || undefined}>
                          {when.time && <strong>{when.time}</strong>}
                          <span>{when.date}</span>
                        </time>
                      </span>
                      <span className={`trace-outcome trace-outcome-${outcomeTone(event)}`}>
                        <span className="trace-outcome-dot" aria-hidden="true" />
                        {outcome(event)}
                      </span>
                      <ChevronDown size={17} className="trace-expand" aria-hidden="true" />
                    </button>
                    {expanded && <ActivityDetail event={event} id={detailId} />}
                  </li>
                );
              })}
            </ol>
            {!rows.length && !loading && !pendingSearch && (
              <div className="trace-empty">
                <h2>
                  {unavailable
                    ? 'History cannot be shown right now'
                    : !matchingResults
                      ? 'Matching history could not be loaded'
                      : historyIncomplete
                        ? 'No activity is available in this history'
                        : request.q
                          ? 'No matching activity'
                          : filter === 'issues'
                            ? 'No recorded issues found'
                            : 'No activity has been recorded yet'}
                </h2>
                <p>
                  {unavailable
                    ? 'Refresh when history storage is available again.'
                    : !matchingResults
                      ? 'Try loading this history again.'
                      : historyIncomplete
                        ? 'Recording problems may have left gaps. See the notice above.'
                        : query
                          ? 'Try another person, action or issue.'
                          : filter === 'issues'
                            ? 'Switch to all activity to see recorded actions.'
                            : 'Activity will appear here as people use the app.'}
                </p>
                {query && (
                  <button className="trace-text-button" onClick={() => setQuery('')}>
                    Clear search
                  </button>
                )}
              </div>
            )}
          </section>
          <div className="trace-pagination">
            <p>
              Search covers the full recorded history.
              {!activity.nextCursor && matchingResults && !historyIncomplete && rows.length > 0
                ? ' All matching activity is shown.'
                : ''}
            </p>
            {activity.nextCursor && (
              <button
                className="trace-refresh"
                onClick={loadOlder}
                disabled={loading || pendingSearch || !matchingResults}
              >
                {loading && request.before ? 'Loading older…' : 'Load older activity'}
              </button>
            )}
          </div>
          <Coverage activity={activity} />
        </>
      )}
    </div>
  );
}
