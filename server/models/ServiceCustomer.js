import mongoose from 'mongoose';
const {Schema}=mongoose;
const schema=new Schema({
 customerId:{type:String,required:true,unique:true,maxlength:160},matterCustomerId:{type:String,default:'',index:true,maxlength:120},
 eligibleForAutomaticMatching:{type:Boolean,default:true},phoneObservedAt:Date,sourceStates:Schema.Types.Mixed,
 telephone:{type:String,maxlength:80},whatsappNumber:{type:String,maxlength:80},
 accountStatus:{type:String,maxlength:80},hasActiveSubscription:{type:Boolean,default:null},subscriptionCoverage:String,
 active:{type:Boolean,default:true,index:true},generation:{type:String,index:true},
 name:{type:String,default:'',maxlength:200},email:{type:String,default:'',maxlength:320},phone:{type:String,default:'',maxlength:80},
 subscriptions:[{_id:false,id:String,status:String,plan:{id:String,name:String},start:String,end:String,sourceUpdatedAt:String}],
 sourceAliases:[String],deliveryCustomerIds:[String],deliveryProfiles:[Schema.Types.Mixed],supabaseProfiles:[Schema.Types.Mixed],
 profileObservations:[{_id:false,name:String,email:String,phone:String,rawPhone:String,source:String,sourceRecordId:String,sourceSubscriptionId:String,sourceObservedAt:String,sourceUpdatedAt:String,sourceCreatedAt:String,sourceProcessedAt:String,eligibleForAutomaticMatching:Boolean}],identityNeedsReview:{type:Boolean,default:false},
 source:{type:String,required:true},sourceObservedAt:{type:Date,required:true},sourceUpdatedAt:String,sourceCreatedAt:String,sourceCoverage:{type:String,required:true},sourceReport:Schema.Types.Mixed,
},{timestamps:true});
export default mongoose.models.ServiceCustomer||mongoose.model('ServiceCustomer',schema);
