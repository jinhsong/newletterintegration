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
    throw new ClaudeCliError('BAD_OUTPUT', `${providerLabel}의 최종 응답이 JSON 객체가 아닙니다.`);
  }
  const evidence = parsed._searchEvidence;
  if (!Array.isArray(evidence)) {
    throw new ClaudeCliError(
      'BAD_OUTPUT',
      `${providerLabel} 응답에 검색별 출처 근거(_searchEvidence)가 없습니다.`,
    );
  }
  const normalized = evidence.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ClaudeCliError('BAD_OUTPUT', `_searchEvidence ${index + 1}번째 항목 형식이 올바르지 않습니다.`);
    }
    const unknownFields = Object.keys(entry).filter((key) => !['query', 'mode', 'urls'].includes(key));
    if (unknownFields.length > 0) {
      throw new ClaudeCliError(
        'BAD_OUTPUT',
        `_searchEvidence ${index + 1}번째 항목에 알 수 없는 필드가 있습니다.`,
        unknownFields.join(', '),
      );
    }
    const query = typeof entry.query === 'string' ? entry.query.trim() : '';
    const mode = entry.mode === 'official' || entry.mode === 'broad' ? entry.mode : '';
    if (!query || !mode || !Array.isArray(entry.urls)
      || entry.urls.length < 1 || entry.urls.length > MAX_EVIDENCE_URLS_PER_SEARCH) {
      throw new ClaudeCliError(
        'BAD_OUTPUT',
        `_searchEvidence ${index + 1}번째 항목의 query·mode·urls가 완전하지 않습니다.`,
      );
    }
    const urls = [...new Set(entry.urls.map(publicHttpsUrl).filter(Boolean))];
    if (urls.length !== entry.urls.length) {
      throw new ClaudeCliError(
        'BAD_OUTPUT',
        `_searchEvidence ${index + 1}번째 항목에 중복되거나 안전하지 않은 URL이 있습니다.`,
      );
    }
    return {
      query,
      fingerprint: searchQueryFingerprint(query),
      mode,
      urls,
    };
  });
  const cleaned = { ...parsed };
  delete cleaned._searchEvidence;
  return { evidence: normalized, response: JSON.stringify(cleaned) };
}

export function normalizedProviderEnvelope({
  providerLabel,
  response,
  searches,
  stats = null,
  warnings = [],
}) {
  const successful = searches.filter((search) => search.status === 'success');
  const failed = searches.filter((search) => search.status === 'failed');
  const { evidence, response: cleanedResponse } = normalizedReportedEvidence(response, providerLabel);
  if (evidence.length !== successful.length) {
    throw new ClaudeCliError(
      'SEARCH_INCOMPLETE',
      `${providerLabel}의 성공 검색 수와 보고된 검색별 출처 근거 수가 일치하지 않습니다.`,
      `성공 검색 ${successful.length}회, 출처 근거 ${evidence.length}개`,
    );
  }

  const reportedByFingerprint = new Map();
  for (const entry of evidence) {
    if (!entry.fingerprint || reportedByFingerprint.has(entry.fingerprint)) {
      throw new ClaudeCliError(
        'SEARCH_INCOMPLETE',
        `${providerLabel}의 검색별 출처 근거에 빈 검색어 또는 의미상 중복 검색어가 있습니다.`,
      );
    }
    reportedByFingerprint.set(entry.fingerprint, entry);
  }

  const groundingSearches = successful.map((search) => {
    const fingerprint = searchQueryFingerprint(search.query);
    const reported = reportedByFingerprint.get(fingerprint);
    if (!reported || reported.mode !== search.mode) {
      throw new ClaudeCliError(
        'SEARCH_INCOMPLETE',
        `${providerLabel}의 실제 검색 query와 최종 검색별 출처 근거가 일치하지 않습니다.`,
        search.query,
      );
    }
    reportedByFingerprint.delete(fingerprint);
    const officialUrls = search.mode === 'official'
      ? reported.urls.filter((url) => (
        isTrustedOfficialDomain(new URL(url).hostname, search.allowedDomains)
      ))
      : [];
    if (search.mode === 'official' && officialUrls.length === 0) {
      throw new ClaudeCliError(
        'BAD_OUTPUT',
        `${providerLabel}의 공식기관 검색 근거에 허용 도메인의 원문 URL이 없습니다.`,
        search.query,
      );
    }
    return {
      toolUseId: search.toolUseId,
      query: search.query,
      mode: search.mode,
      allowedDomains: [...search.allowedDomains],
      blockedDomains: [],
      urls: [...reported.urls],
      officialUrls,
    };
  });
  if (reportedByFingerprint.size > 0) {
    throw new ClaudeCliError(
      'SEARCH_INCOMPLETE',
      `${providerLabel} 응답에 실제 실행되지 않은 검색 query의 근거가 포함되었습니다.`,
    );
  }

  const groundingUrls = [...new Set(groundingSearches.flatMap((search) => search.urls))];
  const official = successful.filter((search) => search.mode === 'official').length;
  const broad = successful.filter((search) => search.mode === 'broad').length;
  return {
    response: cleanedResponse,
    // Gemini/Codex JSONL은 검색 query 실행은 보여 주지만 검색결과 원문 URL 목록은
    // 제공하지 않는다. 아래 URL은 모델이 최종 응답에서 보고한 값임을 보존한다.
    evidenceKind: 'reported',
    stats,
    warnings,
    toolEvidence: {
      available: true,
      totalCalls: searches.length,
      totalSuccess: successful.length,
      totalFail: failed.length,
      byName: {
        WebSearch: {
          count: searches.length,
          success: successful.length,
          fail: failed.length,
          official,
          broad,
          queries: successful.map((search) => ({
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
      '공식기관 검색 query에 신뢰 목록 밖 site: 도메인이 포함되었습니다.',
      uniqueDomains.join(', '),
    );
  }
  return {
    query: value,
    mode: uniqueDomains.length > 0 ? 'official' : 'broad',
    allowedDomains: uniqueDomains,
  };
}
