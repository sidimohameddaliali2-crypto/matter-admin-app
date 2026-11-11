import React,{act,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import useArrivalObservations from './useArrivalObservations';
import api from '../../utils/api';
jest.mock('../../utils/api',()=>({__esModule:true,default:{post:jest.fn()}}));
global.IS_REACT_ACT_ENVIRONMENT=true;
let root,container,observers;
function Harness({messages}){const ref=useRef(null);useArrivalObservations(messages,ref,'staff');return <div ref={ref}>{messages.map(m=><div id={'cs-message-'+m._id} key={m._id}>Synthetic observation</div>)}</div>;}
beforeEach(()=>{jest.useFakeTimers();observers=[];global.IntersectionObserver=class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){}};Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);api.post.mockReset();});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();jest.useRealTimers();delete global.IntersectionObserver;});
const message=()=>({_id:'message',externalMessageId:'provider',scope:'scope',authorType:'customer',firstCapturedAt:new Date(Date.now()+1000).toISOString()});
test('failed pending observation retries after a message-effect refresh and retains original visibility time',async()=>{
 let reject;api.post.mockImplementationOnce(()=>new Promise((_,r)=>reject=r)).mockResolvedValue({});
 const messages=[message()];await act(async()=>root.render(<Harness messages={messages}/>));
 await act(async()=>observers.at(-1).callback([{isIntersecting:true,target:container.querySelector('#cs-message-message')}]));
 const original=api.post.mock.calls[0][1].visibleAt;
 await act(async()=>root.render(<Harness messages={[...messages]}/>));
 await act(async()=>reject(Error('temporary failure')));
 await act(async()=>jest.advanceTimersByTime(2000));
 expect(api.post).toHaveBeenCalledTimes(2);expect(api.post.mock.calls[1][1].visibleAt).toBe(original);
});
test('returning to visible tab observes a visible arrival that intersected while hidden',async()=>{
 api.post.mockResolvedValue({});await act(async()=>root.render(<Harness messages={[message()]}/>));
 const element=container.querySelector('#cs-message-message'),viewport=element.parentElement;
 element.getBoundingClientRect=()=>({top:10,bottom:50,left:0,right:100,height:40});viewport.getBoundingClientRect=()=>({top:0,bottom:200,left:0,right:200,height:200});
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
 await act(async()=>observers.at(-1).callback([{isIntersecting:true,target:element}]));expect(api.post).not.toHaveBeenCalled();
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
 await act(async()=>document.dispatchEvent(new Event('visibilitychange')));expect(api.post).toHaveBeenCalledTimes(1);
});
