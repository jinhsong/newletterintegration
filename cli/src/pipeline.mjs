import fs from 'node:fs/promises';
import net from 'node:net';
import {
  buildCategoryPrompt,
  CATEGORY_RESEARCH_POLICY,
  domains,
  isTrustedOfficialDomain,
  researchPolicyForUnit,
  resolveResearchDepth,
  resolveCategorySelector,
  resolveGroupSelector,
  scopedDomains,
} from './config.mjs';
import {
  callClaudeCli,
  ClaudeCliError,
  isRetryableClaudeError,
  retryMax,
  searchQueryFingerprint,
  timeoutMs as configuredClaudeTimeoutMs,
} from './claude-client.mjs';
import { parseJsonObject } from './json-utils.mjs';

const KST = 'Asia/Seoul';
const IMPORTANCE_ORDER = { 상: 0, 중: 1, 하: 2 };
const FINISH_RESERVE_MS = 120000;
const MINIMUM_FINISH_RESERVE_MS = 5000;
const MINIMUM_CATEGORY_TIMEOUT_MS = 1000;
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

export function createContext(now = new Date(), lookbackOverride, fromDateOverride) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('현재 시각이 올바르지 않습니다.');
  }
  let fromDate;
  let lookbackHours;
  if (lookbackOverride !== undefined && lookbackOverride !== null) {
    if (![24, 72, 168].includes(lookbackOverride)) {
      throw new Error('lookback은 24, 72, 168시간 중 하나여야 합니다.');
    }
    lookbackHours = lookbackOverride;
    fromDate = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  } else if (fromDateOverride !== undefined && fromDateOverride !== null) {
    fromDate = fromDateOverride instanceof Date
      ? new Date(fromDateOverride.getTime())
      : new Date(fromDateOverride);
    if (Number.isNaN(fromDate.getTime())) throw new Error('마지막 성공 실행 시각이 올바르지 않습니다.');
    lookbackHours = (now.getTime() - fromDate.getTime()) / (60 * 60 * 1000);
    if (!(lookbackHours > 0) || lookbackHours > 168) {
      throw new Error('마지막 성공 실행 기준 조사 기간은 0시간 초과 168시간 이하여야 합니다.');
    }
  } else {
    lookbackHours = weekdayKst(now) === 1 ? 72 : 24;
    fromDate = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  }
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

const TRACKING_PARAMETERS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid',
  '_ga', '_gl', 'igshid', 'vero_conv', 'vero_id',
]);

export function canonicalSourceUrl(value) {
  const safe = safeSourceUrl(value);
  if (!safe) return '';
  const url = new URL(safe);
  for (const key of [...url.searchParams.keys()]) {
    const normalized = key.toLocaleLowerCase('en-US');
    if (normalized.startsWith('utm_') || TRACKING_PARAMETERS.has(normalized)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '') || '/';
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
  const source = canonicalSourceUrl(sourceUrl);
  return Boolean(source) && groundingUrls.some(
    (candidate) => canonicalSourceUrl(candidate) === source,
  );
}

function sourceProvenance(sourceUrl, groundingSearches = []) {
  const canonical = canonicalSourceUrl(sourceUrl);
  if (!canonical || !Array.isArray(groundingSearches)) return [];
  return groundingSearches.flatMap((search) => {
    const urls = Array.isArray(search?.urls) ? search.urls : [];
    if (!urls.some((candidate) => canonicalSourceUrl(candidate) === canonical)) return [];
    return [{
      toolUseId: text(search.toolUseId, 200),
      query: text(search.query, 1000),
      mode: ['official', 'broad'].includes(search.mode) ? search.mode : 'unknown',
      allowedDomains: Array.isArray(search.allowedDomains)
        ? search.allowedDomains.map((entry) => text(entry, 253)).filter(Boolean).slice(0, 50)
        : [],
    }];
  }).slice(0, 20);
}

function stringField(raw, field, maximum, errors, { required = false } = {}) {
  const value = raw?.[field];
  if (value === undefined || value === null) {
    if (required) errors.push(field);
    return '';
  }
  if (typeof value !== 'string') {
    errors.push(`${field}Type`);
    return '';
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length > maximum) errors.push(`${field}Length`);
  if (required && !normalized) errors.push(field);
  return normalized.slice(0, maximum);
}

function targetCountriesField(raw, errors) {
  const value = raw?.targetCountries;
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return stringField(raw, 'targetCountries', 240, errors);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    errors.push('targetCountriesType');
    return '';
  }
  const normalized = value.map((entry) => entry.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (normalized.some((entry) => entry.length > 80) || normalized.join(', ').length > 240) {
    errors.push('targetCountriesLength');
  }
  return normalized.map((entry) => entry.slice(0, 80)).join(', ').slice(0, 240);
}

function normalizeItem(raw, groundingUrls = [], domain = null, groundingSearches = [], unit = null) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { item: null, errors: ['itemType'], timestamp: null };
  }
  const importance = stringField(raw, 'importance', 5, errors, { required: true });
  if (!Object.hasOwn(IMPORTANCE_ORDER, importance)) errors.push('importance');

  const announcedDate = stringField(raw, 'announcedDate', 10, errors, { required: true });
  if (!isCalendarDate(announcedDate)) errors.push('announcedDate');

  const announcedAtRaw = stringField(raw, 'announcedAt', 50, errors);
  const timestamp = parseTimestamp(announcedAtRaw);
  if (!timestamp.valid) errors.push('announcedAt');
  if (timestamp.value && formatKst(timestamp.date) !== announcedDate) {
    errors.push('announcedAtDateMismatch');
  }

  const effectiveDate = stringField(raw, 'effectiveDate', 10, errors);
  if (effectiveDate && !isCalendarDate(effectiveDate)) errors.push('effectiveDate');

  const sourceUrlRaw = stringField(raw, 'sourceUrl', 3000, errors, { required: true });
  const sourceUrl = canonicalSourceUrl(sourceUrlRaw);
  const provenance = sourceProvenance(sourceUrl, groundingSearches);
  let sourceTier = 'other';
  try {
    const hostname = new URL(sourceUrl).hostname;
    sourceTier = unit?.officialSources?.find((source) => (
      isTrustedOfficialDomain(hostname, [source.hostname])
    ))?.sourceTier || 'other';
  } catch {
    // sourceUrl 검증 오류는 아래 필수 필드 검증에서 처리한다.
  }
  const sourceVerification = !sourceUrl
    ? 'missing'
    : ((provenance.length > 0 || sourceIsGrounded(sourceUrl, groundingUrls))
      ? 'grounded'
      : 'ungrounded');
  const item = {
    importance,
    importanceReason: stringField(raw, 'importanceReason', 500, errors, { required: true }),
    measureType: stringField(raw, 'measureType', 100, errors, { required: true }),
    title: stringField(raw, 'title', 180, errors, { required: true }),
    titleEn: stringField(raw, 'titleEn', 240, errors),
    summary: stringField(raw, 'summary', 1200, errors, { required: true }),
    businessImpact: stringField(raw, 'businessImpact', 600, errors),
    announcedDate,
    announcedAt: timestamp.value,
    datePrecision: timestamp.value ? 'time' : 'day',
    effectiveDate,
    hsCode: stringField(raw, 'hsCode', 120, errors),
    issuingCountry: stringField(raw, 'issuingCountry', 160, errors, { required: true }),
    targetCountries: targetCountriesField(raw, errors),
    agency: stringField(raw, 'agency', 240, errors, { required: true }),
    sourceName: stringField(raw, 'sourceName', 160, errors, { required: true }),
    sourceUrl,
    sourceCanonicalUrl: sourceUrl,
    sourceVerification,
    sourceTier,
    sourceEvidence: provenance,
    notes: stringField(raw, 'notes', 600, errors),
  };
  if (!sourceUrl) errors.push('sourceUrl');
  if (sourceVerification !== 'grounded') errors.push('sourceUngrounded');
  if (domain && violatesDomainBoundary(domain.key, item)) errors.push('domainBoundary');
  if (unit && !itemMatchesUnitScope(item, unit)) errors.push('unitScope');
  return { item, errors: [...new Set(errors)], timestamp: timestamp.date };
}

