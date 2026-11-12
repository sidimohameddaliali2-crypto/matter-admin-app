import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import {promisify} from 'node:util';

export const driverAuditWriteOptions={writeConcern:{w:'majority',j:true,wtimeoutMS:10000}};
const writerId='direct-writer';
const run=promisify(execFile);

async function processIdentity(){
  try{
    let host,boot,namespace;
    if(process.platform==='linux'){
      [host,boot,namespace]=await Promise.all([
        fs.readFile('/etc/machine-id','utf8'),
        fs.readFile('/proc/sys/kernel/random/boot_id','utf8'),
        fs.readlink('/proc/self/ns/pid'),
      ]);
    }else if(process.platform==='darwin'){
      host=os.hostname();
      ({stdout:boot}=await run('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{timeout:2000}));
      namespace='native';
    }else return null;
    const fields=[host.trim(),boot.trim(),namespace.trim()];
    if(fields.some(value=>!value))return null;
    return createHash('sha256').update(fields.join('\0')).digest('hex');
  }catch{return null;}
}

function exited(pid){
  try{process.kill(pid,0);return false;}
  catch(error){return error.code==='ESRCH';}
}

function writerBusy(){
  return Object.assign(new Error('An existing or unresolved driver audit writer lock must be resolved first.'),{code:'AUDIT_WRITER_BUSY'});
}

export async function assertDriverAuditWriter(db,token,options){
  const existing=await db.collection('driverAuditControl').findOne({_id:writerId},options);
  if(typeof token!=='string'||!token||existing?.token!==token)throw writerBusy();
}

// No timeout can make a concurrent writer safe. Recovery is limited to an
// exact lock on this boot and PID namespace after its process demonstrably exited.
export async function withDriverAuditWriter(db,operation,{identify=processIdentity,hasExited=exited}={}){
  const control=db.collection('driverAuditControl');
  const identity=await identify();
  const token=randomUUID();
  const owner={_id:writerId,token,identity,pid:process.pid,acquiredAt:new Date()};
  try{await control.insertOne(owner,driverAuditWriteOptions);}
  catch(error){
    if(error.code!==11000)throw error;
    const previous=await control.findOne({_id:writerId});
    if(!identity||previous?.identity!==identity||typeof previous.token!=='string'||
       !Number.isSafeInteger(previous.pid)||previous.pid<1||!hasExited(previous.pid))throw writerBusy();
    const removed=await control.deleteOne({_id:writerId,token:previous.token,identity,pid:previous.pid},driverAuditWriteOptions);
    if(removed.deletedCount!==1)throw writerBusy();
    try{await control.insertOne(owner,driverAuditWriteOptions);}
    catch(retryError){if(retryError.code===11000)throw writerBusy();throw retryError;}
  }
  try{return await operation(token);}
  finally{
    const removed=await control.deleteOne({_id:writerId,token},driverAuditWriteOptions);
    if(removed.deletedCount!==1)throw writerBusy();
  }
}
