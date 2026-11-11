import mongoose from 'mongoose';
import {cloudWorkflowModel} from '../services/customerServiceCloudWorkflow.js';
const {Schema}=mongoose;
const schema=new Schema({
 conversationId:{type:Schema.Types.ObjectId,required:true,index:true},customerName:String,
 contextScope:{type:String,enum:['message','conversation']},conversationContext:Schema.Types.Mixed,
 originMessageId:{type:Schema.Types.ObjectId,required:true},originIssueKey:{type:String,required:true,default:'primary',maxlength:100},splitParentRequestId:{type:Schema.Types.ObjectId,default:null},evidenceMessageIds:[Schema.Types.ObjectId],
 title:{type:String,maxlength:160},feedback:{type:[Schema.Types.Mixed],default:[]},
 excerpt:{type:String,required:true,maxlength:1000},receivedAt:{type:Date,required:true},
 ownerId:{type:Schema.Types.ObjectId,default:null},assignedAt:Date,
 status:{type:String,enum:['open','waiting','resolved','non_customer'],default:'open'},
 workflowDefinitionVersion:String,currentActionCode:String,topicDetails:Schema.Types.Mixed,
 classification:Schema.Types.Mixed,waitingOn:String,nextAction:Schema.Types.Mixed,customerUpdateDueAt:Date,
 followups:{type:[Schema.Types.Mixed],default:[]},resolution:Schema.Types.Mixed,
 reassignment:Schema.Types.Mixed,exceptions:{type:[Schema.Types.Mixed],default:[]},
 acknowledged:{type:[Schema.Types.Mixed],default:[]},localRead:{type:[Schema.Types.Mixed],default:[]},
 history:{type:[Schema.Types.Mixed],default:[]},version:{type:Number,default:1},
},{timestamps:true});
// Existing Mongo indexes are not changed by this declaration. See the prepared
// migration note before enabling split writes in any legacy Mongo deployment.
schema.index({originMessageId:1,originIssueKey:1},{unique:true});
export default cloudWorkflowModel(mongoose.models.ServiceRequest||mongoose.model('ServiceRequest',schema));
