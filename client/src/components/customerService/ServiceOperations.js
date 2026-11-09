import React from 'react';
import {Link} from 'react-router-dom';
import {formatDubai, ResourceState} from './serviceUtils';

const duration=seconds=>seconds==null?'Not measured':seconds<60?`${Math.round(seconds)} sec`:seconds<3600?`${Math.round(seconds/60)} min`:`${(seconds/3600).toFixed(1)} hr`;
export default function ServiceOperations({resource}) {
  const data=resource.data;
  const native=data?.historyCoverage?.find(row=>row.source==='gallabox');
  const workbook=data?.historyCoverage?.find(row=>row.source==='gallabox_history');
  const chatLink=assignment=>`/customer-service/chats?period=all&status=open&assignment=${assignment}`;
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
    <section className="cs-card" style={{marginBottom:18}}>
      <h2>Staff response time</h2>
      <p className="cs-muted">Customer message → human staff reply · 8 AM–5 PM Dubai window · working days and holidays unconfirmed</p>
      <div className="cs-metrics">{[['Average staff response',duration(data?.averageSeconds)],['Typical staff response (median)',duration(data?.medianSeconds)],['90% of staff replies within',duration(data?.p90Seconds)]].map(([label,value])=><div className="cs-metric" key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
      <p className="cs-muted">{data?.answeredTurns??'—'} answered customer turns · automatic replies excluded · unanswered chats excluded from these times</p>
      {Boolean(data?.agents?.length)&&<div className="cs-table-wrap"><table><thead><tr><th>Gallabox staff</th><th>Customer turns answered</th><th>Average staff response</th><th>Typical response</th></tr></thead><tbody>{data.agents.map(agent=><tr key={agent.agent_id||agent.name}><td>{agent.name||'Name unavailable'}</td><td>{agent.replies}</td><td>{duration(agent.average_seconds)}</td><td>{duration(agent.median_seconds)}</td></tr>)}</tbody></table></div>}
      {data&&!data.agents?.length&&<p>No verified human replies in the selected dates.</p>}
      <details><summary>How response time is counted</summary><p>{data?.definition}</p><p>{data?.schedule}</p><p>Resolved chats are excluded from current waiting counts. A closing event does not prove the customer’s problem was solved.</p><p>{data?.uncertainTurns??'—'} turns have uncertain outgoing authors and are excluded from response averages.</p><p className="cs-muted">Partial captured history · calculated {formatDubai(data?.responseMetricsAsOf)}</p></details>
    </section>
    <section className="cs-card" style={{marginBottom:18}}><details><summary>History coverage & sync details</summary>
      <h3>Saved in Supabase</h3><p>{native?Number(native.records).toLocaleString():'—'} Gallabox records, including system events · {formatDubai(native?.oldest)} to {formatDubai(native?.newest)}</p>
      <p>{workbook?Number(workbook.records).toLocaleString():'—'} workbook message rows · may overlap Gallabox history</p>
      <p>History completeness is not confirmed.</p>
      <h3>Background sync</h3><p>{data?.sync?.mode==='cloud'?'Runs in Supabase, including when this Mac is off.':'Cloud capture not confirmed.'}</p>
      <dl className="cs-context-list"><dt>Contacts awaiting a recent-message check</dt><dd>{data?.captureQueue?.livePending??'—'}</dd><dt>History scans pending (includes repeat checks)</dt><dd>{data?.captureQueue?.historyPending??'—'}</dd><dt>Contacts checked this scan</dt><dd>{data?.captureQueue?.historyChecked??'—'} / {data?.captureQueue?.historyTotal??'—'}</dd><dt>New-message capture delay</dt><dd>{data?.captureLatency?.samples?duration(data.captureLatency.p90Seconds)+' (90th percentile)':'Not measured — no new arrival samples'}</dd></dl>
      <p className="cs-muted">These are sync jobs, not unanswered customer messages. Chat history reads from Supabase. {data?.workflowStorage==='supabase'?'Reviews and follow-ups save directly to Supabase.':'Reviews and follow-ups use a local working cache.'}</p>
    </details></section>
  </>;
}
