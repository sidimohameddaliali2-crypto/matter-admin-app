import React, { useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import ActionEditor from '../../components/customerService/ActionEditor';
import OwnerSelector from '../../components/customerService/OwnerSelector';
import { categoryLabels, errorMessage, filterParams, formatDubai, fromDubaiInput, idOf, isActionOverdue, matchesIssue, newRequestId, prettyStatus, ResourceState, servicePath, useServiceResource } from '../../components/customerService/serviceUtils';

export function NewAction({ issues, owners, capabilities, currentUserId, onCreated }) {
  const [issueId, setIssueId] = useState('');
  const [description, setDescription] = useState('');
  const [ownerId, setOwnerId] = useState(!capabilities.supervise && capabilities.workActions ? currentUserId : '');
  const [due, setDue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false), request = useRef(null);
  async function submit(event) {
    event.preventDefault(); if (lock.current || !issueId || !description.trim() || !due) return;
    lock.current = true; setBusy(true); setError('');
    const payload = { description: description.trim(), ownerId: ownerId || null, dueAt: fromDubaiInput(due) };
    const signature = JSON.stringify([issueId, payload]);
    if (request.current?.signature !== signature) request.current = { signature, id: newRequestId() };
    try { await api.post(`${servicePath}/issues/${encodeURIComponent(issueId)}/actions`, { ...payload, requestId: request.current.id }); setDescription(''); setIssueId(''); setDue(''); request.current = null; onCreated(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <details><summary>Add follow-up</summary>{error && <div className="cs-alert" role="alert">{error}</div>}<form onSubmit={submit} className="cs-form-stack" style={{ marginTop: 14 }}><label>Issue <small>Use the search above to find an older issue.</small><select aria-label="Follow-up issue" value={issueId} onChange={event => setIssueId(event.target.value)} required><option value="">Choose a visible issue</option>{issues.map(issue => <option key={idOf(issue)} value={idOf(issue)}>{issue.customerName || 'Customer'} · {issue.summary || 'Captured issue'}</option>)}</select></label><label>Action<textarea aria-label="New follow-up description" value={description} maxLength={2000} onChange={event => setDescription(event.target.value)} required/></label><OwnerSelector value={ownerId} onChange={setOwnerId} owners={owners} capabilities={capabilities} currentUserId={currentUserId}/><label>Due · Dubai time<input type="datetime-local" aria-label="New follow-up due in Dubai" value={due} onChange={event => setDue(event.target.value)} required/></label><button type="submit" disabled={busy || !issueId || !description.trim() || !due}>{busy ? 'Saving…' : 'Create internal follow-up'}</button></form></details>;
}

export default function Problems({ me, user, capabilities, categories, filters, epoch, onRefresh }) {
  const [offset,setOffset] = useState(0);
  const [filter, setFilter] = useState(capabilities.supervise ? 'team' : 'mine');
  useEffect(()=>setOffset(0),[filters.from,filters.to,filters.q,filters.categoryId,filter]);
  const records = useServiceResource('/follow-ups', {...filterParams(filters),offset,queue:filter}, epoch);
  const requestWork = useServiceResource('/request-follow-ups',{offset,queue:filter,q:filters.q||filters.search||''},epoch);
  const ownerList = useServiceResource('/owners', {}, epoch);
  const [selected, setSelected] = useState(null);
  const [notice, setNotice] = useState('');
  const currentUserId = idOf(me.profile?.userId || user?._id);
  const issues = (records.data?.issues || []).filter(issue => matchesIssue(issue, filters));
  const visibleIssueIds = new Set(issues.map(idOf));
  const all = (records.data?.actions || []).filter(action => visibleIssueIds.has(idOf(action.issueId)));
  const rows = all.filter(action => filter === 'mine' ? idOf(action.ownerId) === currentUserId : filter === 'unassigned' ? !action.ownerId && action.status !== 'completed' : filter === 'overdue' ? isActionOverdue(action) : true);
  const owners = ownerList.data?.owners || [];
  const chosen = selected ? all.find(action => idOf(action) === selected) : null;
  const saveDone = () => { setNotice('Action update saved.'); setSelected(null); records.refresh(); onRefresh(); };
  return <><div className="cs-toolbar"><div><h2>Follow-ups</h2></div></div><ResourceState loading={records.loading} error={records.error}/>{notice && <div className="cs-success" role="status">{notice}</div>}{ownerList.error && <div className="cs-alert" role="alert">Eligible owners could not be loaded: {ownerList.error}</div>}
    <ResourceState loading={requestWork.loading} error={requestWork.error}/><section className="cs-card"><h3>Request follow-ups</h3><p className="cs-muted">All-date commitments · managed in the customer conversation</p>{(requestWork.data?.followups||[]).map(f=><div className="cs-toolbar" key={f.id}><div><strong>{f.customerName}</strong><p>{f.action}</p><span className="cs-muted">{owners.find(o=>idOf(o.userId||o)===idOf(f.responsibleId))?.displayName||'Recorded owner'} · {formatDubai(f.dueAt)} · {f.status}</span></div><a href={servicePath+'/chats?period=today&conversation='+encodeURIComponent(f.conversationId)+'&request='+encodeURIComponent(f.requestId)}>Open request</a></div>)}{requestWork.data&&!requestWork.data.followups?.length&&<p>No request follow-ups in this queue.</p>}{requestWork.data?.nextOffset!=null&&<button onClick={()=>setOffset(requestWork.data.nextOffset)}>More request follow-ups</button>}</section>
    <div className={chosen ? 'cs-grid' : ''}><section className="cs-card"><div className="cs-toolbar"><div className="cs-chip-row" role="group" aria-label="Follow-up queue filter">{[['mine', 'My actions'], ...(capabilities.supervise ? [['team', 'Team actions'], ['unassigned', 'Unassigned'], ['overdue', 'Overdue']] : [['overdue', 'My overdue']])].map(([key, label]) => <button key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</div><span className="cs-badge">{records.data ? `${rows.length+(requestWork.data?.followups?.length||0)} loaded actions` : 'Loading'}</span></div><div className="cs-table-wrap"><table><thead><tr><th>Customer / action</th><th>Owner</th><th>Due · Dubai</th><th>Status</th><th/></tr></thead><tbody>{rows.map(action => {
      const issue = issues.find(item => idOf(item) === idOf(action.issueId));
      const owner = owners.find(item => idOf(item.userId || item) === idOf(action.ownerId));
      const overdue = isActionOverdue(action);
      const canEdit = capabilities.supervise || (capabilities.workActions && idOf(action.ownerId) === currentUserId);
      return <tr key={idOf(action)}><td><strong>{action.customerName || issue?.customerName || 'Customer'}</strong><p style={{ margin: '4px 0' }}>{action.description}</p><span className="cs-muted">{categoryLabels(issue?.categoryIds, categories)}</span></td><td>{owner?.displayName || (action.ownerId ? idOf(action.ownerId) === currentUserId ? 'Me' : 'Recorded owner' : <span className="cs-badge amber">Unassigned</span>)}</td><td>{formatDubai(action.dueAt)}{overdue && <div><span className="cs-badge amber">Overdue</span></div>}{action.status === 'waiting' && <p className="cs-muted">Next check: {formatDubai(action.nextCheckAt)}</p>}</td><td><span className={`cs-badge ${action.status === 'completed' ? 'green' : 'blue'}`}>{prettyStatus(action.status)}</span>{action.seenAt == null && action.ownerId && action.status !== 'completed' && <p className="cs-muted">Not yet seen</p>}</td><td><button onClick={() => setSelected(idOf(action))}>{canEdit ? 'Manage action' : 'View history'}</button></td></tr>;
    })}</tbody></table></div>{records.data && !rows.length && !requestWork.data?.followups?.length && <div className="cs-empty"><h3>No actions in this queue</h3><p>Adjust the filters or add a necessary follow-up to a captured issue.</p></div>}
      {(offset>0 || records.data?.nextOffset!=null) && <div className="cs-form-actions"><button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>Previous actions</button><button disabled={records.data?.nextOffset==null} onClick={()=>setOffset(records.data.nextOffset)}>Next actions</button></div>}
    </section>{chosen && <ActionEditor key={`${idOf(chosen)}-${chosen.version}`} action={chosen} owners={owners} capabilities={capabilities} currentUserId={currentUserId} onSaved={saveDone} onClose={() => setSelected(null)}/>}</div>
  </>;
}
