import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  buildInsightPrompt,
  domains,
  makeEmptyInsights,
  parseInsightsWithRecovery,
  repoRoot,
} from './config-loader.mjs';
import { parseJsonArray, parseJsonObject } from './json-utils.mjs';

const KST = 'Asia/Seoul';

function formatKst(date, withTime) {
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
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  return withTime ? `${ymd} ${parts.hour}:${parts.minute}` : ymd;
}

function weekdayKst(date) {
  const short = new Intl.DateTimeFormat('en-US', {
    timeZone: KST,
    weekday: 'short',
  }).format(date);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[short];
}

export function createContext(now = new Date(), lookbackOverride) {
  const weekday = weekdayKst(now);
  const lookbackHours = lookbackOverride || (weekday === 1 ? 72 : 24);
  if (![24, 72, 168].includes(lookbackHours)) {
    throw new Error('lookback은 24, 72, 168시간 중 하나여야 합니다.');
  }
  const fromDate = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  return {
    now,
    fromDate,
    lookbackHours,
    fromStr: formatKst(fromDate, true),
    toStr: formatKst(now, true),
    fromISO: formatKst(fromDate, false),
    toISO: formatKst(now, false),
  };
}

function emptyData() {
  const out = {};
  for (const domain of domains) {
    out[domain.key] = {};
    for (const unit of domain.units) out[domain.key][unit.key] = [];
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function unitPrompt(domain, unit, ctx) {
  return [
    'You are running inside the official Gemini CLI with a company Gemini Code Assist Enterprise account.',
    'Use the built-in Google web search tool to verify current information and original publication dates.',
    'Do not edit files or run shell commands. Research only.',
    'Return only the JSON requested below. Do not add markdown fences or commentary.',
    '',
    domain.buildPrompt(unit, ctx),
  ].join('\n');
}

async function callWithRetry(prompt, tag, mockValue, client) {
  if (mockValue !== undefined) {
    return typeof mockValue === 'string' ? mockValue : JSON.stringify(mockValue);
  }

  const retries = client.cliRetryMax();
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const result = await client.callGeminiCli(prompt, { cwd: repoRoot });
      return result.response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const delay = 3000 * 2 ** (attempt - 1);
        console.warn(`[${tag}] 실패 ${attempt}/${retries}: ${error.message} — ${delay}ms 후 재시도`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

async function runPool(jobs, worker, limit) {
  const output = new Array(jobs.length);
  let cursor = 0;
  async function consume() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= jobs.length) return;
      output[index] = await worker(jobs[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, () => consume()));
  return output;
}

export function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function bigrams(value) {
  if (value.length < 2) return [value];
  const out = [];
  for (let i = 0; i < value.length - 1; i += 1) out.push(value.slice(i, i + 2));
  return out;
}

function diceSimilarity(a, b) {
  if (a === b) return 1;
  const aa = bigrams(a);
  const bb = bigrams(b);
  const counts = new Map();
  for (const gram of aa) counts.set(gram, (counts.get(gram) || 0) + 1);
  let overlap = 0;
  for (const gram of bb) {
    const count = counts.get(gram) || 0;
    if (count > 0) {
      overlap += 1;
      counts.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (aa.length + bb.length);
}

function isDuplicate(title, seen) {
  const normalized = normalizeTitle(title);
  if (!normalized) return false;
  return seen.some((other) => other === normalized || diceSimilarity(other, normalized) >= 0.7);
}

function dedupeCurrentRun(data) {
  for (const domain of domains) {
    const seen = [];
    for (const unit of domain.units) {
      data[domain.key][unit.key] = data[domain.key][unit.key].filter((item) => {
        if (isDuplicate(item.title, seen)) return false;
        const normalized = normalizeTitle(item.title);
        if (normalized) seen.push(normalized);
        return true;
      });
    }
  }

  const specialized = [];
  for (const domain of domains.filter((item) => !item.generalBucket)) {
    for (const unit of domain.units) {
      for (const item of data[domain.key][unit.key]) {
        const normalized = normalizeTitle(item.title);
        if (normalized) specialized.push(normalized);
      }
    }
  }
  for (const domain of domains.filter((item) => item.generalBucket)) {
    for (const unit of domain.units) {
      data[domain.key][unit.key] = data[domain.key][unit.key]
        .filter((item) => !isDuplicate(item.title, specialized));
    }
  }
}

function dedupeHistory(data, historyTitles) {
  if (!historyTitles) return;
  for (const domain of domains) {
    const seen = Array.isArray(historyTitles[domain.key])
      ? historyTitles[domain.key].filter(Boolean)
      : [];
    for (const unit of domain.units) {
      data[domain.key][unit.key] = data[domain.key][unit.key].filter((item) => {
        if (isDuplicate(item.title, seen)) return false;
        const normalized = normalizeTitle(item.title);
        if (normalized) seen.push(normalized);
        return true;
      });
    }
  }
}

function filterDates(items, ctx) {
  return items.filter((item) => (
    /^\d{4}-\d{2}-\d{2}$/.test(item.announcedDate || '')
    && item.announcedDate >= ctx.fromISO
    && item.announcedDate <= ctx.toISO
  ));
}

function daysSinceKst(dateString, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString || '')) return null;
  const today = formatKst(now, false);
  const itemMs = Date.UTC(
    Number(dateString.slice(0, 4)),
    Number(dateString.slice(5, 7)) - 1,
    Number(dateString.slice(8, 10)),
  );
  const todayMs = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10)),
  );
  return Math.round((todayMs - itemMs) / 86400000);
}

