import {createHash} from 'node:crypto';
import {cloudInbox,encodeCloudRecord} from './customerServiceCloudStore.js';
import {cloudWorkflowTransaction} from './customerServiceCloudWorkflow.js';
import Staff from '../models/ServiceStaffProfile.js';
const APPROVED_ADMIN_GRANTS=Object.freeze(['assignRequests','approveExceptions','closeSensitive','managePolicies','reportingAccess']);
// Explicit CLI-only operations. The reviewed subject set is supplied privately;
// no real staff IDs or implicit account grants are shipped in application code.
export function createApprovedAdminOperations({approvedIds}={}){
 if(!Array.isArray(approvedIds)||approvedIds.length!==3||new Set(approvedIds).size!==3||approvedIds.some(id=>typeof id!=='string'||!/^[a-f\d]{24}$/i.test(id)))throw Error('An exact reviewed three-person subject set is required.');
 const APPROVED_ADMIN_IDS=Object.freeze([...approvedIds]);
async function approvedAdminPlan(){
 return Promise.all(APPROVED_ADMIN_IDS.map(async userId=>{const profile=await Staff.findOne({userId});if(!profile?.enabled)throw Error('Approved staff profile unavailable or disabled');return {userId,profileId:String(profile._id),expectedHash:encodeCloudRecord('servicestaffprofiles',profile.toObject()).sha256,mode:'supervisor',grants:[...new Set([...(profile.grants||[]),...APPROVED_ADMIN_GRANTS])]};}));
}
async function applyApprovedAdminPlan({plan,approvalReference,apply=false}){
 if(!cloudInbox()?.workflow)throw Error('Canonical workflow required');
 if(typeof approvalReference!=='string'||approvalReference.trim().length<10)throw Error('Explicit owner approval reference required');
 if(!Array.isArray(plan)||plan.length!==3||new Set(plan.map(p=>p.userId)).size!==3||plan.some(p=>!APPROVED_ADMIN_IDS.includes(p.userId)))throw Error('Only the exact approved staff set is permitted');
 return cloudWorkflowTransaction(async()=>{const results=[];
  for(const expected of plan){const profile=await Staff.findOne({userId:expected.userId});if(!profile?.enabled||String(profile._id)!==expected.profileId||encodeCloudRecord('servicestaffprofiles',profile.toObject()).sha256!==expected.expectedHash)throw Error('Staff profile changed; produce and review a fresh plan');
   const before={mode:profile.mode,grants:[...profile.grants]},after={mode:'supervisor',grants:[...new Set([...profile.grants,...APPROVED_ADMIN_GRANTS])]};
   if(apply){profile.mode=after.mode;profile.grants=after.grants;profile.history.push({at:new Date(),before,after,reason:'Owner-approved CLI administration; approval='+approvalReference+'; approvalSHA256='+createHash('sha256').update(approvalReference).digest('hex')});await profile.save();}
   results.push({userId:expected.userId,before,after,applied:apply,authority:'explicit_owner_approval',approvalReference});
  }return results;
 });
}

return {approvedAdminPlan,applyApprovedAdminPlan};
}
