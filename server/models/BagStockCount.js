import mongoose from 'mongoose';
const schema=new mongoose.Schema({
  requestId:{type:String,required:true,unique:true},submittedBy:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},
  capturedAt:{type:Date,required:true},submittedAt:{type:Date,default:Date.now},note:{type:String,maxlength:2000},
  scannedCodes:[String],expectedCodes:[String],missingCodes:[String],unexpectedCodes:[String],duplicateScans:Number
},{timestamps:true});
export default mongoose.model('BagStockCount',schema);
