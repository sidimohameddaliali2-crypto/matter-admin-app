import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {useSelector} from 'react-redux';
import io from 'socket.io-client';
import {SocketProvider} from './SocketContext';
jest.mock('react-redux',()=>({useSelector:jest.fn()}));
jest.mock('socket.io-client',()=>({__esModule:true,default:jest.fn()}));
global.IS_REACT_ACT_ENVIRONMENT=true;
let root,el,state,close;
beforeEach(()=>{jest.clearAllMocks();state={auth:{token:'synthetic-token',user:{serviceOnly:true}}};useSelector.mockImplementation(fn=>fn(state));close=jest.fn();io.mockReturnValue({on:jest.fn(),close});el=document.createElement('div');document.body.appendChild(el);root=createRoot(el);});
afterEach(async()=>{await act(async()=>root.unmount());el.remove();});
test('service-only sign-in never opens the unrelated driver socket',async()=>{await act(async()=>root.render(<SocketProvider>Inbox</SocketProvider>));expect(el.textContent).toBe('Inbox');expect(io).not.toHaveBeenCalled();});
test('normal staff keep their socket contract and switching to service-only closes it',async()=>{
 state.auth.user={serviceOnly:false};await act(async()=>root.render(<SocketProvider>Staff</SocketProvider>));expect(io).toHaveBeenCalledWith(expect.any(String),{auth:{token:'synthetic-token'}});
 state.auth.user={serviceOnly:true};await act(async()=>root.render(<SocketProvider>Inbox</SocketProvider>));expect(close).toHaveBeenCalledTimes(1);expect(io).toHaveBeenCalledTimes(1);
});
