function required(env, name) {
  if (!env[name]?.trim()) throw new Error(`${name} is required`);
  return env[name].trim();
}
function httpsUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials, query, or fragment`);
  }
  return url;
}
export function readConfig(env = process.env) {
  const gas = httpsUrl(required(env, 'GAS_WEB_APP_URL'), 'GAS_WEB_APP_URL');
  if (gas.hostname !== 'script.google.com' || !/^\/macros\/s\/[\w-]+\/exec$/.test(gas.pathname)) {
    throw new Error('GAS_WEB_APP_URL must be a deployed script.google.com /macros/s/.../exec URL');
  }
  const token = required(env, 'GAS_API_TOKEN');
  if (token.length < 32) throw new Error('GAS_API_TOKEN must contain at least 32 characters');
  const transport = env.MCP_TRANSPORT || 'stdio';
  if (!['stdio', 'http'].includes(transport)) throw new Error('MCP_TRANSPORT must be stdio or http');
  const config = { gasUrl: gas.href, gasToken: token, transport, sendEnabled: env.ENABLE_SEND_TOOL === 'true' };
  if (transport === 'http') {
    config.publicUrl = httpsUrl(required(env, 'MCP_PUBLIC_URL'), 'MCP_PUBLIC_URL').href;
    if (new URL(config.publicUrl).pathname !== '/mcp') throw new Error('MCP_PUBLIC_URL path must be /mcp');
    config.issuer = required(env, 'OAUTH_ISSUER');
    httpsUrl(config.issuer, 'OAUTH_ISSUER'); // Validate without changing the issuer's exact string.
    config.jwksUrl = httpsUrl(required(env, 'OAUTH_JWKS_URL'), 'OAUTH_JWKS_URL').href;
    config.allowedSubjects = required(env, 'OAUTH_ALLOWED_SUBJECTS').split(',').map(s => s.trim()).filter(Boolean);
    if (!config.allowedSubjects.length || config.allowedSubjects.includes('*')) throw new Error('Explicit OAuth subjects are required');
    config.port = Number(env.PORT || 8080);
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid PORT');
    config.host = env.HOST || '127.0.0.1';
  }
  return config;
}
