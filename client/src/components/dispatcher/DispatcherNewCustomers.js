import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Search, ArrowRight, MapPin } from 'lucide-react';
import api from '../../utils/api';
import { useSocket } from '../../contexts/SocketContext';
import { DispatcherDialog } from './DispatcherFilters';
import { businessComponentsToUtcDate, formatBusinessDateInput } from '../../utils/businessTime';
import { errorMessage, newRequestId, shiftDay } from '../../utils/dispatcher';
import { Cell, timestamp } from './DispatcherDelivery';

const CACHE_TTL_MS = 2 * 60 * 1000;
export const createNewCustomerCache = () => ({ count: null, queueRevision: null, expiresAt: 0, pages: new Map() });
export function invalidateNewCustomerCache(cache) {
  cache.expiresAt = 0;
  cache.pages.clear();
}

const isFresh = cache => cache.expiresAt > Date.now();
function rememberQueue(cache, { count, queueRevision }) {
  if (!isFresh(cache) || cache.count !== count || cache.queueRevision !== queueRevision) {
    const now = Date.now();
    const tomorrow = shiftDay(formatBusinessDateInput(new Date(now)), 1);
    const midnight = businessComponentsToUtcDate(tomorrow, '00:00');
    cache.pages.clear();
    cache.expiresAt = Math.min(now + CACHE_TTL_MS, midnight.getTime());
  }
  cache.count = count;
  cache.queueRevision = queueRevision;
}

