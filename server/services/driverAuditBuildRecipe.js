import fs from 'node:fs/promises';
import path from 'node:path';
import {privateAuditJson} from '../vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';

const fields = ['builderSha256', 'rendererSha256', 'journalsSha256', 'baselineManifestSha256'];
const receiptName = 'build-recipe.private.json';

function checkedRecipe(recipe) {
  if (!recipe || Object.keys(recipe).length !== fields.length ||
    !fields.every(key => typeof recipe[key] === 'string' && /^[a-f0-9]{64}$/.test(recipe[key]))) {
    throw Error('Invalid audit build recipe');
  }
  return Object.fromEntries(fields.map(key => [key, recipe[key]]));
}

export async function saveDriverAuditBuildRecipe(directory, recipe) {
  const handle = await fs.open(path.join(directory, receiptName), 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({version: 1, recipe: checkedRecipe(recipe)}));
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (const root of [directory, path.dirname(directory)]) {
    const dir = await fs.open(root, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
}

export async function readDriverAuditBuildRecipe(directory, legacyRecipe) {
  try {
    const receipt = await privateAuditJson(path.join(directory, receiptName));
    if (receipt.version !== 1) throw Error('Invalid audit build recipe version');
    return checkedRecipe(receipt.recipe);
  } catch (error) {
    if (error.code === 'ENOENT' && legacyRecipe) return checkedRecipe(legacyRecipe);
    return null;
  }
}
