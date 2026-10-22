import mongoose from 'mongoose';
const schema=new mongoose.Schema({
  subjectKey:{type:String,required:true,unique:true},bagId:String,
  status:{type:String,enum:['open','in_review','awaiting_evidence','ready_for_correction'],default:'open'},
  assignedTo:{type:mongoose.Schema.Types.ObjectId,ref:'User',default:null},
  note:{type:String,maxlength:2000,default:''},version:{type:Number,default:1},
  history:[{status:String,note:String,actor:{type:mongoose.Schema.Types.ObjectId,ref:'User'},timestamp:{type:Date,default:Date.now}}]
},{timestamps:true});
export default mongoose.model('BagReviewCase',schema);
