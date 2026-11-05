import { randomBytes } from 'node:crypto';
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import User from '../models/User.js';
import { hashMcpToken, mcpStaffContext } from './matterMcpAuth.js';
import { createMcpOAuthStore } from './matterMcpOAuthStore.js';
import { renderMcpConsent } from './matterMcpConsent.js';

export const MCP_OAUTH_SCOPES = ['deliveries:read', 'deliveries:write'];
const opaque = prefix => `${prefix}${randomBytes(32).toString('base64url')}`;
const validOpaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const ACCESS_MS = 15 * 60 * 1000;
const GRANT_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_MS = 10 * 60 * 1000;

export function mcpOAuthUrls(env = process.env) {
  const resource = new URL(env.MATTER_MCP_PUBLIC_URL || 'https://matterapp.online/api/mcp');
  const loopback = ['127.0.0.1', 'localhost'].includes(resource.hostname);
  if ((resource.protocol !== 'https:' && !(resource.protocol === 'http:' && loopback))
    || resource.username || resource.password || resource.search || resource.hash || resource.pathname !== '/api/mcp') {
    throw new Error('MATTER_MCP_PUBLIC_URL must be the canonical HTTPS /api/mcp URL');
  }
  const issuer = `${resource.origin}/api/mcp/oauth`;
  return { resource: resource.href, origin: resource.origin, issuer, metadata: `${issuer}/resource` };
}

