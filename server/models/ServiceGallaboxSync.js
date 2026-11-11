import mongoose from 'mongoose';
const schema=new mongoose.Schema({
 scope:{type:String,required:true,unique:true},queue:{type:[mongoose.Schema.Types.Mixed],default:[]},completed:{type:mongoose.Schema.Types.Mixed,default:{}},
 liveQueue:{type:[mongoose.Schema.Types.Mixed],default:[]},liveCompleted:{type:mongoose.Schema.Types.Mixed,default:{}},lastLiveSuccessAt:Date,liveError:String,
 leaseToken:String,leaseUntil:Date,lastDiscoveryAt:Date,nextDiscoveryAttemptAt:Date,discoveryFailures:{type:Number,default:0},limited:{type:Number,default:0},historySeedHashes:{type:[String],default:[]},historyQueued:{type:Number,default:0},historyCompleted:{type:Number,default:0},lastSuccessAt:Date,lastAttemptAt:Date,error:{type:String,default:''},
 inserted:{type:Number,default:0},duplicates:{type:Number,default:0},pages:{type:Number,default:0},discovered:{type:Number,default:0},
},{timestamps:true});
export default mongoose.models.ServiceGallaboxSync||mongoose.model('ServiceGallaboxSync',schema);
