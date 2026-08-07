import fs from 'node:fs/promises';
import net from 'node:net';
import {
  buildCategoryPrompt,
  CATEGORY_RESEARCH_POLICY,
  domains,
  isTrustedOfficialDomain,
  resolveCategorySelector,
  scopedDomains,
} from './config.mjs';
import {
  callClaudeCli,
  ClaudeCliError,
  isRetryableClaudeError,
  retryMax,
  searchQueryFingerprint,
} from './claude-client.mjs';
import { parseJsonObject } from './json-utils.mjs';

const KST = 'Asia/Seoul';
const IMPORTANCE_ORDER = { 상: 0, 중: 1, 하: 2 };
const FALLBACK_ERROR_CODES = new Set([
  'BAD_JSON',
  'BAD_OUTPUT',
  'TURN_LIMIT',
  'SEARCH_NOT_RUN',
  'SEARCH_INCOMPLETE',
  'SEARCH_FAILED',
  'SEARCH_WARNING',
]);
const FATAL_ERROR_CODES = new Set([
  'ABORTED',
  'AUTH',
  'AUTH_ORG',
  'BUDGET_LIMIT',
  'CLI_EXIT',
  'CLI_NOT_FOUND',
  'CLI_VERSION',
  'CONFIG',
  'POLICY',
  'PROCESS_CLEANUP',
  'SECURITY_POLICY',
  'WEB_SEARCH_UNAVAILABLE',
]);

function formatKst(date, withTime = false) {
  const options = {
    timeZone: KST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };
  if (withTime) {
    options.hour = '2-digit';
    options.minute = '2-digit';
    options.hourCycle = 'h23';
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', options)
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return withTime ? `${day} ${parts.hour}:${parts.minute}` : day;
}

function weekdayKst(date) {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: KST,
    weekday: 'short',
  }).format(date);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[day];
}

export function createContext(now = new Date(), lookbackOverride) {
  const lookbackHours = lookbackOverride ?? (weekdayKst(now) === 1 ? 72 : 24);
  if (![24, 72, 168].includes(lookbackHours)) {
    throw new Error('lookback은 24, 72, 168시간 중 하나여야 합니다.');
  }
  const fromDate = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  return {
    now,
    fromDate,
    lookbackHours,
    fromISO: formatKst(fromDate),
    toISO: formatKst(now),
    fromStr: formatKst(fromDate, true),
    toStr: formatKst(now, true),
    dateCoverageNote: '발표시각이 확인된 항목은 정확한 시각, 나머지는 KST 달력 날짜 기준',
  };
}

function text(value, maximum = 2000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

export function safeSourceUrl(value) {
  let url;
  try {
    url = new URL(text(value, 3000));
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
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan')
    || net.isIP(ipCandidate)
  ) return '';
  url.hash = '';
  return url.href;
}

export function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function parseTimestamp(value) {
  const normalized = text(value, 50);
  if (!normalized) return { value: '', valid: true, date: null };
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(normalized);
  if (!match || !isCalendarDate(match[1])) {
    return { value: '', valid: false, date: null };
  }
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] || 0);
  const offsetHour = Number(match[6] || 0);
  const offsetMinute = Number(match[7] || 0);
  if (
    hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 14
    || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0)
  ) return { value: '', valid: false, date: null };
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return { value: '', valid: false, date: null };
  return { value: normalized, valid: true, date };
}

function sourceIsGrounded(sourceUrl, groundingUrls) {
  if (!sourceUrl || groundingUrls.length === 0) return false;
  const source = new URL(sourceUrl);
  return groundingUrls.some((candidate) => {
    try {
      const grounded = new URL(candidate);
      return grounded.href === source.href;
    } catch {
      return false;
    }
  });
}

