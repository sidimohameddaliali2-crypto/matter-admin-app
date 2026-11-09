import RequestWork,{RequestQueues} from '../../components/customerService/RequestWork';
import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import api from '../../utils/api';
import Conversation from '../../components/customerService/Conversation';
import CustomerContextDrawer from '../../components/customerService/CustomerContext';
import ActionEditor from '../../components/customerService/ActionEditor';
import {categoryLabels, errorMessage, filterParams, formatDubai, idOf, prettyStatus, ResourceState, serviceFilterSearch, servicePath, unpack, useServiceResource} from '../../components/customerService/serviceUtils';

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

export default function CustomerChats({me,user,capabilities,categories,filters,epoch,onRefresh}) {
  const location=useLocation(),navigate=useNavigate();
  const [source,setSource]=useState('native');
  const [requestMessage,setRequestMessage]=useState(null);
  const [workQueue,setWorkQueue]=useState(false);
  const [requestId,setRequestId]=useState(()=>new URLSearchParams(location.search).get('request')||'');
  const initialQuery=new URLSearchParams(location.search);
  const [status,setStatus]=useState(()=>['open','resolved','all','unknown'].includes(initialQuery.get('status'))?initialQuery.get('status'):'open');
  const [assignment,setAssignment]=useState(()=>['unassigned','assigned','all','unknown'].includes(initialQuery.get('assignment'))?initialQuery.get('assignment'):'all');
  function changeQueue(field,value){
    if(field==='status')setStatus(value);else setAssignment(value);
    const query=new URLSearchParams(location.search);query.set(field,value);
    navigate(`${location.pathname}?${query}`,{replace:true});
  }
  const backlog=source==='native'&&(status==='open'||assignment==='unassigned');
  const dateParams=filterParams(filters);
  if(backlog){delete dateParams.from;delete dateParams.to;}
  const [selected,setSelected]=useState(()=>new URLSearchParams(location.search).get('conversation')||'');
  const [context,setContext]=useState(false),[actionId,setActionId]=useState('');
  const transcript=useRef(null),atBottom=useRef(true),lastSeen=useRef({chat:'',message:''});
  const [newMessages,setNewMessages]=useState(false);
  const list=useInboxPages('/conversations',{...dateParams,source,...(source==='native'?{status,assignment}:{}),limit:50},'conversations',epoch);
  const detail=useInboxPages(selected?`/conversations/${encodeURIComponent(selected)}`:null,{limit:100},'messages',epoch);
  const owners=useServiceResource(selected?'/owners':null,{},epoch);
  const currentUserId=idOf(me.profile?.userId||user?._id);
  const conversation=detail.data?.conversation;
  const issues=detail.data?.issues||[];
  const actions=detail.data?.actions||[];
  const chosen=actions.find(action=>idOf(action)===actionId);
  function open(id){setRequestId('');setRequestMessage(null);atBottom.current=true;setNewMessages(false);setSelected(id);setActionId('');setContext(false);navigate(`${location.pathname}${serviceFilterSearch(filters)}&status=${status}&assignment=${assignment}&conversation=${encodeURIComponent(id)}`,{replace:true});}
  const saved=(request)=>{setActionId('');if(request?._id){setRequestMessage(null);setRequestId(request._id);}detail.refresh();onRefresh();};
  useLayoutEffect(()=>{
    const panel=transcript.current,last=idOf(detail.rows.at(-1));
    if(!panel||!last)return;
    if(lastSeen.current.chat!==selected||atBottom.current){panel.scrollTop=panel.scrollHeight;setNewMessages(false);}
    else if(lastSeen.current.message!==last)setNewMessages(true);
    lastSeen.current={chat:selected,message:last};
  },[detail.rows,selected]);
  const showLatest=()=>{if(transcript.current)transcript.current.scrollTop=transcript.current.scrollHeight;atBottom.current=true;setNewMessages(false);};
  return <>
    <div className="cs-inbox">
      <aside className="cs-card cs-inbox-list" aria-label="Conversations">
<nav className="cs-inbox-mode" aria-label="Inbox view"><button aria-pressed={!workQueue} onClick={()=>setWorkQueue(false)}>Conversations</button><button aria-pressed={workQueue} onClick={()=>setWorkQueue(true)}>Staff work</button></nav>
{workQueue?<RequestQueues capabilities={capabilities} epoch={epoch} onOpen={r=>{open(idOf(r.conversationId));setRequestId(r._id||'');if(r.candidate)setRequestMessage({_id:r.originMessageId,text:r.excerpt});}}/>:<>
    <div className="cs-toolbar"><div><h2>Inbox</h2><span className="cs-muted">{list.error||detail.error?'Updates paused · retrying':'Incoming chats update automatically'}</span></div><label className="cs-inbox-source">Show<select aria-label="Conversation source" value={source} onChange={event=>{setSource(event.target.value);setSelected('');setActionId('');}}><option value="native">Native chats</option><option value="history">Workbook excerpts</option></select></label></div>
    {source==='native'&&<div className="cs-toolbar" aria-label="Inbox filters"><label>Conversation status <select aria-label="Conversation status" value={status} onChange={e=>changeQueue('status',e.target.value)}><option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All statuses</option><option value="unknown">Status unavailable</option></select></label><label>Assignment <select aria-label="Assignment" value={assignment} onChange={e=>changeQueue('assignment',e.target.value)}><option value="all">All assignments</option><option value="unassigned">Unassigned</option><option value="assigned">Assigned</option><option value="unknown">Assignment unavailable</option></select></label>{backlog&&<span className="cs-muted">Backlog · all dates</span>}</div>}
<ResourceState loading={list.loading} error={list.error}/>
        {list.rows.map(row=><button className={`cs-inbox-row ${(selected===idOf(row)||idOf(conversation?.historyAnchorId)===idOf(row))?'active':''}`} key={idOf(row)} aria-pressed={(selected===idOf(row)||idOf(conversation?.historyAnchorId)===idOf(row))} onClick={()=>open(idOf(row))}><span className="cs-inbox-row-top"><strong>{row.customerName||'Unnamed contact'}</strong><time>{formatDubai(row.lastMessageAt)}</time></span><span className="cs-inbox-preview">{row.lastMessage?.text||(row.lastMessage?.authorType==='system'?'Conversation activity':row.lastMessage?.type==='other'?'Message':row.lastMessage?.type)||row.summary||'Open conversation'}</span><span className="cs-inbox-tags">{row.providerInbox&&<><span className="cs-badge">{row.providerInbox.status==='open'?'Open':row.providerInbox.status==='resolved'?'Resolved':'Status unavailable'}</span><span className="cs-badge">{row.providerInbox.assignment==='unassigned'?'Unassigned':row.providerInbox.assignment==='assigned'?row.providerInbox.assigneeName||'Assigned':'Assignment unavailable'}</span></>}{!row.customerId&&<span className="cs-badge">Unmatched contact</span>}{row.historical&&<span className="cs-badge amber">Workbook excerpt</span>}{row.groupingUnverified&&<span className="cs-muted">Grouping unverified</span>}</span></button>)}
        {!list.loading&&!list.rows.length&&<div className="cs-empty"><h3>No conversations match</h3><p>{backlog?'Try another status or assignment.':'Choose All time to browse older chats.'}</p></div>}
        {list.hasMore&&<button className="cs-inbox-more" disabled={list.loadingMore} onClick={list.loadMore}>{list.loadingMore?'Loading…':'Load more conversations'}</button>}
        {list.error&&<button onClick={list.refresh}>Retry conversation list</button>}
      </>}
      </aside>
      <div className="cs-inbox-detail" key={selected||'empty'}>
        {!selected?<section className="cs-card cs-empty"><h3>Select a conversation</h3></section>:<>
          <ResourceState loading={detail.loading} error={detail.error}/>
          {detail.error&&<button onClick={detail.refresh}>Retry conversation</button>}
          {conversation&&<>
            <div className="cs-toolbar cs-inbox-contact"><div><h3>{conversation.customerName||'Unnamed contact'}</h3>{conversation.providerInbox&&<div className="cs-inbox-tags"><span className="cs-muted">Gallabox</span><span className="cs-badge">{conversation.providerInbox.status==='open'?'Open':conversation.providerInbox.status==='resolved'?'Resolved':'Status unavailable'}</span><span className="cs-badge">{conversation.providerInbox.assignment==='unassigned'?'Unassigned':conversation.providerInbox.assignment==='assigned'?conversation.providerInbox.assigneeName||'Assigned':'Assignment unavailable'}</span></div>}<span className="cs-muted">{conversation.customerId||'Unmatched contact'} · {conversation.historical?'Workbook excerpt':`${conversation.threadCount||1} source thread${conversation.threadCount===1?'':'s'}`} · {conversation.coverageStatus==='complete'?'Source marks capture complete':conversation.coverageStatus==='partial'?'Partial capture':'Completeness unknown'}</span></div><div className="cs-form-actions"><button onClick={showLatest}>{newMessages?'New messages ↓':'Latest messages'}</button><button onClick={()=>setContext(true)}>View customer</button></div></div>
            {conversation.historyRecovery&&<details className="cs-history-coverage"><summary>{conversation.historyRecovery.hasError?'History recovery needs retry':conversation.historyRecovery.pending?'Checking older source history':'Available source history checked'}</summary><p className="cs-muted">Last successful page: {formatDubai(conversation.historyRecovery.lastSuccessAt)} · Page {conversation.historyRecovery.page}. A completed scan means the provider returned no more pages; it does not prove deleted or expired messages are recoverable.</p></details>}
            {detail.hasMore&&<button disabled={detail.loadingMore} onClick={()=>{atBottom.current=false;detail.loadMore();}}>{detail.loadingMore?'Loading…':'Load older messages'}</button>}
            <div className="cs-conversation-workspace"><div><div className="cs-inbox-transcript" ref={transcript} onScroll={event=>{const panel=event.currentTarget;atBottom.current=panel.scrollHeight-panel.scrollTop-panel.clientHeight<70;if(atBottom.current)setNewMessages(false);}}><Conversation onRequest={setRequestMessage} conversationId={selected} issue={{...conversation,summary:'Conversation history'}} messages={detail.rows}/></div></div><RequestWork requestId={requestId} conversationId={selected} message={requestMessage} capabilities={capabilities} owners={owners.data?.owners||[]} epoch={epoch} onSaved={saved}/></div>
            {issues.length>0&&<details className="cs-card cs-inbox-work"><summary>Historical review records · {issues.length} source episodes · {actions.filter(action=>action.status!=='completed').length} open actions</summary>
              {issues.filter(issue=>issue.summary||issue.boundaryState==='confirmed').map(issue=><div key={idOf(issue)} className="cs-toolbar"><div><strong>{issue.summary||`Source episode · ${formatDubai(issue.episodeFrom||issue.createdAt)}`}</strong><p className="cs-muted">{categoryLabels(issue.categoryIds,categories)} · {prettyStatus(issue.outcome)}</p></div></div>)}
              {actions.map(action=><div key={idOf(action)} className="cs-toolbar"><div><strong>{action.description}</strong><p className="cs-muted">{prettyStatus(action.status)} · {formatDubai(action.dueAt)} · {owners.data?.owners?.find(owner=>idOf(owner.userId||owner)===idOf(action.ownerId))?.displayName||(action.ownerId?'Assigned':'Unassigned')}</p></div><button onClick={()=>setActionId(idOf(action))}>{capabilities.supervise||idOf(action.ownerId)===currentUserId?'Manage action':'View history'}</button></div>)}
              {capabilities.review&&<p><a href={`${servicePath}/reviews${serviceFilterSearch(filters)}`}>Open assigned reviews</a></p>}
            </details>}
            {chosen&&<ActionEditor key={`${idOf(chosen)}-${chosen.version}`} action={chosen} owners={owners.data?.owners||[]} capabilities={capabilities} currentUserId={currentUserId} onSaved={saved} onClose={()=>setActionId('')}/>}
          </>}
        </>}
      </div>
    </div>
    {context&&conversation&&<CustomerContextDrawer filters={filters} customerId={conversation.customerId} customerName={conversation.customerName} issues={issues} categories={categories} capabilities={capabilities} currentUserId={currentUserId} onClose={()=>setContext(false)}/>}
  </>;
}
