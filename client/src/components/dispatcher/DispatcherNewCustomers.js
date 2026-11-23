import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Search, ArrowRight, MapPin } from 'lucide-react';
import api from '../../utils/api';
import { DispatcherDialog } from './DispatcherFilters';
import { errorMessage, newRequestId } from '../../utils/dispatcher';
import { timestamp } from './DispatcherDelivery';

export default function DispatcherNewCustomers() {
  const [count,setCount]=useState(null),[countError,setCountError]=useState(''),[open,setOpen]=useState(false),[rows,setRows]=useState([]),[page,setPage]=useState(1),[pages,setPages]=useState(0),[search,setSearch]=useState(''),[detail,setDetail]=useState(null),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[feedback,setFeedback]=useState(false),[category,setCategory]=useState(''),[issue,setIssue]=useState(''),[notice,setNotice]=useState('');
  const attempt=useRef(null),lock=useRef(false),generation=useRef(0);
  const loadCount=useCallback(async()=>{try{const r=await api.get('/dispatcher-location-reviews');setCount(r.data.data.count);setCountError('');}catch(e){setCount(null);setCountError(errorMessage(e));}},[]);
  useEffect(()=>{loadCount();},[loadCount]);
  useEffect(()=>{
    if(!open)return;
    const n=++generation.current;setLoading(true);setError('');setRows([]);
    api.get('/dispatcher-location-reviews',{params:{details:true,page}}).then(r=>{if(n!==generation.current)return;setRows(r.data.data.rows);setPages(r.data.data.pages);setCount(r.data.data.count);setCountError('');}).catch(e=>{if(n===generation.current)setError(errorMessage(e));}).finally(()=>{if(n===generation.current)setLoading(false);});
    return()=>{generation.current++;};
  },[open,page]);
  const select=async s=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');attempt.current=null;
    try{const r=await api.get(`/dispatcher-location-reviews/${s.subscriptionId}`);setDetail(r.data.data);setFeedback(false);setCategory('');setIssue('');}
    catch(e){setError(errorMessage(e));}finally{lock.current=false;setBusy(false);}
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
  const filtered=rows.filter(s=>[s.customerName,s.customerId,s.location,s.zone].some(v=>String(v||'').toLowerCase().includes(search.toLowerCase()))),current=detail?.reviews?.find(r=>r.revision===detail.revision);
  return <div className="dp-new-customer-action"><button aria-label={`New customer, ${count===null?'count unavailable':count}`} onClick={()=>{setPage(1);setSearch('');setOpen(true);}}>New customer <span className="dp-count-badge">{count===null?'—':count}</span></button>{countError&&<p className="dp-help">New customer count unavailable. <button onClick={loadCount}>Retry count</button></p>}
    {open&&<DispatcherDialog title={detail?'Review customer location':'New customers'} busy={busy} onClose={close}>
      {notice&&<p className="dp-notice" role="status">{notice}</p>}{error&&<p className="dp-error" role="alert">{error}</p>}
      {!detail?<><p className="dp-help">Customer type: New · Website Subscriptions. {count??'—'} customers across all subscriptions. Confirmation keeps the customer type unchanged.</p><label className="dp-search"><Search size={18}/><input aria-label="Search new customers on this page" placeholder="Search this page: customer, location or zone…" value={search} onChange={e=>setSearch(e.target.value)}/></label>
        {loading?<p role="status">Loading current customer locations…</p>:<div className="dp-new-customer-list">{filtered.map(s=><button key={s.subscriptionId} disabled={busy} onClick={()=>select(s)}><span><strong>{s.customerName}</strong><small>CUS-{s.customerId} · SUB-{s.subscriptionId}</small><small><MapPin size={14}/>{s.zone||'Zone unavailable'}</small><small>{s.unavailable?'Location could not be loaded. Open to retry.':s.location||'Current delivery address is missing or ambiguous.'}</small></span><ArrowRight size={19}/></button>)}</div>}
        {!loading&&!error&&!filtered.length&&<p className="dp-empty">No matching customers marked New.</p>}
        <div className="dp-actions"><button disabled={loading||page<=1} onClick={()=>{setPage(p=>p-1);setSearch('');}}>Previous</button><span>Page {page} / {pages||1}</span><button disabled={loading||page>=pages} onClick={()=>{setPage(p=>p+1);setSearch('');}}>Next</button></div>
      </>:<><button disabled={busy} onClick={()=>{setDetail(null);setError('');setNotice('');attempt.current=null;}}>← Back to new customers</button>
        <section className="dp-detail-section"><p className="dp-eyebrow">CUSTOMER TYPE: NEW</p><h3>{detail.customerName}</h3><p>CUS-{detail.customerId} · SUB-{detail.subscriptionId}</p><p>{detail.location||'Current delivery address is missing or ambiguous.'}</p><p><strong>Zone:</strong> {detail.zone||'Zone missing'}</p>{detail.addressDetails?.additional_details&&<p>{detail.addressDetails.additional_details}</p>}</section>
        <section className="dp-detail-section"><h3>Google Maps · saved pin</h3>{detail.pin?<><iframe className="dp-customer-map" title="New customer saved location in Google Maps" src={`https://www.google.com/maps?q=${detail.pin.lat},${detail.pin.lng}&output=embed`} loading="lazy"/><p>{detail.pin.lat.toFixed(6)}, {detail.pin.lng.toFixed(6)}</p><a className="dp-map-link" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${detail.pin.lat},${detail.pin.lng}`)}`} target="_blank" rel="noopener noreferrer">Open location in Google Maps ↗</a></>:<p className="dp-warning">No saved GPS pin. Give feedback to request the exact location.</p>}</section>
        {current&&<p className="dp-help">{current.action==='confirm'?'Confirmed':'Feedback recorded'} by {current.actorName} · {timestamp(current.timestamp)}</p>}
        {attempt.current&&<p className="dp-warning">Save could not be confirmed. Retry the same review before starting another.</p>}
        {feedback?<form onSubmit={e=>{e.preventDefault();save('feedback');}}><label className="dp-field">Issue type<select aria-label="Location issue type" required disabled={busy||!!attempt.current} value={category} onChange={e=>setCategory(e.target.value)}><option value="">Choose an issue</option><option value="location_incorrect">Location incorrect</option><option value="missing_information">Missing information</option><option value="gps_wrong">GPS wrong</option></select></label><label className="dp-field">What is the issue?<textarea aria-label="Issue description" required maxLength={2000} rows={4} disabled={busy||!!attempt.current} placeholder="Describe what needs to be corrected…" value={issue} onChange={e=>setIssue(e.target.value)}/></label><div className="dp-actions"><button type="button" disabled={busy||!!attempt.current} onClick={()=>setFeedback(false)}>Cancel feedback</button><button className="primary" disabled={busy}>{busy?'Saving…':attempt.current?'Retry feedback':'Save feedback'}</button></div></form>:<div className="dp-actions"><button className="primary" disabled={busy||!detail.pin||!detail.location||!!attempt.current&&attempt.current.action!=='confirm'} onClick={()=>save('confirm')}>{busy?'Saving…':attempt.current?'Retry confirmation':'Confirm location'}</button><button disabled={busy||!!attempt.current} onClick={()=>setFeedback(true)}>Give feedback</button></div>}
        {!!detail.reviews?.length&&<section className="dp-detail-section"><h3>Location review history</h3><ol className="dp-timeline">{detail.reviews.map(r=><li key={r.requestId}><strong>{r.action==='confirm'?'Location confirmed':({location_incorrect:'Location incorrect',missing_information:'Missing information',gps_wrong:'GPS wrong'}[r.category]||'Feedback')}</strong><small>{r.actorName} · {timestamp(r.timestamp)}</small>{r.issue&&<p>{r.issue}</p>}{r.revision!==detail.revision&&<small>Earlier location snapshot</small>}</li>)}</ol><p className="dp-help">Showing up to 50 recent reviews.</p></section>}
      </>}
    </DispatcherDialog>}
  </div>;
}
