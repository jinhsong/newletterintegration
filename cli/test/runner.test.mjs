import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCategoryPrompt,
  buildDomainPrompt,
  categoryCatalog,
  domains,
  isTrustedOfficialDomain,
  resolveCategorySelector,
  scopedDomains,
  unitCount,
} from '../src/config.mjs';
import { ClaudeCliError } from '../src/claude-client.mjs';
import {
  collectMonitoring,
  createContext,
  isCalendarDate,
  parseDomainResponse,
  safeSourceUrl,
  titleSimilarity,
  validateResearchEnvelope,
} from '../src/pipeline.mjs';
import { parseJsonArray, parseJsonObject } from '../src/json-utils.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(testDir, 'fixtures', 'responses.json');
const now = new Date('2026-07-29T00:00:00Z');

function item(overrides = {}) {
  return {
    importance: '중',
    importanceReason: '준수 범위 점검이 필요합니다.',
    measureType: '관세율',
    title: '전자부품 통상 조치',
    titleEn: 'Electronic component trade measure',
    summary: '전자부품에 적용되는 조치의 원문과 발표일을 확인했습니다.',
    businessImpact: '관련 공급망과 통관 계획을 점검해야 합니다.',
    announcedDate: '2026-07-29',
    announcedAt: '',
    effectiveDate: '',
    hsCode: '8517',
    issuingCountry: '미국',
    targetCountries: '한국',
    agency: '시험 기관',
    sourceName: '시험 기관',
    sourceUrl: 'https://example.com/measure',
    notes: '',
    ...overrides,
  };
}

function responseFor(domain, selectedUnits = domain.units, categoryItems = {}) {
  return {
    domain: domain.key,
    insight: '검증된 항목을 바탕으로 작성한 인사이트입니다.',
    categories: Object.fromEntries(
      selectedUnits.map((unit) => [unit.key, categoryItems[unit.key] || []]),
    ),
  };
}

function searchedEnvelope(response, overrides = {}) {
  const categoryCount = response && typeof response === 'object' && response.categories
    ? Object.keys(response.categories).length
    : 1;
  const responseCategory = response && typeof response === 'object' && response.categories
    ? Object.keys(response.categories)[0]
    : '';
  const configuredCategory = categoryCatalog.find((entry) => (
    entry.domainKey === response?.domain && entry.unitKey === responseCategory
  ));
  const officialDomain = configuredCategory?.officialDomains?.[0] || 'agency.gov';
  const searchCount = overrides.expectedSearches ?? Math.max(2, categoryCount * 2);
  const queries = overrides.queries || Array.from({ length: searchCount }, (_, index) => (
    index === 0
      ? {
        query: `official source query ${index + 1}`,
        mode: 'official',
        allowedDomains: [officialDomain],
      }
      : {
        query: `broad trend query ${index + 1}`,
        mode: 'broad',
        allowedDomains: [],
      }
  ));
  const search = {
    count: searchCount,
    success: searchCount,
    fail: 0,
    official: queries.filter((entry) => entry.mode === 'official').length,
    broad: queries.filter((entry) => entry.mode === 'broad').length,
    queries,
    ...overrides.search,
  };
  return {
    response: JSON.stringify(response),
    toolEvidence: {
      available: true,
      totalCalls: search.count,
      totalSuccess: search.success,
      totalFail: search.fail,
      byName: { WebSearch: search },
    },
    warnings: overrides.warnings || [],
    groundingUrls: overrides.groundingUrls || [],
  };
}

function promptDomainAndUnits(prompt) {
  const domain = domains.find((candidate) => prompt.includes(`[조사 영역] ${candidate.label}`));
  assert.ok(domain, '프롬프트에서 영역을 식별할 수 있어야 합니다.');
  const units = domain.units.filter((unit) => prompt.includes(`"${unit.key}": [`));
  return { domain, units };
}

