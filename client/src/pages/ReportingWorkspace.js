import React,{useEffect,useRef,useState} from 'react';
import {useSelector} from 'react-redux';
import {connectReportingWorkspace,currentStaffToken} from '../utils/reportingWorkspaceSession';
export default function ReportingWorkspace(){
 const token=useSelector(s=>s.auth.token),tokenRef=useRef(token);tokenRef.current=token;
 const [frame,setFrame]=useState(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[storedToken,setStoredToken]=useState(()=>localStorage.getItem('token'));
 useEffect(()=>{const changed=e=>{if(e.key==='token'||e.key===null){setStoredToken(localStorage.getItem('token'));setFrame(null);}};window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);},[]);
 useEffect(()=>{
  const controller=new AbortController(),connection=connectReportingWorkspace({getToken:()=>currentStaffToken(tokenRef.current,localStorage.getItem('token'))});let running=false;
  setFrame('');setError('');
  const connect=async()=>{if(running)return;running=true;try{const next=await connection.connect({signal:controller.signal});if(!controller.signal.aborted){setFrame(next);setError('');}}catch(e){if(!controller.signal.aborted){setFrame(null);setError(e.message);}}finally{running=false;}};
  connect();const timer=setInterval(connect,30000);return()=>{controller.abort();clearInterval(timer);};
 },[token,storedToken,attempt]);
 return <section aria-label="Reporting workspace" className="w-full"><div className="flex items-center justify-between gap-3 mb-3"><h1 className="text-xl font-bold">Delivery reporting</h1><button type="button" className="px-4 py-2 rounded bg-lime-300 text-slate-900" onClick={()=>setAttempt(n=>n+1)}>Reconnect reporting</button></div>{error?<p role="alert">{error}</p>:!frame?<p role="status">Connecting your staff reporting session…</p>:<iframe key={frame.generation} title="Full delivery reporting" src={frame.frame} style={{width:'100%',height:'calc(100vh - 170px)',minHeight:600,border:0,background:'#f0ede5'}}/>}</section>;
}
