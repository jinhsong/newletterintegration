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
  const lookbackHours = lookbackOverride || (weekdayKst(now) === 1 ? 72 : 24);
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
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || !hostname.includes('.')
    || hostname === 'localhost'
    || hostname.endsWith('.local')
    || net.isIP(hostname)
  ) return '';
  url.hash = '';
  return url.href;
}

function normalizeImportance(value) {
  return Object.hasOwn(IMPORTANCE_ORDER, value) ? value : '하';
}

function normalizeItem(raw) {
  return {
    importance: normalizeImportance(text(raw?.importance, 5)),
    importanceReason: text(raw?.importanceReason, 500),
    measureType: text(raw?.measureType, 100),
    title: text(raw?.title, 180),
    titleEn: text(raw?.titleEn, 240),
    summary: text(raw?.summary, 1200),
    businessImpact: text(raw?.businessImpact, 600),
    announcedDate: text(raw?.announcedDate, 10),
    effectiveDate: text(raw?.effectiveDate, 10),
    hsCode: text(raw?.hsCode, 120),
    issuingCountry: text(raw?.issuingCountry, 160),
    targetCountries: Array.isArray(raw?.targetCountries)
      ? raw.targetCountries.map((item) => text(item, 80)).filter(Boolean).join(', ')
      : text(raw?.targetCountries, 240),
    agency: text(raw?.agency, 240),
    sourceName: text(raw?.sourceName, 160),
    sourceUrl: safeSourceUrl(raw?.sourceUrl),
    notes: text(raw?.notes, 600),
  };
}

function inDateRange(item, context) {
  return /^\d{4}-\d{2}-\d{2}$/.test(item.announcedDate)
    && item.announcedDate >= context.fromISO
    && item.announcedDate <= context.toISO;
}

export function normalizeTitle(value) {
  return text(value, 300)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function emptyDomainResult(domain) {
  return {
    insight: '',
    categories: Object.fromEntries(domain.units.map((unit) => [unit.key, []])),
  };
}

export function parseDomainResponse(domain, response, context) {
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
  const invalidUnit = domain.units.find((unit) => !Array.isArray(parsed.categories[unit.key]));
  if (invalidUnit) {
    throw new GeminiCliError(
      'BAD_JSON',
      `${domain.label} 응답에 ${invalidUnit.key} 배열이 없습니다.`,
    );
  }

  const result = emptyDomainResult(domain);
  result.insight = text(parsed.insight, 1000);
  const categories = parsed.categories;
  for (const unit of domain.units) {
    const rawItems = Array.isArray(categories[unit.key]) ? categories[unit.key] : [];
    result.categories[unit.key] = rawItems
      .slice(0, 5)
      .map(normalizeItem)
      .filter((item) => item.title && inDateRange(item, context));
  }
  return result;
}

function dedupeAndSort(results) {
  for (const domain of domains) {
    const seen = new Set();
    for (const unit of domain.units) {
      results[domain.key].categories[unit.key] = results[domain.key].categories[unit.key]
        .filter((item) => {
          const key = normalizeTitle(item.title);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => (
          IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance]
          || b.announcedDate.localeCompare(a.announcedDate)
        ));
    }
  }

  const specialized = new Set();
  for (const domainKey of ['export', 'trade']) {
    const domain = domains.find((item) => item.key === domainKey);
    for (const unit of domain.units) {
      for (const item of results[domainKey].categories[unit.key]) {
        specialized.add(normalizeTitle(item.title));
      }
    }
  }
  const customs = domains.find((item) => item.key === 'customs');
  for (const unit of customs.units) {
    results.customs.categories[unit.key] = results.customs.categories[unit.key]
      .filter((item) => !specialized.has(normalizeTitle(item.title)));
  }
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

async function collectDomain(domain, context, options, mock) {
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
    return parseDomainResponse(domain, serialized, context);
  }

  const attempts = retryMax();
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const envelope = await callGeminiCli(buildDomainPrompt(domain, context), {
        cwd: options.cwd,
        signal: options.signal,
      });
      return parseDomainResponse(domain, envelope.response, context);
    } catch (error) {
      lastError = error instanceof GeminiCliError
        ? error
        : new GeminiCliError('UNKNOWN', error.message);
      if (lastError.code === 'ABORTED') throw lastError;
      const retryable = isRetryableGeminiError(lastError) || lastError.code === 'BAD_JSON';
      if (!retryable || attempt >= attempts) break;
      const delay = 30000 * 2 ** (attempt - 1);
      console.warn(`  ${lastError.code}: ${delay / 1000}초 후 한 번 더 시도합니다.`);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new GeminiCliError('ABORTED', '사용자가 실행을 중단했습니다.'));
        }, { once: true });
      });
    }
  }
  throw lastError;
}

export async function collectMonitoring(options = {}) {
  const context = createContext(options.now || new Date(), options.lookbackHours);
  const mock = await loadMock(options.mockPath);
  const results = Object.fromEntries(domains.map((domain) => [domain.key, emptyDomainResult(domain)]));
  const failures = [];
  let completed = 0;

  console.log(`조사 기간: ${context.fromStr} ~ ${context.toStr} KST`);
  console.log(`Gemini 호출: ${domains.length}개 영역을 한 번에 하나씩 조사합니다.`);

  for (let index = 0; index < domains.length; index += 1) {
    const domain = domains[index];
    if (options.signal?.aborted) throw new GeminiCliError('ABORTED', '사용자가 실행을 중단했습니다.');
    console.log(`[${index + 1}/${domains.length}] ${domain.label} 조사 시작`);
    try {
      results[domain.key] = await collectDomain(domain, context, options, mock);
      const count = domain.units.reduce(
        (sum, unit) => sum + results[domain.key].categories[unit.key].length,
        0,
      );
      completed += 1;
      console.log(`[${index + 1}/${domains.length}] ${domain.label} 완료: ${count}건`);
    } catch (error) {
      if (error?.code === 'ABORTED') throw error;
      const failure = {
        domainKey: domain.key,
        domainLabel: domain.label,
        code: error?.code || 'UNKNOWN',
        reason: error?.message || String(error),
        details: text(error?.details, 1000),
      };
      failures.push(failure);
      console.error(`[${index + 1}/${domains.length}] ${domain.label} 실패 (${failure.code}): ${failure.reason}`);
      if (failure.details) console.error(`  상세: ${failure.details}`);
    }
  }

  dedupeAndSort(results);
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    context: {
      fromISO: context.fromISO,
      toISO: context.toISO,
      fromStr: context.fromStr,
      toStr: context.toStr,
      lookbackHours: context.lookbackHours,
    },
    results,
    failures,
    collection: {
      totalDomains: domains.length,
      completedDomains: completed,
    },
    stats: calculateStats(results),
  };
}
