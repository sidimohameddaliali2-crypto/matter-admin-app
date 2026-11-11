import {cloudInbox,cloudSqlText as lit} from './customerServiceCloudStore.js';
const staffUserProjection="jsonb_build_object('_id',d.id,'isActive',d.active,'role','viewer','email',d.email,'profile',jsonb_build_object('firstName',d.display_name,'lastName',''),'permissions',jsonb_build_object('customerService',true),'permissionsConfigured',true,'serviceOnly',true)";
export async function sourceStaffUsers(ids){
 if(!cloudInbox()?.workflow||ids?.length===0)return [];
 return await cloudInbox().store.query(`SELECT COALESCE(jsonb_agg(${staffUserProjection} ORDER BY d.display_name,d.id),'[]') FROM gallabox_private.staff_directory d WHERE d.active ${ids?`AND d.id IN (${ids.map(id=>lit(String(id))).join(',')})`:''} AND EXISTS(SELECT 1 FROM gallabox_private.staff_login l WHERE l.staff_id=d.id AND l.active);`);
}
export async function sourceStaffDirectory(){
 if(!cloudInbox()?.workflow)return [];
 return await cloudInbox().store.query("SELECT COALESCE(jsonb_agg(jsonb_build_object('userId',id,'displayName',display_name,'name',display_name,'active',active,'identitySource','gallabox','loginLinked',EXISTS(SELECT 1 FROM gallabox_private.staff_login l WHERE l.staff_id=staff_directory.id AND l.active)) ORDER BY display_name),'[]') FROM gallabox_private.staff_directory WHERE active;");
}
export async function sourceStaffIdentity(id){
 if(!cloudInbox()?.workflow)return null;
 return await cloudInbox().store.query(`SELECT jsonb_build_object('userId',id,'displayName',display_name,'active',active,'identitySource','gallabox') FROM gallabox_private.staff_directory WHERE id=${lit(String(id))} AND active;`);
}
export async function sourceStaffUser(id){
 if(!cloudInbox()?.workflow)return null;
 return await cloudInbox().store.query(`SELECT ${staffUserProjection} FROM gallabox_private.staff_directory d WHERE d.id=${lit(String(id))} AND d.active AND EXISTS(SELECT 1 FROM gallabox_private.staff_login l WHERE l.staff_id=d.id AND l.active);`);
}
export async function resolveStaffLogin(provider,subject){
 if(!cloudInbox()?.workflow)return null;
 // Resolve and check the exact login plus active staff in one snapshot. No access cache.
 return await cloudInbox().store.query(`SELECT ${staffUserProjection} FROM gallabox_private.staff_login l JOIN gallabox_private.staff_directory d ON d.id=l.staff_id WHERE l.provider=${lit(provider)} AND l.subject=${lit(subject)} AND l.active AND d.active;`);
}
