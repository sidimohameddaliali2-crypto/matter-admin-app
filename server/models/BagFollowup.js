import mongoose from 'mongoose';
const schema=new mongoose.Schema({
  customerId:{type:String,required:true,unique:true},customerName:String,
  cycleKey:{type:String,required:true},version:{type:Number,default:1},
  owner:{type:mongoose.Schema.Types.ObjectId,ref:'User',default:null},
  status:{type:String,enum:['open','contacted','awaiting_collection','escalated'],default:'open'},
  nextDueAt:Date,note:String,lastContactAt:Date,
  history:[{_id:false,eventId:String,cycleKey:String,action:String,status:String,note:String,owner:{type:mongoose.Schema.Types.ObjectId,ref:'User'},nextDueAt:Date,channel:String,actor:{type:mongoose.Schema.Types.ObjectId,ref:'User'},actorName:String,timestamp:Date,bagIds:[String]}],
},{timestamps:true});
export default mongoose.model('BagFollowup',schema);
