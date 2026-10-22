import Bag from '../models/Bag.js';
import User from '../models/User.js';
import Delivery from '../models/Delivery.js';
import mongoose from 'mongoose';
import { executeBagMovement } from './bagLifecycleService.js';

const repository={
  find:bagId=>Bag.collection.findOne({bagId}),
  commit:async(bag,plan)=>{
    const version=bag.custodyVersion===undefined?{custodyVersion:{$exists:false}}:{custodyVersion:bag.custodyVersion};
    const update={$set:{...plan.set,custodyVersion:(bag.custodyVersion||0)+1},$push:{history:plan.event}};
    if(Object.keys(plan.unset).length)update.$unset=plan.unset;
    const result=await Bag.collection.findOneAndUpdate({_id:bag._id,...version,'history.eventId':{$ne:plan.event.eventId}},update,{returnDocument:'after'});
    return result?.value??null;
  }
};
export async function moveBag(bagId,command,user) {
  for(const value of [command.driverId,command.deliveryId])if(value&&!mongoose.isValidObjectId(value))throw Object.assign(new Error('Invalid driver or delivery reference.'),{statusCode:400});
  if(command.driverId){const target=await User.findById(command.driverId).select('role isActive');if(!target||target.role!=='driver'||!target.isActive)throw Object.assign(new Error('Select an active driver.'),{statusCode:400});command={...command,driverId:new mongoose.Types.ObjectId(String(command.driverId))};}
  if(['deliver','collect'].includes(command.action)&&command.deliveryId){
    const delivery=await Delivery.findById(command.deliveryId).select('driver customerId customerName');
    if(!delivery||String(delivery.driver)!==String(user._id))throw Object.assign(new Error('This delivery is not assigned to you.'),{statusCode:403});
    if(command.customerId&&delivery.customerId!==command.customerId)throw Object.assign(new Error('Customer does not match the delivery.'),{statusCode:409});
    command={...command,deliveryId:delivery._id,customerId:delivery.customerId,customerName:delivery.customerName};
  }
  if(command.action==='deliver'&&!command.deliveryId)throw Object.assign(new Error('Delivery is required.'),{statusCode:400});
  const name=[user.profile?.firstName,user.profile?.lastName].filter(Boolean).join(' ')||user.name||user.role;
  const result=await executeBagMovement(repository,bagId,command,{_id:user._id,role:user.role,name});
  // Bag state + receipt are authoritative and atomic. Updating the related
  // delivery is retryable from that same receipt, never from all historical uses.
  if(command.action==='receive'){
    const receipt=result.bag.history.find(event=>event.eventId===command.eventId);
    if(receipt?.before?.currentDelivery){
      await Delivery.updateOne({_id:receipt.before.currentDelivery,'bagReturnReceipts.eventId':{$ne:receipt.eventId}},{$push:{bagReturnReceipts:{bagId:result.bag.bagId,eventId:receipt.eventId,receivedAt:receipt.timestamp}}});
      await Delivery.updateOne({_id:receipt.before.currentDelivery,'bagAssignment.bagId':result.bag.bagId,'bagAssignment.status':{$ne:'returned'}},{$set:{'bagAssignment.status':'returned','bagAssignment.returnedAt':receipt.timestamp}});
    }
  }
  return result;
}
