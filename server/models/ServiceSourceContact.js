import mongoose from 'mongoose';
const schema=new mongoose.Schema({scope:{type:String,required:true},externalContactId:{type:String,required:true},name:String,email:String,phone:String,multiplePhones:{type:Boolean,default:false},multipleEmails:{type:Boolean,default:false},origin:String,observedAt:Date,customerId:{type:String,default:''},matchState:{type:String,default:'unmatched'},matchedBy:String,candidateCustomerIds:[String],matchedAt:Date},{timestamps:true});
// Dated, manually reviewed source evidence; never inferred from names or phone suffixes.
schema.add({emailEvidence:mongoose.Schema.Types.Mixed,reviewedPhoneProof:mongoose.Schema.Types.Mixed,reviewedNativeSenderProof:mongoose.Schema.Types.Mixed});
schema.index({scope:1,externalContactId:1},{unique:true});
export default mongoose.models.ServiceSourceContact||mongoose.model('ServiceSourceContact',schema);
