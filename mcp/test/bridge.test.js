import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGasClient } from '../src/gas-client.js';
import { readConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { createHttpApp, createTokenVerifier } from '../src/http.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';

const base = { GAS_WEB_APP_URL: 'https://script.google.com/macros/s/test-deployment/exec', GAS_API_TOKEN: 's'.repeat(48) };
const config = readConfig(base);

test('config rejects unsafe URLs, short secrets, and unauthenticated HTTP mode', () => {
  assert.throws(() => readConfig({ ...base, GAS_API_TOKEN: 'short' }));
  assert.throws(() => readConfig({ ...base, GAS_WEB_APP_URL: 'https://evil.example/exec' }));
  assert.throws(() => readConfig({ ...base, MCP_TRANSPORT: 'http' }));
});

test('Apps Script redirect uses GET and does not forward token or payload', async () => {
  const calls = [];
  const call = createGasClient(config, async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response('', { status: 302, headers: { location: 'https://script.googleusercontent.com/macros/echo?key=test' } });
    return Response.json({ ok: true, data: { status: 'queued' } });
  });
  assert.equal((await call('collect', { requestId: 'collection-00000001' })).status, 'queued');
  assert.equal(calls[1].options.method, 'GET'); assert.equal(calls[1].options.body, undefined); assert.equal(calls[1].options.headers, undefined);
  assert.equal(JSON.parse(calls[0].options.body).token, base.GAS_API_TOKEN);
});

test('HTTP 200 application failures, login redirects, and malformed JSON are errors', async () => {
  await assert.rejects(createGasClient(config, async () => Response.json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'denied' } }))('latest'), { code: 'UNAUTHORIZED' });
  await assert.rejects(createGasClient(config, async () => new Response('', { status: 302, headers: { location: 'https://accounts.google.com/login' } }))('latest'), { code: 'DEPLOYMENT_ACCESS' });
  await assert.rejects(createGasClient(config, async () => new Response('<html>login</html>'))('latest'), { code: 'UPSTREAM_FORMAT' });
});

async function connectedServer(options, calls) {
  const server = createServer(async (action, args) => { calls.push({ action, args }); return { status: 'queued', jobId: args.requestId }; }, options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(a); await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('MCP exposes read/collect/status by default, validates input, and routes real protocol calls', async () => {
  const calls = []; const h = await connectedServer({}, calls);
  try {
    assert.deepEqual((await h.client.listTools()).tools.map(t => t.name), ['get_latest_briefing', 'start_briefing_collection', 'get_briefing_job']);
    const r = await h.client.callTool({ name: 'start_briefing_collection', arguments: { requestId: 'collection-00000001' } });
    assert.equal(r.structuredContent.status, 'queued'); assert.equal(calls[0].action, 'collect');
    const invalid = await h.client.callTool({ name: 'start_briefing_collection', arguments: { requestId: 'short' } });
    assert.equal(invalid.isError, true); assert.equal(calls.length, 1);
  } finally { await h.close(); }
});

test('MCP scope checks prevent collection/mail and advertise OAuth metadata', async () => {
  const calls = []; const h = await connectedServer({ sendEnabled: true, oauth: true, grantedScopes: new Set(['trade:read']) }, calls);
  try {
    const tools = (await h.client.listTools()).tools;
    assert.equal(tools.length, 4); assert.equal(tools[3].annotations.destructiveHint, true);
    assert.equal(tools[0]._meta.securitySchemes[0].type, 'oauth2');
    const r = await h.client.callTool({ name: 'start_briefing_collection', arguments: { requestId: 'collection-00000001' } });
    assert.equal(r.isError, true); assert.equal(calls.length, 0);
  } finally { await h.close(); }
});

test('JWT verifier checks signature, audience, issuer, expiration, subject allowlist, and scopes', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test';
  const cfg = { issuer: 'https://issuer.example/', publicUrl: 'https://mcp.example/mcp', allowedSubjects: ['user-one'], jwksUrl: 'https://issuer.example/jwks' };
  const verify = createTokenVerifier(cfg, createLocalJWKSet({ keys: [jwk] }));
  const token = (extra = {}) => new SignJWT({ sub: 'user-one', scope: 'trade:read trade:collect', ...extra })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(extra.iss || cfg.issuer).setAudience(extra.aud || cfg.publicUrl).setIssuedAt().setExpirationTime(extra.exp || '5m').sign(privateKey);
  assert.ok((await verify(await token())).has('trade:collect'));
  for (const bad of [{ sub: 'other-user' }, { aud: 'other-audience' }, { iss: 'https://wrong.example/' }, { scope: 'trade:send' }, { exp: 1 }]) await assert.rejects(verify(await token(bad)));
  const valid = await token(); await assert.rejects(verify(valid.slice(0, -20) + 'invalid-signature'));
});

test('HTTP discovery, auth challenge, origin check, and stateless MCP handshake work', async () => {
  const cfg = { publicUrl: 'https://mcp.example/mcp', issuer: 'https://issuer.example/', sendEnabled: false };
  const app = createHttpApp(cfg, async () => ({ status: 'completed' }), async token => {
    if (token !== 'test-token') throw new Error('denied'); return new Set(['trade:read']);
  });
  const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
  const origin = `http://127.0.0.1:${listener.address().port}`;
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  try {
    const unauth = await fetch(origin + '/mcp', { method: 'POST' }); assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('www-authenticate'), /oauth-protected-resource/);
    const metadata = await (await fetch(origin + '/.well-known/oauth-protected-resource')).json(); assert.equal(metadata.resource, cfg.publicUrl);
    assert.equal((await fetch(origin + '/mcp', { method: 'POST', headers: { Origin: 'https://evil.example', Authorization: 'Bearer test-token' } })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer test-token' } } }));
    assert.equal((await client.listTools()).tools.length, 3);
    assert.equal((await client.callTool({ name: 'get_latest_briefing', arguments: {} })).structuredContent.status, 'completed');
  } finally { await client.close(); await new Promise(resolve => listener.close(resolve)); }
});
