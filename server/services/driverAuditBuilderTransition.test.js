import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {transitionDriverAuditBuilder} from './driverAuditBuilderTransition.js';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

async function fixture(t){
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'audit-builder-transition-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const builder=path.join(root,'builder');
  const code='scripts/run-automatic-report.mjs';
  const files=source=>JSON.stringify({version:1,files:{[code]:digest(source)}});
  const from=digest(files('// original'));
  const to=digest(files('// candidate'));
  const staging=path.join(root,'builder-staged-'+to);
  const retained=path.join(root,'builder-retained-'+from);
  for(const [directory,source] of [[builder,'// original'],[staging,'// candidate']]){
    await fs.mkdir(path.join(directory,'scripts'),{mode:0o700,recursive:true});
    await fs.writeFile(path.join(directory,code),source,{mode:0o600});
    await fs.writeFile(path.join(directory,'runtime-manifest.json'),files(source),{mode:0o600});
  }
  const original=JSON.stringify({version:1,root,codeRoot:builder,builderSha256:from,other:'preserved'},null,2)+'\n';
  const config=path.join(root,'sync.json');
  await fs.writeFile(config,original,{mode:0o600});
  return {root,from,to,original,config,builder,staging,retained};
}

test('builder swap resumes from interruption between directory renames and rolls back to exact config bytes',async t=>{
  const f=await fixture(t);
  const rename=fs.rename;
  let interrupted=false;
  fs.rename=async (from,to)=>{
    if(!interrupted&&from===f.staging&&to===f.builder){
      interrupted=true;
      throw Error('interrupted');
    }
    return rename(from,to);
  };
  try{await assert.rejects(transitionDriverAuditBuilder(f),/interrupted/);}
  finally{fs.rename=rename;}
  assert.equal(await fs.readFile(f.config,'utf8'),f.original);
  assert.equal((await transitionDriverAuditBuilder(f)).builderSha256,f.to);
  assert.equal((await transitionDriverAuditBuilder(f)).builderSha256,f.to);
  assert.deepEqual(JSON.parse(await fs.readFile(f.config,'utf8')),{...JSON.parse(f.original),builderSha256:f.to,legacyBuildRecipe:null});
  assert.equal((await transitionDriverAuditBuilder({...f,rollback:true})).builderSha256,f.from);
  assert.equal((await transitionDriverAuditBuilder({...f,rollback:true})).builderSha256,f.from);
  assert.equal(await fs.readFile(f.config,'utf8'),f.original);
});

test('candidate tampering and changed configuration fail before directory switches',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.staging,'scripts/run-automatic-report.mjs'),'// changed');
  await assert.rejects(transitionDriverAuditBuilder(f),/builder file mismatch/);
  assert.equal(await fs.readFile(f.config,'utf8'),f.original);
  assert.equal(await fs.readFile(path.join(f.builder,'scripts/run-automatic-report.mjs'),'utf8'),'// original');
});
