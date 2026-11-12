import {createHmac,timingSafeEqual} from 'node:crypto';
// A pre-upgrade session cannot serve evidence through an older offline worker.
const cookieName='matter_driver_audit_v2';
const allowed=new Set(['super_admin','admin','manager','dispatcher','viewer']);
const writers=new Set(['super_admin','admin','manager','dispatcher']);
export function createDriverAuditAuth({authenticateStaffToken,secret,origin}){
 if(typeof authenticateStaffToken!=='function'||typeof secret!=='string'||secret.length<24)throw Error('Staff audit authentication required');
 const site=new URL(origin),secure=site.protocol==='https:';
 const csrf=token=>createHmac('sha256',secret).update('driver-audit:'+token).digest('hex');
 const verify=async token=>{const user=await authenticateStaffToken(token);if(!user?.isActive||!allowed.has(user.role)||user.role!=='super_admin'&&user.permissions?.reports!==true)throw Object.assign(Error('Reports permission required'),{status:403});return {id:'matter:'+String(user._id),email:user.email,role:writers.has(user.role)?'reviewer':'viewer'};};
 return {
  clearCookie:`${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure?'; Secure':''}`,
  async issue(authorization){const token=typeof authorization==='string'&&/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(authorization)?authorization.slice(7):null;if(!token)throw Object.assign(Error('Staff sign-in required'),{status:401});await verify(token);return {cookie:`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${secure?'; Secure':''}`};},
  async authenticate(header){const matches=String(header||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(cookieName+'='));if(matches.length!==1)throw Object.assign(Error('Staff sign-in required'),{status:401});const token=matches[0].slice(cookieName.length+1);if(!/^[A-Za-z0-9_.-]{1,8192}$/.test(token))throw Object.assign(Error('Invalid staff session'),{status:401});let actor;try{actor=await verify(token);}catch(e){throw Object.assign(Error('Staff session unavailable'),{status:e.status||401});}return {actor,csrf:csrf(token)};},
  csrfMatches(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===64&&b.length===64&&timingSafeEqual(Buffer.from(a),Buffer.from(b));},
 };
}
