import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbookImport } from './WorkbookMealPages';
jest.mock('react-router-dom',()=>({Link:({children})=><span>{children}</span>}),{virtual:true});
jest.mock('./workbookMeals',()=>({...jest.requireActual('./workbookMeals'),parseMealWorkbook:()=>[{id:'one',name:'Own meal',components:[]}]}));
jest.mock('xlsx',()=>({read:()=>({Sheets:{Meals:{},Components:{}}}),utils:{sheet_to_json:()=>[]}}));

test('a completed cancelled import cannot close a newer import dialog',async()=>{
  global.IS_REACT_ACT_ENVIRONMENT=true;
  let release;
  const onImport=jest.fn(()=>new Promise(resolve=>{release=resolve;})),onClose=jest.fn();
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
  try {
    await act(async()=>root.render(<WorkbookImport key="old" onImport={onImport} onClose={onClose}/>));
    const input=document.querySelector('input[type=file]');Object.defineProperty(input,'files',{value:[{name:'Own.xlsx',arrayBuffer:async()=>new ArrayBuffer(0)}]});
    await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
    expect(button('Import meals').disabled).toBe(false);
    await act(async()=>button('Import meals').click());expect(input.disabled).toBe(true);
    await act(async()=>root.render(<WorkbookImport key="new" onImport={jest.fn()} onClose={onClose}/>));
    await act(async()=>release());
    expect(onClose).not.toHaveBeenCalled();expect(document.querySelector('input[type=file]').disabled).toBe(false);
  }finally{await act(async()=>root.unmount());host.remove();}
});
