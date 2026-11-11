import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {appendReportingReview,validReportingHistory,reviewEvents} from './app/src/content/dashboard/reporting-review.mjs';
export const emptyHistory=()=>({records:{},overrides:{},removed:{},preferences:{}});
export async function atomicJson(file,value){
 await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const temp=file+'.'+crypto.randomUUID()+'.tmp';
 const h=await fs.open(temp,'wx',0o600);
 try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}
 await fs.rename(temp,file);const dir=await fs.open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function withFileLock(lockFile,timeoutMs,fn){
 await fs.mkdir(path.dirname(lockFile),{recursive:true,mode:0o700});
 const token=crypto.randomUUID(),deadline=Date.now()+timeoutMs;
 let handle;
 while(!handle){
  try{handle=await fs.open(lockFile,'wx',0o600);}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   if(Date.now()>=deadline)throw Error('Saved review history is locked by another writer; retry later. Locks are never reclaimed automatically.');
   await delay(Math.min(25,Math.max(1,deadline-Date.now())));
  }
 }
 try{
  await handle.writeFile(JSON.stringify({token,pid:process.pid,acquiredAt:new Date().toISOString()}));
  await handle.sync();
  return await fn();
 }finally{
  await handle.close();
  // Remove only the lock this writer created. A stale or malformed lock is
  // deliberately left in place for verified manual recovery; never steal it.
  let owner=null;
  try{owner=JSON.parse(await fs.readFile(lockFile,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(owner?.token===token)await fs.unlink(lockFile);
 }
}
export function createReviewStore(file,{lockTimeoutMs=10000}={}){
 if(!Number.isSafeInteger(lockTimeoutMs)||lockTimeoutMs<0)throw new RangeError('Review lock timeout must be a non-negative safe integer.');
 file=path.resolve(file);
 const lockFile=file+'.lock';
 let queue=Promise.resolve();
 const lock=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
 const read=async()=>{let state;try{state=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return emptyHistory();throw Error('Saved review history is unreadable; it has not been replaced.');}if(!validReportingHistory(state))throw Error('Saved review history is invalid; it has not been replaced.');return state;};
 return {read,
  migrate:input=>lock(()=>withFileLock(lockFile,lockTimeoutMs,async()=>{if(!validReportingHistory(input))throw Error('Browser history is invalid; no history was changed.');const current=await read(),events=reviewEvents(current),byId=new Map(events.map(e=>[e.id,e]));for(const event of reviewEvents(input)){const prior=byId.get(event.id);if(prior&&JSON.stringify(prior)!==JSON.stringify(event))throw Error('Conflicting review ID; both sources retained for investigation.');byId.set(event.id,event);}const state={...current,records:{...current.records,reportingReviews:[...byId.values()]}};if(byId.size!==events.length)await atomicJson(file,state);return state;})),
  save:(snapshot,input)=>lock(()=>withFileLock(lockFile,lockTimeoutMs,async()=>{const state=await read();let next=state;const storage={getItem:()=>JSON.stringify(state),setItem:(_,raw)=>{next=JSON.parse(raw);}};const result=appendReportingReview(storage,'reviews',snapshot,input);if(!result.replayed)await atomicJson(file,next);return {...result,state:next};}))};
}
