import mongoose from 'mongoose';
const schema=new mongoose.Schema({
  requestId:{type:String,required:true,unique:true},
  customerId:{type:String,required:true,index:true},
  subscriptionId:{type:String,required:true},
  actor:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},actorName:{type:String,required:true},
  action:{type:String,enum:['confirm','feedback'],required:true},
  category:{type:String,enum:['','location_incorrect','missing_information','gps_wrong'],default:''},
  issue:{type:String,maxlength:2000,default:''},
  revision:{type:String,required:true},snapshot:{type:mongoose.Schema.Types.Mixed,required:true},
  timestamp:{type:Date,default:Date.now,immutable:true}
},{versionKey:false});
export default mongoose.model('DispatcherLocationReview',schema);
