import { createHash, timingSafeEqual } from 'node:crypto';
import { effectivePermissions } from '../models/User.js';

export function hashMcpToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function parseMcpCredentials(credentialsJson) {
  let credentials;
  try {
    credentials = JSON.parse(credentialsJson || '[]');
    if (!Array.isArray(credentials)) throw new Error();
    for (const credential of credentials) {
      if (!credential || !/^[a-f0-9]{64}$/.test(credential.sha256)
        || !/^[a-f0-9]{24}$/i.test(credential.userId)
        || (credential.allowWrites !== undefined && typeof credential.allowWrites !== 'boolean')) {
        throw new Error();
      }
    }
  } catch {
    throw Object.assign(new Error('MCP credentials are not configured correctly'), { statusCode: 503 });
  }
  return credentials;
}

export async function mcpStaffContext(userId, { credentialsJson, findUser }) {
  const entries = parseMcpCredentials(credentialsJson).filter(entry => entry.userId.toLowerCase() === String(userId).toLowerCase());
  if (!entries.length) throw Object.assign(new Error('This staff account is not enabled for MCP'), { statusCode: 403 });
  const user = await findUser(userId);
  if (!user?.isActive) throw Object.assign(new Error('Staff account is unavailable'), { statusCode: 401 });
  const permissions = effectivePermissions(user);
  if (!['super_admin', 'admin', 'manager', 'dispatcher'].includes(user.role) || !permissions.deliveries) {
    throw Object.assign(new Error('This staff account cannot access delivery tools'), { statusCode: 403 });
  }
  return { user, permissions, allowWrites: entries.some(entry => entry.allowWrites === true) };
}

export async function authenticateMcpCredential(authorization, { credentialsJson, findUser }) {
  const unauthorized = () => Object.assign(new Error('Invalid MCP credential'), { statusCode: 401 });
  const match = /^Bearer (matter_mcp_[A-Za-z0-9_-]{43})$/.exec(authorization || '');
  if (!match) throw unauthorized();
  const credentials = parseMcpCredentials(credentialsJson);

  const digest = Buffer.from(hashMcpToken(match[1]), 'hex');
  const credential = credentials.find(entry => timingSafeEqual(digest, Buffer.from(entry.sha256, 'hex')));
  if (!credential) throw unauthorized();
  const context = await mcpStaffContext(credential.userId, { credentialsJson, findUser });
  return { ...context, allowWrites: credential.allowWrites === true };
}
