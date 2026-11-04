import { randomBytes } from 'node:crypto';
import { hashMcpToken } from '../services/matterMcpAuth.js';

const userId = process.argv[2];
if (!/^[a-f0-9]{24}$/i.test(userId || '') || process.argv.slice(3).some(value => value !== '--allow-writes')) {
  console.error('Usage: node scripts/createMcpCredential.js STAFF_USER_MONGODB_ID [--allow-writes]');
  process.exitCode = 1;
} else {
  const token = `matter_mcp_${randomBytes(32).toString('base64url')}`;
  console.log('Secret credential: enter only in the private plugin connection settings. Do not paste into chat or commit it.');
  console.log(token);
  console.log('\nServer environment (only the hash is stored):');
  console.log('ENABLE_MATTER_MCP=true');
  console.log(`MATTER_MCP_CREDENTIALS='${JSON.stringify([{ userId, sha256: hashMcpToken(token), allowWrites: process.argv.includes('--allow-writes') }])}'`);
}
