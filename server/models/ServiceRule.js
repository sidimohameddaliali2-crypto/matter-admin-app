import mongoose from 'mongoose';
import {cloudWorkflowModel} from '../services/customerServiceCloudWorkflow.js';
const schema=new mongoose.Schema({_id:String,definition:mongoose.Schema.Types.Mixed,history:[mongoose.Schema.Types.Mixed],version:{type:Number,default:1}},{timestamps:true});
export default cloudWorkflowModel(mongoose.models.ServiceRule||mongoose.model('ServiceRule',schema));