function normalizeItem(raw, groundingUrls = []) {
  const errors = [];
  const importance = text(raw?.importance, 5);
  if (!Object.hasOwn(IMPORTANCE_ORDER, importance)) errors.push('importance');

  const announcedDate = text(raw?.announcedDate, 10);
  if (!isCalendarDate(announcedDate)) errors.push('announcedDate');

  const timestamp = parseTimestamp(raw?.announcedAt);
  if (!timestamp.valid) errors.push('announcedAt');
  if (timestamp.value && timestamp.value.slice(0, 10) !== announcedDate) {
    errors.push('announcedAtDateMismatch');
  }

  const effectiveDate = text(raw?.effectiveDate, 10);
  if (effectiveDate && !isCalendarDate(effectiveDate)) errors.push('effectiveDate');

  const sourceUrl = safeSourceUrl(raw?.sourceUrl);
  const item = {
    importance,
    importanceReason: text(raw?.importanceReason, 500),
    measureType: text(raw?.measureType, 100),
    title: text(raw?.title, 180),
    titleEn: text(raw?.titleEn, 240),
    summary: text(raw?.summary, 1200),
    businessImpact: text(raw?.businessImpact, 600),
    announcedDate,
    announcedAt: timestamp.value,
    datePrecision: timestamp.value ? 'time' : 'day',
    effectiveDate,
    hsCode: text(raw?.hsCode, 120),
    issuingCountry: text(raw?.issuingCountry, 160),
    targetCountries: Array.isArray(raw?.targetCountries)
      ? raw.targetCountries.map((itemValue) => text(itemValue, 80)).filter(Boolean).join(', ')
      : text(raw?.targetCountries, 240),
    agency: text(raw?.agency, 240),
    sourceName: text(raw?.sourceName, 160),
    sourceUrl,
    sourceVerification: !sourceUrl
      ? 'missing'
      : (sourceIsGrounded(sourceUrl, groundingUrls) ? 'grounded' : 'format-only'),
    notes: text(raw?.notes, 600),
  };

  for (const field of [
    'importanceReason',
    'measureType',
    'title',
    'summary',
    'issuingCountry',
    'agency',
    'sourceName',
    'sourceUrl',
  ]) {
    if (!item[field]) errors.push(field);
  }
  return { item, errors: [...new Set(errors)], timestamp: timestamp.date };
}

function inDateRange(item, timestamp, context) {
  if (timestamp) {
    return timestamp.getTime() >= context.fromDate.getTime()
      && timestamp.getTime() <= context.now.getTime();
  }
  return item.announcedDate >= context.fromISO && item.announcedDate <= context.toISO;
}

export function normalizeTitle(value) {
  return text(value, 300)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function categoryFailure(reason = '조사되지 않음') {
  return {
    status: 'failure',
    coverage: 'none',
    itemCount: 0,
    rejectedCount: 0,
    reason,
  };
}

function emptyDomainResult(domain, requestedUnits = domain.units) {
  return {
    insight: '',
    categoryInsights: Object.fromEntries(requestedUnits.map((unit) => [unit.key, ''])),
    categories: Object.fromEntries(requestedUnits.map((unit) => [unit.key, []])),
    categoryStatus: Object.fromEntries(
      requestedUnits.map((unit) => [unit.key, categoryFailure()]),
    ),
    coverage: {
      requestedCategories: requestedUnits.length,
      completedCategories: 0,
      failedCategories: requestedUnits.length,
      webSearchSuccesses: 0,
      warningCount: 0,
      complete: false,
    },
  };
}

function compareItems(a, b) {
  return IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance]
    || b.announcedDate.localeCompare(a.announcedDate)
    || (b.announcedAt || '').localeCompare(a.announcedAt || '')
    || a.title.localeCompare(b.title, 'ko');
}

function refreshCoverage(result) {
  const statuses = Object.values(result.categoryStatus);
  const completedCategories = statuses.filter((status) => status.status !== 'failure').length;
  result.coverage.requestedCategories = statuses.length;
  result.coverage.completedCategories = completedCategories;
  result.coverage.failedCategories = statuses.length - completedCategories;
  result.coverage.complete = completedCategories === statuses.length;
  return result;
}

