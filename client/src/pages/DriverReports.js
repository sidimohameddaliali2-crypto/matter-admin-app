import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import api from '../utils/api';
import { canOpenDriverAudits, DRIVER_AUDIT_CLIENT } from '../utils/driverAuditWorker.mjs';

const OPEN_TIMEOUT_MS = 25000;
const REPORT_PATH = '/api/reporting/view';
const viewParameters = new Set(['reportFrom', 'reportTo', 'reportDates', 'reportDrill', 'photoReview']);
const reloadMessage = 'Reload Matter to open Driver Reports.';
const failureMessage = 'Driver Reports could not load. Try again.';

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
  const userId = useSelector(state => state.auth.user?._id);
  const viewKey = userId ? 'matter:driver-reports:view:' + userId : null;
  const [attempt, setAttempt] = useState({ number: 0, reconnect: false });
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(true);
  const [frameState, setFrameState] = useState('loading');
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function connect() {
      setError('');
      setConnecting(true);
      if (!attempt.reconnect) {
        setUrl('');
        setFrameState('loading');
      }
      try {
        const workerReady = await canOpenDriverAudits(navigator.serviceWorker).catch(() => false);
        if (controller.signal.aborted) return;
        if (!workerReady) {
          setError(reloadMessage);
          return;
        }

        const { data } = await api.post('/driver-audits/session', {}, {
          headers: { 'X-Driver-Audit-Client': DRIVER_AUDIT_CLIENT },
          timeout: OPEN_TIMEOUT_MS,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
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
      } catch (requestError) {
        if (!controller.signal.aborted) {
          setError(requestError.response?.status === 428 ? reloadMessage : failureMessage);
        }
      } finally {
        if (!controller.signal.aborted) setConnecting(false);
      }
    }
    void connect();
    return () => controller.abort();
  }, [attempt, viewKey]);

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
    window.addEventListener('message', onMessage);
    window.addEventListener('matter-before-logout', onLogout);
    return () => {
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
  const needsReload = error === reloadMessage;
  const reconnect = expired && !hasFrameError;
  const showAction = !connecting && (error || hasFrameError || expired);
  const loading = connecting || (url && frameState === 'loading');
  const message = error || (frameState === 'failed' ? failureMessage :
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
      {url && (
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
