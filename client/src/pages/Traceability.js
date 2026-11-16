import React, { useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, ArrowUpRight } from 'lucide-react';
import api from '../utils/api';
import './Traceability.css';

const time = (value) =>
  new Date(value).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dubai', hour12: false });
const duration = (value) => `${Math.round(value || 0).toLocaleString()} ms`;
const sourceUrl = (source) => {
  const [file, line] = source.split(':');
  return `https://github.com/sidimohameddaliali2-crypto/matter-admin-app/blob/codex/app-traceability-20261117/${file}${line ? `#L${line}` : ''}`;
};
const Method = ({ value }) => (
  <span className={`trace-method trace-method-${value.toLowerCase()}`}>{value}</span>
);

function RouteDetail({ route, catalog }) {
  if (!route) return <p className="trace-empty">No routes match these filters.</p>;
  const area = catalog.areas?.find((item) =>
    item.paths.split(', ').some((prefix) => route.path.startsWith(prefix.replace(/\/\*$/, ''))),
  );
  return (
    <section className="trace-detail" aria-label="Route details">
      <div className="trace-detail-heading">
        <Method value={route.method} />
        <h2>{route.path}</h2>
      </div>
      <p className="trace-description">
        {route.description ||
          area?.meaning ||
          'Read the linked handler to establish this route’s behavior and side effects.'}
      </p>
      <dl className="trace-facts">
        <dt>Access declarations</dt>
        <dd>
          {[...(route.middlewareDeclarations || []), ...(route.handlerGuards || [])].join(' → ') ||
            'Inspect the handler and its parent mount for access checks.'}
        </dd>
        <dt>Inputs referenced</dt>
        <dd>{route.requestKeys?.join(', ') || 'Defined in the handler or delegated service.'}</dd>
        <dt>Response fields</dt>
        <dd>{route.responseKeys?.join(', ') || 'Defined in the handler or delegated service.'}</dd>
        <dt>Models and services</dt>
        <dd>
          {route.referencedCalls?.join(', ') ||
            'Inspect the linked implementation for indirect calls.'}
        </dd>
        <dt>Inline HTTP statuses</dt>
        <dd>{route.declaredStatuses?.join(', ') || 'Default response or delegated handler.'}</dd>
      </dl>
      <div className="trace-interpretation">
        <h3>How to read this</h3>
        <p>
          These are code declarations. A response can finish while a provider action is still
          pending. Check warnings, completeness and the owning record before treating it as an
          operational result.
        </p>
      </div>
      <a className="trace-source" href={sourceUrl(route.source)} target="_blank" rel="noreferrer">
        {route.source}
        <ArrowUpRight size={15} aria-hidden="true" />
      </a>
    </section>
  );
}

