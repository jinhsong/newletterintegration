import { isIP } from 'node:net';
import { isTrustedOfficialDomain } from './config.mjs';
import {
  ClaudeCliError,
  searchQueryFingerprint,
} from './claude-client.mjs';
import { parseJsonObject } from './json-utils.mjs';

const MAX_EVIDENCE_URLS_PER_SEARCH = 100;
const NON_PUBLIC_HOSTNAME_SUFFIXES = Object.freeze([
  'localhost',
  'local',
  'internal',
  'lan',
  'test',
  'invalid',
  'example',
  'onion',
  'home.arpa',
]);

function publicHttpsUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return '';
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const ipCandidate = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || !hostname.includes('.')
    || isIP(ipCandidate)
    || NON_PUBLIC_HOSTNAME_SUFFIXES.some((suffix) => (
      hostname === suffix || hostname.endsWith(`.${suffix}`)
    ))
  ) return '';
  url.hash = '';
  return url.href;
}

function isGeminiGroundingRedirect(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'vertexaisearch.cloud.google.com'
      && url.pathname.startsWith('/grounding-api-redirect/');
  } catch {
    return false;
  }
}

function normalizedReportedEvidence(response, providerLabel) {
  let parsed;
  try {
    parsed = parseJsonObject(response);
  } catch (error) {
    throw new ClaudeCliError(
      'BAD_JSON',
      `${providerLabel}의 최종 JSON 응답을 읽지 못했습니다.`,
      error.message,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ClaudeCliError('BAD_OUTPUT', `${providerLabel}의 최종 응답은 JSON 객체여야 합니다.`);
  }
  if (!Array.isArray(parsed._searchEvidence)) {
    throw new ClaudeCliError(
      'BAD_OUTPUT',
      `${providerLabel} 응답에 검색별 출처 근거(_searchEvidence)가 없습니다.`,
    );
  }

  const warnings = [];
  const evidence = [];
  for (let index = 0; index < parsed._searchEvidence.length; index += 1) {
    const entry = parsed._searchEvidence[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`_searchEvidence ${index + 1}번 항목의 형식이 잘못되어 제외했습니다.`);
      continue;
    }
    const query = typeof entry.query === 'string' ? entry.query.trim() : '';
    if (!query || !Array.isArray(entry.urls) || entry.urls.length > MAX_EVIDENCE_URLS_PER_SEARCH) {
      warnings.push(`_searchEvidence ${index + 1}번 항목의 query 또는 urls가 올바르지 않아 제외했습니다.`);
      continue;
    }
    const urls = [...new Set(entry.urls.map(publicHttpsUrl).filter(Boolean))];
    if (urls.length < entry.urls.length) {
      warnings.push(`_searchEvidence ${index + 1}번 항목의 중복·비공개·잘못된 URL을 제외했습니다.`);
    }
    evidence.push({
      query,
      fingerprint: searchQueryFingerprint(query),
      mode: entry.mode === 'official' || entry.mode === 'broad' ? entry.mode : '',
      urls,
    });
  }
  const cleaned = { ...parsed };
  delete cleaned._searchEvidence;
  return { evidence, response: JSON.stringify(cleaned), warnings };
}