export function parseDomainResponse(domain, response, context, options = {}) {
  let parsed;
  try {
    parsed = typeof response === 'string' ? parseJsonObject(response) : response;
  } catch (error) {
    throw new ClaudeCliError('BAD_JSON', `${domain.label} 응답 JSON을 읽지 못했습니다.`, error.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ClaudeCliError('BAD_JSON', `${domain.label} 응답이 JSON 객체가 아닙니다.`);
  }
  if (parsed.domain !== domain.key) {
    throw new ClaudeCliError('BAD_JSON', `${domain.label} 응답의 domain 값이 올바르지 않습니다.`);
  }
  if (!parsed.categories || typeof parsed.categories !== 'object' || Array.isArray(parsed.categories)) {
    throw new ClaudeCliError('BAD_JSON', `${domain.label} 응답에 categories 객체가 없습니다.`);
  }

  const requestedUnits = options.units || domain.units;
  const requestedKeys = new Set(requestedUnits.map((unit) => unit.key));
  const unexpectedKeys = Object.keys(parsed.categories)
    .filter((key) => !requestedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw new ClaudeCliError(
      'BAD_JSON',
      `${domain.label} 응답에 요청하지 않은 카테고리가 포함되어 있습니다.`,
      unexpectedKeys.join(', '),
    );
  }
  const coverage = options.coverage === 'fallback' ? 'fallback' : 'full';
  const result = emptyDomainResult(domain, requestedUnits);
  result.coverage.webSearchSuccesses = Number(options.webSearchSuccesses) || 0;
  result.coverage.warningCount = Number(options.warningCount) || 0;

  for (const unit of requestedUnits) {
    const rawItems = parsed.categories[unit.key];
    if (!Array.isArray(rawItems)) {
      result.categoryStatus[unit.key] = categoryFailure(`${unit.key} 배열 누락`);
      continue;
    }

    const accepted = [];
    let rejectedCount = 0;
    for (const rawItem of rawItems.slice(0, 50)) {
      const normalized = normalizeItem(rawItem, options.groundingUrls || []);
      if (normalized.errors.length > 0 || !inDateRange(normalized.item, normalized.timestamp, context)) {
        rejectedCount += 1;
        continue;
      }
      accepted.push(normalized.item);
    }
    accepted.sort(compareItems);
    const uniqueAccepted = [];
    for (const candidate of accepted) {
      const duplicateIndex = uniqueAccepted.findIndex((existing) => sameEvent(existing, candidate));
      if (duplicateIndex === -1) {
        uniqueAccepted.push(candidate);
      } else if (shouldReplaceDuplicate(uniqueAccepted[duplicateIndex], candidate)) {
        uniqueAccepted[duplicateIndex] = candidate;
      }
    }
    uniqueAccepted.sort(compareItems);
    result.categories[unit.key] = uniqueAccepted.slice(
      0,
      CATEGORY_RESEARCH_POLICY.maximumItemsPerCategory,
    );

    if (rawItems.length > 0 && accepted.length === 0) {
      result.categoryStatus[unit.key] = {
        ...categoryFailure('응답 항목이 필수 필드 또는 조사 기간 검증을 통과하지 못함'),
        rejectedCount,
      };
      continue;
    }
    result.categoryStatus[unit.key] = {
      status: accepted.length > 0 ? 'success' : 'empty',
      coverage,
      itemCount: result.categories[unit.key].length,
      rejectedCount,
      webSearchSuccesses: Number(options.webSearchSuccesses) || 0,
      reason: rejectedCount > 0 ? `${rejectedCount}건 검증 제외` : '',
    };
  }

  const itemCount = requestedUnits.reduce(
    (sum, unit) => sum + result.categories[unit.key].length,
    0,
  );
  result.insight = itemCount > 0 ? text(parsed.insight, 1000) : '';
  for (const unit of requestedUnits) {
    result.categoryInsights[unit.key] = result.categories[unit.key].length > 0
      ? result.insight
      : '';
  }
  return refreshCoverage(result);
}

function warningStrings(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ClaudeCliError('BAD_OUTPUT', 'Claude CLI의 warnings 형식이 올바르지 않습니다.');
  }
  return value.map((warning) => text(warning, 1000)).filter(Boolean);
}

function normalizedEvidenceQueries(search, officialDomainAllowlist = []) {
  if (!Array.isArray(search?.queries)) return [];
  return search.queries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const query = text(entry.query, 1000);
    if (!query) return null;
    const normalized = query
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    if (!normalized) return null;
    if (!Array.isArray(entry.allowedDomains)) return null;
    const allowedDomains = entry.allowedDomains
      .map((value) => text(value, 253))
      .filter(Boolean);
    if (allowedDomains.length !== entry.allowedDomains.length) return null;
    const trustedOfficial = allowedDomains.length > 0
      && allowedDomains.every(
        (hostname) => isTrustedOfficialDomain(hostname, officialDomainAllowlist),
      );
    const mode = trustedOfficial ? 'official' : (allowedDomains.length > 0 ? 'untrusted' : 'broad');
    return {
      query,
      normalized,
      fingerprint: searchQueryFingerprint(normalized),
      mode,
    };
  }).filter(Boolean);
}

