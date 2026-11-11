import {useEffect,useState} from 'react';

export default function useIssueDrawer({open,panelRef,onClose,conversationId,ready}){
 const [narrow,setNarrow]=useState(()=>Boolean(window.matchMedia?.('(max-width: 1150px)').matches));
 useEffect(()=>{const media=window.matchMedia?.('(max-width: 1150px)');if(!media)return undefined;const update=()=>setNarrow(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
 useEffect(()=>{
  const panel=panelRef.current;if(!open||!narrow||!panel)return undefined;
  const trigger=panel.contains(document.activeElement)?document.querySelector('.cs-work-toggle'):document.activeElement,background=[];
  for(let branch=panel;branch.parentElement&&branch!==document.body;branch=branch.parentElement)for(const sibling of branch.parentElement.children)if(sibling!==branch&&!['SCRIPT','STYLE','LINK'].includes(sibling.tagName)){background.push([sibling,sibling.hasAttribute('inert')]);sibling.setAttribute('inert','');}
  const focusable=()=>[...panel.querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex]')].filter(e=>{
   if(e.disabled||e.tabIndex<0&&!(e.tagName==='SUMMARY'&&!e.hasAttribute('tabindex'))||e.closest('[hidden]')||![...e.getClientRects()].some(r=>r.width>0&&r.height>0))return false;
   for(let ancestor=e.parentElement;ancestor&&ancestor!==panel;ancestor=ancestor.parentElement)if(ancestor.tagName==='DETAILS'&&!ancestor.open&&!ancestor.querySelector('summary')?.contains(e))return false;
   return true;
  });
  const first=()=>panel.querySelector('.cs-work-close')||focusable()[0]||panel;
  panel.scrollTop=0;first().focus({preventScroll:true});
  const keys=e=>{
   if(e.defaultPrevented)return;
   if(e.key==='Escape'){e.preventDefault();onClose();}
   if(e.key==='Tab'){const elements=focusable(),at=elements.indexOf(document.activeElement);if(!elements.length){e.preventDefault();panel.focus();}else if(e.shiftKey&&(at<=0)||!e.shiftKey&&(at===elements.length-1||at<0)){e.preventDefault();elements[e.shiftKey?elements.length-1:0].focus();}}
  };
  const focus=e=>{if(!panel.contains(e.target))first().focus({preventScroll:true});};
  document.addEventListener('keydown',keys);document.addEventListener('focusin',focus);
  return()=>{document.removeEventListener('keydown',keys);document.removeEventListener('focusin',focus);for(const [element,wasInert]of background)if(!wasInert)element.removeAttribute('inert');if(trigger?.isConnected)trigger.focus({preventScroll:true});};
 },[open,narrow,panelRef,onClose,conversationId,ready]);
 return narrow&&open;
}
