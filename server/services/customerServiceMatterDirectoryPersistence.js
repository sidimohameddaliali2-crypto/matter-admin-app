import {createHash}from'node:crypto';
import mongoose from'mongoose';
import ServiceCustomer from'../models/ServiceCustomer.js';
import ServiceCustomerDirectoryState from'../models/ServiceCustomerDirectoryState.js';
export function directoryGeneration(directory){
 if(!directory?.report?.remoteCollectionReconciled||!Array.isArray(directory.customers)||directory.customers.length!==directory.report.uniqueCustomers)throw new Error('Reconciled customer snapshot required');
 const ids=directory.customers.map(c=>c.customerId);if(new Set(ids).size!==ids.length)throw new Error('Duplicate canonical customer identity');
 return createHash('sha256').update(JSON.stringify(directory)).digest('hex');
}
export async function persistCustomerDirectory(directory,{connection=mongoose,CustomerModel=ServiceCustomer,StateModel=ServiceCustomerDirectoryState,clock=()=>new Date()}={}){
 const generation=directoryGeneration(directory),key='matter_customer_directory';
 const prior=await StateModel.findOne({key}).lean();
 if(prior?.activeGeneration===generation&&prior.status===(directory.report.status||'ready'))return {generation,duplicate:true,count:directory.customers.length};
 const session=await connection.startSession();
 try{await session.withTransaction(async()=>{
  const observedAt=new Date(directory.report.observedAt);if(!Number.isFinite(+observedAt))throw new Error('Directory timestamp is invalid');
  const current=await StateModel.findOne({key}).session(session).lean();
  if(directory.expectedGeneration!==undefined&&current?.activeGeneration!==directory.expectedGeneration)throw new Error('Retained directory generation changed; retry required');
  if(current?.sourceObservedAt&&+new Date(current.sourceObservedAt)>+observedAt)throw new Error('Refusing older directory snapshot');
  await CustomerModel.updateMany({active:true},{$set:{active:false}},{session});
  if(directory.customers.length)await CustomerModel.bulkWrite(directory.customers.map(customer=>({updateOne:{filter:{customerId:customer.customerId},update:{$set:{...customer,active:true,generation}},upsert:true}})),{session});
  const now=clock();
  await StateModel.updateOne({key},{$set:{activeGeneration:generation,status:directory.report.status||'ready',sourceObservedAt:observedAt,lastAttemptAt:now,lastSuccessfulAt:now,error:'',counts:{customers:directory.customers.length,remoteRecords:directory.report.totalRemoteRecords,apiCustomers:directory.report.apiCustomers},report:directory.report},$setOnInsert:{key}},{upsert:true,session});
 });return{generation,duplicate:false,count:directory.customers.length};}catch(error){await StateModel.updateOne({key,...(directory.expectedGeneration!==undefined?{activeGeneration:directory.expectedGeneration}:{})},{$set:{status:'failed',lastAttemptAt:clock(),error:'Directory refresh failed; the previous successful generation remains active.'},$setOnInsert:{key}},{upsert:directory.expectedGeneration===undefined});throw error;}finally{await session.endSession();}
}
