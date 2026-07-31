import fs from 'node:fs/promises';
import net from 'node:net';
import {
  buildDomainPrompt,
  domains,
} from './config.mjs';
import {
  callGeminiCli,
  GeminiCliError,
  isRetryableGeminiError,
  retryMax,
} from './gemini-client.mjs';
import { parseJsonObject } from './json-utils.mjs';

const KST = 'Asia/Seoul';
const IMPORTANCE_ORDER = { 상: 0, 중: 1, 하: 2 };
const FALLBACK_BATCH_SIZE = 1;
const FALLBACK_ERROR_CODES = new Set([
  'BAD_JSON',
  'BAD_OUTPUT',
  'TIMEOUT',
  'TURN_LIMIT',
  'SEARCH_NOT_RUN',
  'SEARCH_INCOMPLETE',
  'SEARCH_FAILED',
  'SEARCH_WARNING',
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

function emptyDomainResult(domain) {
  return {
    insight: '',
    categories: Object.fromEntries(domain.units.map((unit) => [unit.key, []])),
    categoryStatus: Object.fromEntries(
      domain.units.map((unit) => [unit.key, categoryFailure()]),
    ),
    coverage: {
      requestedCategories: domain.units.length,
      completedCategories: 0,
      failedCategories: domain.units.length,
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
    throw new GeminiCliError('BAD_JSON', `${domain.label} 응답 JSON을 읽지 못했습니다.`, error.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GeminiCliError('BAD_JSON', `${domain.label} 응답이 JSON 객체가 아닙니다.`);
  }
  if (parsed.domain !== domain.key) {
    throw new GeminiCliError('BAD_JSON', `${domain.label} 응답의 domain 값이 올바르지 않습니다.`);
  }
  if (!parsed.categories || typeof parsed.categories !== 'object' || Array.isArray(parsed.categories)) {
    throw new GeminiCliError('BAD_JSON', `${domain.label} 응답에 categories 객체가 없습니다.`);
  }

  const requestedUnits = options.units || domain.units;
  const coverage = options.coverage === 'fallback' ? 'fallback' : 'full';
  const result = emptyDomainResult(domain);
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
    result.categories[unit.key] = uniqueAccepted.slice(0, 5);

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
      reason: rejectedCount > 0 ? `${rejectedCount}건 검증 제외` : '',
    };
  }

  const itemCount = requestedUnits.reduce(
    (sum, unit) => sum + result.categories[unit.key].length,
    0,
  );
  result.insight = itemCount > 0 ? text(parsed.insight, 1000) : '';
  return refreshCoverage(result);
}

function warningStrings(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new GeminiCliError('BAD_OUTPUT', 'Gemini CLI의 warnings 형식이 올바르지 않습니다.');
  }
  return value.map((warning) => text(warning, 1000)).filter(Boolean);
}

export function validateResearchEnvelope(envelope, label = '조사', expectedSearches = 1) {
  if (!envelope || typeof envelope !== 'object') {
    throw new GeminiCliError('BAD_OUTPUT', `${label} 응답 봉투가 올바르지 않습니다.`);
  }
  const warnings = warningStrings(envelope.warnings);
  const search = envelope.stats?.tools?.byName?.google_web_search;
  const success = Number(search?.success);
  const fail = Number(search?.fail || 0);

  if (!Number.isSafeInteger(success) || success < 1) {
    const code = Number.isSafeInteger(fail) && fail > 0 ? 'SEARCH_FAILED' : 'SEARCH_NOT_RUN';
    throw new GeminiCliError(
      code,
      `${label}에서 성공한 Google 웹 검색을 확인하지 못했습니다.`,
      warnings.join('\n'),
    );
  }
  if (!Number.isSafeInteger(expectedSearches) || expectedSearches < 1) {
    throw new GeminiCliError('CONFIG', `${label}의 최소 검색 횟수 설정이 올바르지 않습니다.`);
  }
  if (success < expectedSearches) {
    throw new GeminiCliError(
      'SEARCH_INCOMPLETE',
      `${label}에서 카테고리별 검색 횟수가 부족합니다.`,
      `필요 ${expectedSearches}회, 성공 ${success}회`,
    );
  }
  if (!Number.isSafeInteger(fail) || fail < 0 || fail > 0) {
    throw new GeminiCliError(
      'SEARCH_FAILED',
      `${label} 중 Google 웹 검색 실패가 감지되었습니다.`,
      warnings.join('\n'),
    );
  }

  const blockingWarnings = warnings.filter((warning) => (
    /\b(?:error|failed|failure|denied|forbidden|blocked|disabled|unavailable)\b|오류|실패|거부|차단|비활성|사용할 수 없/i.test(warning)
  ));
  if (blockingWarnings.length > 0) {
    throw new GeminiCliError(
      'SEARCH_WARNING',
      `${label} 중 결과 신뢰성에 영향을 주는 Gemini CLI 경고가 발생했습니다.`,
      blockingWarnings.join('\n').slice(0, 3000),
    );
  }
  const groundingUrls = Array.isArray(envelope.groundingUrls)
    ? [...new Set(envelope.groundingUrls.map(safeSourceUrl).filter(Boolean))]
    : [];
  return { webSearchSuccesses: success, warnings, groundingUrls };
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
    const items = result.categories[unit.key].sort(compareItems).slice(0, 5);
    result.categories[unit.key] = items;
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

function dedupeAndSort(results) {
  for (const domain of domains) dedupeDomain(results[domain.key], domain);

  const specializedItems = [];
  for (const domainKey of ['export', 'trade']) {
    const domain = domains.find((item) => item.key === domainKey);
    for (const unit of domain.units) {
      specializedItems.push(...results[domainKey].categories[unit.key]);
    }
  }
  const customs = domains.find((item) => item.key === 'customs');
  for (const unit of customs.units) {
    results.customs.categories[unit.key] = results.customs.categories[unit.key]
      .filter((item) => !specializedItems.some((specialized) => sameEvent(item, specialized)));
  }

  for (const domain of domains) syncCategoryStatuses(results[domain.key], domain);
}

function calculateStats(results) {
  const stats = { total: 0, high: 0, byDomain: {} };
  for (const domain of domains) {
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

function asGeminiError(error) {
  return error instanceof GeminiCliError
    ? error
    : new GeminiCliError('UNKNOWN', error?.message || String(error));
}

function abortableDelay(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const reason = signal.reason;
      reject(reason?.code === 'RUN_TIMEOUT'
        ? new GeminiCliError('RUN_TIMEOUT', reason.message || '전체 실행 제한 시간을 초과했습니다.', reason.details || '')
        : new GeminiCliError('ABORTED', '사용자가 실행을 중단했습니다.'));
      return;
    }
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      const reason = signal.reason;
      reject(reason?.code === 'RUN_TIMEOUT'
        ? new GeminiCliError('RUN_TIMEOUT', reason.message || '전체 실행 제한 시간을 초과했습니다.', reason.details || '')
        : new GeminiCliError('ABORTED', '사용자가 실행을 중단했습니다.'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function collectUnits(domain, units, context, options, mock, coverage) {
  if (mock) {
    const value = mock.domains?.[domain.key] || { insight: '', categories: {} };
    if (value.__error) {
      throw new GeminiCliError(
        text(value.__error.code, 40) || 'MOCK_ERROR',
        text(value.__error.message, 500) || `${domain.label} mock 실패`,
      );
    }
    const serialized = JSON.stringify(value)
      .replaceAll('__TODAY__', context.toISO)
      .replaceAll('__FROM__', context.fromISO);
    return {
      result: parseDomainResponse(domain, serialized, context, { units, coverage }),
      audit: { webSearchSuccesses: 0, warnings: [] },
    };
  }

  const attempts = retryMax();
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const caller = options.callGemini || callGeminiCli;
      const envelope = await caller(buildDomainPrompt(domain, context, units), {
        cwd: options.cwd,
        signal: options.signal,
      });
      const audit = validateResearchEnvelope(envelope, `${domain.label} 조사`, units.length);
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
      lastError = asGeminiError(error);
      if (lastError.code === 'ABORTED') throw lastError;
      const retryable = isRetryableGeminiError(lastError) && lastError.code !== 'TIMEOUT';
      if (!retryable || attempt >= attempts) break;
      const delay = 30000 * 2 ** (attempt - 1);
      console.warn(`  ${lastError.code}: ${delay / 1000}초 후 한 번 더 시도합니다.`);
      await abortableDelay(delay, options.signal);
    }
  }
  throw lastError;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function mergeRecoveredUnits(target, recovered, units) {
  for (const unit of units) {
    const status = recovered.categoryStatus[unit.key];
    if (status.status === 'failure') continue;
    target.categories[unit.key] = recovered.categories[unit.key];
    target.categoryStatus[unit.key] = status;
  }
}

function markUnitsFailed(result, units, error) {
  const reason = text(error?.message || error, 500);
  for (const unit of units) {
    if (result.categoryStatus[unit.key].status !== 'failure') continue;
    result.categoryStatus[unit.key] = categoryFailure(reason);
  }
}

async function recoverBatch(domain, batch, context, options, mock, target, auditTotals) {
  try {
    const recovered = await collectUnits(domain, batch, context, options, mock, 'fallback');
    auditTotals.webSearchSuccesses += recovered.audit.webSearchSuccesses;
    auditTotals.warningCount += recovered.audit.warnings.length;
    mergeRecoveredUnits(target, recovered.result, batch);

    const stillMissing = batch.filter(
      (unit) => recovered.result.categoryStatus[unit.key].status === 'failure',
    );
    if (stillMissing.length > 0 && stillMissing.length < batch.length && !mock) {
      const second = await collectUnits(domain, stillMissing, context, options, mock, 'fallback');
      auditTotals.webSearchSuccesses += second.audit.webSearchSuccesses;
      auditTotals.warningCount += second.audit.warnings.length;
      mergeRecoveredUnits(target, second.result, stillMissing);
    }
  } catch (error) {
    if (error?.code === 'ABORTED') throw error;
    markUnitsFailed(target, batch, asGeminiError(error));
  }
}

async function collectDomain(domain, context, options, mock) {
  let result = emptyDomainResult(domain);
  let initialError = null;
  const auditTotals = { webSearchSuccesses: 0, warningCount: 0 };

  try {
    const primary = await collectUnits(domain, domain.units, context, options, mock, 'full');
    result = primary.result;
    auditTotals.webSearchSuccesses += primary.audit.webSearchSuccesses;
    auditTotals.warningCount += primary.audit.warnings.length;
  } catch (error) {
    initialError = asGeminiError(error);
    if (initialError.code === 'ABORTED') throw initialError;
    if (!FALLBACK_ERROR_CODES.has(initialError.code) || mock) throw initialError;
    markUnitsFailed(result, domain.units, initialError);
  }

  let unresolved = domain.units.filter(
    (unit) => result.categoryStatus[unit.key].status === 'failure',
  );
  if (unresolved.length > 0 && !mock) {
    console.warn(`  ${domain.label}: ${unresolved.length}개 카테고리를 하나씩 다시 조사합니다.`);
    for (const batch of chunks(unresolved, FALLBACK_BATCH_SIZE)) {
      await recoverBatch(domain, batch, context, options, mock, result, auditTotals);
    }
    unresolved = domain.units.filter(
      (unit) => result.categoryStatus[unit.key].status === 'failure',
    );
  }

  result.coverage.webSearchSuccesses = auditTotals.webSearchSuccesses;
  result.coverage.warningCount = auditTotals.warningCount;
  if (initialError) {
    result.coverage.recoveryUsed = true;
    result.coverage.recoveryReason = initialError.code;
  } else {
    result.coverage.recoveryUsed = domain.units.some(
      (unit) => result.categoryStatus[unit.key].coverage === 'fallback',
    );
    result.coverage.recoveryReason = result.coverage.recoveryUsed ? 'MISSING_CATEGORY' : '';
  }
  refreshCoverage(result);

  if (unresolved.length === 0) return { result, failure: null };
  const details = unresolved
    .map((unit) => `${unit.key}: ${result.categoryStatus[unit.key].reason}`)
    .join('\n');
  return {
    result,
    failure: new GeminiCliError(
      'PARTIAL_COVERAGE',
      `${domain.label} ${unresolved.length}개 카테고리의 조사를 완료하지 못했습니다.`,
      details,
    ),
  };
}

function failureRecord(domain, error) {
  return {
    domainKey: domain.key,
    domainLabel: domain.label,
    code: error?.code || 'UNKNOWN',
    reason: error?.message || String(error),
    details: text(error?.details, 1000),
  };
}

export async function collectMonitoring(options = {}) {
  const context = createContext(options.now || new Date(), options.lookbackHours);
  const mock = await loadMock(options.mockPath);
  const results = Object.fromEntries(domains.map((domain) => [domain.key, emptyDomainResult(domain)]));
  const failures = [];

  console.log(`조사 기간: ${context.fromStr} ~ ${context.toStr} KST`);
  console.log('Gemini 호출: 3개 영역을 순차 조사하고 실패한 카테고리만 하나씩 다시 조사합니다.');

  for (let index = 0; index < domains.length; index += 1) {
    const domain = domains[index];
    if (options.signal?.aborted) {
      const reason = options.signal.reason;
      if (reason?.code !== 'RUN_TIMEOUT') {
        throw new GeminiCliError('ABORTED', '사용자가 실행을 중단했습니다.');
      }
      for (const pendingDomain of domains.slice(index)) {
        const deadlineError = new GeminiCliError(
          'RUN_TIMEOUT',
          reason.message || '전체 실행 제한 시간을 초과했습니다.',
        );
        markUnitsFailed(results[pendingDomain.key], pendingDomain.units, deadlineError);
        refreshCoverage(results[pendingDomain.key]);
        failures.push(failureRecord(pendingDomain, deadlineError));
        console.error(`${pendingDomain.label} 미실행 (RUN_TIMEOUT): ${deadlineError.message}`);
      }
      break;
    }
    console.log(`[${index + 1}/${domains.length}] ${domain.label} 조사 시작`);
    try {
      const collected = await collectDomain(domain, context, options, mock);
      results[domain.key] = collected.result;
      if (collected.failure) failures.push(failureRecord(domain, collected.failure));
      const count = domain.units.reduce(
        (sum, unit) => sum + collected.result.categories[unit.key].length,
        0,
      );
      const suffix = collected.result.coverage.complete ? '' : ' (부분 결과)';
      console.log(`[${index + 1}/${domains.length}] ${domain.label} 완료: ${count}건${suffix}`);
    } catch (error) {
      if (error?.code === 'ABORTED') throw error;
      const geminiError = asGeminiError(error);
      markUnitsFailed(results[domain.key], domain.units, geminiError);
      refreshCoverage(results[domain.key]);
      const failure = failureRecord(domain, geminiError);
      failures.push(failure);
      console.error(`[${index + 1}/${domains.length}] ${domain.label} 실패 (${failure.code}): ${failure.reason}`);
      if (failure.details) console.error(`  상세: ${failure.details}`);
    }
  }

  dedupeAndSort(results);
  const usableDomains = domains.filter(
    (domain) => results[domain.key].coverage.completedCategories > 0,
  ).length;
  const fullyCompletedDomains = domains.filter(
    (domain) => results[domain.key].coverage.complete,
  ).length;
  const completedCategories = domains.reduce(
    (sum, domain) => sum + results[domain.key].coverage.completedCategories,
    0,
  );

  return {
    version: 3,
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
      totalDomains: domains.length,
      completedDomains: usableDomains,
      fullyCompletedDomains,
      totalCategories: domains.reduce((sum, domain) => sum + domain.units.length, 0),
      completedCategories,
    },
    stats: calculateStats(results),
  };
}
