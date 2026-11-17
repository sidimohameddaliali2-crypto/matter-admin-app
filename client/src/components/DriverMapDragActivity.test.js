import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../utils/api';
import { recordActivityChange } from '../utils/activityCapture';
jest.mock('../utils/activityCapture',()=>({recordActivityChange:jest.fn()}));
jest.mock('../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn()}}));
let mockMarkers=[];
jest.mock('@2gis/mapgl',()=>({load:async()=>({
  Map:class {fitBounds(){}setCenter(){}setZoom(){}getZoom(){return 11;}unproject(){return [55.4,25.3];}destroy(){}},
  HtmlMarker:class {constructor(map,options){this.element=global.document.createElement('div');this.element.innerHTML=options.html;mockMarkers.push(this);}getContent(){return this.element;}setCoordinates(){}destroy(){}},
  Circle:class{destroy(){}},Polyline:class{destroy(){}}
})}));
process.env.REACT_APP_2GIS_API_KEY='fixture-map-key';
const DriverRouteMap2GIS=require('./DriverRouteMap2GIS').default;
let host,root;
const drivers=[{_id:'driver',profile:{firstName:'Aster',vehicleType:'van'}}];
const deliveries=[{_id:'stop',customerName:'Birch',driver:drivers[0],gpsLocation:{lat:25.1,lng:55.2}}];
const click=async label=>act(async()=>[...host.querySelectorAll('button')].find(node=>node.textContent.trim()===label||node.title===label).click());
beforeEach(()=>{global.IS_REACT_ACT_ENVIRONMENT=true;mockMarkers=[];jest.clearAllMocks();api.get.mockResolvedValue({data:{data:false}});api.post.mockResolvedValue({data:{data:{}}});host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();});
const render=()=>act(async()=>root.render(<DriverRouteMap2GIS open asPage drivers={drivers} deliveries={deliveries} date="2099-01-05"/>));
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
