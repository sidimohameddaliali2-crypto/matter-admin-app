import mongoose from 'mongoose';
const schema=new mongoose.Schema({
  requestId:{type:String,required:true,unique:true},
  customerId:{type:String,required:true,index:true},customerName:String,
  subscriptionReference:String,endEvidence:{type:String,required:true},
  currency:{type:String,enum:['AED'],default:'AED'},amountMinor:{type:Number,default:15500,enum:[15500]},
  active:{type:Boolean,default:true},
  status:{type:String,enum:['review','approved','completed','not_due'],default:'review'},version:{type:Number,default:1},
  createdBy:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},createdByName:String,
  bags:[{_id:false,recordId:{type:mongoose.Schema.Types.ObjectId,ref:'Bag'},bagId:String,returnKey:String}],
  inspections:[{_id:false,recordId:{type:mongoose.Schema.Types.ObjectId,ref:'Bag'},receiptEventId:String,damageEventId:String,outcome:{type:String,enum:['good','damaged']},note:String,actor:{type:mongoose.Schema.Types.ObjectId,ref:'User'},timestamp:Date}],
  approval:{fingerprint:String,actor:{type:mongoose.Schema.Types.ObjectId,ref:'User'},actorName:String,timestamp:Date,note:String},
  completion:{completedAt:Date,reference:String,note:String,recordedBy:{type:mongoose.Schema.Types.ObjectId,ref:'User'},recordedByName:String,recordedAt:Date},
  history:[{_id:false,eventId:String,action:String,note:String,actor:{type:mongoose.Schema.Types.ObjectId,ref:'User'},actorName:String,timestamp:Date}],
},{timestamps:true});
schema.index({customerId:1},{unique:true,partialFilterExpression:{active:true}});
// A return can belong to only one case, including after refund completion.
schema.index({'bags.returnKey':1},{unique:true});
export default mongoose.model('BagRefundCase',schema);
