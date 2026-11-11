import React,{useEffect,useId,useState} from 'react';

// One deliberate selection supplies both existing taxonomy IDs. No inference.
export default function IssueDetailPicker({topics,topic,detail,onSelect,disabled}){
 const listId=useId(),[open,setOpen]=useState(false),[query,setQuery]=useState(''),[active,setActive]=useState(0);
 const selectedTopic=topics.find(t=>t.id===topic),selected=selectedTopic?.includes?.find(d=>d.id===detail);
 const choices=topics.flatMap(t=>(t.includes||[]).map(d=>({topic:t,detail:d}))).filter(({topic:t,detail:d})=>(t.label+' '+d.label).toLowerCase().includes(query.trim().toLowerCase()));
 useEffect(()=>{if(open)document.getElementById(listId+'-'+active)?.scrollIntoView?.({block:'nearest'});},[open,active,listId]);
 const choose=item=>{onSelect(item.topic.id,item.detail.id);setOpen(false);setQuery('');setActive(0);};
 return <div className="cs-detail-picker"><label htmlFor={listId+'-input'}>Issue</label><input id={listId+'-input'} aria-label="Choose issue" role="combobox" aria-expanded={open} aria-controls={open?listId:undefined} aria-autocomplete="list" aria-activedescendant={open&&choices[active]?listId+'-'+active:undefined} autoComplete="off" disabled={disabled} value={open?query:selected?selected.label+' · '+selectedTopic.label:''} placeholder="Search delivery, refund, meal…" onFocus={()=>{setOpen(true);setQuery('');setActive(0);}} onBlur={e=>{if(!e.currentTarget.parentElement.contains(e.relatedTarget)){setOpen(false);setQuery('');}}} onChange={e=>{setQuery(e.target.value);setActive(0);setOpen(true);}} onKeyDown={e=>{
  if(e.key==='Escape'&&open){e.preventDefault();e.stopPropagation();setOpen(false);setQuery('');}
  else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setOpen(true);setActive(i=>open?Math.max(0,Math.min(choices.length-1,i+(e.key==='ArrowDown'?1:-1))):0);}
  else if(e.key==='Enter'&&open){e.preventDefault();if(choices[active])choose(choices[active]);}
 }}/>{open&&<div className="cs-detail-choices" role="listbox" aria-label="Issue details" id={listId}>{choices.length?choices.map((item,i)=><React.Fragment key={item.topic.id+':'+item.detail.id}>{(i===0||choices[i-1].topic.id!==item.topic.id)&&<p className="cs-picker-group" role="presentation">{item.topic.label}</p>}<button type="button" tabIndex={-1} id={listId+'-'+i} role="option" aria-selected={active===i} onMouseDown={e=>e.preventDefault()} onMouseEnter={()=>setActive(i)} onClick={()=>choose(item)}>{item.detail.label}</button></React.Fragment>):<p>No matching issue. Try another word.</p>}</div>}</div>;
}