function statsFor(data, now) {
  const stats = {
    total: 0,
    high: 0,
    maxDays: null,
    byDomain: {},
  };
  for (const domain of domains) {
    const domainStats = { total: 0, high: 0 };
    for (const unit of domain.units) {
      for (const item of data[domain.key][unit.key]) {
        domainStats.total += 1;
        stats.total += 1;
        if (item.importance === '상') {
          domainStats.high += 1;
          stats.high += 1;
        }
        const days = daysSinceKst(item.announcedDate, now);
        if (days !== null && (stats.maxDays === null || days > stats.maxDays)) {
          stats.maxDays = days;
        }
      }
    }
    stats.byDomain[domain.key] = domainStats;
  }
  return stats;
}

async function loadMock(mockPath, ctx) {
  if (!mockPath) return null;
  const raw = await fs.readFile(mockPath, 'utf8');
  return JSON.parse(
    raw
      .replaceAll('__TODAY__', ctx.toISO)
      .replaceAll('__FROM__', ctx.fromISO),
  );
}

export async function collectWithGeminiCli(options = {}) {
  const ctx = createContext(options.now || new Date(), options.lookbackHours);
  const mock = await loadMock(options.mockPath, ctx);
  const client = mock ? null : await import('./gemini-client.mjs');
  const concurrency = options.concurrency || (client ? client.cliConcurrency() : 3);
  const data = emptyData();
  const failedUnits = [];
  const jobs = [];
  for (const domain of domains) {
    for (const unit of domain.units) jobs.push({ domain, unit });
  }

  console.log(`수집 시작: ${ctx.fromStr} ~ ${ctx.toStr} KST / ${jobs.length}개 단위`);
  await runPool(jobs, async ({ domain, unit }) => {
    const key = `${domain.key}/${unit.key}`;
    const mockValue = mock
      ? (Object.hasOwn(mock.units || {}, key) ? mock.units[key] : [])
      : undefined;
    try {
      const response = await callWithRetry(
        unitPrompt(domain, unit, ctx),
        key,
        mockValue,
        client,
      );
      const rawItems = parseJsonArray(response).slice(0, 12);
      const normalized = rawItems
        .map((item) => plain(domain.normalize(item)))
        .filter((item) => item.title);
      data[domain.key][unit.key] = filterDates(normalized, ctx);
      console.log(`[${domain.label}/${unit.label}] ${data[domain.key][unit.key].length}건`);
    } catch (error) {
      failedUnits.push({
        domainKey: domain.key,
        domainLabel: domain.label,
        unitKey: unit.key,
        unitLabel: unit.label,
        reason: error.message,
      });
      console.error(`[${domain.label}/${unit.label}] 실패: ${error.message}`);
    }
  }, concurrency);

  if (failedUnits.length === jobs.length) {
    throw new Error('17개 수집 단위가 모두 실패했습니다. 결과 파일을 전달하지 않습니다.');
  }
  dedupeCurrentRun(data);
  dedupeHistory(data, options.historyTitles);

  const insights = plain(makeEmptyInsights());
  if (!options.skipInsights) {
    const insightJobs = domains.filter((domain) => (
      domain.units.some((unit) => data[domain.key][unit.key].length > 0)
    ));
    await runPool(insightJobs, async (domain) => {
      const key = `insight/${domain.key}`;
      const mockValue = mock
        ? (Object.hasOwn(mock.insights || {}, domain.key)
          ? mock.insights[domain.key]
          : { overall: null, byCategory: {} })
        : undefined;
      try {
        const response = await callWithRetry(
          buildInsightPrompt(domain, data),
          key,
          mockValue,
          client,
        );
        const parsed = parseJsonObject(response);
        insights[domain.key] = plain(
          parseInsightsWithRecovery(domain, JSON.stringify(parsed)),
        );
      } catch (error) {
        console.warn(`[인사이트/${domain.label}] 생략: ${error.message}`);
      }
    }, Math.min(3, concurrency));
  }

  const stats = statsFor(data, ctx.now);
  const deliveryKey = options.deliveryKey || ctx.toISO;
  return {
    version: 1,
    deliveryKey,
    runId: `${ctx.toISO.replaceAll('-', '')}-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    nowISO: ctx.now.toISOString(),
    fromISO: ctx.fromDate.toISOString(),
    lookbackHours: ctx.lookbackHours,
    data,
    insights,
    failedUnits,
    stats,
  };
}

export function buildMarkdownSummary(payload) {
  const lines = [
    `# 글로벌 통상 모니터링 ${payload.deliveryKey}`,
    '',
    `- 수집 기간: ${payload.fromISO} ~ ${payload.nowISO}`,
    `- 총 ${payload.stats.total}건 / 중요도 상 ${payload.stats.high}건`,
    `- 실패 단위: ${payload.failedUnits.length}개`,
    '',
  ];
  for (const domain of domains) {
    lines.push(`## ${domain.label} (${payload.stats.byDomain[domain.key].total}건)`, '');
    for (const unit of domain.units) {
      const items = payload.data[domain.key][unit.key];
      if (items.length === 0) continue;
      lines.push(`### ${unit.label}`);
      for (const item of items) {
        const url = item.__modelUrl || '';
        lines.push(`- [${item.importance}] ${url ? `[${item.title}](${url})` : item.title} — ${item.announcedDate}`);
      }
      lines.push('');
    }
  }
  if (payload.failedUnits.length > 0) {
    lines.push('## 수집 실패', '');
    for (const failed of payload.failedUnits) {
      lines.push(`- ${failed.domainLabel}/${failed.unitLabel}: ${failed.reason}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