export function validateResearchEnvelope(
  envelope,
  label = '조사',
  expectedSearches = 1,
  options = {},
) {
  if (!envelope || typeof envelope !== 'object') {
    throw new ClaudeCliError('BAD_OUTPUT', `${label} 응답 봉투가 올바르지 않습니다.`);
  }
  const warnings = warningStrings(envelope.warnings);
  const search = envelope.toolEvidence?.byName?.WebSearch;
  const success = Number(search?.success);
  const fail = Number(search?.fail || 0);

  if (!Number.isSafeInteger(success) || success < 1) {
    const code = Number.isSafeInteger(fail) && fail > 0 ? 'SEARCH_FAILED' : 'SEARCH_NOT_RUN';
    throw new ClaudeCliError(
      code,
      `${label}에서 성공한 Claude WebSearch 호출을 확인하지 못했습니다.`,
      warnings.join('\n'),
    );
  }
  if (!Number.isSafeInteger(expectedSearches) || expectedSearches < 1) {
    throw new ClaudeCliError('CONFIG', `${label}의 최소 검색 횟수 설정이 올바르지 않습니다.`);
  }
  if (success < expectedSearches) {
    throw new ClaudeCliError(
      'SEARCH_INCOMPLETE',
      `${label}에서 카테고리별 검색 횟수가 부족합니다.`,
      `필요 ${expectedSearches}회, 성공 ${success}회`,
    );
  }
  if (!Number.isSafeInteger(fail) || fail < 0) {
    throw new ClaudeCliError(
      'SEARCH_FAILED',
      `${label} 중 Claude WebSearch 실패가 감지되었습니다.`,
      warnings.join('\n'),
    );
  }
  const officialDomainAllowlist = Array.isArray(options.officialDomainAllowlist)
    ? options.officialDomainAllowlist
    : [];
  if (options.requireOfficialAndBroadSearch === true && officialDomainAllowlist.length === 0) {
    throw new ClaudeCliError('CONFIG', `${label}의 공식기관 신뢰 도메인 목록이 비어 있습니다.`);
  }
  const minimumOfficialSearches = options.minimumOfficialSearches ?? 1;
  const minimumBroadSearches = options.minimumBroadSearches ?? 1;
  if (options.requireOfficialAndBroadSearch === true && (
    !Number.isSafeInteger(minimumOfficialSearches)
    || minimumOfficialSearches < 1
    || !Number.isSafeInteger(minimumBroadSearches)
    || minimumBroadSearches < 1
  )) {
    throw new ClaudeCliError('CONFIG', `${label}의 검색 종류별 최소 횟수 설정이 올바르지 않습니다.`);
  }
  if (options.requireOfficialAndBroadSearch !== true && fail > 0) {
    throw new ClaudeCliError(
      'SEARCH_FAILED',
      `${label} 중 Claude WebSearch 실패가 감지되었습니다.`,
      warnings.join('\n'),
    );
  }
  const queries = normalizedEvidenceQueries(search, officialDomainAllowlist);
  if (options.requireOfficialAndBroadSearch === true && queries.length !== success) {
    throw new ClaudeCliError(
      'SEARCH_INCOMPLETE',
      `${label}의 성공 검색별 query·도메인 증거가 완전하지 않습니다.`,
      `성공 ${success}회, 검증 가능한 검색 증거 ${queries.length}개`,
    );
  }
  const distinctQueries = new Set(
    queries.map((entry) => entry.fingerprint).filter(Boolean),
  );
  const officialSearches = queries.filter((entry) => entry.mode === 'official').length;
  const broadSearches = queries.filter((entry) => entry.mode === 'broad').length;
  const untrustedSearches = queries.filter((entry) => entry.mode === 'untrusted').length;
  if (options.requireOfficialAndBroadSearch === true && untrustedSearches > 0) {
    throw new ClaudeCliError(
      'SEARCH_INCOMPLETE',
      `${label}의 공식기관 검색에 신뢰 목록 밖 도메인이 포함되었습니다.`,
      `신뢰 목록 밖 도메인 제한 검색 ${untrustedSearches}회`,
    );
  }
  const minimumDistinctQueries = Math.max(
    expectedSearches,
    minimumOfficialSearches + minimumBroadSearches,
  );
  if (options.requireOfficialAndBroadSearch === true && (
    distinctQueries.size < minimumDistinctQueries
    || officialSearches < minimumOfficialSearches
    || broadSearches < minimumBroadSearches
  )) {
    throw new ClaudeCliError(
      'SEARCH_INCOMPLETE',
      `${label}에서 필수 다각도 공식기관 검색과 일반 동향 검색을 모두 확인하지 못했습니다.`,
      `서로 다른 query ${distinctQueries.size}개(최소 ${minimumDistinctQueries}개), `
      + `공식기관 검색 ${officialSearches}회(최소 ${minimumOfficialSearches}회), `
      + `일반 동향 검색 ${broadSearches}회(최소 ${minimumBroadSearches}회)`,
    );
  }
  const blockingWarnings = warnings.filter((warning) => (
    !(options.requireOfficialAndBroadSearch === true && fail > 0 && /^WebSearch 실패:/i.test(warning))
    && /\b(?:error|failed|failure|denied|forbidden|blocked|disabled|unavailable)\b|오류|실패|거부|차단|비활성|사용할 수 없/i.test(warning)
  ));
  if (blockingWarnings.length > 0) {
    throw new ClaudeCliError(
      'SEARCH_WARNING',
      `${label} 중 결과 신뢰성에 영향을 주는 Claude CLI 경고가 발생했습니다.`,
      blockingWarnings.join('\n').slice(0, 3000),
    );
  }
  const groundingUrls = Array.isArray(envelope.groundingUrls)
    ? [...new Set(envelope.groundingUrls.map(safeSourceUrl).filter(Boolean))]
    : [];
  return {
    webSearchSuccesses: success,
    officialSearches,
    broadSearches,
    warnings,
    groundingUrls,
  };
}

