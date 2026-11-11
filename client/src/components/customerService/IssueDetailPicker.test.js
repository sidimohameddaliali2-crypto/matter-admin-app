import React,{act,useState} from 'react';import {createRoot} from 'react-dom/client';
import IssueDetailPicker from './IssueDetailPicker';import {REQUEST_TOPIC_TAGS} from '../../../../server/config/customerServiceTopicTags';
global.IS_REACT_ACT_ENVIRONMENT=true;let root,el;const select=jest.fn();
function Harness(){const [chosen,setChosen]=useState({});return <IssueDetailPicker topics={REQUEST_TOPIC_TAGS} topic={chosen.topic} detail={chosen.detail} onSelect={(topic,detail)=>{setChosen({topic,detail});select(topic,detail);}}/>;}
beforeEach(async()=>{select.mockClear();el=document.createElement('div');document.body.appendChild(el);root=createRoot(el);await act(async()=>root.render(<Harness/>));});afterEach(async()=>{await act(async()=>root.unmount());el.remove();});
test('one grouped picker retains every existing topic/detail ID and selects each without a second classification picker',async()=>{
 const choices=REQUEST_TOPIC_TAGS.flatMap(t=>t.includes.map(d=>({topic:t,detail:d})));
 for(let i=0;i<choices.length;i++){
  await act(async()=>el.querySelector('input').dispatchEvent(new FocusEvent('focusin',{bubbles:true})));expect(el.querySelectorAll('[role="option"]')).toHaveLength(choices.length);
  await act(async()=>el.querySelectorAll('[role="option"]')[i].click());expect(select).toHaveBeenLastCalledWith(choices[i].topic.id,choices[i].detail.id);expect(el.querySelector('input').value).toBe(choices[i].detail.label+' · '+choices[i].topic.label);expect(el.querySelector('[role="listbox"]')).toBeNull();
 }
});
test('keyboard search selects an exact existing detail and Escape dismisses the list without choosing one',async()=>{
 const input=el.querySelector('input');await act(async()=>{input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Missed Delivery');input.dispatchEvent(new Event('input',{bubbles:true}));});expect(el.querySelectorAll('[role="option"]')).toHaveLength(1);
 await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));expect(select).toHaveBeenLastCalledWith('tag_delivery','missed_delivery');
 await act(async()=>input.dispatchEvent(new FocusEvent('focusin',{bubbles:true})));await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));expect(el.querySelector('[role="listbox"]')).toBeNull();expect(select).toHaveBeenCalledTimes(1);
});