export default function DispatcherNewCustomers({ cache: workspaceCache }) {
  const { socket } = useSocket();
  const [localCache] = useState(createNewCustomerCache);
  const cache = workspaceCache || localCache;
  const activeCache = useRef(cache);
  activeCache.current = cache;
  const [reload, setReload] = useState(0);
  const [count, setCount] = useState(() => isFresh(cache) ? cache.count : null);
  const [countError,setCountError]=useState(''),[open,setOpen]=useState(false),[rows,setRows]=useState([]),[page,setPage]=useState(1),[pages,setPages]=useState(0),[search,setSearch]=useState(''),[detail,setDetail]=useState(null),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[feedback,setFeedback]=useState(false),[category,setCategory]=useState(''),[issue,setIssue]=useState(''),[notice,setNotice]=useState('');
  const [loadedPage, setLoadedPage] = useState(null);
  const [pageError, setPageError] = useState('');
  const attempt=useRef(null),lock=useRef(false),generation=useRef(0),countGeneration=useRef(0);
  const invalidateQueue = useCallback(() => {
    invalidateNewCustomerCache(activeCache.current);
    countGeneration.current++;
    generation.current++;
  }, []);

  const loadCount = useCallback(async () => {
    const request = ++countGeneration.current;
    if (isFresh(cache)) {
      setCount(cache.count);
      setCountError('');
      return;
    }
    try {
      const response = await api.get('/dispatcher-location-reviews');
      if (request !== countGeneration.current) return;
      const data = response.data.data;
      rememberQueue(cache, data);
      setCount(data.count);
      setCountError('');
    } catch (e) {
      if (request !== countGeneration.current) return;
      setCount(null);
      setCountError(errorMessage(e));
    }
  }, [cache]);

  useEffect(() => {
    if (!socket) return;
    let timer;
    const refresh = () => {
      invalidateQueue();
      clearTimeout(timer);
      timer = setTimeout(() => setReload(value => value + 1), 350);
    };
    const events = ['delivery:created', 'delivery:updated', 'delivery:statusUpdate', 'deliveries:deleted', 'connect'];
    events.forEach(name => socket.on(name, refresh));
    return () => {
      clearTimeout(timer);
      events.forEach(name => socket.off(name, refresh));
    };
  }, [socket, invalidateQueue]);

  useEffect(() => {
    if (!open) {
      loadCount();
      return () => { countGeneration.current++; };
    }
    countGeneration.current++;
    const request = ++generation.current;
    const showPage = data => {
      setRows(data.rows);
      setPages(data.pages);
      setLoadedPage(page);
      setPage(current => Math.min(current, Math.max(1, data.pages)));
      setCount(data.count);
      setCountError('');
    };
    setPageError('');
    const savedPage = isFresh(cache) ? cache.pages.get(page) : undefined;
    if (savedPage) {
      showPage(savedPage);
      setLoading(false);
      return;
    }
    setLoadedPage(null);
    setRows([]);
    setLoading(true);
    api.get('/dispatcher-location-reviews', { params: { details: true, page } }).then(response => {
      if (request !== generation.current) return;
      const data = response.data.data;
      rememberQueue(cache, data);
      cache.pages.set(page, data);
      showPage(data);
    }).catch(e => {
      if (request !== generation.current) return;
      setPageError(errorMessage(e));
      if (!isFresh(cache)) {
        setCount(null);
        setCountError(errorMessage(e));
      }
    }).finally(() => {
      if (request === generation.current) setLoading(false);
    });
    return () => { generation.current++; };
  }, [open, page, reload, cache, loadCount]);
  const select=async s=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');attempt.current=null;
    try{const r=await api.get(`/dispatcher-location-reviews/${s.subscriptionId}`);setDetail(r.data.data);setFeedback(false);setCategory('');setIssue('');}
    catch(e){
      if(e.response?.status===409){
        invalidateQueue();
        setNotice('This customer is no longer in the new-customer queue.');
        setReload(value => value + 1);
      }else setError(errorMessage(e));
    }finally{lock.current=false;setBusy(false);}
  };
  const save=async action=>{
    if(lock.current)return;
    if(action==='feedback'&&(!category||!issue.trim())){setError('Choose an issue type and describe the issue.');return;}
    lock.current=true;setBusy(true);setError('');
    const body=attempt.current||{requestId:newRequestId(),action,category:action==='feedback'?category:'',issue:action==='feedback'?issue.trim():'',revision:detail.revision};attempt.current=body;
    try{const r=await api.post(`/dispatcher-location-reviews/${detail.subscriptionId}`,body);setDetail(d=>({...d,reviews:[r.data.data.review,...(d.reviews||[]).filter(x=>x.requestId!==body.requestId)]}));attempt.current=null;setFeedback(false);setNotice(body.action==='confirm'?'Location confirmed.':'Feedback saved.');}
    catch(e){setError(errorMessage(e));if(e.response&&e.response.status<500)attempt.current=null;}
    finally{lock.current=false;setBusy(false);}
  };
  const close=()=>{if(lock.current)return;setOpen(false);setDetail(null);setError('');setNotice('');attempt.current=null;};
  const waitingForPage = loading || (loadedPage !== page && !pageError);
  const address = detail?.addressDetails;
  const filtered=(loadedPage === page ? rows : []).filter(s=>[s.customerName,s.customerId,s.location,s.zone].some(v=>String(v||'').toLowerCase().includes(search.toLowerCase()))),current=detail?.reviews?.find(r=>r.revision===detail.revision);
  return <div className="dp-new-customer-action"><button type="button" className="dp-new-customer-button" aria-label={`New customer, ${count===null?'count unavailable':count}`} onClick={()=>{setPage(1);setSearch('');setOpen(true);}}>New customer <span className="dp-count-badge">{count===null?'—':count}</span></button>{countError&&<p className="dp-help">New customer count unavailable. <button onClick={loadCount}>Retry count</button></p>}
    {open&&<DispatcherDialog title={detail?'Review customer location':'New customers'} busy={busy} onClose={close}>
      {notice&&<p className="dp-notice" role="status">{notice}</p>}{error&&<p className="dp-error" role="alert">{error}</p>}
      {!detail?<><p className="dp-help">{count??'—'} new customers with a scheduled delivery today or later, awaiting their first completed delivery. Removed automatically after that delivery is completed.</p><label className="dp-search"><Search size={18}/><input aria-label="Search new customers on this page" placeholder="Search this page: customer, location or zone…" value={search} onChange={e=>setSearch(e.target.value)}/></label>
        {pageError&&<p className="dp-error" role="alert">{pageError} <button onClick={()=>setReload(value=>value+1)}>Retry list</button></p>}
        {waitingForPage?<p role="status">Loading current customer locations…</p>:<div className="dp-new-customer-list">{filtered.map(s=><button key={s.subscriptionId} disabled={busy} onClick={()=>select(s)}><span><strong>{s.customerName}</strong><small>CUS-{s.customerId} · SUB-{s.subscriptionId}</small>{s.nextDeliveryAt&&<small>Next delivery · {timestamp(s.nextDeliveryAt)}</small>}<small><MapPin size={14}/>{s.zone||'Zone unavailable'}</small><small>{s.unavailable?'Location could not be loaded. Open to retry.':s.location||'Current delivery address is missing or ambiguous.'}</small></span><ArrowRight size={19}/></button>)}</div>}
        {!waitingForPage&&!pageError&&!error&&!filtered.length&&<p className="dp-empty">No new customers with an upcoming first delivery.</p>}
        <div className="dp-actions"><button disabled={waitingForPage||page<=1} onClick={()=>{setPage(p=>p-1);setSearch('');}}>Previous</button><span>Page {page} / {pages||1}</span><button disabled={waitingForPage||page>=pages} onClick={()=>{setPage(p=>p+1);setSearch('');}}>Next</button></div>
      </>:<><button disabled={busy} onClick={()=>{setDetail(null);setError('');setNotice('');attempt.current=null;}}>← Back to new customers</button>
        <section className="dp-detail-section"><p className="dp-eyebrow">CUSTOMER TYPE: NEW</p><h3>{detail.customerName}</h3><p>CUS-{detail.customerId} · SUB-{detail.subscriptionId}</p>{detail.nextDeliveryAt&&<p>Next delivery · {timestamp(detail.nextDeliveryAt)}</p>}</section>
        <section className="dp-detail-section">
          <h3>Delivery address</h3>
          <p>{detail.location || 'Current delivery address is missing or ambiguous.'}</p>
          <div className="dp-detail-grid">
            <Cell label="Building name" value={address?.building} />
            <Cell label="Apartment / unit number" value={String(address?.unit ?? '')} />
            <Cell label="Floor" value={String(address?.floor ?? '')} />
            <Cell label="Street" value={address?.street} />
            <Cell label="Area" value={address?.area} />
            <Cell label="Emirate" value={address?.emirate} />
            <Cell label="Zone" value={detail.zone} />
          </div>
          {address?.additional_details && <p><strong>Delivery instructions:</strong> {address.additional_details}</p>}</section>
        <section className="dp-detail-section"><h3>Google Maps · saved pin</h3>{detail.pin?<><iframe className="dp-customer-map" title="New customer saved location in Google Maps" src={`https://www.google.com/maps?q=${detail.pin.lat},${detail.pin.lng}&output=embed`} loading="lazy"/><p>{detail.pin.lat.toFixed(6)}, {detail.pin.lng.toFixed(6)}</p><a className="dp-map-link" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${detail.pin.lat},${detail.pin.lng}`)}`} target="_blank" rel="noopener noreferrer">Open location in Google Maps ↗</a></>:<p className="dp-warning">No saved GPS pin. Give feedback to request the exact location.</p>}</section>
        {current&&<p className="dp-help">{current.action==='confirm'?'Confirmed':'Feedback recorded'} by {current.actorName} · {timestamp(current.timestamp)}</p>}
        {attempt.current&&<p className="dp-warning">Save could not be confirmed. Retry the same review before starting another.</p>}
        {feedback?<form onSubmit={e=>{e.preventDefault();save('feedback');}}><label className="dp-field">Issue type<select aria-label="Location issue type" required disabled={busy||!!attempt.current} value={category} onChange={e=>setCategory(e.target.value)}><option value="">Choose an issue</option><option value="location_incorrect">Location incorrect</option><option value="missing_information">Missing information</option><option value="gps_wrong">GPS wrong</option></select></label><label className="dp-field">What is the issue?<textarea aria-label="Issue description" required maxLength={2000} rows={4} disabled={busy||!!attempt.current} placeholder="Describe what needs to be corrected…" value={issue} onChange={e=>setIssue(e.target.value)}/></label><div className="dp-actions"><button type="button" disabled={busy||!!attempt.current} onClick={()=>setFeedback(false)}>Cancel feedback</button><button className="primary" disabled={busy}>{busy?'Saving…':attempt.current?'Retry feedback':'Save feedback'}</button></div></form>:<div className="dp-actions"><button className="primary" disabled={busy||!detail.pin||!detail.location||!!attempt.current&&attempt.current.action!=='confirm'} onClick={()=>save('confirm')}>{busy?'Saving…':attempt.current?'Retry confirmation':'Confirm location'}</button><button disabled={busy||!!attempt.current} onClick={()=>setFeedback(true)}>Give feedback</button></div>}
        {!!detail.reviews?.length&&<section className="dp-detail-section"><h3>Location review history</h3><ol className="dp-timeline">{detail.reviews.map(r=><li key={r.requestId}><strong>{r.action==='confirm'?'Location confirmed':({location_incorrect:'Location incorrect',missing_information:'Missing information',gps_wrong:'GPS wrong'}[r.category]||'Feedback')}</strong><small>{r.actorName} · {timestamp(r.timestamp)}</small>{r.issue&&<p>{r.issue}</p>}{r.revision!==detail.revision&&<small>Earlier location snapshot</small>}</li>)}</ol><p className="dp-help">Showing up to 50 recent reviews.</p></section>}
      </>}
    </DispatcherDialog>}
  </div>;
}
