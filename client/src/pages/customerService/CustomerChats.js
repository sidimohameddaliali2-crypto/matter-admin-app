import useArrivalObservations from '../../components/customerService/useArrivalObservations';
import CustomerLinkReview from '../../components/customerService/CustomerLinkReview';
import RequestWork,{RequestQueues} from '../../components/customerService/RequestWork';
import SidebarSandbox from '../../components/customerService/SidebarSandbox';
import IssueOverview from '../../components/customerService/IssueOverview';
import useIssueDrawer from '../../components/customerService/useIssueDrawer';
import './sidebarSandbox.css';
import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import api from '../../utils/api';
import Conversation from '../../components/customerService/Conversation';
import CustomerContextDrawer from '../../components/customerService/CustomerContext';
import ActionEditor from '../../components/customerService/ActionEditor';
import {dubaiToday, categoryLabels, errorMessage, filterParams, formatDubai, idOf, prettyStatus, ResourceState, serviceFilterSearch, servicePath, unpack, useServiceResource} from '../../components/customerService/serviceUtils';

// Polling merges by source message identity; opening another contact invalidates
// every pending response. Older loaded pages keep their own pagination cursor.
function useInboxPages(path, params, field, epoch) {
  const paramsKey=JSON.stringify(params), identity=`${path}:${paramsKey}`;
  const [state,setState]=useState({identity,rows:[],data:null,loading:!!path,error:'',hasMore:false,nextCursor:null});
  const more=useRef(()=>{}), reload=useRef(()=>{});
  useEffect(()=>{
    if(!path)return undefined;
    let live=true,busy=false,hasLoaded=false,loadedOlder=false,cursor=null,latestSignature=null,queuedOlder=false;
    const controller=new AbortController();
    setState(previous=>previous.identity===identity?{...previous,error:''}:{identity,rows:[],data:null,loading:true,error:'',hasMore:false,nextCursor:null});
    async function load(older=false){
      if(!live||(older&&!cursor))return;
      if(busy){if(older)queuedOlder=true;return;}
      busy=true;
      if(!hasLoaded||older)setState(previous=>({...previous,loading:!hasLoaded,loadingMore:older}));
      try{
        const data=unpack(await api.get(`${servicePath}${path}`,{params:{...JSON.parse(paramsKey),...(older?{cursor}:{})},signal:controller.signal}))||{};
        if(!live)return;
        // Compare the full latest payload, including permissions and recovered
        // context. Unchanged polls must not rebuild the loaded transcript.
        if(!older){
          const signature=JSON.stringify(data);
          if(hasLoaded&&signature===latestSignature){
            setState(previous=>previous.error?{...previous,error:'',loading:false,loadingMore:false}:previous);
            return;
          }
          latestSignature=signature;
        }
        if(older)loadedOlder=true;
        if(!hasLoaded||older||!loadedOlder)cursor=data.nextCursor||null;
        setState(previous=>{
          const keepRows=previous.identity===identity&&!(field==='conversations'&&!older&&!loadedOlder);
          const map=new Map((keepRows?previous.rows:[]).map(row=>[idOf(row),row]));
          (data[field]||[]).forEach(row=>map.set(idOf(row),row));
          const time=row=>new Date(field==='messages'?row.sentAt:row.lastMessageAt).getTime()||0;
          const rows=[...map.values()].sort((a,b)=>(field==='messages'?1:-1)*(time(a)-time(b))||idOf(a).localeCompare(idOf(b)));
          return {identity,rows,data:older?previous.data:data,loading:false,loadingMore:false,error:'',nextCursor:cursor,hasMore:older||!loadedOlder?!!data.hasMore:previous.hasMore};
        });
        hasLoaded=true;
      }catch(failure){if(live)setState(previous=>({...previous,loading:false,loadingMore:false,error:errorMessage(failure)}));}
      finally{busy=false;if(queuedOlder&&live){queuedOlder=false;void load(true);}}
    }
    more.current=()=>load(true);reload.current=()=>load();load();
    const timer=setInterval(()=>{if(document.visibilityState!=='hidden')load();},5000);
    return()=>{live=false;controller.abort();clearInterval(timer);};
  },[path,paramsKey,identity,field,epoch]);
  const current=!!path&&state.identity===identity;
  return {...(current?state:{rows:[],data:null,loading:!!path,error:'',hasMore:false}),loadMore:()=>more.current(),refresh:()=>reload.current()};
}

