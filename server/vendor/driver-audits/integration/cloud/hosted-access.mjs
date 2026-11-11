// These functions require a trusted server-side service RPC transport.
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(x);
const roles=new Set(['owner','reviewer','viewer']);
export function createHostedAccess({rpc}){
 if(typeof rpc!=='function')throw Error('Access RPC transport required');
 return {async membership(userId){if(!uuid(userId))throw Error('Invalid user identity');const value=await rpc('matter_hosted_membership_lookup',{p_user_id:userId});if(value===null)return null;if(!value||typeof value.active!=='boolean'||!roles.has(value.role)||!Number.isSafeInteger(value.revision)||value.revision<1)throw Error('Invalid membership response');return {active:value.active,role:value.role,revision:value.revision};},
 async sessionActive({userId,sessionId}){if(!uuid(userId)||!uuid(sessionId))throw Error('Invalid session identity');const value=await rpc('matter_hosted_session_active',{p_user_id:userId,p_session_id:sessionId});if(typeof value!=='boolean')throw Error('Invalid session response');return value;}};
}
// Provisioning is a separate operator workflow; do not expose it as a browser route.
export function createHostedProvisioner({rpc}){
 if(typeof rpc!=='function')throw Error('Provisioning RPC transport required');
 return async({userId,role,active,expectedRevision,eventId,operatorId})=>{
  if(!uuid(userId)||!roles.has(role)||typeof active!=='boolean'||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||typeof eventId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,159}$/.test(eventId)||typeof operatorId!=='string'||!operatorId.trim()||operatorId.length>200)throw Error('Invalid provisioning request');
  try{const value=await rpc('matter_hosted_membership_provision',{p_user_id:userId,p_role:role,p_active:active,p_expected:expectedRevision,p_event_id:eventId,p_operator_id:operatorId});if(!value||!Number.isSafeInteger(value.revision)||value.revision<1||typeof value.replayed!=='boolean')throw Error('Invalid provisioning response');return value;}catch(e){if(e?.code==='40001'||e?.code==='23505'||e?.status===409)throw Object.assign(Error('Membership revision or request conflict'),{status:409});throw e;}
 };
}
