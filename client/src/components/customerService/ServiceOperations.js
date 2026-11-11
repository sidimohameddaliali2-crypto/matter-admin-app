import React from 'react';
import {Link} from 'react-router-dom';
import {formatDubai, ResourceState, useServiceResource} from './serviceUtils';

const duration=seconds=>seconds==null?'Not measured':seconds<60?`${Math.round(seconds)} sec`:seconds<3600?`${Math.round(seconds/60)} min`:`${(seconds/3600).toFixed(1)} hr`;
export default function ServiceOperations({resource}) {
  const data=resource.data;
  const health=useServiceResource('/capture-health'),capture=health.data;
  const native=data?.historyCoverage?.find(row=>row.source==='gallabox');
  const workbook=data?.historyCoverage?.find(row=>row.source==='gallabox_history');
  const chatLink=assignment=>`/customer-service/chats?period=all&status=open&assignment=${assignment}`;
  if(data?.unavailable)return <p className="cs-muted">{data.reason}</p>;
  return <>
    <section className="cs-card" style={{marginBottom:18}}>
      <h2>Customer inbox now</h2>
      <p className="cs-muted">All dates · current Gallabox status</p>
      <ResourceState loading={resource.loading} error={resource.error}/>
      <div className="cs-metrics">
        <Link className="cs-metric" to={chatLink('all')}><strong>{data?.backlog?.open??'—'}</strong><span>Open chats</span></Link>
        <Link className="cs-metric" to={chatLink('unassigned')}><strong>{data?.backlog?.unassignedOpen??'—'}</strong><span>Unassigned open chats</span></Link>
      </div>
      <p className="cs-muted">Last checked {formatDubai(data?.sync?.lastSuccessAt)}{data?.sync?.lastError?' · Updates delayed':''}</p>
    </section>
    <p className="cs-muted">Response performance uses the request-linked report above. Legacy conversation averages used a superseded daily window and are not displayed as staff performance.</p>
    <section className="cs-card" style={{marginBottom:18}}><details><summary>History coverage & sync details</summary>
      <h3>Saved in Supabase</h3><p>{native?Number(native.records).toLocaleString():'—'} Gallabox records, including system events · {formatDubai(native?.oldest)} to {formatDubai(native?.newest)}</p>
      <p>{workbook?Number(workbook.records).toLocaleString():'—'} workbook message rows · may overlap Gallabox history</p>
      <p>History completeness is not confirmed.</p>
      <h3>Capture health</h3><ResourceState error={health.error} loading={health.loading}/><button type="button" onClick={health.refresh}>Check capture now</button>{capture&&<><p>{String(capture.state||'Unavailable').replaceAll('_',' ')} · checked {formatDubai(capture.observedAt)}</p><p>Last successful sync {formatDubai(capture.control?.lastSuccessAt)} · Last saved message {formatDubai(capture.lastDurableCaptureAt)}</p>{capture.lanes?.map(lane=><p key={lane.lane}>{lane.lane}: {lane.pendingJobs} checks pending · {lane.failedJobs} failed · {lane.retryFailures} retry failures</p>)}<p>{capture.conflicts??'Not measured'} capture conflicts · Alert threshold {capture.thresholdConfirmed?'configured':'not yet agreed'}</p><p className="cs-muted">On-demand observation. Continuing alert delivery is not configured. Pending checks do not prove missing messages.</p></>}<h3>Background sync</h3><p>{data?.sync?.mode==='cloud'?'Runs in Supabase, including when this Mac is off.':'Cloud capture not confirmed.'}</p>
      <dl className="cs-context-list"><dt>Contacts awaiting a recent-message check</dt><dd>{data?.captureQueue?.livePending??'—'}</dd><dt>History scans pending (includes repeat checks)</dt><dd>{data?.captureQueue?.historyPending??'—'}</dd><dt>Contacts checked this scan</dt><dd>{data?.captureQueue?.historyChecked??'—'} / {data?.captureQueue?.historyTotal??'—'}</dd><dt>New-message capture delay</dt><dd>{data?.captureLatency?.samples?duration(data.captureLatency.p90Seconds)+' (90th percentile)':'Not measured — no new arrival samples'}</dd></dl>
      <p className="cs-muted">These are sync jobs, not unanswered customer messages. Chat history reads from Supabase. {data?.workflowStorage==='supabase'?'Reviews and follow-ups save directly to Supabase.':'Reviews and follow-ups use a local working cache.'}</p>
    </details></section>
  </>;
}
