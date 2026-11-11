import React, {useEffect, useState} from 'react';
import api from '../utils/api';

export default function DriverAudits(){
 const [error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{let active=true;setError('');api.post('/driver-audits/session',{}).then(({data})=>{
  if(!active)return;
  if(typeof data?.url!=='string'||!data.url.startsWith('/driver-audit-view?'))throw Error('Invalid audit entry');
  window.location.replace(data.url);
 }).catch(()=>{if(active)setError('Driver audits could not open. Your saved findings are retained.');});return()=>{active=false;};},[attempt]);
 return <section className="p-6"><h1 className="text-2xl font-bold">Driver audits</h1>{error?<><p role="alert" className="mt-4">{error}</p><button className="mt-4 underline" onClick={()=>setAttempt(x=>x+1)}>Retry</button></>:<p role="status" className="mt-4">Opening driver audits…</p>}<p className="mt-4"><a href="/reports" className="underline">Back to reports</a></p></section>;
}
