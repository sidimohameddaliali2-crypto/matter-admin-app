import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {configureStore} from '@reduxjs/toolkit';
import {Provider} from 'react-redux';
import useDriverAssignmentRefresh from './useDriverAssignmentRefresh';
import reducer,{fetchDriverDeliveries} from '../store/slices/driverMobileSlice';
import api from '../utils/api';
jest.mock('../utils/api',()=>({__esModule:true,default:{get:jest.fn()}}));
let mockSocket;
jest.mock('../contexts/SocketContext',()=>({useSocket:()=>({socket:mockSocket})}));
global.IS_REACT_ACT_ENVIRONMENT=true;
const Harness=()=>{useDriverAssignmentRefresh();return null;};
test('assignment notification refreshes the driver feed, reassignment removes it, and offline refresh is deferred',async()=>{
 const handlers=new Map();mockSocket={on:jest.fn((e,fn)=>handlers.set(e,fn)),off:jest.fn()};let feed=[{_id:'assigned-delivery',customerName:'Fixture',status:'assigned'}];api.get.mockImplementation(async()=>({data:{success:true,data:{deliveries:feed,handoffs:[]}}}));
 const store=configureStore({reducer:{driverMobile:reducer}}),el=document.createElement('div'),root=createRoot(el);document.body.append(el);
 jest.useFakeTimers();const online=jest.spyOn(navigator,'onLine','get').mockReturnValue(true);
 try{
  await act(async()=>root.render(<Provider store={store}><Harness/></Provider>));
  await act(async()=>{handlers.get('delivery:updated')({driver:'this-driver'});jest.advanceTimersByTime(351);});
  expect(api.get).toHaveBeenCalledWith('/deliveries/driver/today');expect(store.getState().driverMobile.deliveries.map(d=>d._id)).toEqual(['assigned-delivery']);
  api.get.mockRejectedValueOnce(new Error('Network unavailable')).mockRejectedValueOnce(new Error('Network unavailable'));
  await act(async()=>{handlers.get('delivery:updated')({});jest.advanceTimersByTime(351);});
  expect(store.getState().driverMobile.deliveries.map(d=>d._id)).toEqual(['assigned-delivery']);
  feed=[];await act(async()=>{handlers.get('delivery:updated')({driver:'another-driver'});jest.advanceTimersByTime(351);});expect(store.getState().driverMobile.deliveries).toEqual([]);
  api.get.mockClear();online.mockReturnValue(false);await act(async()=>{handlers.get('delivery:updated')({});jest.advanceTimersByTime(351);});expect(api.get).not.toHaveBeenCalled();
  online.mockReturnValue(true);await act(async()=>{window.dispatchEvent(new Event('online'));jest.advanceTimersByTime(351);});expect(api.get).toHaveBeenCalled();
  await act(async()=>root.unmount());expect(mockSocket.off).toHaveBeenCalledWith('delivery:updated',expect.any(Function));
 }finally{jest.useRealTimers();online.mockRestore();el.remove();}
});


test('a delayed pre-reassignment feed cannot restore work removed by a newer response',async()=>{
 let resolveOld;api.get.mockReset();api.get.mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockResolvedValue({data:{success:true,data:{deliveries:[],handoffs:[]}}});
 const store=configureStore({reducer:{driverMobile:reducer}});const old=store.dispatch(fetchDriverDeliveries());await store.dispatch(fetchDriverDeliveries());resolveOld({data:{success:true,data:{deliveries:[{_id:'removed-job',status:'assigned'}],handoffs:[]}}});await old;expect(store.getState().driverMobile.deliveries).toEqual([]);
});
