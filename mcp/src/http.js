import express from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';

export function createTokenVerifier(config, keySet = createRemoteJWKSet(new URL(config.jwksUrl))) {
  return async token => {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: config.issuer, audience: config.publicUrl, algorithms: ['RS256', 'ES256'],
      requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5
    });
    if (!config.allowedSubjects.includes(payload.sub)) throw new Error('Subject denied');
    const scopes = new Set(typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : []);
    if (!scopes.has('trade:read')) throw new Error('Read scope required');
    return scopes;
  };
}

export function createHttpApp(config, callGas, verifyToken = createTokenVerifier(config)) {
  const app = express();
  const publicUrl = new URL(config.publicUrl);
  const metadataUrl = `${publicUrl.origin}/.well-known/oauth-protected-resource`;
  const advertisedScopes = ['trade:read', 'trade:collect', ...(config.sendEnabled ? ['trade:send'] : [])];
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.json({
    resource: config.publicUrl, authorization_servers: [config.issuer], scopes_supported: advertisedScopes,
    bearer_methods_supported: ['header'], resource_name: '통상 통합 모니터링'
  }));
  app.use('/mcp', async (req, res, next) => {
    // Browser-origin requests must come from the configured origin. Server-to-server MCP has no Origin header.
    if (req.headers.origin && req.headers.origin !== publicUrl.origin) return res.status(403).json({ error: 'origin_denied' });
    try {
      const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '');
      if (!match) throw new Error('Missing token');
      req.tradeScopes = await verifyToken(match[1]);
      next();
    } catch {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}", scope="${advertisedScopes.join(' ')}"`);
      res.status(401).json({ error: 'unauthorized' });
    }
  });
  app.post('/mcp', express.json({ limit: '32kb' }), async (req, res) => {
    const server = createServer(callGas, { sendEnabled: config.sendEnabled, grantedScopes: req.tradeScopes, oauth: true });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
    }
  });
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());
  app.use((_err, _req, res, _next) => res.status(400).json({ error: 'invalid_request' }));
  return app;
}