export function normalizedProviderEnvelope({
  providerKey = '',
  providerLabel,
  response,
  searches,
  stats = null,
  warnings = [],
}) {
  const successful = searches.filter((search) => search.status === 'success');
  const failed = searches.filter((search) => search.status === 'failed');
  const normalized = normalizedReportedEvidence(response, providerLabel);
  const allWarnings = [...warnings, ...normalized.warnings];
  const actualByFingerprint = new Map();
  for (const search of successful) {
    const fingerprint = searchQueryFingerprint(search.query);
    if (!fingerprint || actualByFingerprint.has(fingerprint)) {
      throw new ClaudeCliError(
        'SEARCH_INCOMPLETE',
        `${providerLabel}가 동일하거나 빈 검색어를 성공 검색으로 보고했습니다.`,
        search.query,
      );
    }
    actualByFingerprint.set(fingerprint, search);
  }

  const reportedByFingerprint = new Map();
  for (const entry of normalized.evidence) {
    const actual = actualByFingerprint.get(entry.fingerprint);
    if (!entry.fingerprint || !actual) {
      throw new ClaudeCliError(
        'SEARCH_INCOMPLETE',
        `${providerLabel} 응답에 실제로 실행하지 않은 검색어의 근거가 포함되었습니다.`,
        entry.query,
      );
    }
    const existing = reportedByFingerprint.get(entry.fingerprint);
    if (existing) {
      existing.urls = [...new Set([...existing.urls, ...entry.urls])];
      allWarnings.push(`중복된 검색 근거를 하나로 합쳤습니다: ${entry.query}`);
    } else {
      reportedByFingerprint.set(entry.fingerprint, { ...entry });
    }
  }

  const groundingSearches = [];
  for (const search of successful) {
    const fingerprint = searchQueryFingerprint(search.query);
    const reported = reportedByFingerprint.get(fingerprint);
    if (!reported || reported.urls.length === 0) {
      allWarnings.push(`검색은 성공했지만 확인 가능한 출처 URL이 없어 근거 검색에서 제외했습니다: ${search.query}`);
      continue;
    }
    if (reported.mode && reported.mode !== search.mode) {
      allWarnings.push(`모델이 보고한 검색 유형(${reported.mode}) 대신 실제 검색 유형(${search.mode})을 적용했습니다: ${search.query}`);
    }
    const officialUrls = search.mode === 'official'
      ? reported.urls.filter((url) => isTrustedOfficialDomain(new URL(url).hostname, search.allowedDomains))
      : [];
    const officialRedirectUrls = search.mode === 'official' && providerKey === 'gemini'
      ? reported.urls.filter(isGeminiGroundingRedirect)
      : [];
    if (search.mode === 'official' && officialUrls.length === 0 && officialRedirectUrls.length === 0) {
      allWarnings.push(`공식기관 검색에 신뢰 도메인 원문 또는 Gemini Grounding 링크가 없어 근거 검색에서 제외했습니다: ${search.query}`);
      continue;
    }
    if (officialRedirectUrls.length > 0 && officialUrls.length === 0) {
      allWarnings.push(`Gemini Grounding 리다이렉트 링크로 공식 검색 근거를 확인했습니다. 원문 URL보다 검증 수준이 낮습니다: ${search.query}`);
    }
    groundingSearches.push({
      toolUseId: search.toolUseId,
      query: search.query,
      mode: search.mode,
      allowedDomains: [...search.allowedDomains],
      blockedDomains: [],
      urls: [...reported.urls],
      officialUrls,
      officialRedirectUrls,
      evidenceMatch: officialRedirectUrls.length > 0 && officialUrls.length === 0
        ? 'gemini-grounding-redirect'
        : 'reported-url',
    });
  }

  const groundingUrls = [...new Set(groundingSearches.flatMap((search) => search.urls))];
  const official = groundingSearches.filter((search) => search.mode === 'official').length;
  const broad = groundingSearches.filter((search) => search.mode === 'broad').length;
  const unbackedCount = successful.length - groundingSearches.length;
  return {
    response: normalized.response,
    evidenceKind: 'reported',
    stats,
    warnings: [...new Set(allWarnings.filter(Boolean))],
    toolEvidence: {
      available: true,
      totalCalls: searches.length,
      totalSuccess: groundingSearches.length,
      totalFail: failed.length + unbackedCount,
      byName: {
        WebSearch: {
          count: searches.length,
          success: groundingSearches.length,
          fail: failed.length + unbackedCount,
          official,
          broad,
          queries: groundingSearches.map((search) => ({
            query: search.query,
            mode: search.mode,
            allowedDomains: [...search.allowedDomains],
            blockedDomains: [],
          })),
        },
      },
    },
    groundingUrls,
    groundingSearches,
  };
}

export function classifySiteFilteredQuery(query, officialDomainAllowlist) {
  const value = String(query || '').trim();
  if (!value) throw new ClaudeCliError('BAD_OUTPUT', '검색 도구 query가 비어 있습니다.');
  const siteDomains = [...value.matchAll(/(?:^|[\s(])site:([a-z0-9.-]+)(?=$|[\s)])/gi)]
    .map((match) => match[1].toLowerCase().replace(/\.$/, ''));
  const uniqueDomains = [...new Set(siteDomains)];
  if (uniqueDomains.some((hostname) => !isTrustedOfficialDomain(hostname, officialDomainAllowlist))) {
    throw new ClaudeCliError(
      'SEARCH_INCOMPLETE',
      '공식기관 검색어에 허용 목록 밖 site: 도메인이 포함되었습니다.',
      uniqueDomains.join(', '),
    );
  }
  return {
    query: value,
    mode: uniqueDomains.length > 0 ? 'official' : 'broad',
    allowedDomains: uniqueDomains,
  };
}
