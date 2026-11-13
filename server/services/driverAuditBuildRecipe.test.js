import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {readDriverAuditBuildRecipe,saveDriverAuditBuildRecipe} from './driverAuditBuildRecipe.js';

const oldRecipe={
  builderSha256:'a'.repeat(64),rendererSha256:'b'.repeat(64),
  journalsSha256:'c'.repeat(64),baselineManifestSha256:'d'.repeat(64),
};

test('attempt keeps its original recipe across builder swaps and rollback',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'audit-build-recipe-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const first=await fs.mkdtemp(path.join(root,'first-'));
  const second=await fs.mkdtemp(path.join(root,'second-'));
  const legacy=await fs.mkdtemp(path.join(root,'legacy-'));
  const unknown=await fs.mkdtemp(path.join(root,'unknown-'));
  const newRecipe={...oldRecipe,builderSha256:'e'.repeat(64)};
  await saveDriverAuditBuildRecipe(first,oldRecipe);
  await saveDriverAuditBuildRecipe(second,newRecipe);
  await assert.rejects(saveDriverAuditBuildRecipe(first,newRecipe),{code:'EEXIST'});
  assert.deepEqual(await readDriverAuditBuildRecipe(first,newRecipe),oldRecipe);
  assert.deepEqual(await readDriverAuditBuildRecipe(second,oldRecipe),newRecipe);
  assert.deepEqual(await readDriverAuditBuildRecipe(legacy,oldRecipe),oldRecipe);
  assert.equal(await readDriverAuditBuildRecipe(unknown,null),null);
  await fs.writeFile(path.join(first,'build-recipe.private.json'),'{');
  assert.equal(await readDriverAuditBuildRecipe(first,oldRecipe),null);
});
