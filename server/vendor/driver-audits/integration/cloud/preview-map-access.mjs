import {randomUUID} from 'node:crypto';
export function createPreviewMapAccess({stateStore,config,clock=()=>new Date()}){
 return async actor=>{
  if(!actor||!['owner','reviewer','viewer'].includes(actor.role))throw Object.assign(Error('Reporting access denied'),{status:403});
  const month=clock().toISOString().slice(0,7);
  if(config?.verifiedFreeMonth!==month||config.projectNumber!=='1067787252495'||!Number.isSafeInteger(config.maxLoads)||config.maxLoads<1||config.maxLoads>10000||!config.key||config.enabled!==true)return {enabled:false,message:'Google map setup is pending. Recorded GPS coordinates and times remain available.'};
  const key='preview-map-loads:20261106:'+month;
  for(let i=0;i<4;i++){const old=await stateStore.read(key),value=old.body?JSON.parse(old.body):{count:0};if(!Number.isSafeInteger(value.count)||value.count<0)throw Error('Invalid Maps allowance');if(value.count>=config.maxLoads)return {enabled:false,message:'This preview has reached its free map-load allowance. Other evidence remains available.'};
   try{await stateStore.compareAndSwap({key,expectedRevision:old.revision,eventId:randomUUID(),body:JSON.stringify({count:value.count+1}),event:JSON.stringify({kind:'map-load',actorId:actor.id,month}),request:JSON.stringify({month,actorId:actor.id,count:value.count+1})});return {enabled:true,key:config.key};}catch(e){if(e.status!==409||i===3)throw e;}
  }
 };
}