export function createMatterOAuthProvider({ env = process.env, store = createMcpOAuthStore(),
  findUser = identifier => User.findById(identifier).select('-password'), now = () => Date.now() } = {}) {
  const urls = mcpOAuthUrls(env);
  const contextFor = userId => mcpStaffContext(userId, { credentialsJson: env.MATTER_MCP_CREDENTIALS, findUser });
  const live = async (kind, key) => {
    const value = await store.get(kind, key);
    if (!value || value.deadline <= now()) throw new InvalidGrantError('The connection has expired. Start again from ChatGPT.');
    return value;
  };
  const assertResource = resource => {
    if (resource && String(resource) !== urls.resource) throw new InvalidRequestError('Invalid MCP resource');
  };
  const validateScopes = scopes => {
    if (!scopes.includes('deliveries:read') || scopes.some(scope => !MCP_OAUTH_SCOPES.includes(scope))) {
      throw new InvalidScopeError('Unsupported MATTER scopes');
    }
    return [...new Set(scopes)];
  };
  const tokenPair = (clientId, userId, scopes, deadline = now() + GRANT_MS) => {
    const access = opaque('matter_oauth_access_');
    const refresh = opaque('matter_oauth_refresh_');
    return {
      payload: { clientId, userId, scopes, issuer: urls.issuer, resource: urls.resource,
        accessHash: hashMcpToken(access), refreshHash: hashMcpToken(refresh),
        accessExpiresAt: Math.min(now() + ACCESS_MS, deadline), deadline },
      tokens: { access_token: access, refresh_token: refresh, token_type: 'Bearer',
        expires_in: Math.floor(Math.min(ACCESS_MS, deadline - now()) / 1000), scope: scopes.join(' ') },
    };
  };
  const clientsStore = {
    async getClient(clientId) { return store.get('client', clientId); },
    async registerClient(metadata) {
      if (!Array.isArray(metadata.redirect_uris) || !metadata.redirect_uris.length || metadata.redirect_uris.length > 5) {
        throw new InvalidClientMetadataError('Provide a ChatGPT redirect URI');
      }
      const allowedOrigins = ['https://chatgpt.com', 'https://chat.openai.com'];
      for (const uri of metadata.redirect_uris) {
        const redirect = new URL(uri);
        const callbackPath = ['/connector_platform_oauth_redirect', '/connector_platform/oauth/callback'].includes(redirect.pathname)
          || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(redirect.pathname)
          || /^\/aip\/g-[A-Za-z0-9_-]+\/oauth\/callback$/.test(redirect.pathname);
        if (!allowedOrigins.includes(redirect.origin) || !callbackPath || redirect.username || redirect.password || redirect.hash || redirect.search) {
          throw new InvalidClientMetadataError('Only HTTPS ChatGPT OAuth callback URIs are supported');
        }
      }
      if (metadata.token_endpoint_auth_method && metadata.token_endpoint_auth_method !== 'none') {
        throw new InvalidClientMetadataError('Use public-client authentication (none) with PKCE');
      }
      const client = { client_id: opaque('matter_client_'), client_id_issued_at: Math.floor(now() / 1000),
        redirect_uris: [...metadata.redirect_uris], client_name: String(metadata.client_name || 'ChatGPT').slice(0, 100),
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
      await store.put('client', client.client_id, client);
      return client;
    },
  };
  const provider = {
    urls, clientsStore,
    async authorize(client, params, res) {
      assertResource(params.resource);
      if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('S256 PKCE is required');
      const scopes = validateScopes(params.scopes?.length ? params.scopes : MCP_OAUTH_SCOPES);
      const requestId = opaque('');
      const csrf = opaque('');
      const cookie = opaque('');
      const deadline = now() + PENDING_MS;
      await store.put('pending', hashMcpToken(requestId), {
        clientId: client.client_id, redirectUri: params.redirectUri, challenge: params.codeChallenge,
        state: params.state, scopes, resource: urls.resource, csrfHash: hashMcpToken(csrf), cookieHash: hashMcpToken(cookie), deadline,
      }, new Date(deadline));
      res.cookie(`matter_oauth_${requestId.slice(0, 12)}`, cookie, {
        httpOnly: true, secure: urls.origin.startsWith('https:'), sameSite: 'lax', path: '/api/mcp/oauth', maxAge: PENDING_MS,
      });
      renderMcpConsent({ requestId, csrf, clientName: client.client_name, redirectOrigin: new URL(params.redirectUri).origin, scopes, res });
    },
    async approve({ requestId, csrf, cookie, userId, allowWrites }) {
      if (![requestId, csrf, cookie].every(validOpaque)) throw new InvalidRequestError('Invalid connection form');
      const key = hashMcpToken(requestId);
      const pending = await live('pending', key);
      if (pending.csrfHash !== hashMcpToken(csrf) || pending.cookieHash !== hashMcpToken(cookie)) {
        throw new InvalidRequestError('Invalid connection form. Start again from ChatGPT.');
      }
      const context = await contextFor(userId);
      const scopes = pending.scopes.filter(scope => scope !== 'deliveries:write' || allowWrites === true);
      if (scopes.includes('deliveries:write') && !context.allowWrites) throw new InvalidScopeError('Editing is not enabled for this staff account');
      if (!await clientsStore.getClient(pending.clientId)) throw new InvalidGrantError('OAuth client is unavailable');
      if (!await store.take('pending', key)) throw new InvalidGrantError('Connection form already used');
      const code = opaque('');
      const deadline = now() + 60000;
      await store.put('code', hashMcpToken(code), { ...pending, scopes, userId: String(userId), deadline }, new Date(deadline));
      const redirect = new URL(pending.redirectUri);
      redirect.searchParams.set('code', code);
      if (pending.state !== undefined) redirect.searchParams.set('state', pending.state);
      return redirect.href;
    },
    async challengeForAuthorizationCode(client, code) {
      const grant = await live('code', hashMcpToken(code));
      if (grant.clientId !== client.client_id) throw new InvalidGrantError('Code belongs to another client');
      return grant.challenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
      assertResource(resource);
      const key = hashMcpToken(code);
      const grant = await live('code', key);
      if (grant.clientId !== client.client_id || redirectUri !== grant.redirectUri || grant.resource !== urls.resource) {
        throw new InvalidGrantError('Invalid code, resource, or redirect URI');
      }
      const context = await contextFor(grant.userId);
      if (grant.scopes.includes('deliveries:write') && !context.allowWrites) throw new InvalidGrantError('Editing permission was removed');
      if (!await store.take('code', key)) throw new InvalidGrantError('Authorization code already used');
      const pair = tokenPair(client.client_id, grant.userId, grant.scopes);
      await store.put('grant', opaque(''), pair.payload, new Date(pair.payload.deadline));
      return pair.tokens;
    },
    async exchangeRefreshToken(client, refresh, scopes, resource) {
      assertResource(resource);
      const hash = hashMcpToken(refresh);
      const grant = await store.findGrant('refreshHash', hash);
      if (!grant || grant.payload.deadline <= now() || grant.payload.clientId !== client.client_id
        || grant.payload.issuer !== urls.issuer || grant.payload.resource !== urls.resource) throw new InvalidGrantError('Refresh token is invalid or expired');
      if (grant.payload.refreshHash !== hash || (grant.payload.usedRefreshHashes?.length || 0) >= 4096) {
        await store.revokeGrant(grant.key);
        throw new InvalidGrantError('Refresh token replay detected. Reconnect from ChatGPT.');
      }
      const context = await contextFor(grant.payload.userId);
      const requested = validateScopes(scopes || grant.payload.scopes);
      if (requested.some(scope => !grant.payload.scopes.includes(scope))) throw new InvalidScopeError('Cannot expand granted scopes');
      const granted = requested.filter(scope => scope !== 'deliveries:write' || context.allowWrites);
      const pair = tokenPair(client.client_id, grant.payload.userId, granted, grant.payload.deadline);
      pair.payload.usedRefreshHashes = [...(grant.payload.usedRefreshHashes || []), hash];
      if (!await store.rotate(grant.key, hash, pair.payload, new Date(pair.payload.deadline))) {
        await store.revokeGrant(grant.key);
        throw new InvalidGrantError('Refresh token already used. Reconnect from ChatGPT.');
      }
      return pair.tokens;
    },
    async verifyAccessToken(token) {
      if (!/^matter_oauth_access_[A-Za-z0-9_-]{43}$/.test(token)) throw new InvalidTokenError('Invalid OAuth access token');
      const grant = await store.findGrant('accessHash', hashMcpToken(token));
      if (!grant || grant.payload.accessExpiresAt <= now() || grant.payload.deadline <= now()
        || grant.payload.issuer !== urls.issuer || grant.payload.resource !== urls.resource
        || !grant.payload.scopes.includes('deliveries:read')) throw new InvalidTokenError('OAuth access token is expired or revoked');
      if (!await clientsStore.getClient(grant.payload.clientId)) throw new InvalidTokenError('OAuth client is unavailable');
      let context;
      try { context = await contextFor(grant.payload.userId); }
      catch { throw new InvalidTokenError('Staff MCP access was removed'); }
      return { ...context, allowWrites: context.allowWrites && grant.payload.scopes.includes('deliveries:write'),
        clientId: grant.payload.clientId, scopes: grant.payload.scopes, resource: new URL(urls.resource),
        expiresAt: Math.floor(grant.payload.accessExpiresAt / 1000) };
    },
    async revokeToken(client, request) { await store.revoke(client.client_id, hashMcpToken(request.token)); },
  };
  return provider;
}
