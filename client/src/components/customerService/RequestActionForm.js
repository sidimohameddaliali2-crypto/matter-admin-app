import React,{useEffect,useRef,useState} from 'react';
import api from '../../utils/api';
import {servicePath,unpack,errorMessage,idOf,formatDubai,newRequestId} from './serviceUtils';
import {workflowTopic,topicName,topicDetailName} from './requestTopics';
import IssueDetailPicker from './IssueDetailPicker';
import RequestTypeButtons from './RequestTypeButtons';

const localTime=value=>value?new Date(new Date(value).getTime()+14400000).toISOString().slice(0,16):'';
export default function RequestActionForm({request,message,messages=[],definitions,owners,actorId,conversationId,conversationScope=false,splitParent,suggestedOwnerId,onSaved,onDraftStateChange,reopen=false,reopenMessage,capabilities={},qaState}){
 const reopeningNonCustomer=reopen&&['spam','vendor','non_customer'].includes(request?.classification?.kind);
 const baseStorageKey=`matter:action-draft:${actorId}:${conversationId}:${splitParent?'split:':''}${request?._id||(conversationScope?'conversation':message?._id)}`,storageKey=baseStorageKey+(reopen?':reopen':'');
 const legacyReopen=useRef(null);
 const read=()=>{try{const current=JSON.parse(sessionStorage.getItem(storageKey));if(current)return current;if(reopen){const text=sessionStorage.getItem(baseStorageKey),previous=JSON.parse(text);if(previous?.reopen||previous?.fields?.reopenReason||previous?.fields?.reopenMessageId){legacyReopen.current=text;return previous;}}return null;}catch{return null;}};
 const clearDraft=()=>{draftActive.current=false;actionDrafts.current={};try{sessionStorage.removeItem(storageKey);if(legacyReopen.current&&sessionStorage.getItem(baseStorageKey)===legacyReopen.current)sessionStorage.removeItem(baseStorageKey);}catch{/* Storage failure must not reverse a confirmed server save. */}};
 const initial=useRef(read());
 const actionDrafts=useRef(initial.current?.actionDrafts||{});
 const draftActive=useRef(Boolean(initial.current));
 const next=[...(request?.followups||[])].filter(f=>f.status!=='completed').sort((a,b)=>new Date(a.dueAt)-new Date(b.dueAt))[0]||request?.nextAction;
 const [fields,setFields]=useState(()=>initial.current?.fields||{kind:reopeningNonCustomer?'':request?.classification?.kind||(!request&&capabilities.sidebarSandbox?'inquiry':''),topic:reopeningNonCustomer?'':request?.classification?.topic||'',subtopic:reopeningNonCustomer?'':request?.classification?.subtopic||'',ownerId:suggestedOwnerId||'',nextAction:next?.action||'',dueAt:localTime(next?.dueAt),waitingOn:request?.waitingOn||'',customerUpdateDueAt:reopen?'':localTime(request?.customerUpdateDueAt),details:{}});
 const classificationOnly=!request&&conversationScope&&['spam','vendor','non_customer'].includes(fields.kind);
 const [version,setVersion]=useState(()=>initial.current?.version??request?.version);
 const [commandKey,setCommandKey]=useState(()=>initial.current?.commandKey||newRequestId());
 const [splitKey]=useState(()=>initial.current?.splitKey||newRequestId());
 const [issueKey]=useState(()=>initial.current?.issueKey||newRequestId());
 const [parentVersion,setParentVersion]=useState(()=>initial.current?.parentVersion??splitParent?.version);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
 const [editingOwner,setEditingOwner]=useState(false),[showDescription,setShowDescription]=useState(false);
 const saving=useRef(false);
 const ownerTouched=useRef(false);
 useEffect(()=>{if(reopen&&reopenMessage?.authorType==='customer'&&idOf(reopenMessage)!==initial.current?.fields?.reopenMessageId){draftActive.current=true;setFields(f=>({...f,reopenMessageId:idOf(reopenMessage)}));setCommandKey(newRequestId());}},[reopen,idOf(reopenMessage)]);
 useEffect(()=>{
  if(!request&&suggestedOwnerId&&!ownerTouched.current&&!initial.current?.fields?.ownerId)setFields(f=>f.ownerId?f:{...f,ownerId:suggestedOwnerId});
 },[suggestedOwnerId,request?._id]);
 useEffect(()=>{
  if(request&&!draftActive.current&&!initial.current&&!reopeningNonCustomer){setVersion(request.version);setFields(f=>({...f,kind:request.classification?.kind||'',topic:request.classification?.topic||'',subtopic:request.classification?.subtopic||'',nextAction:next?.action||'',dueAt:localTime(next?.dueAt),waitingOn:request.waitingOn||'',customerUpdateDueAt:reopen?'':localTime(request.customerUpdateDueAt)}));}
 },[request?.version,reopeningNonCustomer]);
 const fieldClassification={kind:fields.kind,topic:fields.topic,...(fields.subtopic?{subtopic:fields.subtopic}:{})};
 const currentClassification=request&&!reopeningNonCustomer?request.classification:fieldClassification;
 const currentTopic=currentClassification?.topic||'';
 const currentSubtopic=currentClassification?.subtopic||'';
 const currentWorkflow=workflowTopic(currentClassification,definitions);
 const selectedTopic=definitions.topics.find(topic=>topic.id===fields.topic);
 const selectedDetail=selectedTopic?.includes?.find(detail=>detail.id===fields.subtopic);
 const newTagDefinitions=definitions.topics.some(topic=>Array.isArray(topic.includes));
 const simpleSurface=capabilities.sidebarSandbox||definitions.issuePicker?.available===true;
 const requiresCurrentDetail=(!request||reopeningNonCustomer)&&newTagDefinitions&&!classificationOnly;
 const legacyDraftNeedsReview=Boolean(requiresCurrentDetail&&fields.topic&&!selectedTopic);
 const staleDetailNeedsReview=Boolean(requiresCurrentDetail&&selectedTopic&&fields.subtopic&&!selectedDetail);
 const classificationChanged=Boolean(request&&!reopeningNonCustomer&&(fields.topic!==currentTopic||(fields.subtopic||'')!==currentSubtopic));
 const actions=((classificationOnly||requiresCurrentDetail&&!selectedDetail?[]:definitions.actions?.[currentWorkflow])||[]).filter(a=>!reopen||!a.terminal);
 const allowed=a=>capabilities.previewReadOnly||!a.terminal||!['refund','food_quality'].includes(currentWorkflow)||capabilities.closeSensitive;
 const action=classificationChanged?null:actions.find(a=>a.code===fields.actionCode);
 const previousAction=classificationChanged||legacyDraftNeedsReview||staleDetailNeedsReview?definitions.actions?.[workflowTopic(fieldClassification,definitions)]?.find(a=>a.code===fields.actionCode):null;
 const previousFields=[...(previousAction?.fields||[]),...(previousAction?.outcomes?.find(o=>o.code===fields.outcomeCode)?.fields||[])];
 const outcome=action?.outcomes?.find(o=>o.code===fields.outcomeCode);
 const isFollowup=a=>['followup_other','followup','team'].includes(a.code);
 const pendingActions=actions.filter(a=>!a.terminal&&a.code!=='followup_other'&&(!simpleSurface||!isFollowup(a)));
 const followupChoices=actions.filter(a=>!a.terminal&&isFollowup(a));
 const followupAction=actions.find(a=>a.code==='followup_other')||followupChoices[0]||pendingActions[0];
 const terminalChoices=actions.filter(a=>a.terminal).flatMap(a=>(a.outcomes||[]).filter(o=>o.code!=='day_credit_applied'||!capabilities.sidebarSandbox||qaState?.practice?.detail==='missed_delivery').map(o=>({key:a.code+':'+o.code,action:a,outcome:o})));
 const intent=classificationChanged?'':fields.uiMode||(action?.terminal?'resolve':action?.code==='followup_other'?'followup':action?'update':'');
 const selectedOwner=owners.find(o=>idOf(o.userId||o)===fields.ownerId);
 const defaultSummary=(topicDetailName(fieldClassification,definitions)||topicName(fieldClassification,definitions)).slice(0,160);
 const customerMessage=message?.authorType==='customer'?message:messages.find(m=>m.authorType==='customer'&&idOf(m)===idOf(request?.originMessageId))||messages.find(m=>m.authorType==='customer');
 const qaCredit=qaState?.events?.find(e=>e.kind==='credit_posted'),qaReply=qaState?.events?.find(e=>e.kind==='customer_updated');
 const hasUnsaved=Boolean(draftActive.current&&(fields.actionCode||fields.uiMode||!request&&(fields.kind||fields.topic||fields.title)||reopen&&(fields.reopenReason||fields.reopenMessageId)));
 useEffect(()=>{onDraftStateChange?.();},[hasUnsaved,onDraftStateChange]);
 useEffect(()=>{try{if(hasUnsaved)sessionStorage.setItem(storageKey,JSON.stringify({fields,actionDrafts:actionDrafts.current,reopen,version,commandKey,splitKey,issueKey,parentVersion,sourceMessageId:message?._id,requestId:request?._id}));}catch{/* In-memory input remains available. */}},[storageKey,hasUnsaved,fields,version,commandKey,splitKey,issueKey,parentVersion,reopen]);
 const edit=(name,value)=>{if(name==='ownerId')ownerTouched.current=true;draftActive.current=true;setFields(f=>({...f,[name]:value}));setCommandKey(newRequestId());};
 const detail=(name,value)=>{draftActive.current=true;setFields(f=>({...f,details:{...f.details,[name]:value}}));setCommandKey(newRequestId());};
 const chooseTopic=topic=>{draftActive.current=true;setFields(f=>({...f,topic,subtopic:'',uiMode:'',actionCode:'',outcomeCode:'',details:{},evidenceMessageId:'',evidenceReference:'',waitingOn:''}));setCommandKey(newRequestId());setError('');};
 const chooseDetail=subtopic=>{draftActive.current=true;setFields(f=>({...f,subtopic,uiMode:'',actionCode:'',outcomeCode:'',details:{},evidenceMessageId:'',evidenceReference:'',waitingOn:''}));setCommandKey(newRequestId());setError('');};
 const draftKey=f=>JSON.stringify([f.topic||'',f.subtopic||'',f.uiMode||'',f.actionCode||'',f.outcomeCode||'']);
 const remember=()=>{if(fields.uiMode||fields.actionCode){const snapshot={...fields,details:{...fields.details}};delete actionDrafts.current[draftKey(fields)];actionDrafts.current[draftKey(fields)]=snapshot;}};
 const remembered=mode=>Object.values(actionDrafts.current).reverse().find(f=>f.topic===currentTopic&&(f.subtopic||'')===currentSubtopic&&f.uiMode===mode);
 function defaultDetails(a,outcomeCode=''){
  const details=Object.fromEntries((a.fields||[]).filter(field=>field.type!=='checkbox'&&request?.topicDetails?.[field.id]!=null).map(field=>[field.id,request.topicDetails[field.id]]));
  if(capabilities.sidebarSandbox&&qaState?.practice)for(const field of [...(a.fields||[]),...(a.outcomes?.find(o=>o.code===outcomeCode)?.fields||[])]){
   if(field.id==='deliveryDate')details.deliveryDate=qaState.practice.delivery_date;
   if(field.id==='reference')details.reference=qaState.practice.order_reference;
   if(field.id==='creditReference'&&qaCredit)details.creditReference=qaCredit.body.reference;
  }
  return details;
 }
 function selectAction(a,uiMode='update',outcomeCode=''){
  draftActive.current=true;if(classificationChanged){setVersion(request.version);setConflict(false);}
  remember();const saved=actionDrafts.current[draftKey({topic:currentTopic,subtopic:currentSubtopic,uiMode,actionCode:a.code,outcomeCode})],details=saved?{...saved.details}:defaultDetails(a,outcomeCode);
  if(!request&&conversationScope&&currentWorkflow==='other'&&a.code==='describe'&&fields.title?.trim())details.problem=fields.title.trim();
  setFields(f=>({...f,...saved,kind:request&&!reopeningNonCustomer?request.classification?.kind:f.kind,ownerId:f.ownerId,title:f.title,reopenReason:f.reopenReason,reopenMessageId:f.reopenMessageId,topic:currentTopic,subtopic:currentSubtopic,uiMode,actionCode:a.code,outcomeCode,details,evidenceMessageId:saved?.evidenceMessageId||'',evidenceReference:saved?.evidenceReference||'',waitingOn:saved?.waitingOn??(currentWorkflow==='account_support'&&a.code==='team'?'Technical Support':f.waitingOn),nextAction:saved?.nextAction??(f.nextAction||(!a.terminal&&a.code!=='followup_other'&&currentWorkflow!=='other'?a.label:''))}));
  setCommandKey(newRequestId());setError('');
 }
 function chooseIntent(value,reset=false){
  if(value===intent&&!classificationChanged&&!reset)return;
  const saved=reset?null:remembered(value);
  if(value==='update'){const next=pendingActions.find(a=>a.code===saved?.actionCode)||pendingActions.find(a=>a.featured!==false)||pendingActions[0];if(next)selectAction(next,'update');}
  else if(value==='followup'){const next=followupChoices.find(a=>a.code===saved?.actionCode)||followupAction;if(next)selectAction(next,'followup');}
  else if(saved&&terminalChoices.some(c=>c.action.code===saved.actionCode&&c.outcome.code===saved.outcomeCode)){selectAction(terminalChoices.find(c=>c.action.code===saved.actionCode&&c.outcome.code===saved.outcomeCode).action,'resolve',saved.outcomeCode);}
  else{remember();draftActive.current=true;if(classificationChanged){setVersion(request.version);setConflict(false);}setFields(f=>({...f,kind:request&&!reopeningNonCustomer?request.classification?.kind:f.kind,topic:currentTopic,subtopic:currentSubtopic,uiMode:'resolve',actionCode:'',outcomeCode:'',details:{},evidenceMessageId:'',evidenceReference:''}));setCommandKey(newRequestId());setError('');}
 }
 function chooseIssue(topic,subtopic){
  const classification={kind:fields.kind,topic,subtopic},family=definitions.actions?.[workflowTopic(classification,definitions)]||[],first=family.find(a=>!a.terminal&&!isFollowup(a)&&a.featured!==false)||family.find(a=>!a.terminal&&!isFollowup(a))||family.find(a=>!a.terminal);
  draftActive.current=true;remember();setFields(f=>({...f,topic,subtopic,uiMode:first?isFollowup(first)?'followup':'update':'',actionCode:first?.code||'',outcomeCode:'',details:first?defaultDetails(first):{},evidenceMessageId:'',evidenceReference:'',nextAction:f.nextAction||first?.label||'',waitingOn:''}));setCommandKey(newRequestId());setError('');
 }
 async function submit(event){
  event.preventDefault();if(saving.current)return;saving.current=true;setBusy(true);setError('');
  if(capabilities.previewReadOnly){saving.current=false;setBusy(false);setError('Local preview only. Live records are not changed.');return;}
  try{
   if(classificationOnly){
    if(!definitions.nonCustomerTypes?.available)throw Error('This type is not available for saving yet. Your choice is retained.');
    const result=unpack(await api.post(servicePath+'/requests',{requestId:commandKey,issueKey,conversationId,classificationOnly:true,classification:{kind:fields.kind}}));
    clearDraft();initial.current=null;onSaved(result);return;
   }
   if(!action||!allowed(action))throw Error('Choose an action before saving.');
   const {uiMode,...workFields}=fields;
   const body={...workFields,definitionVersion:definitions.actionVersion,requestId:commandKey,version,operation:'work',reopen,...(reopeningNonCustomer?{classification:fieldClassification}:{}),...(request?{}:{...(conversationScope?{conversationId,issueKey}:{messageId:message?._id}),classification:fieldClassification,title:conversationScope?(fields.title?.trim()?fields.title:defaultSummary):topicName(fieldClassification,definitions)}),...(splitParent?{splitParentId:splitParent._id,parentVersion,splitKey}:{})};
   if(fields.dueAt)body.dueAt=new Date(fields.dueAt+'+04:00').toISOString();
   if(Object.hasOwn(fields,'customerUpdateDueAt'))body.customerUpdateDueAt=fields.customerUpdateDueAt?new Date(fields.customerUpdateDueAt+'+04:00').toISOString():null;
   const result=unpack(await api.post(servicePath+(request?`/requests/${request._id}/commands`:'/work-items'),body));
   clearDraft();setFields(f=>({...f,uiMode:'',actionCode:'',outcomeCode:'',details:{}}));setVersion(result.version);setCommandKey(newRequestId());initial.current=null;setConflict(false);onSaved(result);
  }catch(e){setConflict(e.response?.status===409);setError(errorMessage(e));}finally{saving.current=false;setBusy(false);}
 }
 const human=m=>m.authorType==='staff'&&!m.internalNote&&!m.display?.automatedReply&&m.sourceMetadata?.nativeContent?.kind!=='reaction';
 const evidence=outcome?.code==='day_credit_applied'||outcome?.group==='information'&&outcome.code!=='suggestion_passed'?messages.filter(human):outcome?.group==='withdrawn'?messages.filter(m=>m.authorType==='customer'):messages.filter(m=>['customer','staff'].includes(m.authorType)&&!m.internalNote);
 const input=f=><label key={f.id} className={f.type==='checkbox'?'cs-action-check':''}>{f.type==='checkbox'?<><input aria-label={f.label} type="checkbox" checked={fields.details?.[f.id]===true} onChange={e=>detail(f.id,e.target.checked)} required={f.required}/>{f.label}</>:<>{capabilities.sidebarSandbox&&f.id==='reference'?'Order / plan ref':f.label}{!f.required?' (optional)':''}<input aria-label={f.label} type={f.type} min={f.type==='number'?0:undefined} step={f.type==='number'?'any':undefined} value={fields.details?.[f.id]??''} onInput={e=>detail(f.id,e.target.value)} onChange={e=>detail(f.id,e.target.value)} required={f.required}/></>}</label>;
 return <form className="cs-topic-action" aria-label="Problem action" onSubmit={submit}><fieldset className="cs-action-fields" disabled={busy}>
  {customerMessage&&(!request||intent==='update')&&<blockquote className="cs-customer-excerpt"><span>Customer said</span><p title={customerMessage.text||''}>{customerMessage.text||'Customer attachment — see conversation'}</p></blockquote>}
  {capabilities.previewReadOnly&&<p className="cs-notice">View only · saving is disabled.</p>}
  {reopen&&<><label>Why reopen?<input aria-label="Why reopen this issue?" value={fields.reopenReason||''} onChange={e=>edit('reopenReason',e.target.value)} required/></label><label>Customer follow-up<select aria-label="Related customer message" value={fields.reopenMessageId||''} onChange={e=>edit('reopenMessageId',e.target.value)} required><option value="">Select message</option>{messages.filter(m=>m.authorType==='customer').map(m=><option key={idOf(m)} value={idOf(m)}>{(m.text||'Attachment').slice(0,140)}</option>)}</select></label></>}
  {(!request||reopeningNonCustomer)&&<div className="cs-action-classification">
   {!request&&conversationScope&&definitions.nonCustomerTypes?.available?<RequestTypeButtons value={fields.kind} onChange={value=>edit('kind',value)}/>:<fieldset className="cs-kind-choice" aria-label="Type"><legend className="cs-sr-only">Type</legend>{[['complaint','Complaint'],['inquiry','Inquiry']].map(([value,label])=><label key={value}><input type="radio" name={storageKey+':type'} aria-label={label} value={value} checked={fields.kind===value} onChange={()=>edit('kind',value)} required/>{label}</label>)}</fieldset>}
   {!classificationOnly&&(simpleSurface&&newTagDefinitions&&!legacyDraftNeedsReview&&!staleDetailNeedsReview?<IssueDetailPicker topics={definitions.topics} topic={fields.topic} detail={fields.subtopic} onSelect={chooseIssue}/>:<><label>Topic<select aria-label="Topic" value={fields.topic} onChange={e=>chooseTopic(e.target.value)} required><option value="">Choose topic</option>{legacyDraftNeedsReview&&<option value={fields.topic} disabled>Saved previous topic: {topicName(fieldClassification,definitions)}</option>}{definitions.topics.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
   {Array.isArray(selectedTopic?.includes)&&<label>Issue detail<select aria-label="Issue detail" value={fields.subtopic||''} onChange={e=>chooseDetail(e.target.value)} required><option value="">Choose detail</option>{staleDetailNeedsReview&&<option value={fields.subtopic} disabled>Saved previous issue detail (not current)</option>}{selectedTopic.includes.map(detail=><option key={detail.id} value={detail.id}>{detail.label}</option>)}</select></label>}</>)}
   {!classificationOnly&&(!request||reopen&&!request.ownerId)&&(selectedOwner&&!editingOwner?<div className="cs-owner-compact"><span>Owner</span><strong>{selectedOwner.displayName}</strong><button type="button" aria-label="Change handler" onClick={()=>setEditingOwner(true)}>Change</button></div>:<label>Owner<select aria-label="Handled by" value={fields.ownerId} onChange={e=>{edit('ownerId',e.target.value);setEditingOwner(false);}} required><option value="">Choose staff</option>{owners.map(o=><option key={idOf(o.userId||o)} value={idOf(o.userId||o)}>{o.displayName}</option>)}</select></label>)}
  </div>}
  {splitParent&&<label>Why a separate issue?<input aria-label="Why this is another problem" value={fields.splitReason||''} onChange={e=>edit('splitReason',e.target.value)} required/></label>}
  {(classificationChanged||legacyDraftNeedsReview||staleDetailNeedsReview)&&<div className="cs-notice" role="alert"><p>{legacyDraftNeedsReview?'Choose a current topic and issue detail to continue. Your previous input is retained.':staleDetailNeedsReview?'Choose a current issue detail. Your previous input is retained.':'The issue topic changed to '+topicName(currentClassification,definitions)+(topicDetailName(currentClassification,definitions)?' · '+topicDetailName(currentClassification,definitions):'')+'. Choose an action for the updated topic.'}</p><details><summary>Previous input</summary>{Object.entries(fields.details||{}).map(([name,value])=><p key={name}>{previousFields.find(f=>f.id===name)?.label||'Saved detail'}: {value===true?'Confirmed':String(value)}</p>)}{fields.nextAction&&<p>Next action: {fields.nextAction}</p>}{fields.evidenceReference&&<p>Completion reference: {fields.evidenceReference}</p>}</details></div>}
  {!!actions.length&&<div className="cs-universal-actions" role="group" aria-label="Issue actions">
   {!!pendingActions.length&&<button type="button" aria-pressed={intent==='update'} onClick={()=>chooseIntent('update')}>Update</button>}
   {!!followupAction&&<button type="button" aria-pressed={intent==='followup'} onClick={()=>chooseIntent('followup')}>Follow up</button>}
   {!!terminalChoices.length&&<button type="button" aria-pressed={intent==='resolve'} disabled={!terminalChoices.some(c=>allowed(c.action))} title={!terminalChoices.some(c=>allowed(c.action))?'An authorized closer must record this outcome':undefined} onClick={()=>chooseIntent('resolve')}>Resolve</button>}
  </div>}
  {intent==='update'&&pendingActions.length>1&&<label>Action<select aria-label="Update action" value={action?.code||''} onChange={e=>{const selected=pendingActions.find(a=>a.code===e.target.value);if(selected)selectAction(selected,'update');}} required><option value="">Choose action</option>{pendingActions.map(a=><option key={a.code} value={a.code}>{a.label}</option>)}</select></label>}
  {simpleSurface&&intent==='followup'&&followupChoices.length>1&&<label>Follow-up type<select aria-label="Follow-up type" value={action?.code||''} onChange={e=>{const selected=followupChoices.find(a=>a.code===e.target.value);if(selected)selectAction(selected,'followup');}}>{followupChoices.map(a=><option key={a.code} value={a.code}>{a.code==='followup_other'?'Next check':a.label}</option>)}</select></label>}
  {intent==='resolve'&&<label>Outcome<select aria-label="What happened?" value={action&&outcome?action.code+':'+outcome.code:''} onChange={e=>{const selected=terminalChoices.find(c=>c.key===e.target.value);if(selected)selectAction(selected.action,'resolve',selected.outcome.code);else chooseIntent('resolve',true);}} required><option value="">Choose outcome</option>{terminalChoices.map(c=><option key={c.key} value={c.key} disabled={!allowed(c.action)}>{c.outcome.label}</option>)}</select></label>}
  {action&&allowed(action)&&<>
   {[...(action.fields||[]),...(outcome?.fields||[])].filter((f,i,a)=>a.findIndex(x=>x.id===f.id)===i).map(input)}
   {!action.terminal&&<>
    <label>Next step<input aria-label="What happens next?" placeholder="What needs to happen next?" value={fields.nextAction||''} onChange={e=>edit('nextAction',e.target.value)} required/></label>
    <label>Waiting for<select aria-label="Waiting for" value={fields.waitingOn||''} onChange={e=>edit('waitingOn',e.target.value)}><option value="">Ready to work</option>{['Customer','Delivery','Kitchen','Finance','Technical Support'].map(t=><option key={t}>{t}</option>)}</select></label>
    <label>Due · Dubai<input aria-label="Check again · Dubai" type="datetime-local" value={fields.dueAt||''} onInput={e=>edit('dueAt',e.target.value)} onChange={e=>edit('dueAt',e.target.value)} required/></label>
    {intent==='followup'&&<label>Customer update promised · Dubai (optional)<input aria-label="Customer update promised · Dubai" type="datetime-local" value={fields.customerUpdateDueAt||''} onInput={e=>edit('customerUpdateDueAt',e.target.value)} onChange={e=>edit('customerUpdateDueAt',e.target.value)}/></label>}
    <div className="cs-day-choices">{['Today','Tomorrow'].map((label,i)=><button type="button" key={label} onClick={()=>{const d=new Date(Date.now()+14400000+i*86400000).toISOString().slice(0,10);edit('dueAt',d+'T'+(fields.dueAt?.slice(11)||'09:00'));}}>{label}</button>)}</div>
   </>}
   {outcome&&<>
    {capabilities.sidebarSandbox&&outcome.code==='day_credit_applied'&&<div className="cs-linked-evidence" aria-label="Linked QA evidence"><p><strong>{qaCredit?'Credit posted':'Credit not posted'}</strong>{qaCredit&&<span>{qaCredit.body.reference}</span>}</p>{qaCredit&&fields.details?.creditReference!==qaCredit.body.reference&&<button type="button" onClick={()=>detail('creditReference',qaCredit.body.reference)}>Use linked credit reference</button>}<p><strong>{qaReply?fields.evidenceMessageId===qaReply.body.messageId?'Customer update linked':'Staff completion reply captured':'Completion reply not captured'}</strong><span>Local QA records; no customer messages are sent.</span></p>{qaReply&&fields.evidenceMessageId!==qaReply.body.messageId&&<button type="button" onClick={()=>edit('evidenceMessageId',qaReply.body.messageId)}>Link captured staff reply</button>}</div>}
    <label>{outcome.group==='information'&&outcome.code!=='suggestion_passed'?'Human reply':'Evidence'}<select aria-label="Outcome evidence message" value={fields.evidenceMessageId||''} onChange={e=>edit('evidenceMessageId',e.target.value)} required={['information','withdrawn'].includes(outcome.group)&&outcome.code!=='suggestion_passed'}><option value="">Select message</option>{evidence.map(m=><option key={idOf(m)} value={idOf(m)}>{formatDubai(m.sentAt)} · {(m.text||'Attachment').slice(0,140)}</option>)}</select></label>
    {outcome.code!=='day_credit_applied'&&!(outcome.group==='information'&&outcome.code!=='suggestion_passed')&&outcome.group!=='withdrawn'&&<label>Or completion reference<input aria-label="Completion record / reference" value={fields.evidenceReference||''} onChange={e=>edit('evidenceReference',e.target.value)} placeholder="Record or reference confirming completion"/></label>}
   </>}
  </>}
  {!request&&conversationScope&&!classificationOnly&&<div className="cs-optional-description"><button className="cs-text-action" type="button" aria-expanded={showDescription} onClick={()=>setShowDescription(value=>!value)}>{showDescription?'Hide description':fields.title?'Edit description':'Add description'}</button>{showDescription&&<label>Description<input aria-label="Issue summary" maxLength={160} value={fields.title||''} onChange={e=>edit('title',e.target.value)} placeholder={defaultSummary||'Optional context from the conversation'}/></label>}</div>}
  {classificationOnly&&<div className="cs-action-save"><span className="cs-edit-status">{busy?'Saving…':'Unsaved'}</span><button className="cs-primary" disabled={busy||capabilities.previewReadOnly}>{busy?'Saving…':'Save classification'}</button></div>}
  {error&&<p role="alert">Not saved. Your draft is kept. {error}</p>}
  {conflict&&<button type="button" onClick={()=>{setVersion(request?.version);setParentVersion(splitParent?.version);setConflict(false);setCommandKey(newRequestId());setError('Review the latest issue details, then retry your retained input.');}}>Review latest version and keep my input</button>}
  {action&&allowed(action)&&<div className="cs-action-save"><span className="cs-edit-status" role="status">{busy?'Saving…':'Unsaved'}</span><div className="cs-action-footer"><button className="cs-primary" disabled={capabilities.previewReadOnly||busy||conflict||action.terminal&&!outcome}>{busy?'Saving…':action.terminal?outcome?.group==='information'?'Save answer':'Save outcome':intent==='followup'?'Save follow-up':'Save update'}</button><button type="button" disabled={busy} onClick={()=>{clearDraft();initial.current=null;setFields(f=>({...f,uiMode:'',actionCode:'',outcomeCode:'',details:{}}));setCommandKey(newRequestId());setError('');}}>Cancel</button></div></div>}
 </fieldset></form>;
}
