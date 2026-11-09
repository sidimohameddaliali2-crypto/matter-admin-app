import React, { useCallback, useEffect, useState } from 'react';
import api from '../../utils/api';

export const servicePath = '/customer-service';
export const idOf = value => String(value?._id || value?.userId?._id || value?.userId || value || '');
export const unpack = response => response?.data?.data;
export const errorMessage = (error, fallback = 'This could not be loaded. Please try again.') => error?.response?.data?.message || error?.response?.data?.error || error?.message || fallback;
export const newRequestId = () => globalThis.crypto?.randomUUID?.() || `cs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const displayName = value => value?.displayName || value?.name || [value?.profile?.firstName, value?.profile?.lastName].filter(Boolean).join(' ') || 'Staff member';
const dubaiFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
export const formatDubai = value => {
  if (!value || Number.isNaN(new Date(value).getTime())) return 'Not recorded';
  return dubaiFormatter.format(new Date(value));
};
export const toDubaiInput = value => {
  if (!value || Number.isNaN(new Date(value).getTime())) return '';
  return new Date(new Date(value).getTime() + 4 * 60 * 60 * 1000).toISOString().slice(0, 16);
};
export const fromDubaiInput = value => value ? new Date(`${value}:00+04:00`).toISOString() : null;
export const isStaffReply = message => message?.authorType === 'staff' && message.display?.nativeContent?.kind !== 'reaction' && message.internalNote !== true;
export const prettyStatus = value => String(value || 'unknown').replace(/_/g, ' ');
export const isActionOverdue = (action, now = new Date()) => action.status !== 'completed' && [action.dueAt, action.promisedDueAt].filter(Boolean).some(value => new Date(value) < now);
export const categoryLabels = (ids = [], categories = []) => ids.map(id => categories.find(category => category.id === id)?.label || id).join(' · ') || 'Not determined';
export const filterParams = filters => Object.fromEntries(Object.entries({ from: filters.from, to: filters.to, categoryId: filters.categoryId, q: filters.search }).filter(([, value]) => value));
export const matchesIssue = (issue, filters = {}) => {
  const text = [issue.customerName, issue.customerId, issue.summary].join(' ').toLowerCase();
  if (filters.search && !text.includes(filters.search.toLowerCase())) return false;
  if (filters.categoryId && !(issue.categoryIds || []).includes(filters.categoryId)) return false;
  return true;
};

// Each page keeps its last successful response visible on a failed refresh.
export function useServiceResource(path, params = {}, epoch = 0) {
  const paramsKey = JSON.stringify(params);
  const identity = `${path || ''}:${paramsKey}`;
  const [state, setState] = useState({ identity, data: null, loading: Boolean(path), error: '' });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!path) return undefined;
    let live = true;
    setState(previous => ({ identity, data: previous.identity === identity ? previous.data : null, loading: true, error: '' }));
    api.get(`${servicePath}${path}`, { params: JSON.parse(paramsKey) }).then(response => {
      if (live) setState({ identity, data: unpack(response), loading: false, error: '' });
    }).catch(error => {
      if (live) setState(previous => ({ identity, data: previous.identity === identity ? previous.data : null, loading: false, error: errorMessage(error) }));
    });
    return () => { live = false; };
  }, [path, paramsKey, identity, epoch, revision]);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  // Effects run after render. Guard synchronously so a newly selected case can
  // never be paired with the previous customer's payload, even for one frame.
  const current = Boolean(path) && state.identity === identity;
  return { data: current ? state.data : null, loading: Boolean(path) && (!current || state.loading), error: current ? state.error : '', refresh };
}

export function ResourceState({ loading, error, children }) {
  return <>{error && <div className="cs-alert" role="alert">{error} Any previously loaded information is retained.</div>}{loading && <p className="cs-muted" role="status">Loading saved information…</p>}{children}</>;
}

export const dubaiToday = (now = new Date()) => new Date(new Date(now).getTime() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
export function serviceFiltersFromSearch(search = '', now = new Date()) {
  const query = new URLSearchParams(search), today = dubaiToday(now);
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
  const from = valid(query.get('from')) ? query.get('from') : '';
  const to = valid(query.get('to')) ? query.get('to') : '';
  const range = (from || to) && (!from || !to || from <= to);
  return {from:query.get('period') === 'all' ? '' : range ? from : today,to:query.get('period') === 'all' ? '' : range ? to : today,categoryId:query.get('category') || '',search:query.get('q') || ''};
}
export function serviceFilterSearch(filters, now = new Date()) {
  const query = new URLSearchParams(), today = dubaiToday(now);
  if (!filters.from && !filters.to) query.set('period','all');
  else if (filters.from === today && filters.to === today) query.set('period','today');
  else {if (filters.from) query.set('from',filters.from);if (filters.to) query.set('to',filters.to);}
  if (filters.categoryId) query.set('category',filters.categoryId);
  if (filters.search) query.set('q',filters.search);
  return `?${query}`;
}
