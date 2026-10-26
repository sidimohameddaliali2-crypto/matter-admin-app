import Delivery from '../models/Delivery.js';

export function completionFailureDetails(body={}, error={}, driver, at=new Date()) {
  let proof=body.proof||{};
  if(typeof proof==='string'){try{proof=JSON.parse(proof);}catch{proof={};}}
  const codes=[];
  for(const [source,value] of Object.entries({
    'body.bagId':body.bagId,'body.bagIds':body.bagIds,
    'proof.bagId':proof?.bagId,'proof.bagIds':proof?.bagIds,
    'proof.returnedBags':proof?.returnedBags,'proof.scannedBags':proof?.scannedBags,
  }))for(const code of Array.isArray(value)?value:[value]){
    if(typeof code==='string'&&code.trim()&&codes.length<20)codes.push({source,code:code.slice(0,160)});
  }
  const statusCode=Number.isInteger(error.statusCode)&&error.statusCode>=400&&error.statusCode<500?error.statusCode:500;
  return {at,driver,statusCode,codes,
    bagId:typeof error.bagId==='string'?error.bagId.slice(0,160):undefined,
    message:statusCode<500?String(error.message||'Completion rejected').slice(0,300):'Completion failed',
  };
}

export async function recordCompletionFailure(deliveryId, driverId, body, error, store=Delivery) {
  if(!deliveryId||!driverId)return;
  await store.updateOne({_id:deliveryId,driver:driverId,status:{$nin:['delivered','completed','collected']}},
    {$set:{completionFailure:completionFailureDetails(body,error,driverId)}},{timestamps:false});
}
