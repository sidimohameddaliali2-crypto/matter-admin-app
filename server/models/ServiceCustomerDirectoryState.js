import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({key:{type:String,required:true,unique:true},activeGeneration:String,status:{type:String,enum:['ready','partial','failed'],required:true},sourceObservedAt:Date,lastAttemptAt:Date,lastSuccessfulAt:Date,error:String,counts:Schema.Types.Mixed,report:Schema.Types.Mixed},{timestamps:true});
export default mongoose.models.ServiceCustomerDirectoryState||mongoose.model('ServiceCustomerDirectoryState',schema);
