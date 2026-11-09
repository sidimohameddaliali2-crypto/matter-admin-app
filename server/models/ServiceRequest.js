import mongoose from 'mongoose';
import {cloudWorkflowModel} from '../services/customerServiceCloudWorkflow.js';
const {Schema}=mongoose;
const schema=new Schema({
 conversationId:{type:Schema.Types.ObjectId,required:true,index:true},customerName:String,
 originMessageId:{type:Schema.Types.ObjectId,required:true,unique:true},evidenceMessageIds:[Schema.Types.ObjectId],
 excerpt:{type:String,required:true,maxlength:1000},receivedAt:{type:Date,required:true},
 ownerId:{type:Schema.Types.ObjectId,default:null},assignedAt:Date,
 status:{type:String,enum:['open','waiting','resolved','non_customer'],default:'open'},
 classification:Schema.Types.Mixed,waitingOn:String,nextAction:Schema.Types.Mixed,
 followups:{type:[Schema.Types.Mixed],default:[]},resolution:Schema.Types.Mixed,
 reassignment:Schema.Types.Mixed,exceptions:{type:[Schema.Types.Mixed],default:[]},
 acknowledged:{type:[Schema.Types.Mixed],default:[]},localRead:{type:[Schema.Types.Mixed],default:[]},
 history:{type:[Schema.Types.Mixed],default:[]},version:{type:Number,default:1},
},{timestamps:true});
export default cloudWorkflowModel(mongoose.models.ServiceRequest||mongoose.model('ServiceRequest',schema));