function normalizedWords(value) {
  return text(value, 500)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function characterBigrams(value) {
  const normalized = normalizeTitle(value);
  const grams = new Set();
  if (normalized.length < 2) {
    if (normalized) grams.add(normalized);
    return grams;
  }
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.add(normalized.slice(index, index + 2));
  }
  return grams;
}

export function titleSimilarity(first, second) {
  const left = characterBigrams(first);
  const right = characterBigrams(second);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function comparableField(first, second) {
  const left = normalizedWords(first);
  const right = normalizedWords(second);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function sameEvent(first, second) {
  if (first.announcedDate !== second.announcedDate) return false;
  const sameSource = Boolean(
    first.sourceUrl && second.sourceUrl && first.sourceUrl === second.sourceUrl,
  );
  const firstTitle = normalizeTitle(first.title);
  const secondTitle = normalizeTitle(second.title);
  const sameTitle = Boolean(firstTitle && firstTitle === secondTitle);
  const similarity = titleSimilarity(first.title, second.title);
  const compatibleContext = comparableField(first.issuingCountry, second.issuingCountry)
    && comparableField(first.agency, second.agency)
    && comparableField(first.measureType, second.measureType);
  // 기관의 목록·보도자료 색인 URL은 하루에 여러 조치가 함께 사용할 수 있다.
  // 따라서 URL 일치만으로 합치지 않고 제목까지 같은 사안임을 뒷받침해야 한다.
  if (sameSource && (sameTitle || (compatibleContext && similarity >= 0.45))) return true;
  if (!compatibleContext) return false;
  if (sameTitle) return true;
  return similarity >= 0.68;
}

function itemQuality(item) {
  let score = Math.min(item.summary.length, 600) / 100;
  for (const field of [
    'importanceReason',
    'measureType',
    'titleEn',
    'businessImpact',
    'effectiveDate',
    'hsCode',
    'targetCountries',
    'notes',
  ]) {
    if (item[field]) score += 1;
  }
  if (item.announcedAt) score += 2;
  try {
    const host = new URL(item.sourceUrl).hostname.toLowerCase();
    if (/(?:\.gov|\.go\.kr|\.gc\.ca|\.europa\.eu|\.un\.org|\.wto\.org)$/.test(host)) score += 3;
  } catch {
    // sourceUrl은 앞 단계에서 검증되므로 방어적으로만 처리한다.
  }
  return score;
}

function shouldReplaceDuplicate(current, candidate) {
  const currentImportance = IMPORTANCE_ORDER[current.importance] ?? Number.MAX_SAFE_INTEGER;
  const candidateImportance = IMPORTANCE_ORDER[candidate.importance] ?? Number.MAX_SAFE_INTEGER;
  if (candidateImportance !== currentImportance) return candidateImportance < currentImportance;
  return itemQuality(candidate) > itemQuality(current);
}

function dedupeDomain(result, domain) {
  const kept = [];
  for (const unit of domain.units) {
    for (const item of result.categories[unit.key]) {
      const duplicateIndex = kept.findIndex((entry) => sameEvent(entry.item, item));
      if (duplicateIndex === -1) {
        kept.push({ unitKey: unit.key, item });
      } else if (shouldReplaceDuplicate(kept[duplicateIndex].item, item)) {
        kept[duplicateIndex] = { unitKey: unit.key, item };
      }
    }
  }
  for (const unit of domain.units) result.categories[unit.key] = [];
  for (const entry of kept) result.categories[entry.unitKey].push(entry.item);
}

function syncCategoryStatuses(result, domain) {
  for (const unit of domain.units) {
    const items = result.categories[unit.key]
      .sort(compareItems)
      .slice(0, CATEGORY_RESEARCH_POLICY.maximumItemsPerCategory);
    result.categories[unit.key] = items;
    if (items.length === 0 && result.categoryInsights) result.categoryInsights[unit.key] = '';
    const status = result.categoryStatus[unit.key];
    if (status.status !== 'failure') {
      status.status = items.length > 0 ? 'success' : 'empty';
      status.itemCount = items.length;
    }
  }
  const totalItems = domain.units.reduce(
    (sum, unit) => sum + result.categories[unit.key].length,
    0,
  );
  if (totalItems === 0) result.insight = '';
  refreshCoverage(result);
}

function dedupeAndSort(results, requestedDomains = domains) {
  for (const domain of requestedDomains) dedupeDomain(results[domain.key], domain);

  const specializedItems = [];
  for (const domain of requestedDomains.filter((item) => ['export', 'trade'].includes(item.key))) {
    for (const unit of domain.units) {
      specializedItems.push(...results[domain.key].categories[unit.key]);
    }
  }
  const customs = requestedDomains.find((item) => item.key === 'customs');
  if (customs) {
    for (const unit of customs.units) {
      results.customs.categories[unit.key] = results.customs.categories[unit.key]
        .filter((item) => !specializedItems.some((specialized) => sameEvent(item, specialized)));
    }
  }

  for (const domain of requestedDomains) syncCategoryStatuses(results[domain.key], domain);
}

function calculateStats(results, requestedDomains = domains) {
  const stats = { total: 0, high: 0, byDomain: {} };
  for (const domain of requestedDomains) {
    const domainStats = { total: 0, high: 0 };
    for (const unit of domain.units) {
      for (const item of results[domain.key].categories[unit.key]) {
        domainStats.total += 1;
        stats.total += 1;
        if (item.importance === '상') {
          domainStats.high += 1;
          stats.high += 1;
        }
      }
    }
    stats.byDomain[domain.key] = domainStats;
  }
  return stats;
}

async function loadMock(mockPath) {
  if (!mockPath) return null;
  return JSON.parse(await fs.readFile(mockPath, 'utf8'));
}

function asClaudeError(error) {
  return error instanceof ClaudeCliError
    ? error
    : new ClaudeCliError('UNKNOWN', error?.message || String(error));
}

function abortableDelay(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const reason = signal.reason;
      reject(reason?.code === 'RUN_TIMEOUT'
        ? new ClaudeCliError('RUN_TIMEOUT', reason.message || '전체 실행 제한 시간을 초과했습니다.', reason.details || '')
        : new ClaudeCliError('ABORTED', '사용자가 실행을 중단했습니다.'));
      return;
    }
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      const reason = signal.reason;
      reject(reason?.code === 'RUN_TIMEOUT'
        ? new ClaudeCliError('RUN_TIMEOUT', reason.message || '전체 실행 제한 시간을 초과했습니다.', reason.details || '')
        : new ClaudeCliError('ABORTED', '사용자가 실행을 중단했습니다.'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function collectUnits(domain, units, context, options, mock, coverage) {
  if (!Array.isArray(units) || units.length !== 1) {
    throw new ClaudeCliError('CONFIG', 'Claude 조사 호출은 카테고리 하나만 포함해야 합니다.');
  }
  const [unit] = units;
  if (mock) {
    const value = mock.domains?.[domain.key] || { insight: '', categories: {} };
    if (value.__error) {
      throw new ClaudeCliError(
        text(value.__error.code, 40) || 'MOCK_ERROR',
        text(value.__error.message, 500) || `${domain.label} mock 실패`,
      );
    }
    const scopedValue = value.categories
      && typeof value.categories === 'object'
      && !Array.isArray(value.categories)
      ? {
        ...value,
        categories: Object.fromEntries(
          units
            .filter((requested) => Object.hasOwn(value.categories, requested.key))
            .map((requested) => [requested.key, value.categories[requested.key]]),
        ),
      }
      : value;
    const serialized = JSON.stringify(scopedValue)
      .replaceAll('__TODAY__', context.toISO)
      .replaceAll('__FROM__', context.fromISO);
    return {
      result: parseDomainResponse(domain, serialized, context, { units, coverage }),
      audit: {
        webSearchSuccesses: 0,
        officialSearches: 0,
        broadSearches: 0,
        warnings: [],
      },
    };
  }

  const attempts = retryMax();
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const caller = options.callClaude || callClaudeCli;
      const envelope = await caller(buildCategoryPrompt(domain, unit, context), {
        cwd: options.cwd,
        signal: options.signal,
        minimumWebSearchSuccesses: CATEGORY_RESEARCH_POLICY.minimumSearchesPerCategory,
        minimumOfficialSearches: CATEGORY_RESEARCH_POLICY.minimumOfficialSearches,
        minimumBroadSearches: CATEGORY_RESEARCH_POLICY.minimumBroadSearches,
        requireOfficialAndBroadSearch: true,
        officialDomainAllowlist: unit.officialDomains,
      });
      const audit = validateResearchEnvelope(
        envelope,
        `${domain.label} / ${unit.label} 조사`,
        CATEGORY_RESEARCH_POLICY.minimumSearchesPerCategory,
        {
          minimumOfficialSearches: CATEGORY_RESEARCH_POLICY.minimumOfficialSearches,
          minimumBroadSearches: CATEGORY_RESEARCH_POLICY.minimumBroadSearches,
          requireOfficialAndBroadSearch: true,
          officialDomainAllowlist: unit.officialDomains,
        },
      );
      return {
        result: parseDomainResponse(domain, envelope.response, context, {
          units,
          coverage,
          webSearchSuccesses: audit.webSearchSuccesses,
          warningCount: audit.warnings.length,
          groundingUrls: audit.groundingUrls,
        }),
        audit,
      };
    } catch (error) {
      lastError = asClaudeError(error);
      if (FATAL_ERROR_CODES.has(lastError.code)) throw lastError;
      const retryable = isRetryableClaudeError(lastError) && lastError.code !== 'TIMEOUT';
      if (!retryable || attempt >= attempts) break;
      const delay = 30000 * 2 ** (attempt - 1);
      console.warn(`  ${lastError.code}: ${delay / 1000}초 후 한 번 더 시도합니다.`);
      await abortableDelay(delay, options.signal);
    }
  }
  throw lastError;
}

function markUnitsFailed(result, units, error) {
  const reason = text(error?.message || error, 500);
  for (const unit of units) {
    result.categoryStatus[unit.key] = categoryFailure(reason);
  }
}

function requireCompletedCategory(collected, domain, unit) {
  const status = collected?.result?.categoryStatus?.[unit.key];
  if (status?.status !== 'failure') return collected;
  throw new ClaudeCliError(
    'BAD_JSON',
    `${domain.label} / ${unit.label} 응답이 필수 필드 또는 조사 기간 검증을 통과하지 못했습니다.`,
    status?.reason || '카테고리 결과 없음',
  );
}

async function collectCategory(domain, unit, context, options, mock) {
  let primaryError = null;
  try {
    return {
      ...requireCompletedCategory(
        await collectUnits(domain, [unit], context, options, mock, 'full'),
        domain,
        unit,
      ),
      recoveryUsed: false,
      recoveryReason: '',
    };
  } catch (error) {
    primaryError = asClaudeError(error);
    if (
      FATAL_ERROR_CODES.has(primaryError.code)
      || primaryError.code === 'RUN_TIMEOUT'
      || mock
      || !FALLBACK_ERROR_CODES.has(primaryError.code)
    ) throw primaryError;
  }

  console.warn(`  ${domain.label} / ${unit.label}: 응답 검증 실패로 한 번 더 조사합니다.`);
  try {
    return {
      ...requireCompletedCategory(
        await collectUnits(domain, [unit], context, options, mock, 'fallback'),
        domain,
        unit,
      ),
      recoveryUsed: true,
      recoveryReason: primaryError.code,
    };
  } catch (error) {
    const recoveryError = asClaudeError(error);
    if (FATAL_ERROR_CODES.has(recoveryError.code)) throw recoveryError;
    recoveryError.details = [
      `첫 조사 (${primaryError.code}): ${primaryError.message}`,
      primaryError.details || '',
      `재조사 (${recoveryError.code}): ${recoveryError.message}`,
      recoveryError.details || '',
    ].filter(Boolean).join('\n').slice(0, 3000);
    throw recoveryError;
  }
}

function mergeCategoryResult(target, collected, unit) {
  target.categories[unit.key] = collected.result.categories[unit.key];
  target.categoryStatus[unit.key] = collected.result.categoryStatus[unit.key];
  target.categoryInsights[unit.key] = collected.result.categoryInsights?.[unit.key] || '';
  const insight = target.categoryInsights[unit.key];
  if (insight) {
    target.insight = text(
      [target.insight, `${unit.label}: ${insight}`].filter(Boolean).join(' '),
      1000,
    );
  }
  target.coverage.webSearchSuccesses += collected.audit.webSearchSuccesses;
  target.coverage.warningCount += collected.audit.warnings.length;
  target.coverage.recoveryUsed = Boolean(target.coverage.recoveryUsed || collected.recoveryUsed);
  if (collected.recoveryUsed) target.coverage.recoveryReason = collected.recoveryReason;
  refreshCoverage(target);
}

function failureRecord(domain, error, unit = null) {
  return {
    domainKey: domain.key,
    domainLabel: domain.label,
    categoryKey: unit?.key || '',
    categoryLabel: unit?.label || '',
    code: error?.code || 'UNKNOWN',
    reason: error?.message || String(error),
    details: text(error?.details, 1000),
  };
}

export async function collectMonitoring(options = {}) {
  const context = createContext(options.now || new Date(), options.lookbackHours);
  const mock = await loadMock(options.mockPath);
  const selectionValue = options.categorySelection
    ? `${options.categorySelection.domainKey}:${options.categorySelection.unitKey}`
    : options.category;
  const categorySelection = selectionValue ? resolveCategorySelector(selectionValue) : null;
  const requestedDomains = scopedDomains(categorySelection);
  const targets = requestedDomains.flatMap((domain) => (
    domain.units.map((unit) => ({ domain, unit }))
  ));
  const results = Object.fromEntries(
    requestedDomains.map((domain) => [domain.key, emptyDomainResult(domain, domain.units)]),
  );
  const failures = [];

  console.log(`조사 기간: ${context.fromStr} ~ ${context.toStr} KST`);
  console.log(
    `Claude 호출: ${targets.length}개 카테고리를 각각 조사하며, `
    + `카테고리마다 공식기관 ${CATEGORY_RESEARCH_POLICY.minimumOfficialSearches}회와 `
    + `일반 동향 ${CATEGORY_RESEARCH_POLICY.minimumBroadSearches}회를 별도로 실행합니다.`,
  );

  for (let index = 0; index < targets.length; index += 1) {
    const { domain, unit } = targets[index];
    if (options.signal?.aborted) {
      const reason = options.signal.reason;
      if (reason?.code !== 'RUN_TIMEOUT') {
        throw new ClaudeCliError('ABORTED', '사용자가 실행을 중단했습니다.');
      }
      for (const pending of targets.slice(index)) {
        const deadlineError = new ClaudeCliError(
          'RUN_TIMEOUT',
          reason.message || '전체 실행 제한 시간을 초과했습니다.',
        );
        markUnitsFailed(results[pending.domain.key], [pending.unit], deadlineError);
        refreshCoverage(results[pending.domain.key]);
        failures.push(failureRecord(pending.domain, deadlineError, pending.unit));
        console.error(`${pending.domain.label} / ${pending.unit.label} 미실행 (RUN_TIMEOUT): ${deadlineError.message}`);
      }
      break;
    }
    console.log(`[${index + 1}/${targets.length}] ${domain.label} / ${unit.label} 조사 시작`);
    try {
      const collected = await collectCategory(domain, unit, context, options, mock);
      mergeCategoryResult(results[domain.key], collected, unit);
      const count = collected.result.categories[unit.key].length;
      const suffix = collected.recoveryUsed ? ' (재조사 결과)' : '';
      console.log(`[${index + 1}/${targets.length}] ${domain.label} / ${unit.label} 완료: ${count}건${suffix}`);
    } catch (error) {
      if (error?.code === 'ABORTED') throw error;
      const claudeError = asClaudeError(error);
      if (FATAL_ERROR_CODES.has(claudeError.code)) throw claudeError;
      markUnitsFailed(results[domain.key], [unit], claudeError);
      refreshCoverage(results[domain.key]);
      const failure = failureRecord(domain, claudeError, unit);
      failures.push(failure);
      console.error(`[${index + 1}/${targets.length}] ${domain.label} / ${unit.label} 실패 (${failure.code}): ${failure.reason}`);
      if (failure.details) console.error(`  상세: ${failure.details}`);
      if (claudeError.code === 'RUN_TIMEOUT') {
        for (const pending of targets.slice(index + 1)) {
          const deadlineError = new ClaudeCliError('RUN_TIMEOUT', claudeError.message, claudeError.details);
          markUnitsFailed(results[pending.domain.key], [pending.unit], deadlineError);
          refreshCoverage(results[pending.domain.key]);
          failures.push(failureRecord(pending.domain, deadlineError, pending.unit));
          console.error(`${pending.domain.label} / ${pending.unit.label} 미실행 (RUN_TIMEOUT): ${deadlineError.message}`);
        }
        break;
      }
    }
  }

  dedupeAndSort(results, requestedDomains);
  const usableDomains = requestedDomains.filter(
    (domain) => results[domain.key].coverage.completedCategories > 0,
  ).length;
  const fullyCompletedDomains = requestedDomains.filter(
    (domain) => results[domain.key].coverage.complete,
  ).length;
  const completedCategories = requestedDomains.reduce(
    (sum, domain) => sum + results[domain.key].coverage.completedCategories,
    0,
  );

  return {
    version: 4,
    createdAt: new Date().toISOString(),
    context: {
      fromISO: context.fromISO,
      toISO: context.toISO,
      fromStr: context.fromStr,
      toStr: context.toStr,
      lookbackHours: context.lookbackHours,
      dateCoverageNote: context.dateCoverageNote,
    },
    results,
    failures,
    collection: {
      mode: mock ? 'mock' : 'live',
      scope: categorySelection ? 'category' : 'all',
      selection: categorySelection ? {
        id: categorySelection.id,
        domainKey: categorySelection.domainKey,
        domainLabel: categorySelection.domainLabel,
        unitKey: categorySelection.unitKey,
        unitLabel: categorySelection.unitLabel,
      } : null,
      requestedCategoryIds: targets.map(({ domain, unit }) => `${domain.key}:${unit.key}`),
      totalDomains: requestedDomains.length,
      completedDomains: usableDomains,
      fullyCompletedDomains,
      totalCategories: targets.length,
      completedCategories,
    },
    stats: calculateStats(results, requestedDomains),
  };
}
