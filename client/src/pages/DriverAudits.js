import React, {useEffect, useState} from 'react';
import api from '../utils/api';
import {canOpenDriverAudits, DRIVER_AUDIT_CLIENT} from '../utils/driverAuditWorker.mjs';

const reloadMessage='Reload the app to open driver audits.';
const failureMessage='Driver audits could not open. Your saved findings are retained.';

export default function DriverAudits(){
 const [error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{
  let active=true;
  setError('');
  async function openAudit(){
   const workerReady=await canOpenDriverAudits(navigator.serviceWorker).catch(()=>false);
   if(!active)return;
   if(!workerReady){setError(reloadMessage);return;}
   try{
    const {data}=await api.post('/driver-audits/session',{},{
     headers:{'X-Driver-Audit-Client':DRIVER_AUDIT_CLIENT},
    });
    if(!active)return;
    if(typeof data?.url!=='string'||!data.url.startsWith('/api/reporting/view?'))throw Error('Invalid audit entry');
    window.location.replace(data.url);
   }catch(requestError){
    if(active)setError(requestError.response?.status===428?reloadMessage:failureMessage);
   }
  }
  void openAudit();
  return()=>{active=false;};
 },[attempt]);
 const needsReload=error===reloadMessage;
 const tryAgain=()=>{if(needsReload)window.location.reload();else setAttempt(x=>x+1);};
 return (
  <section className="p-6">
   <h1 className="text-2xl font-bold">Driver audits</h1>
   {error?(
    <>
     <p role="alert" className="mt-4">{error}</p>
     <button className="mt-4 underline" onClick={tryAgain}>{needsReload?'Reload app':'Retry'}</button>
    </>
   ):<p role="status" className="mt-4">Opening driver audits…</p>}
   <p className="mt-4"><a href="/reports" className="underline">Back to reports</a></p>
  </section>
 );
}
