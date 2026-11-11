import React,{useRef,useState} from 'react';
import api from '../../utils/api';
import {servicePath,unpack,errorMessage,useServiceResource} from './serviceUtils';

export default function SidebarSandbox({conversationId,epoch,onOpen,onRefresh}){
 const state=useServiceResource('/sandbox/state',{conversationId},epoch);
 const [topic,setTopic]=useState('tag_delivery'),[detail,setDetail]=useState('missed_delivery'),[guide,setGuide]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const saving=useRef(false),topics=state.data?.topics||[],practice=state.data?.practice,events=state.data?.events||[];
 const reasons=topics.find(t=>t.id===topic)?.includes||[],has=kind=>events.some(e=>e.kind===kind);
 const delivery=practice?.topic==='tag_delivery'&&practice?.detail==='missed_delivery';
 async function perform(action){if(saving.current)return;saving.current=true;setBusy(true);setError('');try{await action();}catch(e){setError(errorMessage(e));}finally{saving.current=false;setBusy(false);}}
 return <section className="cs-qa-toolbar" aria-label="QA playground">
  <strong>QA playground <span>Fictional data</span></strong>
  <label className="cs-sr-only" htmlFor="qa-topic">Practice topic</label><select id="qa-topic" aria-label="Practice topic" value={topic} onChange={e=>{setTopic(e.target.value);setDetail(topics.find(t=>t.id===e.target.value)?.includes[0]?.id||'');}}>{topics.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select>
  <label className="cs-sr-only" htmlFor="qa-detail">Practice detail</label><select id="qa-detail" aria-label="Practice detail" value={detail} onChange={e=>setDetail(e.target.value)}>{reasons.map(d=><option key={d.id} value={d.id}>{d.label}</option>)}</select>
  <button className="cs-primary" disabled={busy||state.loading||!detail} onClick={()=>perform(async()=>{const result=unpack(await api.post(servicePath+'/sandbox/cases',{topic,detail}));onOpen(result.conversationId);onRefresh();setGuide(true);})}>{busy?'Working…':'New practice case'}</button>
  <button aria-expanded={guide} onClick={()=>setGuide(!guide)}>Practice guide</button>
  {(error||state.error)&&<p role="alert">{error||state.error}</p>}
  {guide&&<div className="cs-qa-guide"><div className="cs-qa-guide-title"><strong>Repeat the flow</strong><button onClick={()=>setGuide(false)} aria-label="Close practice guide">Close</button></div>
   <ol><li>Add an issue in the right sidebar. Search Issue and select its detail once. Check Complaint / Inquiry and the retained owner.</li><li>Save a next step and check time. Follow up records the waiting team and any customer promise. Switching actions preserves their drafts.</li><li>Record the supported outcome, inspect View message and Activity. Reopen this issue from a selected customer follow-up. New practice case starts another exercise; earlier runs stay saved.</li></ol>
   {practice?<><p className="cs-qa-case"><strong>{practice.order_reference}</strong> · Service date {practice.delivery_date}</p>
   {delivery?<><p>These buttons simulate the other team and captured messages. They do not contact anyone.</p><div className="cs-qa-events">{[['delivery_acknowledged','Simulate Delivery acknowledgement'],['credit_posted','Simulate posted day credit'],['customer_updated','Simulate staff completion reply'],['customer_followup','Add customer follow-up to reopen']].map(([kind,label])=><button key={kind} disabled={busy||has(kind)||kind==='customer_updated'&&!has('credit_posted')} onClick={()=>perform(async()=>{await api.post(servicePath+'/sandbox/events',{conversationId,kind});state.refresh();onRefresh();})}>{has(kind)?'Recorded: '+label.replace(/^Simulate /,''):label}</button>)}</div>{has('credit_posted')&&<p>Posted credit: <strong>{events.find(e=>e.kind==='credit_posted').body.reference}</strong></p>}<p>In Resolve, choose Day credit applied. Its reference is filled from the QA ledger; confirm Customer informed and link the captured staff reply.</p></>:<p>All configured actions and outcomes are available for this topic. The linked operational simulation currently covers Missed Delivery; other completion references remain staff-recorded evidence.</p>}
   </>:<p>Start a practice case to run the walkthrough. Existing cases and history remain available.</p>}
  </div>}
 </section>;
}