function normalizedPolicyText(values) {
  return values
    .filter(Boolean)
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US');
}

const TRADE_REMEDY_PATTERN = /\b(?:anti[ -]?dumping|countervailing(?:\s+dut(?:y|ies))?|safeguard|cvd)\b|반덤핑|상계관세|세이프가드/;
const EXPORT_CONTROL_PATTERN = /\b(?:usml|itar|ear|sdn|entity\s+list|dual[ -]?use|export\s+controls?|sanctions?)\b|전략물자|수출통제|경제제재|엔티티\s*리스트/;
const ORDINARY_CUSTOMS_PATTERN = /\b(?:tariff\s+rate|customs\s+valuation|rules?\s+of\s+origin|free\s+trade\s+agreement|fta|hs\s+classification|customs\s+clearance)\b|관세율|품목분류|원산지|과세가격|통관절차|자유무역협정/;

function violatesDomainBoundary(domainKey, item) {
  const fullText = normalizedPolicyText([
    item.measureType,
    item.title,
    item.titleEn,
    item.summary,
  ]);
  const classificationText = normalizedPolicyText([
    item.measureType,
    item.title,
    item.titleEn,
  ]);
  if (domainKey === 'customs') {
    return TRADE_REMEDY_PATTERN.test(fullText) || EXPORT_CONTROL_PATTERN.test(fullText);
  }
  if (domainKey === 'export') {
    return TRADE_REMEDY_PATTERN.test(classificationText)
      || ORDINARY_CUSTOMS_PATTERN.test(classificationText);
  }
  if (domainKey === 'trade') {
    return EXPORT_CONTROL_PATTERN.test(classificationText)
      || ORDINARY_CUSTOMS_PATTERN.test(classificationText);
  }
  return true;
}

function itemMatchesUnitScope(item, unit) {
  const fields = Array.isArray(unit?.itemScope?.fields) ? unit.itemScope.fields : [];
  const aliases = Array.isArray(unit?.itemScope?.aliases) ? unit.itemScope.aliases : [];
  if (fields.length === 0 || aliases.length === 0) return false;
  const value = fields.map((field) => item?.[field]).filter(Boolean).join(' ');
  const normalized = normalizedCoveragePhrase(value);
  return aliases.some((alias) => queryContainsAlias(normalized, alias));
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
    rawCount: 0,
    rejectedCount: 0,
    dedupedCount: 0,
    truncatedCount: 0,
    rejectedReasons: {},
    reason,
  };
}

