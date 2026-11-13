import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const maxRendererBytes = 16 * 1024 * 1024;

export async function loadStaffAuditRenderer(directory, expectedSha256) {
  if (!directory && !expectedSha256) return undefined;
  try {
    if (!path.isAbsolute(directory || '') || !hex(expectedSha256)) throw Error('Invalid renderer settings');
    const manifestFile = await fs.open(path.join(directory, 'manifest.private.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let manifest;
    try {
      const stat = await manifestFile.stat();
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077)) throw Error('Invalid manifest file');
      manifest = JSON.parse(await manifestFile.readFile('utf8'));
    } finally { await manifestFile.close(); }
    if (manifest.version !== 1 || manifest.sha256 !== expectedSha256 || !hex(manifest.templateSnapshotSha256) ||
        !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > maxRendererBytes) throw Error('Invalid manifest');
    const file = await fs.open(path.join(directory, 'renderer.private.html'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== manifest.bytes || (stat.mode & 0o077)) throw Error('Invalid renderer file');
      const bytes = await file.readFile();
      if (bytes.length !== manifest.bytes || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw Error('Renderer hash mismatch');
      const html = bytes.toString();
      if (html.split('</head>').length !== 2) throw Error('Invalid renderer document');
      return {html,templateSnapshotSha256:manifest.templateSnapshotSha256};
    } finally { await file.close(); }
  } catch {
    console.warn('Driver Reports renderer override is unavailable; using the packaged renderer');
    return undefined;
  }
}
