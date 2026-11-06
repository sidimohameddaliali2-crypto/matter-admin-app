import '../loadEnv.js';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Staff from '../models/ServiceStaffProfile.js';
import { SERVICE_STAFF_ROLES } from '../services/customerServicePolicy.js';

// Controlled operator bootstrap for installations with no super_admin. No auto-run or startup grant.
const args=process.argv.slice(2);
const option=name=>{const n=args.indexOf(name);return n<0?null:args[n+1];};
const userId=option('--user-id');
if(!/^[a-f\d]{24}$/i.test(userId||'')||!process.env.MONGODB_URI) throw new Error('Provide --user-id and verified private MONGODB_URI. Default is dry-run.');
try {
 await mongoose.connect(process.env.MONGODB_URI,{autoIndex:false,serverSelectionTimeoutMS:5000});
 const user=await User.findById(userId).select('role isActive profile.firstName profile.lastName').lean();
 if(!user?.isActive||!SERVICE_STAFF_ROLES.includes(user.role)) throw new Error('Select an existing active internal staff account.');
 const prior=await Staff.findOne({userId}).lean();
 console.log(JSON.stringify({database:mongoose.connection.name,userId,name:`${user.profile?.firstName||''} ${user.profile?.lastName||''}`.trim(),operation:'Enable customer-service supervisor only',apply:args.includes('--apply')}));
 if(args.includes('--apply')) {
  if(!option('--reason')?.trim()) throw new Error('Record an approved setup reason with --reason before applying.');
  await Staff.updateOne({userId},{$set:{mode:'supervisor',enabled:true,displayName:option('--display-name')||prior?.displayName||`${user.profile?.firstName||''} ${user.profile?.lastName||''}`.trim()},$setOnInsert:{availableMinutes:0},$push:{history:{at:new Date(),before:prior?{mode:prior.mode,enabled:prior.enabled}:null,after:{mode:'supervisor',enabled:true},reason:`Operator bootstrap: ${option('--reason')}`}}},{upsert:true,runValidators:true});
  console.log('Supervisor membership saved. Existing user role and permissions were not changed.');
 }
} finally {await mongoose.disconnect();}
