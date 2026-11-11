import {SERVICE_STAFF_ROLES} from './customerServicePolicy.js';
import {protect,authenticateStaffToken} from '../middleware/auth.js';
import {effectivePermissions} from '../models/User.js';
const verified=new WeakSet();
const fail=statusCode=>Object.assign(Error(statusCode===403?'No linked customer-service access':'Staff sign-in required'),{statusCode});
export const isVerifiedServiceActor=user=>verified.has(user);
// The destination app already authenticates its users. Resolve its verified
// subject to the canonical staff ID; never match names/emails or create grants.
export function createExistingAppStaffAuth({resolve,authenticate=authenticateStaffToken}){
 return {async authenticate(header){
  if(typeof header!=='string'||header.length>9000||!/^Bearer [^\s]+$/.test(header))throw fail(401);
  let account;
  try{account=await authenticate(header.slice(7));}catch{throw fail(401);}
  if(!account?.isActive||!SERVICE_STAFF_ROLES.includes(account.role))throw fail(401);
  if(effectivePermissions(account).customer_service!==true)throw fail(403);
  const user=await resolve('matter',String(account._id));
  if(!user?.isActive)throw fail(403);
  verified.add(user);return {user};
 }};
}
export function createServiceStaffAuth({supabase,resolve,fetchImpl=fetch}){
 return {async authenticate(header){
  if(typeof header!=='string'||header.length>9000||!header.startsWith('Bearer cs-'))throw fail(401);
  let provider,subject,rotated;
  if(header.startsWith('Bearer cs-sb.')){provider='supabase';const r=await supabase.authenticate('__Host-matter_cs='+header.slice(13));subject=r.actor.id;if(r.cookie)rotated='cs-sb.'+r.cookie.split(';')[0].split('=')[1];}
  // Matter /auth/me omits isActive; its authenticate middleware rejects disabled users.
  else if(header.startsWith('Bearer cs-matter.')){provider='matter';const response=await fetchImpl('https://matterapp.online/api/auth/me',{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+header.slice(17),Accept:'application/json'}});if(!response.ok)throw fail(response.status===401?401:503);const text=await response.text();if(text.length>65536)throw fail(503);const data=JSON.parse(text),u=data?.data?.user;if(data.success!==true||!u||u.isActive===false||! /^[a-f\d]{24}$/i.test(u._id)||!SERVICE_STAFF_ROLES.includes(u.role))throw fail(401);subject=u._id;}
  else throw fail(401);
  const user=await resolve(provider,subject);if(!user?.isActive)throw fail(403);verified.add(user);return {user,token:rotated};
 }};
}
// Opt-in on service routes only. Shared app/driver authentication is unchanged.
export async function protectService(req,res,next){const auth=req.app.get('customerServiceAuth');if(!auth)return protect(req,res,next);try{const r=await auth.authenticate(req.headers.authorization);req.user=r.user;if(r.token)res.set('X-Customer-Service-Session',r.token);next();}catch(e){res.status(e.statusCode||e.status||503).json({success:false,message:e.statusCode===403?'No linked customer-service access.':'Staff sign-in required or identity service unavailable.'});}}