test('순수 Node 설정에 글로벌 3개 영역과 18개 카테고리가 있다', () => {
  assert.deepEqual(domains.map((domain) => domain.label), ['관세', '수출통제', '무역구제']);
  assert.equal(unitCount, 18);
  assert.deepEqual(domains.map((domain) => domain.units.map((unit) => unit.key)), [
    ['북미', '중남미', '인도', '유럽', '중동', '동남아/오세아니아', '아프리카', 'CIS', '동아시아'],
    ['미국', '한국', 'EU/일본', '중국/베트남', '영국/캐나다/호주/인도', 'UN 및 다자체제'],
    ['반덤핑', '세이프가드', '보조금/상계관세'],
  ]);
  assert.equal(categoryCatalog.length, 18);
  assert.equal(new Set(categoryCatalog.map((entry) => entry.id)).size, 18);
  assert.ok(categoryCatalog.every((entry) => entry.officialDomains.length > 0));
  assert.equal(isTrustedOfficialDomain('www.bis.gov', ['bis.gov']), true);
  assert.equal(isTrustedOfficialDomain('reuters.com', ['bis.gov']), false);
  assert.equal(isTrustedOfficialDomain('..bis.gov', ['bis.gov']), false);
  assert.equal(resolveCategorySelector('customs:북미').id, 'customs:북미');
  assert.ok(resolveCategorySelector('export:한국').officialDomains.includes('motir.go.kr'));
  assert.equal(resolveCategorySelector('관세:북미').id, 'customs:북미');
  assert.equal(resolveCategorySelector('북미').id, 'customs:북미');
  assert.deepEqual(scopedDomains(resolveCategorySelector('trade:반덤핑'))[0].units.map((unit) => unit.key), ['반덤핑']);
  assert.throws(() => resolveCategorySelector('없는범위'), /--list-categories/);
});

