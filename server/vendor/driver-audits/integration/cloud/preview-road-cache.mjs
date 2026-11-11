// Temporary, private geometry cache. Never uses the append-only review journal.
export function createPreviewRoadCache({rpc}){
 const call=(action,hash,owner,value=null)=>rpc('matter_hosted_preview_road_cache',{p_action:action,p_key:hash,p_owner:owner,p_value:value});
 return {claim:async(hash,owner)=>{const result=await call('claim',hash,owner);if(!['hit','claimed','busy'].includes(result?.state))throw Error('Invalid road cache receipt');if(result.state==='hit'){
  const v=result.value;if(!['ready','partial'].includes(v?.status)||!Array.isArray(v.paths)||v.paths.length>99)throw Error('Invalid cached road geometry');
  for(const p of v.paths)if(!Array.isArray(p.indices)||p.indices.length!==2||!p.indices.every(i=>Number.isInteger(i)&&i>=0&&i<100)||p.indices[1]!==p.indices[0]+1||!Array.isArray(p.path)||p.path.length>20000||!p.path.every(c=>Number.isFinite(c.lat)&&Math.abs(c.lat)<=90&&Number.isFinite(c.lng)&&Math.abs(c.lng)<=180))throw Error('Invalid cached road geometry');
 }return result;},save:async(hash,owner,value)=>{if((await call('save',hash,owner,value))?.state!=='saved')throw Error('Road cache lease expired');},release:(hash,owner)=>call('release',hash,owner)};
}