export default function Traceability() {
  const [catalog, setCatalog] = useState(null);
  const [activity, setActivity] = useState(null);
  const [view, setView] = useState('routes');
  const [query, setQuery] = useState('');
  const [method, setMethod] = useState('ALL');
  const [kind, setKind] = useState('api');
  const [selection, setSelection] = useState(null);
  const [selectedTrace, setSelectedTrace] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    Promise.all([
      api.get('/traceability/catalog', { signal: controller.signal }),
      api.get('/traceability/events', { signal: controller.signal }),
    ])
      .then(([map, events]) => {
        setCatalog(map.data.data);
        setActivity(events.data.data);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError('Traceability could not be loaded. Refresh to try again.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);
  const routeRows = useMemo(() => {
    const rows =
      kind === 'browser'
        ? (catalog?.browser || []).map((row) => ({
            ...row,
            id: row.path,
            method: 'PAGE',
            handlerGuards: row.guardAttributes,
            description: row.elements.join(' → '),
          }))
        : catalog?.api || [];
    return rows.filter(
      (row) =>
        (method === 'ALL' || row.method === method) &&
        `${row.method} ${row.path} ${row.source}`.toLowerCase().includes(query.toLowerCase()),
    );
  }, [catalog, kind, method, query]);
  const route = routeRows.find((row) => row.id === selection) || routeRows[0];
  const events = activity?.events || [];
  const eventRows = events.filter(
    (row) =>
      ['http.completed', 'job.completed'].includes(row.event) &&
      row.route !== '/*' &&
      JSON.stringify([row.request_id, row.trace_id, row.run_id, row.route, row.job, row.outcome])
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const trace = events
    .filter((row) => row.trace_id === selectedTrace)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const changeView = (value) => {
    setView(value);
    setQuery('');
  };
  return (
    <div className="traceability">
      <header className="trace-header">
        <div>
          <h1>Traceability</h1>
          <p>Follow a request. Understand the route behind it.</p>
        </div>
        <button
          className="trace-refresh"
          onClick={() => setRevision((value) => value + 1)}
          disabled={loading}
        >
          <RefreshCw size={16} aria-hidden="true" />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </header>
      {activity?.preview && (
        <p className="trace-preview" role="status">
          Local preview · the route map is from the app’s source. Recent activity comes from
          synthetic local test requests.
        </p>
      )}
      {error && (
        <p className="trace-error" role="alert">
          {error}
        </p>
      )}
      {!catalog && loading && (
        <p className="trace-empty" role="status">
          Loading the route map and recent activity…
        </p>
      )}
      {catalog && (
        <>
          <div className="trace-navigation">
            <nav aria-label="Traceability views">
              <button aria-pressed={view === 'routes'} onClick={() => changeView('routes')}>
                Routes
              </button>
              <button aria-pressed={view === 'activity'} onClick={() => changeView('activity')}>
                Recent activity
              </button>
            </nav>
            <p>
              {catalog.api.length} API declarations <span>·</span> {catalog.browser.length} pages
            </p>
          </div>
          <div className="trace-toolbar">
            <label className="trace-search">
              <Search size={17} aria-hidden="true" />
              <span className="sr-only">
                {view === 'routes' ? 'Find a route' : 'Find a request or trace'}
              </span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={
                  view === 'routes'
                    ? 'Find a route, method or source file'
                    : 'Paste a request ID, or search an outcome'
                }
              />
            </label>
            {view === 'routes' && (
              <>
                <label>
                  <span className="sr-only">Route type</span>
                  <select
                    value={kind}
                    onChange={(event) => {
                      setKind(event.target.value);
                      setMethod('ALL');
                      setSelection(null);
                    }}
                  >
                    <option value="api">API routes</option>
                    <option value="browser">Browser pages</option>
                  </select>
                </label>
                <label>
                  <span className="sr-only">HTTP method</span>
                  <select value={method} onChange={(event) => setMethod(event.target.value)}>
                    {(kind === 'api'
                      ? ['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
                      : ['ALL', 'PAGE']
                    ).map((value) => (
                      <option key={value} value={value}>
                        {value === 'ALL' ? 'All methods' : value}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>
          {view === 'routes' ? (
            <>
              <div className="trace-workspace">
                <section className="trace-route-list" aria-label="Route map">
                  <div className="trace-list-heading">
                    {routeRows.length} matching {kind === 'api' ? 'declarations' : 'pages'}
                  </div>
                  <div className="trace-route-scroll">
                    {routeRows.map((row, index) => (
                      <button
                        key={`${row.id}-${index}`}
                        className="trace-route-row"
                        aria-pressed={route?.id === row.id}
                        onClick={() => setSelection(row.id)}
                      >
                        <Method value={row.method} />
                        <span>{row.path}</span>
                      </button>
                    ))}
                    {!routeRows.length && (
                      <p className="trace-empty">No matching routes. Try a different search.</p>
                    )}
                  </div>
                </section>
                <RouteDetail route={route} catalog={catalog} />
              </div>
              <details className="trace-boundaries">
                <summary>Special handlers and coverage boundaries</summary>
                <p>
                  Raw reporting handlers and OAuth SDKs dispatch some paths outside the regular
                  route declarations.
                </p>
                {catalog.boundaries.map((row) => (
                  <div key={row.path}>
                    <code>{row.path}</code>
                    <p>{row.meaning}</p>
                  </div>
                ))}
              </details>
            </>
          ) : (
            <section className="trace-activity">
              <div className="trace-activity-heading">
                <h2>Recent requests and jobs</h2>
                <p>
                  {activity?.enabled
                    ? `This process · up to ${activity.retentionMinutes} minutes · ${activity.maxEvents.toLocaleString()} event limit`
                    : 'Structured telemetry is disabled on this process.'}
                </p>
              </div>
              <p className="trace-scope">
                Events are held in server memory and clear on restart. Other server processes have
                separate windows. Central storage and cross-process search still need configuration.
              </p>
              {trace.length > 0 && (
                <section className="trace-chain">
                  <h3>Trace detail</h3>
                  <p>
                    <code>{selectedTrace}</code>
                  </p>
                  <ol>
                    {trace.map((row, index) => (
                      <li key={`${row.span_id}-${row.event}-${index}`}>
                        <div>
                          <strong>{row.dependency || row.route || row.job}</strong>
                          <span>
                            {row.event} · {row.outcome || 'started'} · {duration(row.duration_ms)}
                          </span>
                        </div>
                        <code>{row.request_id || row.run_id}</code>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              <div
                className="trace-table-scroll"
                role="region"
                aria-label="Recent requests and jobs"
                tabIndex={0}
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Time · Dubai</th>
                      <th scope="col">Request or job</th>
                      <th scope="col">Outcome</th>
                      <th scope="col">Duration</th>
                      <th scope="col">Reference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {eventRows.slice(0, 200).map((row, index) => (
                      <tr key={`${row.span_id}-${index}`}>
                        <td>{time(row.timestamp)}</td>
                        <th scope="row">
                          <button
                            className="trace-event-link"
                            onClick={() => setSelectedTrace(row.trace_id)}
                          >
                            {row.route || row.job}
                          </button>
                        </th>
                        <td>
                          <span className={`trace-outcome trace-${row.outcome}`}>
                            {row.outcome}
                          </span>
                        </td>
                        <td>{duration(row.duration_ms)}</td>
                        <td>
                          <code>{(row.request_id || row.run_id || '').slice(0, 8)}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!eventRows.length && (
                <p className="trace-empty">
                  No matching activity in this process window. Try refreshing or search the process
                  logs using your request reference.
                </p>
              )}

              <p className="trace-process">
                Process {activity?.instanceId} · started{' '}
                {activity?.startedAt ? time(activity.startedAt) : 'unknown'} Dubai time
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