test('카테고리 프롬프트는 한 범위와 공식기관·일반 동향 이중 검색을 요구한다', () => {
  const context = createContext(now, 24);
  for (const domain of domains) {
    for (const unit of domain.units) {
      const prompt = buildCategoryPrompt(domain, unit, context);
      assert.match(prompt, new RegExp(`"${unit.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}": \\[`));
      assert.match(prompt, /공식기관 원문 검색/);
      assert.match(prompt, /allowed_domains/);
      assert.match(prompt, new RegExp(unit.officialDomains[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(prompt, /일반 동향 검색/);
      assert.match(prompt, /서로 다른 query/);
      assert.match(prompt, /파일을 읽거나 수정하지 말고/);
      assert.match(prompt, /announcedAt/);
      for (const other of domain.units.filter((candidate) => candidate.key !== unit.key)) {
        assert.doesNotMatch(prompt, new RegExp(`"${other.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}": \\[`));
      }
    }
  }
  assert.throws(() => buildDomainPrompt(domains[0], context), /카테고리 하나/);
});

test('KST 월요일은 기본 72시간, 화요일은 24시간을 사용한다', () => {
  const monday = createContext(new Date('2026-07-27T00:00:00Z'));
  const tuesday = createContext(new Date('2026-07-28T00:00:00Z'));
  assert.equal(monday.lookbackHours, 72);
  assert.equal(tuesday.lookbackHours, 24);
  assert.match(tuesday.dateCoverageNote, /달력 날짜/);
  assert.throws(() => createContext(tuesday.now, 0), /24, 72, 168/);
});

test('마크다운 fence와 부가 텍스트가 섞인 JSON을 복구한다', () => {
  assert.deepEqual(parseJsonArray('설명\n```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(parseJsonObject('결과: {"overall":"ok"}'), { overall: 'ok' });
});

test('공개 HTTPS 링크와 실제 달력 날짜만 허용한다', () => {
  assert.equal(safeSourceUrl('https://example.com/a#part'), 'https://example.com/a');
  assert.equal(safeSourceUrl('http://example.com'), '');
  assert.equal(safeSourceUrl('https://127.0.0.1/admin'), '');
  assert.equal(safeSourceUrl('https://[::1]/admin'), '');
  assert.equal(safeSourceUrl('https://service.localhost/admin'), '');
  assert.equal(safeSourceUrl('https://user:pass@example.com'), '');
  assert.equal(isCalendarDate('2026-02-28'), true);
  assert.equal(isCalendarDate('2026-02-30'), false);
  assert.equal(isCalendarDate('2026-13-01'), false);
});

test('Claude 응답은 성공한 WebSearch와 정상 경고만 통과한다', () => {
  const good = validateResearchEnvelope(searchedEnvelope('{}', { warnings: ['일반 업데이트 안내'] }));
  assert.equal(good.webSearchSuccesses, 2);
  assert.equal(good.warnings.length, 1);

  const deep = validateResearchEnvelope(
    searchedEnvelope('{}'),
    '카테고리 조사',
    2,
    {
      requireOfficialAndBroadSearch: true,
      officialDomainAllowlist: ['agency.gov'],
    },
  );
  assert.equal(deep.officialSearches, 1);
  assert.equal(deep.broadSearches, 1);

  assert.throws(
    () => validateResearchEnvelope(searchedEnvelope('{}', { expectedSearches: 1 }), '카테고리 조사', 2),
    (error) => error.code === 'SEARCH_INCOMPLETE',
  );
  assert.throws(
    () => validateResearchEnvelope(
      searchedEnvelope('{}', {
        queries: [
          { query: 'first broad', mode: 'broad', allowedDomains: [] },
          { query: 'second broad', mode: 'broad', allowedDomains: [] },
        ],
      }),
      '카테고리 조사',
      2,
      {
        requireOfficialAndBroadSearch: true,
        officialDomainAllowlist: ['agency.gov'],
      },
    ),
    (error) => error.code === 'SEARCH_INCOMPLETE' && /공식기관 검색 0회/.test(error.details),
  );
  assert.throws(
    () => validateResearchEnvelope(
      searchedEnvelope('{}', {
        expectedSearches: 3,
        queries: [
          { query: 'trusted official', mode: 'official', allowedDomains: ['agency.gov'] },
          { query: 'broad news', mode: 'broad', allowedDomains: [] },
          { query: 'untrusted restricted', mode: 'official', allowedDomains: ['reuters.com'] },
        ],
      }),
      '카테고리 조사',
      2,
      {
        requireOfficialAndBroadSearch: true,
        officialDomainAllowlist: ['agency.gov'],
      },
    ),
    (error) => error.code === 'SEARCH_INCOMPLETE' && /신뢰 목록 밖/.test(error.message),
  );
  assert.throws(
    () => validateResearchEnvelope(
      searchedEnvelope('{}', {
        queries: [{
          query: 'trusted official',
          mode: 'official',
          allowedDomains: ['agency.gov'],
        }],
      }),
      '카테고리 조사',
      2,
      {
        requireOfficialAndBroadSearch: true,
        officialDomainAllowlist: ['agency.gov'],
      },
    ),
    (error) => error.code === 'SEARCH_INCOMPLETE' && /증거가 완전하지/.test(error.message),
  );
  assert.throws(
    () => validateResearchEnvelope(
      searchedEnvelope('{}', {
        queries: [
          { query: 'claimed official', mode: 'official', allowedDomains: [] },
          { query: 'second broad', mode: 'broad', allowedDomains: [] },
        ],
      }),
      '카테고리 조사',
      2,
      {
        requireOfficialAndBroadSearch: true,
        officialDomainAllowlist: ['agency.gov'],
      },
    ),
    (error) => error.code === 'SEARCH_INCOMPLETE' && /공식기관 검색 0회/.test(error.details),
  );

  assert.throws(
    () => validateResearchEnvelope({
      response: '{}',
      toolEvidence: {
        available: true,
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        byName: {},
      },
    }),
    (error) => error.code === 'SEARCH_NOT_RUN',
  );
  assert.throws(
    () => validateResearchEnvelope(searchedEnvelope('{}', { search: { success: 1, fail: 1 } })),
    (error) => error.code === 'SEARCH_FAILED',
  );
  assert.throws(
    () => validateResearchEnvelope(searchedEnvelope('{}', { search: { success: 1.5 } })),
    (error) => error.code === 'SEARCH_NOT_RUN',
  );
  assert.throws(
    () => validateResearchEnvelope(searchedEnvelope('{}', { search: { success: 1, fail: -1 } })),
    (error) => error.code === 'SEARCH_FAILED',
  );
  assert.throws(
    () => validateResearchEnvelope(searchedEnvelope('{}', { warnings: ['web search tool blocked by policy'] })),
    (error) => error.code === 'SEARCH_WARNING',
  );
});

test('항목은 정규화·필수 필드·실제 날짜·정확한 시각·정렬 순으로 검증한 뒤 5건으로 제한한다', () => {
  const context = createContext(now, 24);
  const response = responseFor(domains[0]);
  response.categories.북미 = [
    item({ title: '하 등급', importance: '하', sourceUrl: 'https://example.com/low' }),
    item({ title: '중 등급 1', importance: '중', sourceUrl: 'https://example.com/mid1' }),
    item({ title: '상 등급 1', importance: '상', sourceUrl: 'https://example.com/high1' }),
    item({ title: '중 등급 2', importance: '중', sourceUrl: 'https://example.com/mid2' }),
    item({ title: '상 등급 2', importance: '상', sourceUrl: 'https://example.com/high2' }),
    item({ title: '중 등급 3', importance: '중', sourceUrl: 'https://example.com/mid3' }),
    item({ title: '잘못된 중요도', importance: '최상', sourceUrl: 'https://example.com/bad-importance' }),
    item({ title: '존재하지 않는 날짜', announcedDate: '2026-02-30', sourceUrl: 'https://example.com/bad-date' }),
    item({
      title: '존재하지 않는 발표시각',
      announcedAt: '2026-02-30T08:00:00+09:00',
      sourceUrl: 'https://example.com/bad-time',
    }),
    item({
      title: '정확한 시각 범위 밖',
      announcedDate: '2026-07-28',
      announcedAt: '2026-07-28T08:00:00+09:00',
      sourceUrl: 'https://example.com/too-early',
    }),
    item({
      title: '발표일과 시각 날짜 불일치',
      announcedDate: '2026-07-29',
      announcedAt: '2026-07-28T23:30:00-04:00',
      sourceUrl: 'https://example.com/date-mismatch',
    }),
  ];

  const parsed = parseDomainResponse(domains[0], response, context);
  assert.equal(parsed.categories.북미.length, 5);
  assert.deepEqual(parsed.categories.북미.slice(0, 2).map((entry) => entry.importance), ['상', '상']);
  assert.equal(parsed.categoryStatus.북미.rejectedCount, 5);
  assert.equal(parsed.categories.북미.every((entry) => entry.sourceVerification === 'format-only'), true);
});

test('상위 중복 항목을 먼저 제거한 뒤 서로 다른 항목을 최대 5건 유지한다', () => {
  const context = createContext(now, 24);
  const response = responseFor(domains[0]);
  response.categories.북미 = [
    item({ title: '중복 조치', importance: '상', sourceUrl: 'https://example.com/duplicate' }),
    item({
      title: '중복 조치 상세판',
      importance: '상',
      summary: '더 충실한 설명을 포함한 동일 원문 조치입니다. 추가 적용 범위와 일정을 확인했습니다.',
      sourceUrl: 'https://example.com/duplicate',
    }),
    ...Array.from({ length: 5 }, (_, index) => item({
      title: `서로 다른 조치 ${index + 1}`,
      importance: '중',
      measureType: `서로 다른 조치 유형 ${index + 1}`,
      issuingCountry: `서로 다른 국가 ${index + 1}`,
      agency: `서로 다른 기관 ${index + 1}`,
      sourceUrl: `https://example.com/distinct-${index + 1}`,
    })),
  ];

  const parsed = parseDomainResponse(domains[0], response, context);
  assert.equal(parsed.categories.북미.length, 5);
  assert.equal(new Set(parsed.categories.북미.map((entry) => entry.sourceUrl)).size, 5);
  assert.ok(parsed.categories.북미.some((entry) => entry.sourceUrl.endsWith('/distinct-4')));
});

test('검색 근거 연결은 같은 hostname이 아니라 정확히 같은 URL일 때만 표시한다', () => {
  const context = createContext(now, 24);
  const response = responseFor(domains[0]);
  response.categories.북미 = [
    item({ sourceUrl: 'https://example.com/exact' }),
    item({ title: '같은 호스트 다른 문서', sourceUrl: 'https://example.com/other' }),
  ];
  const parsed = parseDomainResponse(domains[0], response, context, {
    groundingUrls: ['https://example.com/exact'],
  });
  const verificationByUrl = Object.fromEntries(
    parsed.categories.북미.map((entry) => [entry.sourceUrl, entry.sourceVerification]),
  );
  assert.equal(verificationByUrl['https://example.com/exact'], 'grounded');
  assert.equal(verificationByUrl['https://example.com/other'], 'format-only');
});

test('모든 항목이 제거되면 오래된 insight를 지우고 카테고리를 실패로 표시한다', () => {
  const context = createContext(now, 24);
  const response = responseFor(domains[0]);
  response.categories.북미 = [item({ importance: '최상' })];
  const parsed = parseDomainResponse(domains[0], response, context);
  assert.equal(parsed.insight, '');
  assert.equal(parsed.categoryStatus.북미.status, 'failure');
  assert.match(parsed.categoryStatus.북미.reason, /검증을 통과하지 못함/);
});

test('누락 카테고리는 정상 카테고리를 버리지 않고 재조사 대상으로 표시한다', () => {
  const context = createContext(now, 24);
  const units = domains[0].units.filter((unit) => unit.key !== '동아시아');
  const parsed = parseDomainResponse(domains[0], responseFor(domains[0], units), context);
  assert.equal(parsed.categoryStatus.북미.status, 'empty');
  assert.equal(parsed.categoryStatus.동아시아.status, 'failure');
  assert.equal(parsed.coverage.failedCategories, 1);
});

test('잘못된 domain 또는 categories 형식은 BAD_JSON으로 거부한다', () => {
  const context = createContext(now, 24);
  assert.throws(
    () => parseDomainResponse(domains[0], { domain: 'wrong', categories: {} }, context),
    (error) => error.code === 'BAD_JSON',
  );
  assert.throws(
    () => parseDomainResponse(domains[0], { domain: 'customs', categories: [] }, context),
    (error) => error.code === 'BAD_JSON',
  );
  assert.throws(
    () => parseDomainResponse(domains[0], {
      domain: 'customs',
      insight: '',
      categories: { 북미: [], 중남미: [] },
    }, context, { units: [domains[0].units[0]] }),
    (error) => error.code === 'BAD_JSON' && /요청하지 않은 카테고리/.test(error.message),
  );
});

test('제목 유사도는 단순 문장 변형을 감지한다', () => {
  assert.ok(titleSimilarity(
    '미국, 전자부품 관세율 조정 발표',
    '미국 전자부품 관세율 조정 발표',
  ) > 0.85);
  assert.ok(titleSimilarity('미국 관세 조정', 'EU 수출통제 개정') < 0.4);
});

test('mock 수집은 Claude 호출 없이 상태를 포함한 공통 payload를 만든다', async () => {
  const payload = await collectMonitoring({
    mockPath: fixture,
    now,
    lookbackHours: 24,
  });
  assert.equal(payload.version, 4);
  assert.equal(payload.collection.mode, 'mock');
  assert.equal(payload.collection.completedDomains, 3);
  assert.equal(payload.collection.fullyCompletedDomains, 3);
  assert.equal(payload.collection.completedCategories, 18);
  assert.equal(payload.stats.total, 2);
  assert.equal(payload.stats.high, 1);
  assert.equal(payload.results.customs.categories.북미[0].sourceUrl, 'https://ustr.gov/example');
  assert.equal(payload.results.customs.categories.북미[0].sourceVerification, 'format-only');
  assert.equal(payload.results.export.categories.미국[0].sourceUrl, 'https://www.bis.gov/example');
  assert.equal(payload.results.trade.categoryStatus.반덤핑.status, 'empty');
});

test('전체 조사는 18개 카테고리를 각각 한 번 호출하고 호출마다 이중 검색을 요구한다', async () => {
  const requested = [];
  let active = 0;
  let maxActive = 0;
  const callClaude = async (prompt, options) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
      const { domain, units } = promptDomainAndUnits(prompt);
      assert.equal(units.length, 1);
      assert.equal(options.minimumWebSearchSuccesses, 2);
      assert.equal(options.requireOfficialAndBroadSearch, true);
      assert.deepEqual(options.officialDomainAllowlist, units[0].officialDomains);
    requested.push(`${domain.key}:${units[0].key}`);
    await Promise.resolve();
    active -= 1;
    return searchedEnvelope(responseFor(domain, units));
  };

  const payload = await collectMonitoring({ callClaude, now, lookbackHours: 24 });
  assert.deepEqual(requested, categoryCatalog.map((entry) => entry.id));
  assert.equal(maxActive, 1);
  assert.equal(payload.collection.totalCategories, 18);
  assert.equal(payload.collection.completedCategories, 18);
  assert.equal(payload.collection.scope, 'all');
  assert.equal(payload.results.customs.coverage.webSearchSuccesses, 18);
  assert.equal(payload.results.export.coverage.webSearchSuccesses, 12);
  assert.equal(payload.results.trade.coverage.webSearchSuccesses, 6);
});

test('단일 카테고리 선택은 해당 범위만 한 번 호출하고 1/1 결과를 만든다', async () => {
  let calls = 0;
  const callClaude = async (prompt) => {
    calls += 1;
    const { domain, units } = promptDomainAndUnits(prompt);
    assert.equal(domain.key, 'customs');
    assert.deepEqual(units.map((unit) => unit.key), ['북미']);
    return searchedEnvelope(responseFor(domain, units, {
      북미: [item({ title: '선택 범위 결과' })],
    }));
  };
  const payload = await collectMonitoring({
    callClaude,
    category: '관세:북미',
    now,
    lookbackHours: 24,
  });
  assert.equal(calls, 1);
  assert.equal(payload.collection.scope, 'category');
  assert.equal(payload.collection.selection.id, 'customs:북미');
  assert.equal(payload.collection.totalDomains, 1);
  assert.equal(payload.collection.completedDomains, 1);
  assert.equal(payload.collection.totalCategories, 1);
  assert.equal(payload.collection.completedCategories, 1);
  assert.deepEqual(Object.keys(payload.results), ['customs']);
  assert.deepEqual(Object.keys(payload.results.customs.categories), ['북미']);
  assert.equal(payload.stats.total, 1);
});

test('한 카테고리 시간초과 시 해당 카테고리는 재호출하지 않고 나머지 범위를 계속한다', async () => {
  let calls = 0;
  const requestedUnitCounts = [];
  const callClaude = async (prompt) => {
    calls += 1;
    const { domain, units } = promptDomainAndUnits(prompt);
    requestedUnitCounts.push(units.length);
    if (calls === 1) throw new ClaudeCliError('TIMEOUT', '시험 시간초과');
    return searchedEnvelope(responseFor(domain, units));
  };

  const payload = await collectMonitoring({ callClaude, now, lookbackHours: 24 });
  assert.equal(calls, 18);
  assert.deepEqual(requestedUnitCounts, Array(18).fill(1));
  assert.equal(payload.collection.fullyCompletedDomains, 2);
  assert.equal(payload.failures.length, 1);
  assert.equal(payload.failures[0].code, 'TIMEOUT');
  assert.equal(payload.failures[0].categoryKey, '북미');
  assert.equal(Boolean(payload.results.customs.coverage.recoveryUsed), false);
  assert.equal(payload.results.customs.categoryStatus.북미.coverage, 'none');
  assert.equal(payload.results.customs.categoryStatus.동아시아.status, 'empty');
});

test('프로세스 트리 정리 실패는 즉시 전체 조사를 중단하고 후속 호출을 막는다', async () => {
  let calls = 0;
  const callClaude = async () => {
    calls += 1;
    throw new ClaudeCliError(
      'PROCESS_CLEANUP',
      'Claude 프로세스 트리를 완전히 종료하지 못했습니다.',
      'taskkill 종료 명령 시간 초과',
    );
  };

  await assert.rejects(
    () => collectMonitoring({ callClaude, now, lookbackHours: 24 }),
    (error) => error.code === 'PROCESS_CLEANUP' && /taskkill/.test(error.details),
  );
  assert.equal(calls, 1);
});

test('전역 권한 정책 오류는 후속 카테고리를 호출하지 않고 즉시 중단한다', async () => {
  let calls = 0;
  const callClaude = async () => {
    calls += 1;
    throw new ClaudeCliError(
      'POLICY',
      'WebSearch 권한이 회사 정책으로 거부되었습니다.',
      'permission mode forced to default',
    );
  };

  await assert.rejects(
    () => collectMonitoring({ callClaude, now, lookbackHours: 24 }),
    (error) => error.code === 'POLICY' && /permission mode/.test(error.details),
  );
  assert.equal(calls, 1);
});

test('누락 카테고리만 재조사하고 정상 카테고리 결과를 보존한다', async () => {
  let eastAsiaCalls = 0;
  const callClaude = async (prompt) => {
    const { domain, units } = promptDomainAndUnits(prompt);
    if (domain.key === 'customs' && units[0].key === '동아시아') {
      eastAsiaCalls += 1;
      if (eastAsiaCalls === 1) return searchedEnvelope(responseFor(domain, []));
    }
    const categoryItems = units[0].key === '북미'
      ? { 북미: [item({ title: '보존할 북미 결과', sourceUrl: 'https://example.com/preserved' })] }
      : {};
    return searchedEnvelope(responseFor(domain, units, categoryItems));
  };

  const payload = await collectMonitoring({ callClaude, now, lookbackHours: 24 });
  assert.equal(eastAsiaCalls, 2);
  assert.equal(payload.results.customs.categories.북미[0].title, '보존할 북미 결과');
  assert.equal(payload.results.customs.categoryStatus.북미.coverage, 'full');
  assert.equal(payload.results.customs.categoryStatus.동아시아.coverage, 'fallback');
  assert.equal(payload.results.customs.coverage.complete, true);
});

test('카테고리별 재조사도 실패하면 정상 결과를 보존하고 해당 카테고리 오류를 기록한다', async () => {
  let eastAsiaCalls = 0;
  const callClaude = async (prompt) => {
    const { domain, units } = promptDomainAndUnits(prompt);
    if (domain.key === 'customs' && units[0].key === '동아시아') {
      eastAsiaCalls += 1;
      if (eastAsiaCalls === 1) return searchedEnvelope(responseFor(domain, []));
      throw new ClaudeCliError('BAD_JSON', '재조사 응답 손상');
    }
    const categoryItems = units[0].key === '북미'
      ? { 북미: [item({ title: '유지되는 부분 결과', sourceUrl: 'https://example.com/partial' })] }
      : {};
    return searchedEnvelope(responseFor(domain, units, categoryItems));
  };

  const payload = await collectMonitoring({ callClaude, now, lookbackHours: 24 });
  assert.equal(eastAsiaCalls, 2);
  assert.equal(payload.results.customs.categories.북미[0].title, '유지되는 부분 결과');
  assert.equal(payload.results.customs.categoryStatus.동아시아.status, 'failure');
  assert.equal(payload.results.customs.coverage.complete, false);
  assert.equal(payload.failures[0].code, 'BAD_JSON');
  assert.equal(payload.failures[0].categoryKey, '동아시아');
  assert.equal(payload.collection.completedDomains, 3);
  assert.equal(payload.collection.fullyCompletedDomains, 2);
});

test('날짜·국가·조치·URL·제목 유사도로 중복을 제거하고 품질 높은 전문영역 항목을 남긴다', async () => {
  const callClaude = async (prompt) => {
    const { domain, units } = promptDomainAndUnits(prompt);
    const categoryItems = {};
    if (domain.key === 'customs') {
      categoryItems.북미 = [item({
        title: '미국 전자부품 수출 제한 조치 발표',
        measureType: '수출통제',
        sourceUrl: 'https://agency.gov/event-1',
      })];
    }
    if (domain.key === 'export') {
      categoryItems.미국 = [
        item({
          title: '미국 전자부품 수출 제한 조치',
          measureType: '수출통제',
          summary: '짧은 설명',
          titleEn: '',
          businessImpact: '',
          sourceUrl: 'https://agency.gov/event-1',
        }),
        item({
          title: '미국 전자부품 수출 제한 조치 상세 발표',
          measureType: '수출통제',
          summary: '원문의 대상 품목과 시행 일정, 기업의 준수 범위를 구체적으로 확인한 더 충실한 설명입니다.',
          notes: '공식 부속서도 확인함',
          announcedAt: '2026-07-29T08:00:00+09:00',
          sourceUrl: 'https://agency.gov/event-1',
        }),
      ];
    }
    return searchedEnvelope(responseFor(domain, units, categoryItems));
  };

  const payload = await collectMonitoring({ callClaude, now, lookbackHours: 24 });
  assert.equal(payload.results.customs.categories.북미.length, 0);
  assert.equal(payload.results.export.categories.미국.length, 1);
  assert.match(payload.results.export.categories.미국[0].summary, /더 충실한 설명/);
  assert.equal(payload.stats.total, 1);
});

test('재사용 URL의 날짜가 다르거나 같은 일반 제목의 발표 주체가 다르면 별도 사안으로 보존한다', async () => {
  const callClaude = async (prompt) => {
    const { domain, units } = promptDomainAndUnits(prompt);
    const categoryItems = {};
    if (domain.key === 'export') {
      categoryItems.미국 = [
        item({
          title: '공식 규제 포털 7월 28일 공지',
          announcedDate: '2026-07-28',
          sourceUrl: 'https://agency.gov/notices',
        }),
        item({
          title: '공식 규제 포털 7월 29일 공지',
          announcedDate: '2026-07-29',
          sourceUrl: 'https://agency.gov/notices',
        }),
        item({
          title: '같은 날 별도 철강 조치 발표',
          measureType: '철강 수입 제한',
          announcedDate: '2026-07-29',
          sourceUrl: 'https://agency.gov/notices',
        }),
        item({
          title: '전자부품 규정 개정',
          issuingCountry: '미국',
          agency: '미국 기관',
          sourceUrl: 'https://us.example.com/rule',
        }),
        item({
          title: '전자부품 규정 개정',
          issuingCountry: '캐나다',
          agency: '캐나다 기관',
          sourceUrl: 'https://ca.example.com/rule',
        }),
      ];
    }
    return searchedEnvelope(responseFor(domain, units, categoryItems));
  };

  const payload = await collectMonitoring({ callClaude, now, lookbackHours: 24 });
  assert.equal(payload.results.export.categories.미국.length, 5);
});

test('같은 사안의 중복 후보에서는 더 높은 중요도를 상세도보다 우선한다', async () => {
  const callClaude = async (prompt) => {
    const { domain, units } = promptDomainAndUnits(prompt);
    const categoryItems = {};
    if (domain.key === 'export') {
      categoryItems.미국 = [
        item({
          importance: '상',
          title: '반도체 장비 수출통제 개정',
          summary: '핵심 조치입니다.',
          titleEn: '',
          businessImpact: '',
          notes: '',
          sourceUrl: 'https://agency.gov/export-rule',
        }),
        item({
          importance: '중',
          title: '반도체 장비 수출통제 개정 상세',
          summary: '대상 품목과 시행일, 예외 절차 및 기업 준수사항을 매우 상세하게 정리한 설명입니다.',
          announcedAt: '2026-07-29T08:00:00+09:00',
          notes: '상세 부속서 확인',
          sourceUrl: 'https://agency.gov/export-rule',
        }),
      ];
    }
    return searchedEnvelope(responseFor(domain, units, categoryItems));
  };

  const payload = await collectMonitoring({ callClaude, now, lookbackHours: 24 });
  assert.equal(payload.results.export.categories.미국.length, 1);
  assert.equal(payload.results.export.categories.미국[0].importance, '상');
  assert.equal(payload.results.export.categories.한국.length, 0);
});

test('전체 실행 제한 신호는 남은 영역을 RUN_TIMEOUT으로 표시해 부분 저장을 허용한다', async () => {
  const controller = new AbortController();
  const reason = new Error('전체 실행 제한 시험');
  reason.code = 'RUN_TIMEOUT';
  controller.abort(reason);

  const payload = await collectMonitoring({ signal: controller.signal, now, lookbackHours: 24 });
  assert.equal(payload.collection.completedDomains, 0);
  assert.equal(payload.failures.length, 18);
  assert.ok(payload.failures.every((failure) => failure.code === 'RUN_TIMEOUT'));
});

test('조사 호출 중 도달한 전체 실행 제한도 RUN_TIMEOUT 부분 결과로 정리한다', async () => {
  const controller = new AbortController();
  const callClaude = async (_prompt, options) => new Promise((_resolve, reject) => {
    const onAbort = () => reject(new ClaudeCliError(
      options.signal.reason?.code || 'ABORTED',
      options.signal.reason?.message || '중단',
    ));
    options.signal.addEventListener('abort', onAbort, { once: true });
  });
  const collection = collectMonitoring({
    callClaude,
    signal: controller.signal,
    now,
    lookbackHours: 24,
  });
  const reason = new Error('호출 중 전체 실행 제한 시험');
  reason.code = 'RUN_TIMEOUT';
  setTimeout(() => controller.abort(reason), 10);

  const payload = await collection;
  assert.equal(payload.collection.completedDomains, 0);
  assert.equal(payload.failures.length, 18);
  assert.ok(payload.failures.every((failure) => failure.code === 'RUN_TIMEOUT'));
});
