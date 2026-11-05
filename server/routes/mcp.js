import express from 'express';
import jwt from 'jsonwebtoken';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import User from '../models/User.js';
import { authenticateMcpCredential } from '../services/matterMcpAuth.js';
import { createMatterApiClient, createMatterMcpServer } from '../services/matterMcpService.js';
import { businessOffsetMs } from '../utils/businessDate.js';
import { mcpOAuthUrls, MCP_OAUTH_SCOPES } from '../services/matterMcpOAuth.js';

export function createMcpRouter({
  env = process.env,
  findUser = identifier => User.findById(identifier).select('-password'),
  fetchImpl = fetch,
  oauthProvider,
} = {}) {
  const router = express.Router();
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (env.ENABLE_MATTER_MCP !== 'true') return res.sendStatus(404);
    if (req.headers.origin) {
      const origins = String(env.MATTER_MCP_ALLOWED_ORIGINS || '').split(',').map(value => value.trim());
      if (!origins.includes(req.headers.origin)) return res.sendStatus(403);
    }
    if (!env.JWT_SECRET) return res.status(503).json({ success: false, message: 'MCP is not configured' });
    try {
      const oauthToken = /^Bearer (matter_oauth_access_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
      req.mcpContext = oauthToken && oauthProvider && env.ENABLE_MATTER_MCP_OAUTH !== 'false'
        ? await oauthProvider.verifyAccessToken(oauthToken[1])
        : await authenticateMcpCredential(req.headers.authorization, {
          credentialsJson: env.MATTER_MCP_CREDENTIALS,
          findUser,
        });
      next();
    } catch (error) {
      const status = error.statusCode || (error.errorCode === 'invalid_token' ? 401 : 503);
      if (status === 401) {
        const metadata = mcpOAuthUrls(env).metadata;
        res.set('WWW-Authenticate', `Bearer realm="MATTER MCP", resource_metadata="${metadata}", scope="${MCP_OAUTH_SCOPES.join(' ')}"`);
      }
      res.status(status).json({ success: false, message: error.statusCode ? error.message : 'MCP authentication unavailable' });
    }
  });

  router.post('/', async (req, res) => {
    let server;
    let transport;
    try {
      const { user, permissions, allowWrites } = req.mcpContext;
      const token = jwt.sign({ id: String(user._id) }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '60s' });
      const request = createMatterApiClient({
        baseUrl: `http://127.0.0.1:${req.socket.localPort}/api`,
        token,
        fetchImpl,
      });
      server = createMatterMcpServer({
        request, permissions, allowWrites,
        allowDeletes: req.mcpContext.allowDeletes === true && ['admin', 'super_admin'].includes(user.role),
        offsetMinutes: businessOffsetMs(env) / 60000,
        oauth: Boolean(req.mcpContext.scopes),
      });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP request failed' } });
      if (server) await server.close().catch(() => {});
    }
  });
  router.all('/', (_req, res) => {
    res.set('Allow', 'POST').sendStatus(405);
  });
  return router;
}

export default createMcpRouter();