function emptyDomainResult(domain, requestedUnits = domain.units) {
  return {
    insight: '',
    categoryInsights: Object.fromEntries(requestedUnits.map((unit) => [unit.key, ''])),
    categoryAudit: Object.fromEntries(requestedUnits.map((unit) => [unit.key, null])),
    categories: Object.fromEntries(requestedUnits.map((unit) => [unit.key, []])),
    categoryCandidates: Object.fromEntries(requestedUnits.map((unit) => [unit.key, []])),
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
  if (parsed.insight !== undefined && typeof parsed.insight !== 'string') {
    throw new ClaudeCliError('BAD_JSON', `${domain.label} 응답의 insight는 문자열이어야 합니다.`);
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
    const rejectedReasons = {};
    const maximumRawItems = 50;
    for (const rawItem of rawItems.slice(0, maximumRawItems)) {
      const normalized = normalizeItem(
        rawItem,
        options.groundingUrls || [],
        domain,
        options.groundingSearches || [],
        unit,
      );
      const errors = [...normalized.errors];
      if (normalized.item && !inDateRange(normalized.item, normalized.timestamp, context)) {
        errors.push('dateRange');
      }
      if (errors.length > 0) {
        rejectedCount += 1;
        for (const reason of new Set(errors)) {
          rejectedReasons[reason] = (rejectedReasons[reason] || 0) + 1;
        }
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
    const researchPolicy = options.researchPolicy || researchPolicyForUnit(unit, options.depth);
    const overflowCount = Math.max(0, rawItems.length - maximumRawItems);
    const withinUnitDedupedCount = accepted.length - uniqueAccepted.length;
    const truncatedCount = overflowCount
      + Math.max(0, uniqueAccepted.length - researchPolicy.maximumItemsPerCategory);
    result.categoryCandidates[unit.key] = uniqueAccepted;
    result.categories[unit.key] = uniqueAccepted.slice(0, researchPolicy.maximumItemsPerCategory);

    if (rawItems.length > 0 && accepted.length === 0) {
      result.categoryStatus[unit.key] = {
        ...categoryFailure('응답 항목이 필수 필드 또는 조사 기간 검증을 통과하지 못함'),
        rawCount: rawItems.length,
        rejectedCount,
        truncatedCount: overflowCount,
        rawOverflowCount: overflowCount,
        rejectedReasons,
        maximumItems: researchPolicy.maximumItemsPerCategory,
      };
      continue;
    }
    result.categoryStatus[unit.key] = {
      status: accepted.length > 0 ? 'success' : 'empty',
      coverage,
      itemCount: result.categories[unit.key].length,
      rawCount: rawItems.length,
      rejectedCount,
      dedupedCount: withinUnitDedupedCount,
      truncatedCount,
      rawOverflowCount: overflowCount,
      rejectedReasons,
      maximumItems: researchPolicy.maximumItemsPerCategory,
      webSearchSuccesses: Number(options.webSearchSuccesses) || 0,
      officialSearches: Number(options.officialSearches) || 0,
      broadSearches: Number(options.broadSearches) || 0,
      coverageTargetsChecked: Number(options.coverageTargetsChecked) || 0,
      reason: [
        rejectedCount > 0 ? `${rejectedCount}건 검증 제외` : '',
        withinUnitDedupedCount > 0 ? `${withinUnitDedupedCount}건 중복 제거` : '',
        truncatedCount > 0 ? `${truncatedCount}건 표시 한도 제외` : '',
      ].filter(Boolean).join(', '),
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
    const blockedDomains = entry.blockedDomains === undefined
      ? []
      : (Array.isArray(entry.blockedDomains)
        ? entry.blockedDomains.map((value) => text(value, 253)).filter(Boolean)
        : null);
    if (blockedDomains === null || blockedDomains.length !== (entry.blockedDomains?.length || 0)) {
      return null;
    }
    const trustedOfficial = allowedDomains.length > 0
      && allowedDomains.every(
        (hostname) => isTrustedOfficialDomain(hostname, officialDomainAllowlist),
      );
    const mode = trustedOfficial
      ? 'official'
      : (allowedDomains.length > 0 ? 'untrusted' : (blockedDomains.length > 0 ? 'restricted' : 'broad'));
    return {
      query,
      normalized,
      fingerprint: searchQueryFingerprint(normalized),
      mode,
    };
  }).filter(Boolean);
}

function normalizedCoveragePhrase(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function coverageTokens(value) {
  const rawTokens = normalizedCoveragePhrase(value).split(/\s+/).filter(Boolean);
  const tokens = [];
  for (let index = 0; index < rawTokens.length; index += 1) {
    if (!/^[a-z]$/.test(rawTokens[index])) {
      tokens.push(rawTokens[index]);
      continue;
    }
    let joined = rawTokens[index];
    while (index + 1 < rawTokens.length && /^[a-z]$/.test(rawTokens[index + 1])) {
      index += 1;
      joined += rawTokens[index];
    }
    tokens.push(joined);
  }
  return tokens;
}

function queryContainsAlias(query, alias) {
  const querySet = new Set(coverageTokens(query));
  const aliasTokens = coverageTokens(alias);
  if (aliasTokens.length === 0) return false;
  return aliasTokens.every((token) => querySet.has(token));
}

function uncoveredTargets(queries, coverageTargets) {
  if (!Array.isArray(coverageTargets)) return [];
  return coverageTargets.filter((target) => {
    const aliases = Array.isArray(target?.aliases) ? target.aliases : [target?.label];
    return !queries.some((entry) => aliases.some((alias) => queryContainsAlias(entry.normalized, alias)));
  });
}

function coverageEvidence(queries, coverageTargets) {
  const targets = Array.isArray(coverageTargets) ? coverageTargets : [];
  const searches = Array.isArray(queries) ? queries : [];
  const byTarget = targets.map((target) => {
    const aliases = Array.isArray(target?.aliases) ? target.aliases : [target?.label];
    const matchingSearches = searches.filter((entry) => (
      aliases.some((alias) => queryContainsAlias(entry.normalized || entry.query, alias))
    ));
    return {
      label: text(target?.label, 200),
      searchFingerprints: [...new Set(matchingSearches.map((entry) => entry.fingerprint).filter(Boolean))],
      toolUseIds: [...new Set(matchingSearches.map((entry) => text(entry.toolUseId, 200)).filter(Boolean))],
    };
  });
  const contributingSearches = new Set();
  for (const target of byTarget) {
    for (const fingerprint of target.searchFingerprints) contributingSearches.add(fingerprint);
  }
  return { byTarget, contributingSearches };
}

function matchingCoverageTargets(search, coverageTargets) {
  const targets = Array.isArray(coverageTargets) ? coverageTargets : [];
  return targets.filter((target) => {
    const aliases = Array.isArray(target?.aliases) ? target.aliases : [target?.label];
    return aliases.some((alias) => queryContainsAlias(search?.normalized || search?.query, alias));
  });
}

function normalizedGroundingSearches(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ClaudeCliError('BAD_OUTPUT', 'Claude CLI의 검색별 출처 증거 형식이 올바르지 않습니다.');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ClaudeCliError('BAD_OUTPUT', 'Claude CLI의 검색별 출처 증거 항목이 올바르지 않습니다.');
    }
    const query = typeof entry.query === 'string' ? text(entry.query, 1000) : '';
    const toolUseId = typeof entry.toolUseId === 'string' ? text(entry.toolUseId, 200) : '';
    const mode = ['official', 'broad'].includes(entry.mode) ? entry.mode : '';
    if (!query || !toolUseId || !mode || !Array.isArray(entry.urls)) {
      throw new ClaudeCliError('BAD_OUTPUT', 'Claude CLI의 검색별 출처 증거 필드가 완전하지 않습니다.');
    }
    const urls = [...new Set(entry.urls.map(safeSourceUrl).filter(Boolean))];
    const officialUrls = Array.isArray(entry.officialUrls)
      ? [...new Set(entry.officialUrls.map(safeSourceUrl).filter(Boolean))]
      : [];
    const allowedDomains = Array.isArray(entry.allowedDomains)
      ? entry.allowedDomains.map((domain) => text(domain, 253)).filter(Boolean)
      : [];
    if (mode === 'official' && (
      allowedDomains.length === 0
      || officialUrls.some((url) => (
        !urls.some((candidate) => canonicalSourceUrl(candidate) === canonicalSourceUrl(url))
        || !isTrustedOfficialDomain(new URL(url).hostname, allowedDomains)
      ))
    )) {
      throw new ClaudeCliError('BAD_OUTPUT', 'Claude CLI의 공식검색 출처 증거가 허용 도메인과 일치하지 않습니다.');
    }
    return {
      toolUseId,
      query,
      normalized: normalizedCoveragePhrase(query),
      fingerprint: searchQueryFingerprint(query),
      mode,
      allowedDomains,
      blockedDomains: Array.isArray(entry.blockedDomains)
        ? entry.blockedDomains.map((domain) => text(domain, 253)).filter(Boolean)
        : [],
      urls,
      officialUrls,
    };
  });
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
  const restrictedSearches = queries.filter((entry) => entry.mode === 'restricted').length;
  if (options.requireOfficialAndBroadSearch === true && untrustedSearches > 0) {
    throw new ClaudeCliError(
      'SEARCH_INCOMPLETE',
      `${label}의 공식기관 검색에 신뢰 목록 밖 도메인이 포함되었습니다.`,
      `신뢰 목록 밖 도메인 제한 검색 ${untrustedSearches}회`,
    );
  }
  if (options.requireOfficialAndBroadSearch === true && restrictedSearches > 0) {
    throw new ClaudeCliError(
      'SEARCH_INCOMPLETE',
      `${label}의 일반 동향 검색에 blocked_domains가 사용되었습니다.`,
      `제한 검색 ${restrictedSearches}회는 일반 동향 검색 성공 횟수에 포함하지 않습니다.`,
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
  const groundingSearches = normalizedGroundingSearches(envelope.groundingSearches);
  if (options.requireGroundingSearchEvidence === true && envelope.groundingSearches === undefined) {
    throw new ClaudeCliError(
      'BAD_OUTPUT',
      `${label}의 성공 검색별 실제 출처 URL 증거가 없습니다.`,
    );
  }
  if (envelope.groundingSearches !== undefined) {
    const evidenceCounts = new Map();
    for (const entry of queries) {
      const key = `${entry.mode}:${entry.fingerprint}`;
      evidenceCounts.set(key, (evidenceCounts.get(key) || 0) + 1);
    }
    const groundingCounts = new Map();
    for (const entry of groundingSearches) {
      const key = `${entry.mode}:${entry.fingerprint}`;
      groundingCounts.set(key, (groundingCounts.get(key) || 0) + 1);
    }
    const invalidGroundingSearch = groundingSearches.find((entry) => (
      entry.urls.length === 0
      || (entry.mode === 'official' && entry.officialUrls.length === 0)
    ));
    const evidenceMismatch = evidenceCounts.size !== groundingCounts.size
      || [...evidenceCounts].some(([key, count]) => groundingCounts.get(key) !== count);
    if (groundingSearches.length !== success || invalidGroundingSearch || evidenceMismatch) {
      throw new ClaudeCliError(
        'BAD_OUTPUT',
        `${label}의 검색별 출처 증거가 성공한 WebSearch 내역과 일치하지 않습니다.`,
        `성공 검색 ${success}회, 검색별 출처 ${groundingSearches.length}개`,
      );
    }
  }
  let coverageSearches = groundingSearches.length > 0 ? groundingSearches : queries;
  if (options.requireTargetCoverage === true) {
    if (!Number.isSafeInteger(options.officialTargetsPerSearch)
      || options.officialTargetsPerSearch < 1) {
      throw new ClaudeCliError(
        'CONFIG',
        `${label}의 공식 검색당 하위 대상 수 설정이 올바르지 않습니다.`,
      );
    }
    if (envelope.groundingSearches === undefined) {
      throw new ClaudeCliError(
        'BAD_OUTPUT',
        `${label}의 하위 대상 공식 검색 근거가 없습니다.`,
        '각 하위 대상은 실제 공식 원문 URL이 확인된 공식 검색에 포함되어야 합니다.',
      );
    }
    coverageSearches = groundingSearches.filter((entry) => (
      entry.mode === 'official' && entry.officialUrls.length > 0
    ));
  }
  const missingCoverageTargets = uncoveredTargets(coverageSearches, options.coverageTargets);
  const targetCoverage = coverageEvidence(coverageSearches, options.coverageTargets);
  if (options.requireTargetCoverage === true && missingCoverageTargets.length > 0) {
    throw new ClaudeCliError(
      'SEARCH_INCOMPLETE',
      `${label}의 하위 대상 검색 범위가 완전하지 않습니다.`,
      `실제 공식 원문 URL이 확인된 공식 검색 query에서 찾지 못한 대상: ${missingCoverageTargets.map((target) => target.label).join(', ')}`,
    );
  }
  if (options.requireTargetCoverage === true) {
    const overloadedSearch = coverageSearches
      .map((entry) => ({
        entry,
        matchedTargets: matchingCoverageTargets(entry, options.coverageTargets),
      }))
      .find(({ matchedTargets }) => (
        matchedTargets.length > options.officialTargetsPerSearch
      ));
    if (overloadedSearch) {
      throw new ClaudeCliError(
        'SEARCH_INCOMPLETE',
        `${label}의 공식 검색 하나에 하위 대상이 너무 많이 포함되었습니다.`,
        `허용 ${options.officialTargetsPerSearch}개, 감지 ${overloadedSearch.matchedTargets.length}개: ${overloadedSearch.matchedTargets.map((target) => target.label).join(', ')}`,
      );
    }
  }
  return {
    webSearchSuccesses: success,
    officialSearches,
    broadSearches,
    coverageTargetsChecked: Array.isArray(options.coverageTargets)
      ? options.coverageTargets.length
      : 0,
    warnings,
    groundingUrls,
    groundingSearches,
    coverageTargetEvidence: targetCoverage.byTarget,
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
  const leftNumbers = left.match(/\b\d+\b/g) || [];
  const rightNumbers = right.match(/\b\d+\b/g) || [];
  if (leftNumbers.length > 0 && rightNumbers.length > 0
    && leftNumbers.join('|') !== rightNumbers.join('|')) return false;
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

const AGENCY_ALIAS_GROUPS = [
  ['bis', 'bureau of industry and security', '미국 산업안보국'],
  ['ofac', 'office of foreign assets control', '미국 해외자산통제국'],
  ['usitc', 'united states international trade commission', '미국 국제무역위원회'],
  ['ita', 'international trade administration', '미국 국제무역청'],
  ['ustr', 'office of the united states trade representative', '미국 무역대표부'],
  ['mofcom', 'ministry of commerce of china', '중국 상무부'],
  ['meti', 'ministry of economy trade and industry', '일본 경제산업성'],
  ['motie', 'motir', '산업통상자원부', '산업통상부'],
  ['european commission', 'eu commission', '유럽연합 집행위원회', '유럽 집행위원회'],
];

function canonicalAgency(value) {
  const normalized = normalizedWords(value);
  if (!normalized) return '';
  const match = AGENCY_ALIAS_GROUPS.find((group) => group.some((alias) => (
    comparableField(normalized, alias)
  )));
  return match ? match[0] : normalized;
}

function comparableAgency(first, second) {
  const left = canonicalAgency(first);
  const right = canonicalAgency(second);
  return Boolean(left && right && (left === right || comparableField(left, right)));
}

function strongIdentifiers(item) {
  const value = [item.title, item.titleEn, item.summary, item.notes, item.hsCode]
    .filter(Boolean)
    .join(' ')
    .toLocaleUpperCase('en-US');
  // 접두어 "Case" 유무가 달라도 A-570-999 같은 본 식별자가 동일하게 추출되어야 한다.
  const identifiers = value.match(/[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+){2,}/g) || [];
  return new Set(identifiers.map((entry) => entry.replace(/[–\s.]/g, '-')));
}

function sharesStrongIdentifier(first, second) {
  const left = strongIdentifiers(first);
  if (left.size === 0) return false;
  const right = strongIdentifiers(second);
  return [...left].some((identifier) => right.has(identifier));
}

function dateDistanceDays(first, second) {
  const left = Date.parse(`${first}T00:00:00Z`);
  const right = Date.parse(`${second}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / 86400000;
}

const ACTION_MARKER_GROUPS = [
  [
    ['add', /\b(?:add(?:s|ed|ing)?|designat(?:e|es|ed|ing)|list(?:s|ed|ing)|impos(?:e|es|ed|ing))\b|추가|신규\s*지정|등재|부과/],
    ['remove', /\b(?:remov(?:e|es|ed|ing)|delist(?:s|ed|ing)|revoke(?:s|d|ing)?|withdraw(?:s|n|ing)?)\b|삭제|제외|지정\s*해제|철회/],
  ],
  [
    ['initiation', /\b(?:initiat(?:e|es|ed|ing|ion)|launch(?:es|ed|ing)?)\b|조사\s*개시|개시\s*결정/],
    ['preliminary', /\b(?:preliminary|provisional)\b|예비\s*(?:판정|결정|조치)/],
    ['final', /\b(?:final|definitive)\b|최종\s*(?:판정|결정|조치)/],
    ['review', /\b(?:sunset|administrative|annual)\s+review\b|일몰\s*재심|연례\s*재심|행정\s*재심/],
    ['extension', /\b(?:extend(?:s|ed|ing)?|extension|renew(?:s|ed|al)?)\b|연장|갱신/],
    ['termination', /\b(?:terminat(?:e|es|ed|ing|ion)|expire(?:s|d|iry)?)\b|종료|만료|폐지/],
  ],
  [
    ['tighten', /\b(?:increase(?:s|d|ing)?|raise(?:s|d|ing)?|tighten(?:s|ed|ing)?)\b|인상|상향|강화/],
    ['ease', /\b(?:decrease(?:s|d|ing)?|reduce(?:s|d|ing)?|lower(?:s|ed|ing)?|ease(?:s|d|ing)?)\b|인하|하향|완화/],
  ],
];

function actionMarkers(item) {
  const value = normalizedPolicyText([item.measureType, item.title, item.titleEn]);
  return ACTION_MARKER_GROUPS.map((group) => new Set(
    group.filter(([, pattern]) => pattern.test(value)).map(([marker]) => marker),
  ));
}

function hasConflictingAction(first, second) {
  const left = actionMarkers(first);
  const right = actionMarkers(second);
  return left.some((leftGroup, index) => (
    leftGroup.size > 0
    && right[index].size > 0
    && ![...leftGroup].some((marker) => right[index].has(marker))
  ));
}

function sameEvent(first, second) {
  const dateDistance = dateDistanceDays(first.announcedDate, second.announcedDate);
  if (dateDistance > 1) return false;
  if (hasConflictingAction(first, second)) return false;
  const sameSource = Boolean(
    first.sourceCanonicalUrl
    && second.sourceCanonicalUrl
    && first.sourceCanonicalUrl === second.sourceCanonicalUrl,
  );
  const firstTitle = normalizeTitle(first.title);
  const secondTitle = normalizeTitle(second.title);
  const sameTitle = Boolean(firstTitle && firstTitle === secondTitle);
  const similarity = titleSimilarity(first.title, second.title);
  const compatibleContext = comparableField(first.issuingCountry, second.issuingCountry)
    && comparableAgency(first.agency, second.agency)
    && comparableField(first.measureType, second.measureType);
  const sameStrongIdentifier = sharesStrongIdentifier(first, second);
  if (dateDistance === 1) {
    return compatibleContext && (sameStrongIdentifier || (sameSource && sameTitle));
  }
  // 기관의 목록·보도자료 색인 URL은 하루에 여러 조치가 함께 사용할 수 있다.
  // 따라서 URL 일치만으로 합치지 않고 제목까지 같은 사안임을 뒷받침해야 한다.
  if (sameStrongIdentifier && compatibleContext) return true;
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

function sourceAuthorityRank(item) {
  if (['government', 'intergovernmental'].includes(item.sourceTier)) return 3;
  if (item.sourceTier === 'trusted-association') return 2;
  try {
    const host = new URL(item.sourceUrl).hostname.toLowerCase();
    if (/(?:\.gov|\.go\.kr|\.gc\.ca|\.gov\.uk|\.gov\.au|\.gov\.cn|\.go\.jp|\.europa\.eu|\.un\.org|\.wto\.org)$/.test(host)) {
      return 3;
    }
    return 1;
  } catch {
    return 0;
  }
}

function shouldReplaceDuplicate(current, candidate) {
  const verificationRank = { grounded: 2, ungrounded: 1, missing: 0 };
  const currentVerification = verificationRank[current.sourceVerification] ?? 0;
  const candidateVerification = verificationRank[candidate.sourceVerification] ?? 0;
  if (candidateVerification !== currentVerification) {
    return candidateVerification > currentVerification;
  }
  const currentAuthority = sourceAuthorityRank(current);
  const candidateAuthority = sourceAuthorityRank(candidate);
  if (candidateAuthority !== currentAuthority) return candidateAuthority > currentAuthority;
  const currentQuality = itemQuality(current);
  const candidateQuality = itemQuality(candidate);
  if (candidateQuality !== currentQuality) return candidateQuality > currentQuality;
  const currentImportance = IMPORTANCE_ORDER[current.importance] ?? Number.MAX_SAFE_INTEGER;
  const candidateImportance = IMPORTANCE_ORDER[candidate.importance] ?? Number.MAX_SAFE_INTEGER;
  if (candidateImportance !== currentImportance) return candidateImportance < currentImportance;
  return false;
}

function dedupeDomain(result, domain) {
  const kept = [];
  for (const unit of domain.units) {
    const candidates = result.categoryCandidates?.[unit.key] || result.categories[unit.key];
    for (const item of candidates) {
      const duplicateIndex = kept.findIndex((entry) => sameEvent(entry.item, item));
      if (duplicateIndex === -1) {
        kept.push({ unitKey: unit.key, item });
      } else if (shouldReplaceDuplicate(kept[duplicateIndex].item, item)) {
        const removedStatus = result.categoryStatus[kept[duplicateIndex].unitKey];
        removedStatus.dedupedCount = (removedStatus.dedupedCount || 0) + 1;
        kept[duplicateIndex] = { unitKey: unit.key, item };
      } else {
        const status = result.categoryStatus[unit.key];
        status.dedupedCount = (status.dedupedCount || 0) + 1;
      }
    }
  }
  for (const unit of domain.units) result.categories[unit.key] = [];
  for (const entry of kept) result.categories[entry.unitKey].push(entry.item);
}

function combinedCategoryInsights(result, domain, maximum = 1000) {
  const entries = domain.units
    .map((unit) => ({
      label: unit.label,
      insight: text(result.categoryInsights?.[unit.key], maximum),
      hasItems: (result.categories?.[unit.key]?.length || 0) > 0,
    }))
    .filter((entry) => entry.hasItems && entry.insight);
  if (entries.length === 0) return '';
  if (entries.length === 1) return entries[0].insight;
  const labelsLength = entries.reduce((sum, entry) => sum + entry.label.length + 2, 0);
  const separatorsLength = (entries.length - 1) * 1;
  const perCategory = Math.max(
    40,
    Math.floor((maximum - labelsLength - separatorsLength) / entries.length),
  );
  return entries
    .map((entry) => `${entry.label}: ${text(entry.insight, perCategory)}`)
    .join(' ')
    .slice(0, maximum);
}

function syncCategoryStatuses(result, domain) {
  for (const unit of domain.units) {
    const status = result.categoryStatus[unit.key];
    const maximumItems = status.maximumItems || CATEGORY_RESEARCH_POLICY.maximumItemsPerCategory;
    const beforeTruncation = result.categories[unit.key].length;
    const items = result.categories[unit.key]
      .sort(compareItems)
      .slice(0, maximumItems);
    status.truncatedCount = (status.rawOverflowCount || 0)
      + Math.max(0, beforeTruncation - maximumItems);
    result.categories[unit.key] = items;
    if (items.length === 0 && result.categoryInsights) result.categoryInsights[unit.key] = '';
    if (status.status !== 'failure') {
      status.status = items.length > 0 ? 'success' : 'empty';
      status.itemCount = items.length;
      status.reason = [
        status.rejectedCount > 0 ? `${status.rejectedCount}건 검증 제외` : '',
        status.dedupedCount > 0 ? `${status.dedupedCount}건 중복 제거` : '',
        status.truncatedCount > 0 ? `${status.truncatedCount}건 표시 한도 제외` : '',
      ].filter(Boolean).join(', ');
    }
  }
  const totalItems = domain.units.reduce(
    (sum, unit) => sum + result.categories[unit.key].length,
    0,
  );
  result.insight = totalItems === 0 ? '' : combinedCategoryInsights(result, domain);
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
      const previous = results.customs.categories[unit.key];
      const filtered = previous
        .filter((item) => !specializedItems.some((specialized) => sameEvent(item, specialized)));
      const removed = previous.length - filtered.length;
      if (removed > 0) {
        const status = results.customs.categoryStatus[unit.key];
        status.dedupedCount = (status.dedupedCount || 0) + removed;
        status.crossDomainDedupedCount = (status.crossDomainDedupedCount || 0) + removed;
      }
      results.customs.categories[unit.key] = filtered;
    }
  }

  for (const domain of requestedDomains) {
    syncCategoryStatuses(results[domain.key], domain);
    delete results[domain.key].categoryCandidates;
  }
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

function correctiveAppendixFor(error) {
  const code = error?.code || '';
  const instructions = {
    BAD_JSON: '최종 응답은 스키마와 키 이름을 정확히 지킨 단일 JSON 객체만 출력한다. 설명·코드펜스·후행 쉼표를 넣지 않는다.',
    BAD_OUTPUT: '모든 필수 문자열 필드와 HTTPS 원문 URL을 채우고, WebSearch 결과에서 직접 확인하지 못한 항목은 제외한다.',
    TURN_LIMIT: '필수 검색을 먼저 완료하고 검색 도중 장황한 분석을 출력하지 않는다. 마지막 turn을 반드시 JSON 작성에 남긴다.',
    SEARCH_NOT_RUN: '답변을 작성하기 전에 반드시 지정된 횟수의 WebSearch를 실제 실행한다.',
    SEARCH_INCOMPLETE: '공식기관 제한 검색과 제한 없는 일반 검색의 최소 횟수, 서로 다른 query, 모든 하위 대상 표기를 빠짐없이 충족한다.',
    SEARCH_FAILED: '실패한 WebSearch는 다른 query로 즉시 보완하고 성공한 검색만 최소 횟수에 포함한다.',
    SEARCH_WARNING: '차단·거부·실패 경고가 남지 않도록 검색 조건을 고쳐 다시 실행한다.',
  };
  const rejectedReasons = error?.categoryStatus?.rejectedReasons || {};
  const reasonInstructions = {
    sourceUngrounded: 'sourceUrl은 이번 WebSearch의 구조화된 실제 결과 URL과 정확히 일치하는 원문만 사용한다.',
    sourceUrl: '공개 HTTPS 원문 URL을 확인할 수 없는 항목은 제외한다.',
    dateRange: '최초 발표일이 지정된 조사 시작·종료 시각 범위 안임을 다시 확인한다.',
    announcedDate: 'announcedDate는 실제 존재하는 YYYY-MM-DD 최초 발표일이어야 한다.',
    announcedAt: 'announcedAt은 원문에 시각·시간대가 명시된 경우만 ISO 8601로 기록한다.',
    announcedAtDateMismatch: 'announcedAt을 KST로 변환한 날짜와 announcedDate를 일치시킨다.',
    domainBoundary: '선택 영역의 경계를 지키고 일반 관세·수출통제·무역구제의 다른 영역 항목은 제외한다.',
    unitScope: 'issuingCountry·agency·measureType이 선택 카테고리의 허용 대상과 일치하는 항목만 포함한다.',
  };
  const specifics = Object.entries(rejectedReasons)
    .filter(([, count]) => Number(count) > 0)
    .map(([reason, count]) => (
      reasonInstructions[reason]
        ? `${reasonInstructions[reason]} (이전 탈락 ${count}건)`
        : `이전 응답의 ${reason} 검증 실패 ${count}건을 바로잡는다.`
    ));
  return [instructions[code] || '', ...specifics].filter(Boolean).join('\n');
}

function asClaudeError(error) {
  return error instanceof ClaudeCliError
    ? error
    : new ClaudeCliError('UNKNOWN', error?.message || String(error));
}

function abortableDelay(delay, signal, categoryDeadlineAt) {
  if (Number.isFinite(categoryDeadlineAt) && Date.now() + delay >= categoryDeadlineAt) {
    return Promise.reject(new ClaudeCliError(
      'TIMEOUT',
      '이 카테고리에 배정된 전체 조사 시간이 부족해 재시도를 생략했습니다.',
    ));
  }
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

function allocateCategoryDeadline(options = {}) {
  if (options.deadlineAt === undefined || options.deadlineAt === null) return null;
  const deadlineAt = options.deadlineAt instanceof Date
    ? options.deadlineAt.getTime()
    : Number(options.deadlineAt);
  if (!Number.isFinite(deadlineAt)) {
    throw new ClaudeCliError('CONFIG', '전체 실행 마감 시각이 올바르지 않습니다.');
  }
  const remainingTargets = Number(options.remainingTargets);
  if (!Number.isSafeInteger(remainingTargets) || remainingTargets < 1) {
    throw new ClaudeCliError('CONFIG', '남은 카테고리 수가 올바르지 않습니다.');
  }
  const totalRemaining = deadlineAt - Date.now();
  const finishReserve = Math.min(
    FINISH_RESERVE_MS,
    Math.max(MINIMUM_FINISH_RESERVE_MS, Math.floor(totalRemaining * 0.05)),
  );
  const usable = totalRemaining - finishReserve;
  const fairShare = Math.floor(usable / remainingTargets);
  if (fairShare < MINIMUM_CATEGORY_TIMEOUT_MS) {
    throw new ClaudeCliError(
      'RUN_TIMEOUT',
      '남은 전체 실행 시간으로 다음 카테고리를 안전하게 조사할 수 없습니다.',
      `저장 여유 ${Math.ceil(finishReserve / 1000)}초 제외 후 카테고리당 ${Math.max(0, Math.floor(fairShare / 1000))}초 남음`,
    );
  }
  return Date.now() + fairShare;
}

function categoryTimeoutMs(options = {}) {
  const configuredMaximum = configuredClaudeTimeoutMs();
  if (options.categoryDeadlineAt === undefined || options.categoryDeadlineAt === null) {
    return configuredMaximum;
  }
  const categoryDeadlineAt = options.categoryDeadlineAt instanceof Date
    ? options.categoryDeadlineAt.getTime()
    : Number(options.categoryDeadlineAt);
  if (!Number.isFinite(categoryDeadlineAt)) {
    throw new ClaudeCliError('CONFIG', '카테고리 조사 마감 시각이 올바르지 않습니다.');
  }
  const remaining = Math.floor(categoryDeadlineAt - Date.now());
  if (remaining < MINIMUM_CATEGORY_TIMEOUT_MS) {
    throw new ClaudeCliError(
      'TIMEOUT',
      '이 카테고리에 배정된 전체 조사 시간을 초과했습니다.',
    );
  }
  return Math.min(configuredMaximum, remaining);
}

async function collectUnits(domain, units, context, options, mock, coverage) {
  if (!Array.isArray(units) || units.length !== 1) {
    throw new ClaudeCliError('CONFIG', 'Claude 조사 호출은 카테고리 하나만 포함해야 합니다.');
  }
  const [unit] = units;
  const researchPolicy = researchPolicyForUnit(unit, options.depth);
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
    const mockGroundingUrls = Object.values(scopedValue.categories || {})
      .flatMap((items) => (Array.isArray(items) ? items : []))
      .map((rawItem) => safeSourceUrl(rawItem?.sourceUrl))
      .filter(Boolean);
    return {
      result: parseDomainResponse(domain, serialized, context, {
        units,
        coverage,
        groundingUrls: mockGroundingUrls,
        researchPolicy,
      }),
      audit: {
        webSearchSuccesses: 0,
        officialSearches: 0,
        broadSearches: 0,
        warnings: [],
      },
    };
  }

  const attempts = retryMax();
  let lastError = options.correctiveError ? asClaudeError(options.correctiveError) : null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const caller = options.callClaude || callClaudeCli;
      const callTimeoutMs = categoryTimeoutMs(options);
      const envelope = await caller(buildCategoryPrompt(domain, unit, context, {
        depth: researchPolicy.depth,
        correctiveAppendix: correctiveAppendixFor(lastError),
      }), {
        cwd: options.cwd,
        signal: options.signal,
        timeoutMs: callTimeoutMs,
        minimumWebSearchSuccesses: researchPolicy.minimumSearchesPerCategory,
        minimumOfficialSearches: researchPolicy.minimumOfficialSearches,
        minimumBroadSearches: researchPolicy.minimumBroadSearches,
        requireOfficialAndBroadSearch: true,
        officialDomainAllowlist: unit.officialDomains,
      });
      const audit = validateResearchEnvelope(
        envelope,
        `${domain.label} / ${unit.label} 조사`,
        researchPolicy.minimumSearchesPerCategory,
        {
          minimumOfficialSearches: researchPolicy.minimumOfficialSearches,
          minimumBroadSearches: researchPolicy.minimumBroadSearches,
          requireOfficialAndBroadSearch: true,
          requireGroundingSearchEvidence: true,
          requireTargetCoverage: true,
          coverageTargets: unit.coverageTargets,
          officialTargetsPerSearch: researchPolicy.officialTargetsPerSearch,
          officialDomainAllowlist: unit.officialDomains,
        },
      );
      return {
        result: parseDomainResponse(domain, envelope.response, context, {
          units,
          coverage,
          webSearchSuccesses: audit.webSearchSuccesses,
          officialSearches: audit.officialSearches,
          broadSearches: audit.broadSearches,
          coverageTargetsChecked: audit.coverageTargetsChecked,
          warningCount: audit.warnings.length,
          groundingUrls: audit.groundingUrls,
          groundingSearches: audit.groundingSearches,
          researchPolicy,
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
      await abortableDelay(delay, options.signal, options.categoryDeadlineAt);
    }
  }
  throw lastError;
}

function markUnitsFailed(result, units, error) {
  const reason = text(error?.message || error, 500);
  for (const unit of units) {
    const auditStatus = error?.categoryStatus;
    result.categoryStatus[unit.key] = auditStatus && typeof auditStatus === 'object'
      ? {
        ...categoryFailure(reason),
        rawCount: Number(auditStatus.rawCount) || 0,
        rejectedCount: Number(auditStatus.rejectedCount) || 0,
        dedupedCount: Number(auditStatus.dedupedCount) || 0,
        truncatedCount: Number(auditStatus.truncatedCount) || 0,
        rejectedReasons: auditStatus.rejectedReasons || {},
        maximumItems: auditStatus.maximumItems,
      }
      : categoryFailure(reason);
    if (error?.categoryAudit) result.categoryAudit[unit.key] = error.categoryAudit;
  }
}

function requireCompletedCategory(collected, domain, unit) {
  const status = collected?.result?.categoryStatus?.[unit.key];
  if (status?.status !== 'failure') return collected;
  const rejectedSummary = Object.entries(status?.rejectedReasons || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
  const error = new ClaudeCliError(
    'BAD_OUTPUT',
    `${domain.label} / ${unit.label} 응답이 필수 필드 또는 조사 기간 검증을 통과하지 못했습니다.`,
    [status?.reason || '카테고리 결과 없음', rejectedSummary].filter(Boolean).join('\n'),
  );
  error.categoryStatus = status;
  error.categoryAudit = {
    webSearchSuccesses: collected.audit.webSearchSuccesses,
    officialSearches: collected.audit.officialSearches,
    broadSearches: collected.audit.broadSearches,
    coverageTargetsChecked: collected.audit.coverageTargetsChecked || 0,
    coverageTargetEvidence: collected.audit.coverageTargetEvidence || [],
    warningCount: collected.audit.warnings.length,
  };
  throw error;
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
        await collectUnits(
          domain,
          [unit],
          context,
          { ...options, correctiveError: primaryError },
          mock,
          'fallback',
        ),
        domain,
        unit,
      ),
      recoveryUsed: true,
      recoveryReason: primaryError.code,
    };
  } catch (error) {
    const recoveryError = asClaudeError(error);
    if (FATAL_ERROR_CODES.has(recoveryError.code)) throw recoveryError;
    if (!recoveryError.categoryStatus && primaryError.categoryStatus) {
      recoveryError.categoryStatus = primaryError.categoryStatus;
      recoveryError.categoryAudit = primaryError.categoryAudit;
    }
    recoveryError.details = [
      `첫 조사 (${primaryError.code}): ${primaryError.message}`,
      primaryError.details || '',
      `재조사 (${recoveryError.code}): ${recoveryError.message}`,
      recoveryError.details || '',
    ].filter(Boolean).join('\n').slice(0, 3000);
    throw recoveryError;
  }
}

function mergeCategoryResult(target, collected, unit, domain) {
  target.categories[unit.key] = collected.result.categories[unit.key];
  target.categoryCandidates[unit.key] = collected.result.categoryCandidates?.[unit.key]
    || collected.result.categories[unit.key];
  target.categoryStatus[unit.key] = collected.result.categoryStatus[unit.key];
  target.categoryInsights[unit.key] = collected.result.categoryInsights?.[unit.key] || '';
  target.categoryAudit[unit.key] = {
    webSearchSuccesses: collected.audit.webSearchSuccesses,
    officialSearches: collected.audit.officialSearches,
    broadSearches: collected.audit.broadSearches,
    coverageTargetsChecked: collected.audit.coverageTargetsChecked || 0,
    coverageTargetEvidence: collected.audit.coverageTargetEvidence || [],
    warningCount: collected.audit.warnings.length,
    searches: (collected.audit.groundingSearches || []).map((search) => ({
      toolUseId: search.toolUseId,
      query: search.query,
      mode: search.mode,
      resultUrlCount: search.urls.length,
      officialUrlCount: search.officialUrls.length,
    })),
  };
  target.insight = combinedCategoryInsights(target, domain);
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
  const context = createContext(options.now || new Date(), options.lookbackHours, options.fromDate);
  let depth;
  try {
    depth = resolveResearchDepth(options.depth);
  } catch (error) {
    throw new ClaudeCliError('CONFIG', error.message);
  }
  const collectionOptions = { ...options, depth };
  const hasCategoryInput = options.categorySelection != null || options.category != null;
  const hasGroupInput = options.groupSelection != null || options.group != null;
  if (hasCategoryInput && hasGroupInput) {
    throw new ClaudeCliError('CONFIG', '--category와 --group은 함께 사용할 수 없습니다.');
  }
  const selectionValue = options.categorySelection
    ? `${options.categorySelection.domainKey}:${options.categorySelection.unitKey}`
    : options.category;
  const groupValue = options.groupSelection
    ? options.groupSelection.domainKey
    : options.group;
  const categorySelection = hasCategoryInput ? resolveCategorySelector(selectionValue) : null;
  const groupSelection = hasGroupInput ? resolveGroupSelector(groupValue) : null;
  const requestedDomains = scopedDomains(categorySelection, groupSelection);
  const mock = await loadMock(options.mockPath);
  const declaredTargets = requestedDomains.flatMap((domain) => (
    domain.units.map((unit) => ({ domain, unit }))
  ));
  const maximumUnits = Math.max(...requestedDomains.map((domain) => domain.units.length));
  // 전체 실행에서 한 영역이 앞쪽 시간을 독점하지 않도록 영역별 카테고리를 번갈아 조사한다.
  const targets = Array.from({ length: maximumUnits }, (_, unitIndex) => (
    requestedDomains
      .map((domain) => ({ domain, unit: domain.units[unitIndex] }))
      .filter((target) => target.unit)
  )).flat();
  const results = Object.fromEntries(
    requestedDomains.map((domain) => [domain.key, emptyDomainResult(domain, domain.units)]),
  );
  const failures = [];

  console.log(`조사 기간: ${context.fromStr} ~ ${context.toStr} KST`);
  const policies = targets.map(({ unit }) => researchPolicyForUnit(unit, depth));
  const minimumSearches = Math.min(...policies.map((policy) => policy.minimumSearchesPerCategory));
  const maximumSearches = Math.max(...policies.map((policy) => policy.minimumSearchesPerCategory));
  console.log(
    `Claude 호출: ${targets.length}개 카테고리, 조사 깊이 ${depth}, `
    + `카테고리별 ${minimumSearches}~${maximumSearches}회 WebSearch를 실행합니다.`,
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
      const categoryDeadlineAt = allocateCategoryDeadline({
        deadlineAt: collectionOptions.deadlineAt,
        remainingTargets: targets.length - index,
      });
      const collected = await collectCategory(domain, unit, context, {
        ...collectionOptions,
        categoryDeadlineAt,
      }, mock);
      mergeCategoryResult(results[domain.key], collected, unit, domain);
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
    version: 5,
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
      depth,
      scope: categorySelection ? 'category' : groupSelection ? 'group' : 'all',
      selection: categorySelection ? {
        type: 'category',
        id: categorySelection.id,
        domainKey: categorySelection.domainKey,
        domainLabel: categorySelection.domainLabel,
        unitKey: categorySelection.unitKey,
        unitLabel: categorySelection.unitLabel,
      } : groupSelection ? {
        type: 'group',
        id: groupSelection.id,
        domainKey: groupSelection.domainKey,
        domainLabel: groupSelection.domainLabel,
        unitCount: groupSelection.unitCount,
      } : null,
      requestedCategoryIds: declaredTargets.map(({ domain, unit }) => `${domain.key}:${unit.key}`),
      totalDomains: requestedDomains.length,
      completedDomains: usableDomains,
      fullyCompletedDomains,
      totalCategories: targets.length,
      completedCategories,
    },
    stats: calculateStats(results, requestedDomains),
  };
}
