import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {privateAuditDirectory,privateAuditJson,verifyAuditBuilder} from '../vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';

async function sync(file){
  const handle=await fs.open(file,'r');
  try{await handle.sync();}finally{await handle.close();}
}

async function durableWrite(file,bytes){
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{
    await fs.writeFile(temporary,bytes,{mode:0o600,flag:'wx'});
    await sync(temporary);
    await fs.rename(temporary,file);
  }finally{await fs.rm(temporary,{force:true});}
  await sync(path.dirname(file));
}

async function present(file){
  return fs.lstat(file).then(()=>true,error=>{
    if(error.code==='ENOENT')return false;
    throw error;
  });
}

// Caller holds both deployment and worker locks and has drained the direct stage.
export async function transitionDriverAuditBuilder({root,from,to,rollback=false}){
  if(from===to||![from,to].every(hash=>typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash)))
    throw Error('Two distinct reviewed builder hashes required');
  await privateAuditDirectory(root);
  const builder=path.join(root,'builder');
  const config=path.join(root,'sync.json');
  const staging=path.join(root,'builder-staged-'+to);
  const previous=path.join(root,'builder-retained-'+from);
  const receipt=path.join(root,'builder-transition-'+from+'-'+to+'.private.json');
  await privateAuditJson(config);
  const current=await fs.readFile(config);
  const saved=await privateAuditJson(receipt).catch(error=>{
    if(error.code==='ENOENT')return null;
    throw error;
  });
  if(saved&&(saved.version!==1||saved.from!==from||saved.to!==to))
    throw Error('Audit builder transition receipt changed');
  const originalBytes=saved?Buffer.from(saved.oldConfig,'base64'):current;
  const original=JSON.parse(originalBytes);
  if(original.version!==1||original.root!==root||original.codeRoot!==builder||original.builderSha256!==from)
    throw Error('Audit builder transition config changed');
  const upgraded=Buffer.from(JSON.stringify({...original,builderSha256:to,legacyBuildRecipe:original.legacyBuildRecipe??null}));
  if(!current.equals(originalBytes)&&!current.equals(upgraded))
    throw Error('Audit sync config changed during transition');

  if(!saved){
    if(rollback||await present(previous))throw Error('Audit builder transition has no valid receipt');
    await verifyAuditBuilder(builder,from);
    await verifyAuditBuilder(staging,to);
    await durableWrite(receipt,JSON.stringify({version:1,from,to,oldConfig:originalBytes.toString('base64')}));
  }

  const [target,inactive,activeHash,inactiveHash]=rollback?[previous,staging,from,to]:[staging,previous,to,from];
  const builderExists=await present(builder);
  const targetExists=await present(target);
  const inactiveExists=await present(inactive);
  if(builderExists&&targetExists&&!inactiveExists){
    await verifyAuditBuilder(builder,inactiveHash);
    await verifyAuditBuilder(target,activeHash);
    await fs.rename(builder,inactive);
    await sync(root);
  }else if(builderExists&&!targetExists&&inactiveExists){
    await verifyAuditBuilder(builder,activeHash);
    await verifyAuditBuilder(inactive,inactiveHash);
  }else if(!builderExists&&targetExists&&inactiveExists){
    await verifyAuditBuilder(inactive,inactiveHash);
    await verifyAuditBuilder(target,activeHash);
  }else{
    throw Error('Unrecognized audit builder transition state');
  }
  if(targetExists){
    await fs.rename(target,builder);
    await sync(root);
  }
  await verifyAuditBuilder(builder,activeHash);
  const expected=rollback?originalBytes:upgraded;
  if(!current.equals(expected))await durableWrite(config,expected);
  return {builderSha256:activeHash};
}
