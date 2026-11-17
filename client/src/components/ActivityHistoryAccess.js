import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Navigate, useLocation } from 'react-router-dom';
import { refreshCurrentUser } from '../store/slices/authSlice';

const isHistoryPath = (pathname) => pathname.replace(/\/+$/, '').toLowerCase() === '/traceability';

// History checks the current session before mounting its private content. Other
// pages retain the existing background refresh without waiting for that check.
export function AuthBootstrap() {
  const dispatch = useDispatch();
  const authToken = useSelector((state) => state.auth.token);
  const historyPath = isHistoryPath(useLocation().pathname);
  useEffect(() => {
    const token = authToken || localStorage.getItem('token');
    if (token && !historyPath) dispatch(refreshCurrentUser());
  }, [authToken, dispatch, historyPath]);
  return null;
}

export default function ActivityHistoryRoute({ children, fallback }) {
  const dispatch = useDispatch();
  const { user } = useSelector((state) => state.auth);
  // Match the credential used by the API client, including a change in another tab.
  const token = localStorage.getItem('token');
  const [attempt, setAttempt] = useState(0);
  const [access, setAccess] = useState({ token: null, state: 'checking', allowed: false });

  useEffect(() => {
    const changed = (event) => {
      if (event.storageArea && event.storageArea !== localStorage) return;
      if (event.key !== null && event.key !== 'token' && event.key !== 'user') return;
      setAccess({ token: null, state: 'checking', allowed: false });
      setAttempt((value) => value + 1);
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);

  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    setAccess({ token, state: 'checking', allowed: false });
    const request = dispatch(refreshCurrentUser());
    request.unwrap()
      .then((freshUser) => {
        if (active) setAccess({ token, state: 'checked', allowed: freshUser?.canViewActivityHistory === true });
      })
      .catch(() => {
        if (active) setAccess({ token, state: 'failed', allowed: false });
      });
    return () => { active = false; request.abort(); };
  }, [token, dispatch, attempt]);

  if (!token) return <Navigate to="/login" replace />;
  if (access.token !== token || access.state === 'checking') return <p role="status">Checking access…</p>;
  if (access.state === 'failed') return (
    <div role="alert">
      <p>Could not check access to Activity history.</p>
      <button onClick={() => setAttempt((value) => value + 1)}>Try again</button>
    </div>
  );
  if (!access.allowed || user?.canViewActivityHistory !== true) return fallback || <Navigate to="/" replace />;
  return children;
}
