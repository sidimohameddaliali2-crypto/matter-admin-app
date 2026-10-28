import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Camera,QrCode} from 'lucide-react';
import SimpleQrScanner from '../SimpleQrScanner';

// Owner (2026-10-28): warehouse operators scan labels instead of typing them.
// A handheld scanner sends its tag followed by Enter; camera scans use the same handler.
export default function WarehouseScanInput({onScan,disabled=false}){
  const [camera,setCamera]=useState(false),[error,setError]=useState(''),[last,setLast]=useState('');
  const handler=useRef(onScan),recent=useRef({code:'',at:0});handler.current=onScan;
  const forward=useCallback(codes=>{if(disabled)return;const code=String(codes?.[0]?.rawValue||'').trim();if(!code)return;const now=Date.now();if(recent.current.code===code&&now-recent.current.at<1000)return;recent.current={code,at:now};setLast(code);setError('');handler.current([{rawValue:code}]);},[disabled]);
  useEffect(()=>{if(disabled)return;let text='',lastKey=0;const key=e=>{if(e.ctrlKey||e.metaKey||e.altKey||e.isComposing)return;if(['INPUT','SELECT','TEXTAREA'].includes(e.target?.tagName))return;const now=Date.now();if(now-lastKey>250)text='';lastKey=now;if(e.key==='Enter'&&text.length>=6){e.preventDefault();e.stopImmediatePropagation();const code=text;text='';forward([{rawValue:code}]);}else if(e.key.length===1){text+=e.key;if(text.length>200)text='';}};document.addEventListener('keydown',key,true);return()=>document.removeEventListener('keydown',key,true);},[disabled,forward]);
  useEffect(()=>{if(disabled)setCamera(false);},[disabled]);
  return <section className="wk-scaninput" aria-label="Bag tag scanner"><div className="wk-scanner-intro"><QrCode size={30}/><p>Scan the printed bag tag with your camera or handheld scanner. No typing needed.</p></div><button type="button" className="primary" disabled={disabled} onClick={()=>{setCamera(c=>!c);setError('');}}><Camera size={19}/>{camera?'Stop camera':'Start camera'}</button>{camera&&<div className="bo-camera"><SimpleQrScanner onScan={forward} onError={()=>{setCamera(false);setError('Camera unavailable. Enable camera access or use a handheld scanner.');}}/></div>}{error&&<p role="alert" className="bo-error">{error}</p>}{last&&<output className="wk-lastscan" aria-live="polite">Scanned: <strong>{last}</strong></output>}</section>;
}
