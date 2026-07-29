import dns from 'node:dns/promises';
import net from 'node:net';
import { domains } from './config-loader.mjs';

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  return parts[0] === 0
    || parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] >= 224;
}

function isPrivateAddress(address) {
  const lower = String(address || '').toLowerCase();
  if (net.isIPv4(lower)) return isPrivateIpv4(lower);
  if (!net.isIPv6(lower)) return true;
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8')
      || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  if (lower.startsWith('::ffff:')) return isPrivateIpv4(lower.slice(7));
  return false;
}

function parsePublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    return null;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname.includes('.') || hostname === 'localhost' || hostname.endsWith('.local')
      || net.isIP(hostname)) return null;
  url.hash = '';
  return url;
}

async function assertPublicDns(hostname, lookup = dns.lookup) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error('DNS 주소 없음');
  }
  if (addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error('사설/로컬 네트워크 주소 차단');
  }
}

async function requestUrl(url, fetchImpl, timeoutMs, method) {
  const response = await fetchImpl(url, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: method === 'GET' ? { Range: 'bytes=0-2047' } : undefined,
  });
  if (response.body) await response.body.cancel().catch(() => {});
  return response;
}

export async function validatePublicSourceUrl(value, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const lookup = options.lookup || dns.lookup;
  const timeoutMs = options.timeoutMs || 8000;
  let current = parsePublicHttpsUrl(value);
  if (!current) throw new Error('HTTPS 공개 URL 형식이 아님');

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    await assertPublicDns(current.hostname, lookup);
    let response = await requestUrl(current, fetchImpl, timeoutMs, 'HEAD');
    if ([405, 501].includes(response.status)) {
      response = await requestUrl(current, fetchImpl, timeoutMs, 'GET');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`리다이렉트 위치 없음 (${response.status})`);
      current = parsePublicHttpsUrl(new URL(location, current).href);
      if (!current) throw new Error('안전하지 않은 리다이렉트 URL');
      continue;
    }
    if ((response.status >= 200 && response.status < 300) || [401, 403].includes(response.status)) {
      return current.href;
    }
    throw new Error(`HTTP ${response.status}`);
  }
  throw new Error('리다이렉트 횟수 초과');
}

function payloadItems(payload) {
  const items = [];
  for (const domain of domains) {
    for (const unit of domain.units) {
      for (const item of payload.data[domain.key][unit.key] || []) items.push(item);
    }
  }
  return items;
}

async function runPool(items, worker, limit) {
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => consume()));
}

export async function attachValidatedSources(payload, options = {}) {
  const all = payloadItems(payload);
  const candidates = all
    .filter((item) => item.__modelUrl)
    .slice(0, options.maxUrls || 40);
  let accepted = 0;
  await runPool(candidates, async (item) => {
    try {
      item.sourceUrl = await validatePublicSourceUrl(item.__modelUrl, options);
      item.sourceDomain = new URL(item.sourceUrl).hostname.replace(/^www\./, '');
      item.__urlSource = 'validated-model-url';
      accepted += 1;
    } catch {
      item.sourceUrl = '';
      item.sourceDomain = '';
    }
  }, options.concurrency || 5);
  return { candidates: candidates.length, accepted };
}

export function attachMockSources(payload) {
  let accepted = 0;
  for (const item of payloadItems(payload)) {
    const parsed = parsePublicHttpsUrl(item.__modelUrl);
    if (!parsed) continue;
    item.sourceUrl = parsed.href;
    item.sourceDomain = parsed.hostname.replace(/^www\./, '');
    item.__urlSource = 'mock-fixture';
    accepted += 1;
  }
  return { candidates: accepted, accepted };
}