export default function CustomerChats({me,user,capabilities,categories,filters,epoch,onRefresh,onFiltersChange,navigation}) {
  const location=useLocation(),navigate=useNavigate();
  const [source,setSource]=useState('native');
  const [detailsOpen,setDetailsOpen]=useState(false),[panelOpen,setPanelOpen]=useState(()=>!!new URLSearchParams(location.search).get('request'));
  const health=useServiceResource('/capture-health',{},epoch);
  const prependAnchor=useRef(null);
  const chooseMessage=message=>{setRequestMessage(message);setPanelOpen(true);};
  const [requestMessage,setRequestMessage]=useState(null);
  const [issueOverview,setIssueOverview]=useState({requests:[]}),[activeIssue,setActiveIssue]=useState(null),[reopenTarget,setReopenTarget]=useState(null),[createSignal,setCreateSignal]=useState(0);
  const [targetMessageId,setTargetMessageId]=useState(''),[highlightMessageId,setHighlightMessageId]=useState(''),[evidenceError,setEvidenceError]=useState('');
  const evidenceCursor=useRef(null),lastEvidence=useRef(''),panelRef=useRef(null);
  const closeWork=useCallback(()=>setPanelOpen(false),[]);
  const overviewChanged=useCallback(next=>setIssueOverview(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next),[]);
  const activeChanged=useCallback(next=>setActiveIssue(previous=>idOf(previous)===idOf(next)&&previous?.version===next?.version&&previous?.canWork===next?.canWork&&previous?.status===next?.status?previous:next),[]);
  const [workQueue,setWorkQueue]=useState(false);
  const [requestId,setRequestId]=useState(()=>new URLSearchParams(location.search).get('request')||'');
  const initialQuery=new URLSearchParams(location.search);
  const [status,setStatus]=useState(()=>['open','resolved','all','unknown'].includes(initialQuery.get('status'))?initialQuery.get('status'):'open');
  const [assignment,setAssignment]=useState(()=>['mine','unassigned','assigned','all','unknown'].includes(initialQuery.get('assignment'))?initialQuery.get('assignment'):'all');
  function changeQueue(field,value){
    if(field==='status')setStatus(value);else setAssignment(value);
    const query=new URLSearchParams(location.search);query.set(field,value);
    navigate(`${location.pathname}?${query}`,{replace:true});
  }
  const backlog=source==='native'&&(status==='open'||assignment==='unassigned');
  const dateParams=filterParams(filters);
  const initials=name=>String(name||'?').split(/\s+/).map(x=>x[0]).slice(0,2).join('').toUpperCase();
  const shortTime=value=>{const d=new Date(value);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dubai',hour:'2-digit',minute:'2-digit'}).format(d):'';};
  if(backlog){delete dateParams.from;delete dateParams.to;}
  const [selected,setSelected]=useState(()=>new URLSearchParams(location.search).get('conversation')||'');
  const [context,setContext]=useState(false),[actionId,setActionId]=useState('');
  const transcript=useRef(null),atBottom=useRef(true),lastSeen=useRef({chat:'',message:''});
  const [newMessages,setNewMessages]=useState(false);
  const list=useInboxPages('/conversations',{...dateParams,source,...(source==='native'?{status,assignment}:{}),limit:50},'conversations',epoch);
  const detail=useInboxPages(selected?`/conversations/${encodeURIComponent(selected)}`:null,{limit:100},'messages',epoch);
  const owners=useServiceResource(selected?'/owners':null,{},epoch);
  const currentUserId=idOf(me.profile?.userId||user?._id);
  useArrivalObservations(detail.rows,transcript,currentUserId);
  const conversation=detail.data?.conversation;
  const drawerActive=useIssueDrawer({open:panelOpen,panelRef,onClose:closeWork,conversationId:selected,ready:!!conversation});
  const issues=detail.data?.issues||[];
  const actions=detail.data?.actions||[];
  const chosen=actions.find(action=>idOf(action)===actionId);
  function open(id){setRequestId('');setRequestMessage(null);setReopenTarget(null);setCreateSignal(0);setIssueOverview({requests:[]});setActiveIssue(null);setTargetMessageId('');setHighlightMessageId('');setEvidenceError('');atBottom.current=true;setNewMessages(false);setSelected(id);setActionId('');setContext(false);navigate(`${location.pathname}${serviceFilterSearch(filters)}&status=${status}&assignment=${assignment}&conversation=${encodeURIComponent(id)}`,{replace:true});}
  const saved=(request)=>{setActionId('');setReopenTarget(null);if(request?._id){setRequestMessage(null);setRequestId(request._id);}detail.refresh();onRefresh();};
  const viewMessage=id=>{lastEvidence.current=id;evidenceCursor.current=null;atBottom.current=false;setEvidenceError('');setTargetMessageId(id);setPanelOpen(false);};
  const reopenFromMessage=message=>{if(message.authorType!=='customer'||!activeIssue?.canWork||!['resolved','non_customer'].includes(activeIssue.status))return;setRequestMessage(null);setRequestId(activeIssue._id);setReopenTarget({requestId:activeIssue._id,message});setPanelOpen(true);};
  useEffect(()=>{
    if(!targetMessageId)return;
    const element=document.getElementById('cs-message-'+targetMessageId);
    if(element){element.scrollIntoView?.({block:'center'});element.focus({preventScroll:true});setHighlightMessageId(targetMessageId);setTargetMessageId('');return;}
    if(detail.loading||detail.loadingMore)return;
    if(detail.error&&evidenceCursor.current===detail.nextCursor){setEvidenceError('The linked message could not be loaded. Retry to continue.');setTargetMessageId('');return;}
    if(detail.hasMore&&!detail.loadingMore){if(evidenceCursor.current===detail.nextCursor)return;evidenceCursor.current=detail.nextCursor;detail.loadMore();}
    else if(!detail.loading&&!detail.loadingMore){setEvidenceError('The linked message is not in the available capture. Its saved reference is retained.');setTargetMessageId('');}
  },[targetMessageId,detail.rows,detail.loading,detail.loadingMore,detail.error,detail.hasMore,detail.nextCursor]);
  useLayoutEffect(()=>{
    const panel=transcript.current,last=idOf(detail.rows.at(-1));
    if(!panel||!last)return;
    if(prependAnchor.current&&prependAnchor.current.first!==idOf(detail.rows[0])){panel.scrollTop=panel.scrollHeight-prependAnchor.current.height+prependAnchor.current.top;prependAnchor.current=null;}
    else if(lastSeen.current.chat!==selected||atBottom.current){panel.scrollTop=panel.scrollHeight;setNewMessages(false);}
    else if(lastSeen.current.message!==last)setNewMessages(true);
    lastSeen.current={chat:selected,message:last};
  },[detail.rows,selected]);
  const showLatest=()=>{if(transcript.current)transcript.current.scrollTop=transcript.current.scrollHeight;atBottom.current=true;setNewMessages(false);};
  return <div className={capabilities.sidebarSandbox?'cs-chat-shell cs-sandbox-shell':'cs-chat-shell'}>
    {capabilities.sidebarSandbox&&<SidebarSandbox conversationId={selected} epoch={epoch} onRefresh={()=>{detail.refresh();onRefresh();}} onOpen={id=>{setPanelOpen(true);open(id);}}/>}
    <div className={`cs-inbox ${selected?'has-conversation':''} ${panelOpen?'work-panel-open':''}`}>
      <aside className="cs-card cs-inbox-list" aria-label="Conversations">
<div className="cs-inbox-search"><input aria-label="Search customer service" placeholder="Search conversations" value={filters.search||''} onChange={e=>onFiltersChange?.({...filters,search:e.target.value})}/><details className="cs-secondary-menu"><summary aria-label="More staff tools">☰</summary>{navigation}{capabilities.supervise&&<button disabled={!selected} onClick={()=>setDetailsOpen(!detailsOpen)}>Source diagnostics</button>}<button onClick={()=>setWorkQueue(!workQueue)}>My work & follow-ups</button><button onClick={onRefresh}>Refresh saved data</button></details></div><nav className="cs-queue-tabs" aria-label="Conversation queues">{[['mine','Mine'],['unassigned','Unassigned'],['all','All open']].map(([value,label])=><button key={value} aria-pressed={status==='open'&&assignment===value} onClick={()=>{setSource('native');setWorkQueue(false);setStatus('open');setAssignment(value);const q=new URLSearchParams(location.search);q.set('status','open');q.set('assignment',value);navigate(location.pathname+'?'+q,{replace:true});}}>{label}</button>)}</nav><button className="cs-my-work" onClick={()=>setWorkQueue(!workQueue)}>{workQueue?"Back to chats":"My work & follow-ups"}</button><nav className="cs-inbox-mode" hidden aria-label="Inbox view"><button aria-pressed={!workQueue} onClick={()=>setWorkQueue(false)}>Conversations</button><button aria-pressed={workQueue} onClick={()=>setWorkQueue(true)}>Staff work</button></nav>
{workQueue?<RequestQueues capabilities={capabilities} epoch={epoch} onOpen={r=>{setPanelOpen(true);open(idOf(r.conversationId));setRequestId(r._id||'');if(r.candidate)setRequestMessage({_id:r.originMessageId,text:r.excerpt});}}/>:<>
    <details className="cs-queue-filters"><summary>Filters & history</summary><div className="cs-toolbar"><div><span className="cs-muted">Provider conversations · read only</span></div><label className="cs-inbox-source">Show<select aria-label="Conversation source" value={source} onChange={event=>{setSource(event.target.value);setSelected('');setActionId('');}}><option value="native">Native chats</option><option value="history">Workbook excerpts</option></select></label></div>
    {<div className="cs-chip-row" role="group" aria-label="Conversation dates"><button type="button" aria-pressed={filters.from===dubaiToday()&&filters.to===dubaiToday()} onClick={()=>onFiltersChange?.({...filters,from:dubaiToday(),to:dubaiToday()})}>Today</button><button type="button" aria-pressed={!filters.from&&!filters.to} onClick={()=>onFiltersChange?.({...filters,from:'',to:''})}>All time</button></div>}<div className="cs-period"><label>From<input type="date" aria-label="From date in Dubai" value={filters.from||''} onChange={e=>onFiltersChange?.({...filters,from:e.target.value})}/></label><label>To<input type="date" aria-label="To date in Dubai" value={filters.to||''} onChange={e=>onFiltersChange?.({...filters,to:e.target.value})}/></label></div><label>Review category<select aria-label="Review category filter" value={filters.categoryId||''} onChange={e=>onFiltersChange?.({...filters,categoryId:e.target.value})}><option value="">All review categories</option>{categories.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
    {source==='native'&&<div className="cs-toolbar" aria-label="Inbox filters"><label>Conversation status <select aria-label="Conversation status" value={status} onChange={e=>changeQueue('status',e.target.value)}><option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All statuses</option><option value="unknown">Status unavailable</option></select></label><label>Assignment <select aria-label="Assignment" value={assignment} onChange={e=>changeQueue('assignment',e.target.value)}><option value="all">All assignments</option><option value="mine">Mine (verified identity)</option><option value="unassigned">Unassigned</option><option value="assigned">Assigned</option><option value="unknown">Assignment unavailable</option></select></label>{backlog&&<span className="cs-muted">Backlog · all dates</span>}</div>}
</details><div className="cs-conversation-list-scroll"><ResourceState loading={list.loading} error={list.error}/>{list.data?.queueUnavailableReason&&<p role="status">{list.data.queueUnavailableReason}</p>}
        {list.rows.map(row=><button className={`cs-inbox-row ${(selected===idOf(row)||idOf(conversation?.historyAnchorId)===idOf(row))?'active':''}`} key={idOf(row)} aria-pressed={(selected===idOf(row)||idOf(conversation?.historyAnchorId)===idOf(row))} onClick={()=>open(idOf(row))}><span className="cs-list-avatar" aria-hidden="true">{initials(row.customerName)}</span><span className="cs-inbox-row-top"><strong>{row.customerName||'Unnamed contact'}</strong><time title={formatDubai(row.lastMessageAt)}>{shortTime(row.lastMessageAt)}</time></span><span className="cs-inbox-preview">{row.lastMessage?.text||(row.lastMessage?.authorType==='system'?'Conversation activity':row.lastMessage?.type==='other'?'Message':row.lastMessage?.type)||row.summary||'Open conversation'}</span><span className="cs-inbox-tags">{row.historical&&<span className="cs-badge amber">Workbook excerpt</span>}</span></button>)}
        {!list.loading&&!list.rows.length&&<div className="cs-empty"><h3>No conversations match</h3><p>{backlog?'Try another status or assignment.':'Choose All dates to browse older chats.'}</p></div>}
        {list.hasMore&&<button className="cs-inbox-more" disabled={list.loadingMore} onClick={list.loadMore}>{list.loadingMore?'Loading…':'Load more conversations'}</button>}
        {list.error&&<button onClick={list.refresh}>Retry conversation list</button>}
      </div></>}
      </aside>
      <div className="cs-inbox-detail" key={selected||'empty'}>
        {!selected?<section className="cs-card cs-empty"><h3>Select a conversation</h3></section>:<>
          <ResourceState loading={detail.loading} error={detail.error}/>
          {detail.error&&<button onClick={detail.refresh}>Retry conversation</button>}
          {conversation&&<>
            <div className="cs-toolbar cs-inbox-contact"><button className="cs-mobile-back" onClick={()=>setSelected('')}>‹ Chats</button><span className="cs-contact-avatar" aria-hidden="true">{initials(conversation.customerName)}</span><div className="cs-contact-name"><h3>{conversation.customerName||'Unnamed contact'}</h3><span className="cs-owner-line">{conversation.providerInbox?.status==='open'?'Open':conversation.providerInbox?.status==='resolved'?'Resolved':'Status unavailable'} · Chat assigned to {conversation.providerInbox?.assignment==='unassigned'?'Unassigned':conversation.providerInbox?.assigneeName||'Not recorded'}</span></div><div className="cs-form-actions"><button className="cs-work-toggle" aria-expanded={panelOpen} onClick={()=>setPanelOpen(!panelOpen)}>Work items</button></div></div>
            <div className="cs-context-tools" aria-label="Source diagnostics" hidden={!detailsOpen}><h4>Source diagnostics</h4><p className="cs-muted">{conversation.threadCount||1} source threads · {conversation.coverageStatus==='partial'?'Partial capture':'Completeness unknown'} · {conversation.linkOverride?conversation.navigationCustomerId:conversation.customerId||'Unmatched contact'}</p><p className="cs-muted">{health.error?'Capture health unavailable':health.data?.control?.hasError?'Capture error — updates may be delayed':health.data?.control?.enabled===false?'Capture disabled':'Last successful capture: '+formatDubai(health.data?.control?.lastSuccessAt)}. No complete-provider coverage claim.</p>
            {capabilities.supervise&&conversation.source==='gallabox'&&<CustomerLinkReview key={selected} conversationId={selected} messages={detail.rows} onSaved={()=>{detail.refresh();onRefresh();}}/>}
            {conversation.historyRecovery&&<details className="cs-history-coverage"><summary>{conversation.historyRecovery.hasError?'History recovery needs retry':conversation.historyRecovery.pending?'Checking older source history':'Available source history checked'}</summary><p className="cs-muted">Last successful page: {formatDubai(conversation.historyRecovery.lastSuccessAt)} · Page {conversation.historyRecovery.page}. A completed scan means the provider returned no more pages; it does not prove deleted or expired messages are recoverable.</p></details>}
            <div className="cs-secondary-history">{issues.length>0&&<details className="cs-card cs-inbox-work"><summary>Historical review records · {issues.length} source episodes · {actions.filter(action=>action.status!=='completed').length} open actions</summary>
              {issues.filter(issue=>issue.summary||issue.boundaryState==='confirmed').map(issue=><div key={idOf(issue)} className="cs-toolbar"><div><strong>{issue.summary||`Source episode · ${formatDubai(issue.episodeFrom||issue.createdAt)}`}</strong><p className="cs-muted">{categoryLabels(issue.categoryIds,categories)} · {prettyStatus(issue.outcome)}</p></div></div>)}
              {actions.map(action=><div key={idOf(action)} className="cs-toolbar"><div><strong>{action.description}</strong><p className="cs-muted">{prettyStatus(action.status)} · {formatDubai(action.dueAt)} · {owners.data?.owners?.find(owner=>idOf(owner.userId||owner)===idOf(action.ownerId))?.displayName||(action.ownerId?'Assigned':'Unassigned')}</p></div><button onClick={()=>setActionId(idOf(action))}>{capabilities.supervise||idOf(action.ownerId)===currentUserId?'Manage action':'View history'}</button></div>)}
              {capabilities.review&&<p><a href={`${servicePath}/reviews${serviceFilterSearch(filters)}`}>Open assigned reviews</a></p>}
            </details>}
            {chosen&&<ActionEditor key={`${idOf(chosen)}-${chosen.version}`} action={chosen} owners={owners.data?.owners||[]} capabilities={capabilities} currentUserId={currentUserId} onSaved={saved} onClose={()=>setActionId('')}/>}</div>
            </div>
            {!issueOverview.adding&&<IssueOverview compact requests={issueOverview.requests} counts={issueOverview.counts} selectedId={issueOverview.selectedId} actorId={currentUserId} conversationId={selected} owners={owners.data?.owners||[]} onSelect={r=>{setRequestMessage(null);setReopenTarget(null);setRequestId(r._id);setPanelOpen(true);}} onAdd={capabilities.assignRequests?()=>{setPanelOpen(true);setCreateSignal(n=>n+1);}:undefined}/>}
            {targetMessageId&&<p role="status">Finding linked message… <button onClick={()=>setTargetMessageId('')}>Cancel</button></p>}{evidenceError&&<p role="alert">{evidenceError} <button onClick={()=>viewMessage(lastEvidence.current)}>Retry linked message</button></p>}
            {detail.hasMore&&<button disabled={detail.loadingMore} onClick={()=>{atBottom.current=false;if(transcript.current)prependAnchor.current={first:idOf(detail.rows[0]),height:transcript.current.scrollHeight,top:transcript.current.scrollTop};detail.loadMore();}}>{detail.loadingMore?'Loading…':'Load older messages'}</button>}
            <div className="cs-conversation-workspace"><div className="cs-transcript-column"><div className="cs-inbox-transcript" ref={transcript} onScroll={event=>{const panel=event.currentTarget;atBottom.current=panel.scrollHeight-panel.scrollTop-panel.clientHeight<70;if(atBottom.current)setNewMessages(false);}}><Conversation highlightMessageId={highlightMessageId} onReopen={activeIssue?.canWork&&['resolved','non_customer'].includes(activeIssue.status)?reopenFromMessage:undefined} reopenAfter={activeIssue?.resolution?.at} reopenIssueTitle={activeIssue?.title} sourceDetails={detailsOpen} onRequest={chooseMessage} conversationId={selected} issue={{...conversation,summary:'Conversation history'}} messages={detail.rows}/></div><div className="cs-conversation-footer"><span>{capabilities.sidebarSandbox?'QA playground · No messages are sent':health.data?.fictional?'Fictional local review · No messages are sent':health.data?.control?.hasError?'Capture error · updates may be delayed':health.data?.control?.enabled===false?'Capture disabled':'Replies are sent in Gallabox'}</span><button onClick={showLatest}>{newMessages?'New messages ↓':'Latest messages ↓'}</button></div></div><RequestWork sessions={detail.data?.sessions||[]} messages={detail.rows} actorId={currentUserId} onRestoreEvidence={id=>{const m=detail.rows.find(row=>idOf(row)===id);if(!m)return false;chooseMessage(m);return true;}} requestId={requestId} conversationId={selected} message={requestMessage} capabilities={capabilities} owners={owners.data?.owners||[]} epoch={epoch} onSaved={saved} onClose={closeWork} panelRef={panelRef} drawerActive={drawerActive} onOverviewChange={overviewChanged} onActiveIssueChange={activeChanged} onViewMessage={viewMessage} reopenMessage={reopenTarget?.message} reopenRequestId={reopenTarget?.requestId} createSignal={createSignal} conversation={conversation} onOpenConversation={id=>{setPanelOpen(true);open(id);}} onViewAccount={()=>setContext(true)}/></div>

          </>}
        </>}
      </div>
    </div>
    {context&&conversation&&!capabilities.sidebarSandbox&&<CustomerContextDrawer filters={filters} customerId={conversation.linkOverride?conversation.navigationCustomerId:conversation.customerId} customerName={conversation.customerName} issues={issues} categories={categories} capabilities={capabilities} currentUserId={currentUserId} onClose={()=>setContext(false)}/>}
  </div>;
}
