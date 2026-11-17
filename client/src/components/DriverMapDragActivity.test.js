import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../utils/api';
import { recordActivityChange } from '../utils/activityCapture';
jest.mock('../utils/activityCapture',()=>({recordActivityChange:jest.fn()}));
jest.mock('../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn()}}));
let mockMarkers=[];
jest.mock('@2gis/mapgl',()=>({load:async()=>({
  Map:class {constructor(container){this.container=container;}fitBounds(){}setCenter(){}setZoom(){}getZoom(){return 11;}unproject(){return [55.4,25.3];}destroy(){}},
  HtmlMarker:class {constructor(map,options){this.element=global.document.createElement('div');this.element.innerHTML=options.html;map.container.appendChild(this.element);mockMarkers.push(this);}getContent(){return this.element;}setCoordinates(){}destroy(){this.element.remove();}},
  Circle:class{destroy(){}},Polyline:class{destroy(){}}
})}));
process.env.REACT_APP_2GIS_API_KEY='fixture-map-key';
const DriverRouteMap2GIS=require('./DriverRouteMap2GIS').default;
let host,root,unmounted;
const drivers=[{_id:'driver',profile:{firstName:'Aster',vehicleType:'van'}}];
const deliveries=[{_id:'stop',customerName:'Birch',driver:drivers[0],gpsLocation:{lat:25.1,lng:55.2}}];
const click=async label=>act(async()=>[...host.querySelectorAll('button')].find(node=>node.textContent.trim()===label||node.title===label).click());
beforeEach(()=>{global.IS_REACT_ACT_ENVIRONMENT=true;mockMarkers=[];unmounted=false;jest.clearAllMocks();localStorage.setItem('token','staff-A');window.history.replaceState({},'', '/dispatcher/driver-routes');api.get.mockResolvedValue({data:{data:false}});api.post.mockResolvedValue({data:{data:{}}});host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);});
afterEach(()=>{if(!unmounted)act(()=>root.unmount());host.remove();localStorage.clear();window.history.replaceState({},'','/');jest.restoreAllMocks();});
const render=(props={})=>act(async()=>root.render(<DriverRouteMap2GIS open asPage drivers={drivers} deliveries={deliveries} date="2099-01-05" {...props}/>));
const drag=async attribute=>{
  const marker=[...mockMarkers].reverse().find(item=>item.getContent().getAttribute(attribute));
  await act(async()=>{marker.getContent().dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,clientX:10,clientY:10}));window.dispatchEvent(new MouseEvent('pointerup',{bubbles:true,clientX:40,clientY:40}));});
};
test('a real marker drag observes the proposed pin even when the API rejects and the pin is reverted',async()=>{
  await render();expect(recordActivityChange).not.toHaveBeenCalled();
  const edit=[...host.querySelectorAll('button')].find(node=>node.title==='Drag a pin on the map to correct a wrong location');
  await act(async()=>edit.click());api.post.mockRejectedValueOnce(new Error('Offline fixture'));
  await drag('data-delivery-id');
  expect(recordActivityChange).toHaveBeenCalledWith(expect.objectContaining({field:'Proposed location for Birch (stop)',before:'25.100000, 55.200000',after:'25.300000, 55.400000'}));
  expect(api.post).toHaveBeenCalledWith('/deliveries/stop/manual-coords',{lat:25.3,lng:55.4});
  expect(host.textContent).toContain('reverted');
});
test('a simulation hub marker drag and reset observe proposal coordinates without saving them',async()=>{
  await render();await click('Simulate');
  await act(async()=>host.querySelector('[data-testid="sim-hub-vans"] button').click());
  await drag('data-hub-van-id');
  expect(recordActivityChange).toHaveBeenCalledWith(expect.objectContaining({field:'Hub location for Aster',before:'Use route stop',after:'25.300000, 55.400000'}));
  await click('📍 pinned · reset');
  expect(recordActivityChange).toHaveBeenCalledWith(expect.objectContaining({field:'Hub location for Aster',before:'25.300000, 55.400000',after:'Use route stop'}));
  expect(api.post).not.toHaveBeenCalledWith('/deliveries/stop/manual-coords',expect.anything());
});

