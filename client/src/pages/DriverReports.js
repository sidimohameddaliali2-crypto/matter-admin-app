import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { canOpenDriverAudits, DRIVER_AUDIT_CLIENT } from '../utils/driverAuditWorker.mjs';

const OPEN_TIMEOUT_MS = 25000;
const REPORT_PATH = '/api/reporting/view';
const viewParameters = new Set(['reportFrom', 'reportTo', 'reportDates', 'reportDrill', 'photoReview']);
const reloadMessage = 'Reload Matter to open Driver Reports.';
const failureMessage = 'Driver Reports could not load. Try again.';
const changedAccountMessage = 'Your Matter sign-in changed. Reload Matter to open Driver Reports.';

function reportFrameUrl(value, viewKey) {
  if (typeof value !== 'string' || !value.startsWith(REPORT_PATH + '?')) {
    throw new Error('Invalid report entry');
  }
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin || url.pathname !== REPORT_PATH) {
    throw new Error('Invalid report entry');
  }
  if (viewKey) {
    try {
      const saved = sessionStorage.getItem(viewKey);
      for (const [name, value] of new URLSearchParams(saved)) {
        if (viewParameters.has(name) || name.startsWith('report_')) url.searchParams.set(name, value);
      }
    } catch {
      // The report can open with default filters if browser storage is unavailable.
    }
  }
  url.searchParams.set('staffFrame', '1');
  return url.pathname + url.search;
}

export default function DriverReports() {
  const frame = useRef(null);
  const openingToken = useRef(null);
  const userId = useSelector(state => state.auth.user?._id);
  const viewKey = userId ? 'matter:driver-reports:view:' + userId : null;
  const [attempt, setAttempt] = useState({ number: 0, reconnect: false });
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(true);
  const [frameState, setFrameState] = useState('loading');
  const [expired, setExpired] = useState(false);
  const [accountChanged, setAccountChanged] = useState(false);

  useEffect(() => {
    if (accountChanged) return undefined;
    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(() => controller.abort(), OPEN_TIMEOUT_MS);
    async function connect() {
      setError('');
      setConnecting(true);
      if (!attempt.reconnect) {
        setUrl('');
        setFrameState('loading');
      }
      try {
        const workerReady = await canOpenDriverAudits(navigator.serviceWorker).catch(() => false);
        if (!active) return;
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!workerReady) {
          setError(reloadMessage);
          return;
        }

        const token = localStorage.getItem('token');
        if (!token || (openingToken.current && openingToken.current !== token)) {
          setAccountChanged(true);
          return;
        }
        openingToken.current = token;
        const response = await fetch('/api/driver-audits/session', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
            'X-Driver-Audit-Client': DRIVER_AUDIT_CLIENT,
          },
          body: '{}',
          signal: controller.signal,
        });
        if (!active) return;
        if (localStorage.getItem('token') !== token) {
          setAccountChanged(true);
          return;
        }
        if (!response.ok) {
          setError(response.status === 428 ? reloadMessage : failureMessage);
          return;
        }
        const data = await response.json();
        if (!active) return;
        if (attempt.reconnect) {
          // Renew the cookie without reloading the review and its draft.
          const child = frame.current?.contentWindow;
          if (child && frame.current.contentDocument) {
            child.dispatchEvent(new child.Event('focus'));
            child.document.dispatchEvent(new child.Event('visibilitychange'));
          }
          setExpired(false);
        } else {
          setUrl(reportFrameUrl(data?.url, viewKey));
        }
      } catch {
        if (active) setError(failureMessage);
      } finally {
        window.clearTimeout(timer);
        if (active) setConnecting(false);
      }
    }
    void connect();
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [accountChanged, attempt, viewKey]);

  useEffect(() => {
    function onMessage(event) {
      if (event.origin === window.location.origin &&
          event.source === frame.current?.contentWindow &&
          event.data === 'matter-audit-session-expired') {
        setExpired(true);
      }
    }
    function onLogout(event) {
      const child = frame.current?.contentWindow;
      if (!child || !frame.current.contentDocument) return;
      const beforeUnload = new child.Event('beforeunload', { cancelable: true });
      if (!child.dispatchEvent(beforeUnload) && !window.confirm('Leave Driver Reports and discard your unsaved finding?')) {
        event.preventDefault();
      }
    }
    function onStorage(event) {
      if ((event.key === 'token' || event.key === null) && openingToken.current &&
          localStorage.getItem('token') !== openingToken.current) {
        setAccountChanged(true);
      }
    }
    window.addEventListener('storage', onStorage);
    window.addEventListener('message', onMessage);
    window.addEventListener('matter-before-logout', onLogout);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('matter-before-logout', onLogout);
    };
  }, []);

  useEffect(() => {
    if (!viewKey) return undefined;
    function saveView() {
      try {
        const location = frame.current?.contentWindow?.location;
        if (location?.origin === window.location.origin && location.pathname === REPORT_PATH &&
            location.search.length <= 4096) {
          sessionStorage.setItem(viewKey, location.search);
        }
      } catch {
        // A failed or no-longer same-origin frame has no report filters to retain.
      }
    }
    window.addEventListener('pagehide', saveView);
    return () => window.removeEventListener('pagehide', saveView);
  }, [viewKey]);

  useEffect(() => {
    if (!url || frameState !== 'loading') return undefined;
    const timer = window.setTimeout(() => setFrameState('slow'), OPEN_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [url, frameState]);

  function onFrameLoad(event) {
    const loadedReport = event.currentTarget.contentDocument?.querySelector('meta[name="matter-driver-reports"]');
    setFrameState(loadedReport ? 'ready' : 'failed');
  }

  const hasFrameError = frameState === 'failed' || frameState === 'slow';
  const needsReload = accountChanged || error === reloadMessage;
  const reconnect = expired && !hasFrameError;
  const showAction = accountChanged || (!connecting && (error || hasFrameError || expired));
  const loading = !accountChanged && (connecting || (url && frameState === 'loading'));
  const message = accountChanged ? changedAccountMessage : error || (frameState === 'failed' ? failureMessage :
    frameState === 'slow' ? 'Driver Reports is taking longer than expected.' :
    expired ? 'Your report session expired. Reconnect to keep reviewing.' : '');

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Driver Reports">
      {(showAction || loading) && (
        <div className="px-6 py-4">
          {loading && <p role="status">{reconnect ? 'Reconnecting to Driver Reports…' : 'Loading Driver Reports…'}</p>}
          {showAction && (
            <>
              <p role="alert">{message}</p>
              <button
                type="button"
                className="mt-2 font-medium underline"
                onClick={() => {
                  if (needsReload) window.location.reload();
                  else setAttempt(current => ({ number: current.number + 1, reconnect }));
                }}
              >
                {needsReload ? 'Reload Matter' : reconnect ? 'Reconnect' : 'Retry'}
              </button>
            </>
          )}
        </div>
      )}
      {url && !accountChanged && (
        <iframe
          ref={frame}
          title="Driver Reports"
          src={url}
          onLoad={onFrameLoad}
          className={frameState === 'failed' ? 'hidden' : 'min-h-0 w-full flex-1 border-0'}
        />
      )}
    </section>
  );
}
