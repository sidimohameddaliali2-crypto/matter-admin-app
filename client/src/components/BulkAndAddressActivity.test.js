import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installActivityCapture } from '../utils/activityCapture';
import DeliveryAddressFields from './DeliveryAddressFields';
import AddDelivery from '../pages/AddDelivery';
import api from '../utils/api';
import * as XLSX from 'xlsx';
jest.mock('../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn()}}));
jest.mock('react-redux',()=>({useSelector:fn=>fn({auth:{user:{role:'admin'}}})}));
jest.mock('react-router-dom',()=>({useNavigate:()=>jest.fn()}),{virtual:true});
let mockRows=[];
jest.mock('xlsx',()=>({read:jest.fn(()=>({Sheets:{Sheet:{}},SheetNames:['Sheet']})),utils:{sheet_to_json:()=>mockRows}}));
let host,root,cleanup,fetchMock,readers,OriginalReader;
const baseAddress={category:'apartment',building:'Fixture tower',floor:'3',unit:'12',street:'Fixture street',area:'Marina',additional_details:'Side entrance',coordinates:{lat:25.1,lng:55.2},link:'https://maps.google.com/?q=25.1,55.2'};
function Address(){const [value,setValue]=useState(baseAddress);return <form aria-label="Delivery address"><DeliveryAddressFields value={value} onChange={setValue}/><output>{JSON.stringify(value)}</output></form>;}
const sent=()=>fetchMock.mock.calls.flatMap(([,options])=>JSON.parse(options.body).events);
const changes=()=>sent().filter(event=>event.stage==='form_edited').flatMap(event=>event.changes);
const render=node=>act(async()=>root.render(node));
const button=text=>[...host.querySelectorAll('button')].find(node=>node.textContent.trim()===text);
const click=text=>act(async()=>button(text).click());
const input=(node,value)=>act(()=>{node.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});
const deliver=()=>act(async()=>{jest.advanceTimersByTime(2000);for(let i=0;i<8;i++)await Promise.resolve();});
const rows=name=>[['Customer ID','Name','Scheduled Time','Location'],['CUST-1',name,'2099-01-05 05:00','Fixture tower']];
const chooseFile=()=>act(async()=>{const field=host.querySelector('#file-upload');Object.defineProperty(field,'files',{configurable:true,value:[new File(['fixture'],'private-customer-list.xlsx')]});field.dispatchEvent(new Event('change',{bubbles:true}));});
const completeFile=(reader,name='Aster')=>act(async()=>{mockRows=rows(name);reader.onload({target:{result:new ArrayBuffer(0)}});});
beforeEach(()=>{
  global.IS_REACT_ACT_ENVIRONMENT=true;jest.useFakeTimers();jest.clearAllMocks();
  jest.spyOn(console,'warn').mockImplementation(()=>{});jest.spyOn(console,'log').mockImplementation(()=>{});jest.spyOn(window,'alert').mockImplementation(()=>{});
  Object.defineProperty(window,'indexedDB',{configurable:true,value:undefined});
  localStorage.clear();localStorage.setItem('token','fixture-actor');window.history.replaceState({},'','/add-delivery');
  fetchMock=jest.fn().mockResolvedValue({ok:true,status:202,headers:{get:()=>null},json:async()=>({success:true})});window.fetch=fetchMock;
  api.get.mockResolvedValue({data:{data:[]}});api.post.mockResolvedValue({data:{success:true,data:{totalCreated:1}}});
  XLSX.read.mockReturnValue({Sheets:{Sheet:{}},SheetNames:['Sheet']});
  readers=[];OriginalReader=window.FileReader;window.FileReader=class{constructor(){readers.push(this);}readAsArrayBuffer(){}};
  host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);cleanup=installActivityCapture();
});
afterEach(()=>{act(()=>root.unmount());cleanup();host.remove();window.FileReader=OriginalReader;jest.clearAllTimers();jest.useRealTimers();jest.restoreAllMocks();});

test('native category changes capture only dependent field resets and retain other address details',async()=>{
  await render(<Address/>);await act(async()=>host.querySelector('[value="villa"]').click());await deliver();
  expect(changes()).toEqual(expect.arrayContaining([
    expect.objectContaining({field:'Building Name',before:'Fixture tower',after:''}),
    expect.objectContaining({field:'Floor',before:'3',after:''}),
    expect.objectContaining({field:'Apartment Number',before:'12',after:''})
  ]));
  expect(changes().filter(change=>change.field==='Villa')).toHaveLength(1);
  const address=JSON.parse(host.querySelector('output').textContent);expect(address).toMatchObject({street:'Fixture street',area:'Marina',additional_details:'Side entrance',coordinates:{lat:25.1,lng:55.2}});
});

test('map-link changes capture dependent coordinates once and retain floor, unit and instructions',async()=>{
  await render(<Address/>);input(host.querySelector('[placeholder="Paste a map link or enter coordinates below"]'),'https://maps.google.com/?q=25.3,55.4');await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({field:'Latitude',before:'25.1',after:'25.3'}),expect.objectContaining({field:'Longitude',before:'55.2',after:'55.4'})]));
  expect(changes().filter(change=>change.field.includes('Map link'))).toHaveLength(1);
  expect(JSON.parse(host.querySelector('output').textContent)).toMatchObject({building:'Fixture tower',floor:'3',unit:'12',street:'Fixture street',additional_details:'Side entrance'});
});

