import {useEffect,useRef} from 'react';
import api from '../../utils/api';
// Observations stay account-local and retain the original visibility time on retry.
export default function useArrivalObservations(messages,container,accountId){
 const state=useRef({accountId,started:Date.now(),samples:new Map()});
 if(state.current.accountId!==accountId)state.current={accountId,started:Date.now(),samples:new Map()};
 useEffect(()=>{
  const root=container.current,current=state.current;
  if(!root||typeof IntersectionObserver!=='function')return;
  let stopped=false;const timers=new Set();
  const emit=(name,detail)=>root.dispatchEvent(new CustomEvent(name,{bubbles:true,detail}));
  const deliver=async sample=>{
   if(stopped||sample.saved||sample.sending||sample.attempts>=4)return;
   sample.sending=true;sample.attempts++;
   try{await api.post('/customer-service/arrival-observations',sample.detail);sample.saved=true;emit('matter-arrival-recorded',{messageId:sample.detail.messageId,attempts:sample.attempts});}
   catch{emit('matter-arrival-recording-failed',{messageId:sample.detail.messageId,attempts:sample.attempts,exhausted:sample.attempts>=4});if(sample.attempts<4)current.schedule?.(sample);}
   finally{sample.sending=false;}
  };
  const schedule=sample=>{const timer=setTimeout(()=>{timers.delete(timer);deliver(sample);},1000*2**sample.attempts);timers.add(timer);};current.schedule=schedule;
  const map=new Map(messages.map(m=>['cs-message-'+m._id,m]));
  const observe=element=>{
   if(document.visibilityState!=='visible')return;
   const m=map.get(element.id),capture=Date.parse(m?.firstCapturedAt);
   if(!m||m.authorType!=='customer'||!m.externalMessageId||!Number.isFinite(capture)||capture<current.started)return;
   let sample=current.samples.get(m._id);
   if(!sample){sample={attempts:0,saved:false,sending:false,detail:{version:1,messageId:m.externalMessageId,scope:m.scope,visibleAt:new Date().toISOString(),observationStartedAt:new Date(current.started).toISOString()}};current.samples.set(m._id,sample);emit('matter-arrival-visible',sample.detail);}
   deliver(sample);
  };
  const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)observe(entry.target);},{root,threshold:0.1});
  const elements=[];for(const id of map.keys()){const element=document.getElementById(id);if(element&&root.contains(element)){elements.push(element);observer.observe(element);}}
  const visibleAgain=()=>{if(document.visibilityState!=='visible')return;const bounds=root.getBoundingClientRect();for(const element of elements){const r=element.getBoundingClientRect();if(Math.min(r.bottom,bounds.bottom,window.innerHeight)-Math.max(r.top,bounds.top,0)>Math.min(r.height,1)&&r.right>bounds.left&&r.left<bounds.right)observe(element);}};
  document.addEventListener('visibilitychange',visibleAgain);
  for(const sample of current.samples.values())deliver(sample);
  return()=>{stopped=true;if(current.schedule===schedule)current.schedule=null;observer.disconnect();document.removeEventListener('visibilitychange',visibleAgain);for(const timer of timers)clearTimeout(timer);};
 },[messages,container,accountId]);
}
