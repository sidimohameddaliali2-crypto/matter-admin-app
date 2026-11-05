import express from 'express';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { protect } from '../middleware/auth.js';
import { createMatterOAuthProvider, MCP_OAUTH_SCOPES } from '../services/matterMcpOAuth.js';
import { consentScript } from '../services/matterMcpConsent.js';

export function createMcpOAuthIntegration({ env = process.env, provider = createMatterOAuthProvider({ env }),
  authenticate = protect } = {}) {
  const router = express.Router();
  const { urls } = provider;
  const enabled = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (env.ENABLE_MATTER_MCP !== 'true' || env.ENABLE_MATTER_MCP_OAUTH === 'false') return res.sendStatus(404);
    next();
  };
  const metadata = {
    issuer: urls.issuer,
    authorization_endpoint: `${urls.issuer}/authorize`, token_endpoint: `${urls.issuer}/token`,
    registration_endpoint: `${urls.issuer}/register`, revocation_endpoint: `${urls.issuer}/revoke`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'], scopes_supported: MCP_OAUTH_SCOPES,
  };
  router.get([
    '/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/api/mcp/oauth',
    '/api/mcp/oauth/.well-known/oauth-authorization-server',
  ], enabled, (_req, res) => res.json(metadata));
  router.get(['/api/mcp/oauth/resource', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp'],
    enabled, (_req, res) => res.json({ resource: urls.resource, authorization_servers: [urls.issuer],
      scopes_supported: MCP_OAUTH_SCOPES, resource_name: 'MATTER Deliveries' }));

  const auth = express.Router();
  auth.use(enabled);
  auth.use('/authorize', authorizationHandler({ provider }));
  auth.use('/token', tokenHandler({ provider }));
  auth.use('/register', clientRegistrationHandler({ clientsStore: provider.clientsStore }));
  auth.use('/revoke', revocationHandler({ provider }));
  auth.get('/consent.js', (_req, res) => res.type('js').send(consentScript));
  auth.post('/consent', authenticate, async (req, res) => {
    if (req.headers.origin !== urls.origin) return res.status(403).json({ message: 'Invalid connection origin' });
    const { requestId, csrf, allowWrites, allowDeletes } = req.body || {};
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(requestId)) {
      return res.status(400).json({ message: 'Invalid connection form' });
    }
    const cookieName = `matter_oauth_${requestId.slice(0, 12)}`;
    const cookie = String(req.headers.cookie || '').split(';').map(value => value.trim())
      .find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    try {
      const redirect = await provider.approve({ requestId, csrf, cookie, userId: req.user._id, allowWrites, allowDeletes });
      res.clearCookie(cookieName, { httpOnly: true, secure: urls.origin.startsWith('https:'), sameSite: 'lax', path: '/api/mcp/oauth' });
      res.json({ redirect });
    } catch (error) {
      res.status(error.statusCode || (error.errorCode ? 400 : 503)).json({ message:
        error.statusCode || error.errorCode ? error.message : 'Connection unavailable. Please try again later.' });
    }
  });
  router.use('/api/mcp/oauth', auth);
  return { router, provider };
}