test('manual coordinates capture their cleared map-link dependency without duplicating the direct coordinate edit',async()=>{
  await render(<Address/>);input(host.querySelector('input[type="number"]'),'25.3');await deliver();
  expect(changes().filter(change=>change.field.includes('Latitude'))).toHaveLength(1);
  expect(changes()).toContainEqual(expect.objectContaining({field:'Map link',before:baseAddress.link,after:''}));
  expect(JSON.parse(host.querySelector('output').textContent).coordinates.lng).toBe(55.2);
});

test('task map-link changes capture their dependent latitude and longitude before Save',async()=>{
  await render(<AddDelivery/>);await click('Task');input(host.querySelector('[name="gpsLocation.link"]'),'https://maps.google.com/?q=25.3,55.4');await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({field:'Task latitude',before:'',after:'25.3'}),expect.objectContaining({field:'Task longitude',before:'',after:'55.4'})]));
  expect(api.post).not.toHaveBeenCalled();
});

test.each(['Clear','Upload different file'])('bulk %s records removed rows and selected-file count without retaining the filename',async action=>{
  await render(<AddDelivery/>);await click('Bulk Entry');await chooseFile();await completeFile(readers[0]);await deliver();
  await click(action);await deliver();
  expect(changes()).toEqual(expect.arrayContaining([expect.objectContaining({field:'Imported row count',before:'1',after:'0'}),expect.objectContaining({field:'Import file',before:'1 file',after:'0 files'})]));
  expect(changes().find(change=>change.field==='Imported rows (first 5)'&&change.before.includes('Aster')&&change.after==='')).toBeTruthy();
  expect(JSON.stringify(sent())).not.toContain('private-customer-list.xlsx');expect(api.post).not.toHaveBeenCalled();
});

test.each(['token','page','clear','unmount','replacement','tab'])('file completion ignores an obsolete %s context',async scenario=>{
  await render(<AddDelivery/>);await click('Bulk Entry');await chooseFile();const old=readers[0];
  if(scenario==='token')localStorage.setItem('token','different-actor');
  if(scenario==='page')window.history.replaceState({},'','/customers');
  if(scenario==='clear')await click('Clear');
  if(scenario==='unmount')await render(null);
  if(scenario==='replacement')await chooseFile();
  if(scenario==='tab')await click('Task');
  await completeFile(old,'Obsolete row');await deliver();
  expect(host.textContent).not.toContain('Obsolete row');
  expect(XLSX.read).not.toHaveBeenCalled();
  expect(changes().filter(change=>change.field==='Imported rows (first 5)'&&change.after.includes('Obsolete row'))).toEqual([]);
  if(scenario==='replacement'){
    await completeFile(readers[1],'Current row');await deliver();
    expect(changes()).toContainEqual(expect.objectContaining({field:'Imported row count',after:'1'}));
    expect(changes().some(change=>change.field==='Imported rows (first 5)'&&change.after.includes('Current row'))).toBe(true);
  }
});

test('clicking the active Bulk Entry tab preserves its pending file read',async()=>{
  await render(<AddDelivery/>);await click('Bulk Entry');await chooseFile();
  await click('Bulk Entry');await completeFile(readers[0],'Current row');await deliver();
  expect(XLSX.read).toHaveBeenCalledTimes(1);
  expect(changes()).toContainEqual(expect.objectContaining({field:'Imported row count',after:'1'}));
  expect(host.textContent).toContain('Current row');
});

test('clicking the active Collection tab preserves its pending customer location lookup',async()=>{
  let finish;
  api.get.mockImplementation(async path=>{
    if(path==='/customers/CUST-1/location')return new Promise(resolve=>{finish=()=>resolve({data:{data:{address:'Fixture saved address',zone:'Marina'}}});});
    return {data:{data:path==='/customers'?[{customerId:'CUST-1',firstName:'Aster'}]:[]}};
  });
  await render(<AddDelivery/>);await click('Collection');
  input(host.querySelector('[placeholder="Type customer name or ID to search..."]'),'Aster');
  await act(async()=>{jest.advanceTimersByTime(150);});
  await act(async()=>[...host.querySelectorAll('button')].find(node=>node.textContent.includes('Aster')).dispatchEvent(new MouseEvent('mousedown',{bubbles:true})));
  await click('Collection');await act(async()=>finish());await deliver();
  expect(changes()).toContainEqual(expect.objectContaining({field:'Collection address',before:'',after:'Fixture saved address'}));
});

test('successful bulk-import cleanup does not become a second human clear action',async()=>{
  await render(<AddDelivery/>);await click('Bulk Entry');await chooseFile();await completeFile(readers[0]);await deliver();
  const before=changes().length;const submit=[...host.querySelectorAll('button')].find(node=>node.textContent.includes('Import 1'));
  await act(async()=>submit.click());await deliver();
  expect(api.post).toHaveBeenCalledWith('/deliveries/bulk',expect.anything());
  expect(changes().slice(before).filter(change=>change.field==='Imported row count'||change.field==='Imported rows (first 5)')).toEqual([]);
});
