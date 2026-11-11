import React, {useEffect,useRef,useState} from 'react';
import api from '../../utils/api';
import {idOf} from './serviceUtils';
export default function ServiceMedia({message,issue,conversationId}) {
  const type=message.display?.mediaType||message.type;
  const [downloadType,setDownloadType]=useState('');
  const [url,setUrl]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const container=useRef(null),loader=useRef(null);
  const resource=useRef(''),request=useRef(null),generation=useRef(0);
  const issueId=idOf(issue),messageId=idOf(message);
  const parentPath=conversationId?`conversations/${encodeURIComponent(conversationId)}`:`issues/${encodeURIComponent(issueId)}`;
  useEffect(()=>{setUrl('');setError('');setLoading(false);return()=>{generation.current++;request.current?.abort();if(resource.current)URL.revokeObjectURL(resource.current);resource.current='';};},[parentPath,messageId]);
  async function load(){
    const current=++generation.current;request.current?.abort();request.current=new AbortController();setLoading(true);setError('');
    if(resource.current)URL.revokeObjectURL(resource.current);resource.current='';setUrl('');
    try {
      const response=await api.get(`/customer-service/${parentPath}/messages/${encodeURIComponent(messageId)}/media`,{responseType:'blob',signal:request.current.signal});
      if(current!==generation.current)return;
      setDownloadType(response.data.type);const next=URL.createObjectURL(response.data);resource.current=next;setUrl(next);
    } catch(e) {
      if(current!==generation.current)return;
      let text='Attachment could not be loaded. Retry.';
      try {const data=JSON.parse(await e.response?.data?.text());if(data.message)text=data.message;}catch{}
      if(current===generation.current)setError(text);
    } finally {if(current===generation.current)setLoading(false);}
  }
  loader.current=load;
  useEffect(()=>{
    if(type!=='image'||message.mediaState!=='available'||!container.current||typeof IntersectionObserver==='undefined')return undefined;
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){observer.disconnect();loader.current();}},{rootMargin:'150px'});
    observer.observe(container.current);return()=>observer.disconnect();
  },[parentPath,messageId,type,message.mediaState]);
  if(type==='location'&&message.display?.location){const pin=message.display.location;return <details className="cs-location"><summary>Shared location</summary>{pin.name&&<strong>{pin.name}</strong>}{pin.address&&<p>{pin.address}</p>}<p>{pin.latitude}, {pin.longitude}</p></details>;}
  if(type==='other'&&(message.text||message.display?.nativeContent?.text||message.display?.nativeContent?.contacts?.length||message.display?.nativeContent?.kind==='reaction'))return null;
  if(type==='other'&&message.display?.nativeContent?.kind==='unsupported')return <p className="cs-muted">Content unavailable in the Gallabox record.</p>;
  if(type==='other')return <p className="cs-muted">Message details are not available in this capture.</p>;
  const supported=['audio','image','video','document'].includes(type);
  if(!supported || message.mediaState!=='available' || (!issueId&&!conversationId)) return <p className="cs-muted">{type} attachment · unavailable in this capture. Refresh the source capture to check availability.</p>;
  return <div ref={container} className="cs-media" style={{marginTop:8}}>
    {!url&&<button type="button" className="cs-button" onClick={load} disabled={loading}>{loading?'Loading attachment…':error?'Retry attachment':`Load ${type}`}</button>}
    {error&&<p role="alert">{error}</p>}
    {url&&type==='document'&&<a className="cs-button" href={url} download={`message-attachment.${({'application/pdf':'pdf','text/html':'html','application/octet-stream':'bin','application/zip':'zip','application/x-zip-compressed':'zip','application/vnd.ms-excel':'xls','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx'})[downloadType]||'bin'}`}>{downloadType==='application/pdf'?'Download PDF':'Download attachment'}</a>}
    {url&&type==='audio'&&<audio aria-label="Message audio" controls src={url} onError={()=>setError('Your browser could not play this audio. Retry the attachment.')}/>}
    {url&&type==='video'&&<video aria-label="Message video" controls playsInline src={url} style={{maxWidth:'100%',maxHeight:360}} onError={()=>setError('Your browser could not play this video. Retry the attachment.')}/>}
    {url&&type==='image'&&<img alt="Captured message attachment" src={url} style={{maxWidth:'100%',maxHeight:420,objectFit:'contain'}} onError={()=>setError('Your browser could not display this image. Retry the attachment.')}/>}
    {url&&error&&<button type="button" onClick={load}>Retry attachment</button>}
  </div>;
}
