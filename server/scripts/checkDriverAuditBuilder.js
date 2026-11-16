import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {verifyAuditBuilder} from '../vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';

const [builder,expected,volume,...rest]=process.argv.slice(2);
assert(path.isAbsolute(builder??'')&&path.isAbsolute(volume??'')&&!rest.length,'Expected builder path, SHA-256 and private scratch parent');
await verifyAuditBuilder(builder,expected);
const exportsByFile={
  'integration/cloud/automatic-release.mjs':['automaticReleaseBasis','createAutomaticRelease'],
  'integration/cloud/automatic-release-source.mjs':['createAutomaticReleaseSource'],
  'integration/cloud/automatic-release-build.mjs':['buildAutomaticRelease'],
  'scripts/run-automatic-report.mjs':['validateAutomaticCandidate'],
};
for(const [file,names] of Object.entries(exportsByFile)){
  const loaded=await import(pathToFileURL(path.join(builder,file)).href);
  for(const name of names)assert.equal(typeof loaded[name],'function');
}

const scratch=await fs.mkdtemp(path.join(await fs.realpath(volume),'audit-builder-smoke-'));
try{
  const db=new DatabaseSync(path.join(scratch,'lock.sqlite'));
  try{db.exec('BEGIN EXCLUSIVE; ROLLBACK;');}finally{db.close();}
  const original=Buffer.from('audit builder smoke\n'.repeat(256));
  const file=path.join(scratch,'scratch.gz');
  await fs.writeFile(file,await promisify(gzip)(original),{mode:0o600,flag:'wx'});
  await fs.link(file,file+'.linked');
  assert.equal((await fs.stat(file)).ino,(await fs.stat(file+'.linked')).ino);
  assert.deepEqual(await promisify(gunzip)(await fs.readFile(file+'.linked')),original);
  const directory=await fs.open(scratch,'r');
  try{await directory.sync();}finally{await directory.close();}
}finally{await fs.rm(scratch,{recursive:true,force:true});}
console.log(JSON.stringify({status:'checked',platform:process.platform,release:os.release(),node:process.version,builderSha256:expected}));
