import {createPreviewMapAccess} from './preview-map-access.mjs';
// Candidate-only key configuration; shared existing map allowance, no reset.
export function createCandidateMapAccess({stateStore,allowanceStore,stateKey,origin,config,clock}){
 if(!/^preview-acceptance-[a-z0-9-]+:maps-configuration$/.test(stateKey||'')||!/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin||''))throw Error('Invalid candidate Maps scope');
 return async actor=>{
  if(!actor||!['owner','reviewer','viewer'].includes(actor.role))throw Object.assign(Error('Reporting access denied'),{status:403});
  const value=await stateStore.read(stateKey),saved=value.body?JSON.parse(value.body):null;
  if(!saved||saved.version!==1||saved.origin!==origin||saved.projectNumber!==config.projectNumber||!saved.key||saved.verifiedRestrictions!==true)return {enabled:false,message:'Candidate map address is not configured yet. Saved GPS remains available.'};
  return createPreviewMapAccess({stateStore:allowanceStore,config:{...config,key:saved.key},clock})(actor);
 };
}