const startDrag=async kind=>{
  await render();
  if(kind==='pin')await click('Drag a pin on the map to correct a wrong location');
  else {await click('Simulate');await act(async()=>host.querySelector('[data-testid="sim-hub-vans"] button').click());}
  const attribute=kind==='pin'?'data-delivery-id':'data-hub-van-id';
  const marker=[...mockMarkers].reverse().find(item=>item.getContent().hasAttribute(attribute));
  recordActivityChange.mockClear();api.post.mockClear();
  act(()=>marker.getContent().dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,clientX:10,clientY:10})));
  return marker;
};
const release=()=>act(async()=>window.dispatchEvent(new MouseEvent('pointerup',{bubbles:true,clientX:40,clientY:40})));

test.each(['pin','hub'])('%s drag cancels if the signed-in token changes before release',async kind=>{
  await startDrag(kind);localStorage.setItem('token','staff-B');await release();
  expect(recordActivityChange).not.toHaveBeenCalled();expect(api.post).not.toHaveBeenCalled();
});
test.each(['pin','hub'])('%s drag cancels if the page changes before release',async kind=>{
  await startDrag(kind);window.history.replaceState({},'','/customers');await release();
  expect(recordActivityChange).not.toHaveBeenCalled();expect(api.post).not.toHaveBeenCalled();
});
test.each(['pin','hub'])('%s drag removes global listeners when the map closes',async kind=>{
  await startDrag(kind);const remove=jest.spyOn(window,'removeEventListener');await render({open:false});
  expect(remove).toHaveBeenCalledWith('pointerup',expect.any(Function));
  await release();expect(recordActivityChange).not.toHaveBeenCalled();expect(api.post).not.toHaveBeenCalled();
});
test.each(['pin','hub'])('%s drag removes global listeners on unmount and cannot release as another account',async kind=>{
  await startDrag(kind);const remove=jest.spyOn(window,'removeEventListener');act(()=>root.unmount());unmounted=true;
  expect(remove).toHaveBeenCalledWith('pointermove',expect.any(Function));expect(remove).toHaveBeenCalledWith('pointerup',expect.any(Function));
  localStorage.setItem('token','staff-B');window.history.replaceState({},'','/customers');await release();
  expect(recordActivityChange).not.toHaveBeenCalled();expect(api.post).not.toHaveBeenCalled();
});
test('destroyed and replaced delivery markers cannot retain their old pointer handlers',async()=>{
  const marker=await startDrag('pin');await click('Done fixing pins');recordActivityChange.mockClear();
  act(()=>marker.getContent().dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,clientX:10,clientY:10})));
  await release();expect(recordActivityChange).not.toHaveBeenCalled();expect(api.post).not.toHaveBeenCalled();
});

test('a delivery refresh cancels the old drag and a new drag uses the refreshed starting location',async()=>{
  await startDrag('pin');
  await render({deliveries:[{...deliveries[0],gpsLocation:{lat:25.6,lng:55.7}}]});
  await release();expect(recordActivityChange).not.toHaveBeenCalled();expect(api.post).not.toHaveBeenCalled();
  await drag('data-delivery-id');
  expect(recordActivityChange).toHaveBeenCalledWith(expect.objectContaining({before:'25.600000, 55.700000',after:'25.300000, 55.400000'}));
  expect(api.post).toHaveBeenCalledTimes(1);
});

test.each(['pin','hub'])('%s pointer cancellation cannot later become a drop',async kind=>{
  await startDrag(kind);act(()=>window.dispatchEvent(new MouseEvent('pointercancel',{bubbles:true})));
  await release();expect(recordActivityChange).not.toHaveBeenCalled();expect(api.post).not.toHaveBeenCalled();
});
