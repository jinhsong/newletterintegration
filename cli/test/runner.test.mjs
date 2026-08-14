import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCategoryPrompt,
  buildDomainPrompt,
  CATEGORY_RESEARCH_POLICY,
  categoryCatalog,
  domains,
  groupCatalog,
  isTrustedOfficialDomain,
  OFFICIAL_SOURCES_REVIEWED_AT,
  researchPolicyForUnit,
  resolveResearchDepth,
  resolveCategorySelector,
  resolveGroupSelector,
  scopedDomains,
  unitCount,
  validateOfficialSources,
} from '../src/config.mjs';
import { ClaudeCliError } from '../src/claude-client.mjs';
import {
  collectMonitoring,
  canonicalSourceUrl,
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

function itemForUnit(domain, unit, overrides = {}) {
  if (domain.key === 'customs') {
    return item({ issuingCountry: unit.itemScope.aliases[0], ...overrides });
  }
  if (domain.key === 'export') {
    return item({
      measureType: '수출통제',
      issuingCountry: unit.itemScope.aliases[0],
      agency: unit.itemScope.aliases[0],
      ...overrides,
    });
  }
  return item({
    measureType: unit.key,
    title: `${unit.key} 전자부품 조치`,
    ...overrides,
  });
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

function groundedParseOptions(response, unit, overrides = {}) {
  return {
    groundingUrls: Object.values(response.categories || {})
      .flatMap((items) => (Array.isArray(items) ? items : []))
      .map((entry) => entry?.sourceUrl)
      .filter(Boolean),
    researchPolicy: researchPolicyForUnit(unit, overrides.depth),
    evidenceKind: 'direct',
    ...overrides,
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
  const configuredUnit = domains
    .find((domain) => domain.key === configuredCategory?.domainKey)
    ?.units.find((unit) => unit.key === configuredCategory?.unitKey);
  const policy = configuredUnit
    ? researchPolicyForUnit(configuredUnit, overrides.depth)
    : CATEGORY_RESEARCH_POLICY;
  const officialDomain = configuredCategory?.officialDomains?.[0] || 'agency.gov';
  const searchCount = overrides.expectedSearches
    ?? Math.max(
      policy.minimumSearchesPerCategory,
      categoryCount * policy.minimumSearchesPerCategory,
    );
  const coverageLabels = configuredUnit?.coverageTargets.map((target) => target.label) || [];
  const officialTargetChunks = coverageLabels.length > 0
    ? Array.from(
      { length: Math.ceil(coverageLabels.length / policy.officialTargetsPerSearch) },
      (_, index) => coverageLabels
        .slice(
          index * policy.officialTargetsPerSearch,
          (index + 1) * policy.officialTargetsPerSearch,
        )
        .join(' '),
    )
    : ['global'];
  const broadCoverageText = coverageLabels.join(' ') || 'global';
  const officialPerspectives = [
    'official law gazette',
    'official implementation guidance',
    'official product HS measure',
    'official customs authority notice',
    'official trade ministry release',
    'official parliamentary legislation',
    'official executive decree',
    'official tariff schedule revision',
    'official customs classification ruling',
    'official import licensing instruction',
  ];
  const broadPerspectives = [
    'major media policy news',
    'local language industry news',
    'Korean company supply chain impact',
    'international trade press analysis',
    'regional business association update',
    'electronics sector compliance impact',
    'customs broker implementation report',
    'cross border logistics policy coverage',
  ];
  const queries = overrides.queries || Array.from({ length: searchCount }, (_, index) => (
    index < policy.minimumOfficialSearches
      ? {
        query: `${officialPerspectives[index] || `official additional perspective alpha${index + 1}`} ${officialTargetChunks[index % officialTargetChunks.length]}`,
        mode: 'official',
        allowedDomains: [officialDomain],
      }
      : {
        query: `${broadPerspectives[index - policy.minimumOfficialSearches]
          || `additional regional perspective alpha${index + 1}`} ${broadCoverageText}`,
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
  const responseUrls = response && typeof response === 'object'
    ? Object.values(response.categories || {})
      .flatMap((items) => (Array.isArray(items) ? items : []))
      .map((entry) => entry?.sourceUrl)
      .filter(Boolean)
    : [];
  const includeGroundingSearches = overrides.includeGroundingSearches ?? Boolean(configuredUnit);
  const groundingSearches = includeGroundingSearches
    ? queries.map((entry, index) => {
      const officialUrl = entry.allowedDomains.length > 0
        ? `https://${entry.allowedDomains[0]}/result-${index}`
        : '';
      const fallbackUrl = `https://news.example.org/result-${index}`;
      return {
        toolUseId: `tool-${index}`,
        query: entry.query,
        mode: entry.allowedDomains.length > 0 ? 'official' : 'broad',
        allowedDomains: entry.allowedDomains,
        blockedDomains: entry.blockedDomains || [],
        urls: [...new Set([officialUrl || fallbackUrl, ...responseUrls])],
        officialUrls: officialUrl ? [officialUrl] : [],
      };
    })
    : undefined;
  return {
    response: JSON.stringify(response),
    evidenceKind: overrides.evidenceKind || 'direct',
    toolEvidence: {
      available: true,
      totalCalls: search.count,
      totalSuccess: search.success,
      totalFail: search.fail,
      byName: { WebSearch: search },
    },
    warnings: overrides.warnings || [],
    groundingUrls: overrides.groundingUrls || responseUrls,
    ...(groundingSearches ? { groundingSearches } : {}),
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
  assert.ok(categoryCatalog.every((entry) => entry.coverageTargets.length > 0));
  assert.ok(categoryCatalog.every((entry) => entry.queryTerms.length > 0));
  assert.ok(categoryCatalog.every((entry) => (
    entry.itemScope.fields.length > 0 && entry.itemScope.aliases.length > 0
  )));
  assert.ok(categoryCatalog.every((entry) => entry.lastReviewed === OFFICIAL_SOURCES_REVIEWED_AT));
  assert.ok(categoryCatalog.every((entry) => entry.officialSources.every((source) => (
    source.lastReviewed === OFFICIAL_SOURCES_REVIEWED_AT
  ))));
  const northAmerica = resolveCategorySelector('customs:북미');
  assert.ok(northAmerica.officialDomains.includes('whitehouse.gov'));
  assert.ok(northAmerica.officialDomains.includes('federalregister.gov'));
  assert.equal(isTrustedOfficialDomain('Whitehouse.gov', northAmerica.officialDomains), true);
  assert.equal(isTrustedOfficialDomain('www.WHITEHOUSE.GOV', northAmerica.officialDomains), true);
  assert.equal(isTrustedOfficialDomain('notwhitehouse.gov', northAmerica.officialDomains), false);
  assert.equal(isTrustedOfficialDomain('whitehouse.gov.evil.com', northAmerica.officialDomains), false);
  assert.equal(isTrustedOfficialDomain('gov.cn', northAmerica.officialDomains), false);
  assert.equal(isTrustedOfficialDomain('www.bis.gov', ['bis.gov']), true);
  assert.equal(isTrustedOfficialDomain('reuters.com', ['bis.gov']), false);
  assert.equal(isTrustedOfficialDomain('..bis.gov', ['bis.gov']), false);
  assert.equal(resolveCategorySelector('customs:북미').id, 'customs:북미');
  assert.ok(resolveCategorySelector('export:한국').officialDomains.includes('motir.go.kr'));
  assert.equal(
    resolveCategorySelector('export:한국').officialSources
      .find((source) => source.hostname === 'kita.net').sourceTier,
    'trusted-association',
  );
  assert.equal(resolveCategorySelector('관세:북미').id, 'customs:북미');
  assert.equal(resolveCategorySelector('북미').id, 'customs:북미');
  assert.deepEqual(scopedDomains(resolveCategorySelector('trade:반덤핑'))[0].units.map((unit) => unit.key), ['반덤핑']);
  assert.throws(() => resolveCategorySelector('없는범위'), /--list-categories/);
  assert.deepEqual(groupCatalog.map((entry) => [entry.id, entry.domainLabel, entry.unitCount]), [
    ['customs', '관세', 9],
    ['export', '수출통제', 6],
    ['trade', '무역구제', 3],
  ]);
  assert.equal(resolveGroupSelector('CUSTOMS').domainLabel, '관세');
  assert.equal(resolveGroupSelector(' 수출통제 ').id, 'export');
  assert.equal(resolveGroupSelector('trade').domainLabel, '무역구제');
  assert.deepEqual(
    scopedDomains(null, resolveGroupSelector('관세'))[0].units.map((unit) => unit.key),
    domains[0].units.map((unit) => unit.key),
  );
  assert.throws(() => resolveGroupSelector('북미'), /--list-groups/);
  assert.throws(
    () => scopedDomains(resolveCategorySelector('customs:북미'), resolveGroupSelector('관세')),
    /함께 사용할 수 없습니다/,
  );
});

test('카테고리 프롬프트는 깊이·대상 규모에 맞춰 검색 횟수와 표시 한도를 조정한다', () => {
  const context = createContext(now, 24);
  for (const domain of domains) {
    for (const unit of domain.units) {
      const policy = researchPolicyForUnit(unit, 'standard');
      const prompt = buildCategoryPrompt(domain, unit, context);
      assert.match(prompt, new RegExp(`"${unit.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}": \\[`));
      assert.match(prompt, /공식기관 원문 검색/);
      assert.match(prompt, /allowed_domains/);
      assert.match(prompt, new RegExp(unit.officialDomains[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(prompt, /일반 동향 검색/);
      assert.match(prompt, /서로 다른 query/);
      assert.match(prompt, new RegExp(`총 최소 ${policy.minimumSearchesPerCategory}회`));
      assert.match(prompt, new RegExp(`공식기관 원문 검색은 서로 다른 query로 최소 ${policy.minimumOfficialSearches}회`));
      assert.match(prompt, new RegExp(`일반 동향 검색은 서로 다른 query로 최소 ${policy.minimumBroadSearches}회`));
      assert.match(prompt, /일반 동향 검색은.*allowed_domains와 blocked_domains를 모두 넣지 않는다/);
      assert.match(prompt, new RegExp(`최대 ${policy.maximumItemsPerCategory}건`));
      assert.match(prompt, /반드시 검색 query로 모두 확인할 하위 대상/);
      assert.match(prompt, /실제 공식 원문 URL/);
      assert.match(prompt, new RegExp(`최대 ${policy.officialTargetsPerSearch}개`));
      assert.ok(Number.isSafeInteger(policy.officialTargetsPerSearch));
      assert.match(prompt, /권장 검색어 축/);
      assert.match(prompt, /government·intergovernmental/);
      assert.match(prompt, new RegExp(unit.lastReviewed));
      assert.match(prompt, /복수 국가·기관 카테고리/);
      assert.match(prompt, /파일을 읽거나 수정하지 말고/);
      assert.match(prompt, /announcedAt/);
      for (const other of domain.units.filter((candidate) => candidate.key !== unit.key)) {
        assert.doesNotMatch(prompt, new RegExp(`"${other.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}": \\[`));
      }
    }
  }
  const india = domains[0].units.find((unit) => unit.key === '인도');
  const middleEast = domains[0].units.find((unit) => unit.key === '중동');
  assert.ok(
    researchPolicyForUnit(middleEast, 'standard').minimumSearchesPerCategory
      > researchPolicyForUnit(india, 'standard').minimumSearchesPerCategory,
  );
  assert.ok(
    researchPolicyForUnit(middleEast, 'deep').maximumItemsPerCategory
      > researchPolicyForUnit(middleEast, 'fast').maximumItemsPerCategory,
  );
  assert.equal(resolveResearchDepth(), 'standard');
  assert.throws(() => resolveResearchDepth('extreme'), /fast, standard, deep/);
  assert.throws(() => buildDomainPrompt(domains[0], context), /카테고리 하나/);
});

test('공식 출처 메타데이터는 hostname·중복·등급·검토일을 엄격히 검증한다', () => {
  const source = {
    hostname: 'agency.gov',
    sourceTier: 'government',
    lastReviewed: '2026-08-10',
  };
  assert.equal(validateOfficialSources([source]), true);
  assert.throws(() => validateOfficialSources([]), /비어 있습니다/);
  assert.throws(() => validateOfficialSources([source, { ...source }]), /중복/);
  assert.throws(
    () => validateOfficialSources([{ ...source, hostname: 'https://agency.gov/path' }]),
    /hostname 형식/,
  );
  assert.throws(
    () => validateOfficialSources([{ ...source, sourceTier: 'media' }]),
    /sourceTier/,
  );
  assert.throws(
    () => validateOfficialSources([{ ...source, lastReviewed: '' }]),
    /lastReviewed/,
  );
});

test('KST 월요일은 기본 72시간, 화요일은 24시간을 사용한다', () => {
  const monday = createContext(new Date('2026-07-27T00:00:00Z'));
  const tuesday = createContext(new Date('2026-07-28T00:00:00Z'));
  const sunday2359Kst = createContext(new Date('2026-07-26T14:59:00Z'));
  const monday0000Kst = createContext(new Date('2026-07-26T15:00:00Z'));
  assert.equal(monday.lookbackHours, 72);
  assert.equal(tuesday.lookbackHours, 24);
  assert.equal(sunday2359Kst.lookbackHours, 24);
  assert.equal(monday0000Kst.lookbackHours, 72);
  assert.match(tuesday.dateCoverageNote, /달력 날짜/);
  assert.throws(() => createContext(tuesday.now, 0), /1~168/);
  const priorSuccess = new Date(tuesday.now.getTime() - 30.5 * 60 * 60 * 1000);
  const resumed = createContext(tuesday.now, undefined, priorSuccess);
  assert.equal(resumed.lookbackHours, 30.5);
  assert.equal(resumed.fromDate.toISOString(), priorSuccess.toISOString());
  assert.throws(
    () => createContext(tuesday.now, undefined, new Date(tuesday.now.getTime() - 169 * 60 * 60 * 1000)),
    /168시간/,
  );
});

test('Gemini 단일 카테고리와 ChatGPT 그룹 선택이 프롬프트부터 payload까지 유지된다', async () => {
  const geminiSelection = resolveCategorySelector('customs:북미');
  const geminiPrompts = [];
  const geminiPayload = await collectMonitoring({
    provider: 'gemini',
    categorySelection: geminiSelection,
    now,
    lookbackHours: 48,
    callProvider: async (prompt) => {
      geminiPrompts.push(prompt);
      const { domain, units } = promptDomainAndUnits(prompt);
      return searchedEnvelope(responseFor(domain, units), { evidenceKind: 'reported' });
    },
  });
  assert.equal(geminiPrompts.length, 1);
  assert.match(geminiPrompts[0], /Gemini CLI.*google_web_search/s);
  assert.equal(geminiPayload.collection.provider, 'gemini');
  assert.equal(geminiPayload.collection.providerLabel, 'Gemini CLI');
  assert.equal(geminiPayload.collection.scope, 'category');
  assert.equal(geminiPayload.collection.totalCategories, 1);
  assert.equal(geminiPayload.context.lookbackHours, 48);
  assert.deepEqual(Object.keys(geminiPayload.results), ['customs']);

  const chatgptSelection = resolveGroupSelector('trade');
  const chatgptPrompts = [];
  const chatgptPayload = await collectMonitoring({
    provider: 'chatgpt',
    groupSelection: chatgptSelection,
    now,
    lookbackHours: 72,
    callProvider: async (prompt) => {
      chatgptPrompts.push(prompt);
      const { domain, units } = promptDomainAndUnits(prompt);
      return searchedEnvelope(responseFor(domain, units), { evidenceKind: 'reported' });
    },
  });
  assert.equal(chatgptPrompts.length, 3);
  assert.ok(chatgptPrompts.every((prompt) => /ChatGPT\(Codex CLI\).*web_search/s.test(prompt)));
  assert.equal(chatgptPayload.collection.provider, 'chatgpt');
  assert.equal(chatgptPayload.collection.providerLabel, 'ChatGPT (Codex CLI)');
  assert.equal(chatgptPayload.collection.scope, 'group');
  assert.equal(chatgptPayload.collection.totalCategories, 3);
  assert.equal(chatgptPayload.context.lookbackHours, 72);
  assert.deepEqual(Object.keys(chatgptPayload.results), ['trade']);
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
  assert.equal(
    canonicalSourceUrl('https://EXAMPLE.com:443/a/?utm_source=x&b=2&a=1#part'),
    'https://example.com/a?a=1&b=2',
  );
  assert.equal(isCalendarDate('2026-02-28'), true);
  assert.equal(isCalendarDate('2026-02-30'), false);
  assert.equal(isCalendarDate('2026-13-01'), false);
});

test('Claude 응답은 성공한 WebSearch와 정상 경고만 통과한다', () => {
  const good = validateResearchEnvelope(searchedEnvelope('{}', { warnings: ['일반 업데이트 안내'] }));
  assert.equal(good.webSearchSuccesses, 6);
  assert.equal(good.warnings.length, 1);
  assert.equal(good.evidenceKind, 'direct');
  assert.equal(
    validateResearchEnvelope(searchedEnvelope('{}', { evidenceKind: 'reported' })).evidenceKind,
    'reported',
  );
  const missingEvidenceKind = searchedEnvelope('{}');
  delete missingEvidenceKind.evidenceKind;
  assert.throws(
    () => validateResearchEnvelope(missingEvidenceKind, 'Gemini 조사', 1, {
      expectedEvidenceKind: 'reported',
    }),
    (error) => error.code === 'BAD_OUTPUT' && /검색 근거 유형/.test(error.message),
  );
  const quotaWarning = validateResearchEnvelope(searchedEnvelope('{}', {
    warnings: ['quota 429 rate limit reached'],
  }));
  assert.deepEqual(quotaWarning.warnings, ['quota 429 rate limit reached']);

  const deep = validateResearchEnvelope(
    searchedEnvelope('{}'),
    '카테고리 조사',
    CATEGORY_RESEARCH_POLICY.minimumSearchesPerCategory,
    {
      minimumOfficialSearches: CATEGORY_RESEARCH_POLICY.minimumOfficialSearches,
      minimumBroadSearches: CATEGORY_RESEARCH_POLICY.minimumBroadSearches,
      requireOfficialAndBroadSearch: true,
      officialDomainAllowlist: ['agency.gov'],
    },
  );
  assert.equal(deep.officialSearches, 3);
  assert.equal(deep.broadSearches, 3);

  const northAmerica = resolveCategorySelector('customs:북미');
  const northAmericaAudit = validateResearchEnvelope(
    searchedEnvelope('{}', {
      queries: [
        { query: 'White House tariff action', mode: 'official', allowedDomains: ['Whitehouse.gov'] },
        { query: 'Federal Register tariff notice', mode: 'official', allowedDomains: ['federalregister.gov'] },
        { query: 'CBP customs implementation', mode: 'official', allowedDomains: ['www.cbp.gov'] },
        { query: 'North America tariff news', mode: 'broad', allowedDomains: [] },
        { query: 'Canada customs industry update', mode: 'broad', allowedDomains: [] },
        { query: 'Korean supply chain North America tariff', mode: 'broad', allowedDomains: [] },
      ],
    }),
    '관세 / 북미 조사',
    CATEGORY_RESEARCH_POLICY.minimumSearchesPerCategory,
    {
      minimumOfficialSearches: CATEGORY_RESEARCH_POLICY.minimumOfficialSearches,
      minimumBroadSearches: CATEGORY_RESEARCH_POLICY.minimumBroadSearches,
      requireOfficialAndBroadSearch: true,
      officialDomainAllowlist: northAmerica.officialDomains,
    },
  );
  assert.equal(northAmericaAudit.officialSearches, 3);

  assert.throws(
    () => validateResearchEnvelope(
      searchedEnvelope('{}', { expectedSearches: 5 }),
      '카테고리 조사',
      CATEGORY_RESEARCH_POLICY.minimumSearchesPerCategory,
    ),
    (error) => error.code === 'SEARCH_INCOMPLETE',
  );
  assert.throws(
    () => validateResearchEnvelope(
      searchedEnvelope('{}', {
        queries: Array.from({ length: 6 }, (_, index) => ({
          query: `broad query ${index + 1}`,
          mode: 'broad',
          allowedDomains: [],
        })),
      }),
      '카테고리 조사',
      CATEGORY_RESEARCH_POLICY.minimumSearchesPerCategory,
      {
        minimumOfficialSearches: CATEGORY_RESEARCH_POLICY.minimumOfficialSearches,
        minimumBroadSearches: CATEGORY_RESEARCH_POLICY.minimumBroadSearches,
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
        expectedSearches: 2,
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
    () => validateResearchEnvelope(
      searchedEnvelope('{}', {
        queries: [
          ...Array.from({ length: 2 }, (_, index) => ({
            query: `official query ${index + 1}`,
            mode: 'official',
            allowedDomains: ['agency.gov'],
          })),
          ...Array.from({ length: 4 }, (_, index) => ({
            query: `broad query ${index + 1}`,
            mode: 'broad',
            allowedDomains: [],
          })),
        ],
      }),
      '카테고리 조사',
      CATEGORY_RESEARCH_POLICY.minimumSearchesPerCategory,
      {
        minimumOfficialSearches: CATEGORY_RESEARCH_POLICY.minimumOfficialSearches,
        minimumBroadSearches: CATEGORY_RESEARCH_POLICY.minimumBroadSearches,
        requireOfficialAndBroadSearch: true,
        officialDomainAllowlist: ['agency.gov'],
      },
    ),
    (error) => error.code === 'SEARCH_INCOMPLETE' && /공식기관 검색 2회/.test(error.details),
  );

  assert.throws(
    () => validateResearchEnvelope(
      searchedEnvelope('{}', {
        queries: [
          { query: 'official duplicate', mode: 'official', allowedDomains: ['agency.gov'] },
          { query: ' official---duplicate ', mode: 'official', allowedDomains: ['agency.gov'] },
          { query: 'official third', mode: 'official', allowedDomains: ['agency.gov'] },
          { query: 'broad first', mode: 'broad', allowedDomains: [] },
          { query: 'broad second', mode: 'broad', allowedDomains: [] },
          { query: 'broad third', mode: 'broad', allowedDomains: [] },
        ],
      }),
      '카테고리 조사',
      CATEGORY_RESEARCH_POLICY.minimumSearchesPerCategory,
      {
        minimumOfficialSearches: CATEGORY_RESEARCH_POLICY.minimumOfficialSearches,
        minimumBroadSearches: CATEGORY_RESEARCH_POLICY.minimumBroadSearches,
        requireOfficialAndBroadSearch: true,
        officialDomainAllowlist: ['agency.gov'],
      },
    ),
    (error) => error.code === 'SEARCH_INCOMPLETE' && /서로 다른 query 5개/.test(error.details),
  );

  const missingCanadaAudit = validateResearchEnvelope(
      searchedEnvelope('{}', {
        includeGroundingSearches: true,
        queries: [
          { query: 'United States official law', allowedDomains: ['agency.gov'] },
          { query: 'United States official guidance', allowedDomains: ['agency.gov'] },
          { query: 'United States official products', allowedDomains: ['agency.gov'] },
          { query: 'United States media', allowedDomains: [] },
          { query: 'United States local news', allowedDomains: [] },
          { query: 'United States supply chain', allowedDomains: [] },
        ],
      }),
      '북미 조사',
      6,
      {
        minimumOfficialSearches: 3,
        minimumBroadSearches: 3,
        requireOfficialAndBroadSearch: true,
        requireTargetCoverage: true,
        officialTargetsPerSearch: 2,
        officialDomainAllowlist: ['agency.gov'],
        coverageTargets: resolveCategorySelector('customs:북미').coverageTargets,
      },
  );
  assert.deepEqual(missingCanadaAudit.missingCoverageTargets, ['캐나다']);
  assert.match(missingCanadaAudit.warnings.join('\n'), /캐나다/);

  const filteredBroadAudit = validateResearchEnvelope(
    searchedEnvelope('{}', {
      queries: [
        { query: 'official one', allowedDomains: ['agency.gov'] },
        { query: 'official two', allowedDomains: ['agency.gov'] },
        { query: 'official three', allowedDomains: ['agency.gov'] },
        { query: 'broad one', allowedDomains: [], blockedDomains: ['reuters.com'] },
        { query: 'broad two', allowedDomains: [] },
        { query: 'broad three', allowedDomains: [] },
      ],
    }),
    '카테고리 조사',
    6,
    {
      minimumOfficialSearches: 3,
      minimumBroadSearches: 3,
      requireOfficialAndBroadSearch: true,
      officialDomainAllowlist: ['agency.gov'],
    },
  );
  assert.equal(filteredBroadAudit.officialSearches, 3);
  assert.equal(filteredBroadAudit.broadSearches, 3);

  assert.throws(
    () => validateResearchEnvelope(
      searchedEnvelope('{}', {
        queries: [
          { query: 'official law gazette', mode: 'official', allowedDomains: ['agency.gov'] },
          { query: 'official implementation guidance', mode: 'official', allowedDomains: ['agency.gov'] },
          { query: 'official product HS 8517 measure', mode: 'official', allowedDomains: ['agency.gov'] },
          { query: 'major media policy news', mode: 'broad', allowedDomains: [] },
          { query: 'local language industry news', mode: 'broad', allowedDomains: [] },
          { query: '123', mode: 'broad', allowedDomains: [] },
        ],
      }),
      '카테고리 조사',
      CATEGORY_RESEARCH_POLICY.minimumSearchesPerCategory,
      {
        minimumOfficialSearches: CATEGORY_RESEARCH_POLICY.minimumOfficialSearches,
        minimumBroadSearches: CATEGORY_RESEARCH_POLICY.minimumBroadSearches,
        requireOfficialAndBroadSearch: true,
        officialDomainAllowlist: ['agency.gov'],
      },
    ),
    (error) => error.code === 'SEARCH_INCOMPLETE' && /서로 다른 query 5개/.test(error.details),
  );

  const withSurplusFailure = validateResearchEnvelope(
    searchedEnvelope('{}', {
      search: { count: 7, success: 6, fail: 1 },
      warnings: ['WebSearch 실패: 추가 탐색 일시 오류'],
    }),
    '카테고리 조사',
    CATEGORY_RESEARCH_POLICY.minimumSearchesPerCategory,
    {
      minimumOfficialSearches: CATEGORY_RESEARCH_POLICY.minimumOfficialSearches,
      minimumBroadSearches: CATEGORY_RESEARCH_POLICY.minimumBroadSearches,
      requireOfficialAndBroadSearch: true,
      officialDomainAllowlist: ['agency.gov'],
    },
  );
  assert.equal(withSurplusFailure.webSearchSuccesses, 6);
  assert.equal(withSurplusFailure.warnings.length, 1);

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
  const policyWarning = validateResearchEnvelope(
    searchedEnvelope('{}', { warnings: ['web search tool blocked by policy'] }),
  );
  assert.deepEqual(policyWarning.warnings, ['web search tool blocked by policy']);
});

test('하위 대상은 실제 공식 URL이 있는 공식 검색에 분산되고 영문 약칭도 정확히 인식한다', () => {
  const northAmerica = resolveCategorySelector('customs:북미');
  const validationOptions = {
    minimumOfficialSearches: 3,
    minimumBroadSearches: 3,
    requireOfficialAndBroadSearch: true,
    requireGroundingSearchEvidence: true,
    requireTargetCoverage: true,
    officialTargetsPerSearch: 2,
    officialDomainAllowlist: ['agency.gov'],
    coverageTargets: northAmerica.coverageTargets,
  };
  const validQueries = [
    { query: 'U.S. tariff official law', allowedDomains: ['agency.gov'] },
    { query: 'Canada customs official guidance', allowedDomains: ['agency.gov'] },
    { query: 'official product implementation', allowedDomains: ['agency.gov'] },
    { query: 'North America tariff media', allowedDomains: [] },
    { query: 'Canada local industry news', allowedDomains: [] },
    { query: 'Korean supply chain impact', allowedDomains: [] },
  ];
  const audit = validateResearchEnvelope(
    searchedEnvelope('{}', { includeGroundingSearches: true, queries: validQueries }),
    '북미 조사',
    6,
    validationOptions,
  );
  assert.equal(audit.coverageTargetEvidence.length, 2);
  assert.ok(audit.coverageTargetEvidence.every((target) => target.toolUseIds.length > 0));

  const broadOnlyCanada = validQueries.map((entry, index) => (
    index === 1 ? { ...entry, query: 'official customs guidance' } : entry
  ));
  const incompleteCoverage = validateResearchEnvelope(
      searchedEnvelope('{}', { includeGroundingSearches: true, queries: broadOnlyCanada }),
      '북미 조사',
      6,
      validationOptions,
  );
  assert.deepEqual(incompleteCoverage.missingCoverageTargets, ['캐나다']);
  assert.match(incompleteCoverage.warnings.join('\n'), /캐나다/);

  const latinAmerica = resolveCategorySelector('customs:중남미');
  const overloadedQueries = [
    { query: 'Mexico Brazil Colombia official tariff', allowedDomains: ['agency.gov'] },
    { query: 'Peru Argentina official customs', allowedDomains: ['agency.gov'] },
    { query: 'Chile Panama official trade notice', allowedDomains: ['agency.gov'] },
    { query: 'official implementation detail', allowedDomains: ['agency.gov'] },
    { query: 'Latin America tariff media', allowedDomains: [] },
    { query: 'regional customs industry news', allowedDomains: [] },
    { query: 'electronics supply chain impact', allowedDomains: [] },
  ];
  const overloadedCoverage = validateResearchEnvelope(
      searchedEnvelope('{}', {
        includeGroundingSearches: true,
        expectedSearches: 7,
        queries: overloadedQueries,
      }),
      '중남미 조사',
      7,
      {
        ...validationOptions,
        minimumOfficialSearches: 4,
        officialTargetsPerSearch: 2,
        coverageTargets: latinAmerica.coverageTargets,
      },
  );
  assert.equal(overloadedCoverage.overloadedCoverageSearches.length, 1);
  assert.deepEqual(overloadedCoverage.overloadedCoverageSearches[0].matchedTargets, ['멕시코', '브라질', '콜롬비아']);

  const missingOfficialUrl = searchedEnvelope('{}', {
    includeGroundingSearches: true,
    queries: validQueries,
  });
  missingOfficialUrl.groundingSearches[0].officialUrls = [];
  assert.throws(
    () => validateResearchEnvelope(missingOfficialUrl, '북미 조사', 6, validationOptions),
    (error) => error.code === 'BAD_OUTPUT' && /검색별 출처 증거/.test(error.message),
  );
});

test('항목은 strict 타입·실제 날짜·KST 발표시각·검색 근거를 검증한 뒤 동적 한도로 제한한다', () => {
  const context = createContext(now, 24);
  const response = responseFor(domains[0]);
  response.categories.북미 = [
    item({ title: '하 등급', importance: '하', sourceUrl: 'https://example.com/low' }),
    item({ title: '중 등급 1', importance: '중', sourceUrl: 'https://example.com/mid1' }),
    item({ title: '상 등급 1', importance: '상', sourceUrl: 'https://example.com/high1' }),
    item({ title: '중 등급 2', importance: '중', sourceUrl: 'https://example.com/mid2' }),
    item({ title: '상 등급 2', importance: '상', sourceUrl: 'https://example.com/high2' }),
    item({ title: '중 등급 3', importance: '중', sourceUrl: 'https://example.com/mid3' }),
    ...Array.from({ length: 5 }, (_, index) => item({
      title: `추가 동향 ${index + 1}`,
      importance: '하',
      measureType: `추가 조치 ${index + 1}`,
      sourceUrl: `https://example.com/extra-${index + 1}`,
    })),
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
      announcedAt: '2026-07-29T23:30:00-04:00',
      sourceUrl: 'https://example.com/date-mismatch',
    }),
  ];

  const policy = researchPolicyForUnit(domains[0].units[0]);
  const parsed = parseDomainResponse(
    domains[0],
    response,
    context,
    groundedParseOptions(response, domains[0].units[0]),
  );
  assert.equal(parsed.categories.북미.length, policy.maximumItemsPerCategory);
  assert.deepEqual(parsed.categories.북미.slice(0, 2).map((entry) => entry.importance), ['상', '상']);
  assert.equal(parsed.categoryStatus.북미.rejectedCount, 5);
  assert.equal(parsed.categoryStatus.북미.truncatedCount, 1);
  assert.equal(parsed.categories.북미.every((entry) => entry.sourceVerification === 'grounded'), true);
});

test('상위 중복 항목을 먼저 제거한 뒤 서로 다른 항목을 최대 10건 유지한다', () => {
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
    ...Array.from({ length: 10 }, (_, index) => item({
      title: `서로 다른 조치 ${index + 1}`,
      importance: '중',
      measureType: `서로 다른 조치 유형 ${index + 1}`,
      issuingCountry: '미국',
      agency: `서로 다른 기관 ${index + 1}`,
      sourceUrl: `https://example.com/distinct-${index + 1}`,
    })),
  ];

  const policy = researchPolicyForUnit(domains[0].units[0]);
  const parsed = parseDomainResponse(
    domains[0],
    response,
    context,
    groundedParseOptions(response, domains[0].units[0]),
  );
  assert.equal(parsed.categories.북미.length, policy.maximumItemsPerCategory);
  assert.equal(
    new Set(parsed.categories.북미.map((entry) => entry.sourceUrl)).size,
    policy.maximumItemsPerCategory,
  );
  assert.equal(parsed.categories.북미.filter((entry) => entry.sourceUrl.endsWith('/duplicate')).length, 1);
  assert.equal(parsed.categoryStatus.북미.dedupedCount, 1);
  assert.equal(parsed.categoryStatus.북미.truncatedCount, 1);
});

test('검색 근거 URL은 안전하게 canonicalize하고 연결되지 않은 항목은 채택하지 않는다', () => {
  const context = createContext(now, 24);
  const response = responseFor(domains[0]);
  response.categories.북미 = [
    item({ sourceUrl: 'https://example.com/exact/?utm_source=test&a=1' }),
    item({ title: '같은 호스트 다른 문서', sourceUrl: 'https://example.com/other' }),
  ];
  const parsed = parseDomainResponse(domains[0], response, context, {
    groundingUrls: ['https://example.com/exact?a=1#result'],
    evidenceKind: 'direct',
  });
  assert.equal(parsed.categories.북미.length, 1);
  assert.equal(parsed.categories.북미[0].sourceVerification, 'grounded');
  assert.equal(parsed.categories.북미[0].sourceCanonicalUrl, 'https://example.com/exact?a=1');
  assert.equal(parsed.categoryStatus.북미.rejectedCount, 1);
  assert.equal(parsed.categoryStatus.북미.rejectedReasons.sourceUngrounded, 1);

  const reportedResponse = responseFor(domains[0]);
  reportedResponse.categories.북미 = [item({ sourceUrl: 'https://example.com/reported' })];
  const reported = parseDomainResponse(domains[0], reportedResponse, context, {
    groundingUrls: ['https://example.com/reported'],
    evidenceKind: 'reported',
  });
  assert.equal(reported.categories.북미.length, 1);
  assert.equal(reported.categories.북미[0].sourceVerification, 'reported');
});

test('문자열 타입과 원본 날짜 길이를 자르기 전에 거부하고 announcedAt은 KST 날짜로 판정한다', () => {
  const context = createContext(now, 24);
  const response = responseFor(domains[0]);
  response.categories.북미 = [
    item({ title: { text: '객체 제목' }, sourceUrl: 'https://example.com/type' }),
    item({ announcedDate: '2026-07-29 extra', sourceUrl: 'https://example.com/long-date' }),
    item({
      title: 'KST 날짜 일치',
      announcedDate: '2026-07-29',
      announcedAt: '2026-07-28T18:00:00-04:00',
      sourceUrl: 'https://example.com/kst',
    }),
  ];
  const parsed = parseDomainResponse(
    domains[0], response, context, groundedParseOptions(response, domains[0].units[0]),
  );
  assert.deepEqual(parsed.categories.북미.map((entry) => entry.title), ['KST 날짜 일치']);
  assert.equal(parsed.categoryStatus.북미.rejectedCount, 2);
  assert.equal(parsed.categoryStatus.북미.rejectedReasons.titleType, 1);
  assert.equal(parsed.categoryStatus.북미.rejectedReasons.announcedDateLength, 1);
});

test('검색별 provenance를 항목에 연결하고 payload 감사 정보로 보존할 수 있다', () => {
  const context = createContext(now, 24);
  const response = responseFor(domains[0]);
  response.categories.북미 = [item({ sourceUrl: 'https://agency.gov/notice?utm_medium=x' })];
  const groundingSearches = [{
    toolUseId: 'tool-1',
    query: 'United States Canada official tariff notice',
    mode: 'official',
    allowedDomains: ['agency.gov'],
    blockedDomains: [],
    urls: ['https://agency.gov/notice'],
    officialUrls: ['https://agency.gov/notice'],
  }];
  const parsed = parseDomainResponse(domains[0], response, context, {
    groundingSearches,
    groundingUrls: [],
    evidenceKind: 'direct',
  });
  assert.equal(parsed.categories.북미.length, 1);
  assert.deepEqual(parsed.categories.북미[0].sourceEvidence, [{
    toolUseId: 'tool-1',
    query: 'United States Canada official tariff notice',
    mode: 'official',
    allowedDomains: ['agency.gov'],
    match: 'exact',
  }]);

  response.categories.북미 = [item({ sourceUrl: 'https://agency.gov/notice/new-path' })];
  const reported = parseDomainResponse(domains[0], response, context, {
    groundingSearches: [{
      ...groundingSearches[0],
      urls: ['https://vertexaisearch.cloud.google.com/grounding-api-redirect/example'],
      officialUrls: [],
      officialRedirectUrls: ['https://vertexaisearch.cloud.google.com/grounding-api-redirect/example'],
    }],
    groundingUrls: [],
    evidenceKind: 'reported',
  });
  assert.equal(reported.categories.북미.length, 1);
  assert.equal(reported.categories.북미[0].sourceVerification, 'reported');
  assert.equal(reported.categories.북미[0].sourceEvidence[0].match, 'reported-domain');
});

test('관세 단독 조사도 명백한 무역구제·수출통제 영역 위반을 제거한다', () => {
  const context = createContext(now, 24);
  const response = responseFor(domains[0]);
  response.categories.북미 = [
    item({ title: '일반 관세율 개정', sourceUrl: 'https://example.com/customs' }),
    item({
      title: '반덤핑 최종 판정',
      measureType: 'AD',
      sourceUrl: 'https://example.com/ad',
    }),
    item({
      title: 'Entity List 수출통제 개정',
      measureType: 'EAR',
      sourceUrl: 'https://example.com/ear',
    }),
  ];
  const parsed = parseDomainResponse(
    domains[0], response, context, groundedParseOptions(response, domains[0].units[0]),
  );
  assert.deepEqual(parsed.categories.북미.map((entry) => entry.title), ['일반 관세율 개정']);
  assert.equal(parsed.categoryStatus.북미.rejectedReasons.domainBoundary, 2);
});

test('수출통제·무역구제도 영역 경계와 선택 카테고리 소속을 함께 검증한다', () => {
  const context = createContext(now, 24);
  const exportDomain = domains.find((domain) => domain.key === 'export');
  const exportUnit = exportDomain.units.find((unit) => unit.key === '미국');
  const exportResponse = responseFor(exportDomain, [exportUnit], {
    미국: [
      itemForUnit(exportDomain, exportUnit, {
        title: 'BIS 반도체 수출통제 강화',
        sourceUrl: 'https://example.com/export-valid',
      }),
      itemForUnit(exportDomain, exportUnit, {
        title: '미국 일반 관세율 인상',
        measureType: '관세율',
        sourceUrl: 'https://example.com/export-customs',
      }),
      itemForUnit(exportDomain, exportUnit, {
        title: '미국 반덤핑 조사 개시',
        measureType: '반덤핑',
        sourceUrl: 'https://example.com/export-trade',
      }),
      itemForUnit(exportDomain, exportUnit, {
        title: 'EU 이중용도 수출통제 개정',
        issuingCountry: 'EU',
        agency: 'European Commission',
        sourceUrl: 'https://example.com/export-wrong-unit',
      }),
    ],
  });
  const parsedExport = parseDomainResponse(
    exportDomain,
    exportResponse,
    context,
    groundedParseOptions(exportResponse, exportUnit, { units: [exportUnit] }),
  );
  assert.deepEqual(parsedExport.categories.미국.map((entry) => entry.title), ['BIS 반도체 수출통제 강화']);
  assert.equal(parsedExport.categoryStatus.미국.rejectedReasons.domainBoundary, 2);
  assert.equal(parsedExport.categoryStatus.미국.rejectedReasons.unitScope, 1);

  const tradeDomain = domains.find((domain) => domain.key === 'trade');
  const tradeUnit = tradeDomain.units.find((unit) => unit.key === '반덤핑');
  const tradeResponse = responseFor(tradeDomain, [tradeUnit], {
    반덤핑: [
      itemForUnit(tradeDomain, tradeUnit, {
        title: '전자부품 반덤핑 조사 개시',
        sourceUrl: 'https://example.com/trade-valid',
      }),
      itemForUnit(tradeDomain, tradeUnit, {
        title: '전자부품 Entity List 수출통제 개정',
        measureType: '수출통제',
        sourceUrl: 'https://example.com/trade-export',
      }),
      itemForUnit(tradeDomain, tradeUnit, {
        title: '전자부품 일반 관세율 개정',
        measureType: '관세율',
        sourceUrl: 'https://example.com/trade-customs',
      }),
      itemForUnit(tradeDomain, tradeUnit, {
        title: '전자부품 세이프가드 조사 개시',
        measureType: '세이프가드',
        sourceUrl: 'https://example.com/trade-wrong-unit',
      }),
    ],
  });
  const parsedTrade = parseDomainResponse(
    tradeDomain,
    tradeResponse,
    context,
    groundedParseOptions(tradeResponse, tradeUnit, { units: [tradeUnit] }),
  );
  assert.deepEqual(parsedTrade.categories.반덤핑.map((entry) => entry.title), ['전자부품 반덤핑 조사 개시']);
  assert.equal(parsedTrade.categoryStatus.반덤핑.rejectedReasons.domainBoundary, 2);
  assert.equal(parsedTrade.categoryStatus.반덤핑.rejectedReasons.unitScope, 3);
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

test('같은 사건의 상반된 조치와 서로 다른 판정 단계는 중복으로 합치지 않는다', () => {
  const context = createContext(now, 24);
  const exportDomain = domains.find((domain) => domain.key === 'export');
  const exportUnit = exportDomain.units.find((unit) => unit.key === '미국');
  const exportResponse = responseFor(exportDomain, [exportUnit], {
    미국: [
      itemForUnit(exportDomain, exportUnit, {
        measureType: 'Entity List',
        title: 'BIS Entity List 10개 기업 추가',
        sourceUrl: 'https://www.bis.gov/entity-list-update',
      }),
      itemForUnit(exportDomain, exportUnit, {
        measureType: 'Entity List',
        title: 'BIS Entity List 10개 기업 삭제',
        sourceUrl: 'https://www.bis.gov/entity-list-update',
      }),
    ],
  });
  const parsedExport = parseDomainResponse(
    exportDomain,
    exportResponse,
    context,
    groundedParseOptions(exportResponse, exportUnit, { units: [exportUnit] }),
  );
  assert.equal(parsedExport.categories.미국.length, 2);
  assert.equal(parsedExport.categoryStatus.미국.dedupedCount, 0);

  const tradeDomain = domains.find((domain) => domain.key === 'trade');
  const tradeUnit = tradeDomain.units.find((unit) => unit.key === '반덤핑');
  const tradeResponse = responseFor(tradeDomain, [tradeUnit], {
    반덤핑: [
      itemForUnit(tradeDomain, tradeUnit, {
        title: 'A-570-999 반덤핑 예비 판정',
        sourceUrl: 'https://www.usitc.gov/A-570-999',
      }),
      itemForUnit(tradeDomain, tradeUnit, {
        title: 'A-570-999 반덤핑 최종 판정',
        sourceUrl: 'https://www.usitc.gov/A-570-999',
      }),
    ],
  });
  const parsedTrade = parseDomainResponse(
    tradeDomain,
    tradeResponse,
    context,
    groundedParseOptions(tradeResponse, tradeUnit, { units: [tradeUnit] }),
  );
  assert.equal(parsedTrade.categories.반덤핑.length, 2);
  assert.equal(parsedTrade.categoryStatus.반덤핑.dedupedCount, 0);
});

test('mock 수집은 Claude 호출 없이 상태를 포함한 공통 payload를 만든다', async () => {
  const payload = await collectMonitoring({
    mockPath: fixture,
    now,
    lookbackHours: 24,
  });
  assert.equal(payload.version, 8);
  assert.equal(payload.collection.mode, 'mock');
  assert.equal(payload.collection.depth, 'standard');
  assert.equal(payload.collection.completedDomains, 3);
  assert.equal(payload.collection.fullyCompletedDomains, 3);
  assert.equal(payload.collection.completedCategories, 18);
  assert.equal(payload.stats.total, 2);
  assert.equal(payload.stats.high, 1);
  assert.equal(payload.results.customs.categories.북미[0].sourceUrl, 'https://ustr.gov/example');
  assert.equal(payload.results.customs.categories.북미[0].sourceVerification, 'grounded');
  assert.equal(payload.results.export.categories.미국[0].sourceUrl, 'https://www.bis.gov/example');
  assert.equal(payload.results.trade.categoryStatus.반덤핑.status, 'empty');
});

test('전체 조사는 영역 round-robin 순서로 실행하고 카테고리 규모별 검색 정책을 전달한다', async () => {
  const requested = [];
  let active = 0;
  let maxActive = 0;
  const callClaude = async (prompt, options) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
      const { domain, units } = promptDomainAndUnits(prompt);
      assert.equal(units.length, 1);
      const policy = researchPolicyForUnit(units[0]);
      assert.equal(
        options.minimumWebSearchSuccesses,
        policy.minimumSearchesPerCategory,
      );
      assert.equal(
        options.minimumOfficialSearches,
        policy.minimumOfficialSearches,
      );
      assert.equal(
        options.minimumBroadSearches,
        policy.minimumBroadSearches,
      );
      assert.equal(options.requireOfficialAndBroadSearch, true);
      assert.deepEqual(options.officialDomainAllowlist, units[0].officialDomains);
    requested.push(`${domain.key}:${units[0].key}`);
    await Promise.resolve();
    active -= 1;
    return searchedEnvelope(responseFor(domain, units));
  };

  const payload = await collectMonitoring({ callClaude, now, lookbackHours: 24 });
  const expectedExecutionOrder = Array.from({
    length: Math.max(...domains.map((domain) => domain.units.length)),
  }, (_, index) => domains
    .map((domain) => domain.units[index] ? `${domain.key}:${domain.units[index].key}` : null)
    .filter(Boolean)).flat();
  assert.deepEqual(requested, expectedExecutionOrder);
  assert.equal(maxActive, 1);
  assert.equal(payload.collection.totalCategories, 18);
  assert.equal(payload.collection.completedCategories, 18);
  assert.equal(payload.collection.scope, 'all');
  assert.deepEqual(payload.collection.requestedCategoryIds, categoryCatalog.map((entry) => entry.id));
  for (const domain of domains) {
    assert.equal(
      payload.results[domain.key].coverage.webSearchSuccesses,
      domain.units.reduce(
        (sum, unit) => sum + researchPolicyForUnit(unit).minimumSearchesPerCategory,
        0,
      ),
    );
  }
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
    }), { includeGroundingSearches: true });
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
  assert.ok(payload.results.customs.categories.북미[0].sourceEvidence.length > 0);
  assert.equal(
    payload.results.customs.categoryAudit.북미.searches.length,
    researchPolicyForUnit(domains[0].units[0]).minimumSearchesPerCategory,
  );
});

test('deadlineAt은 저장 여유와 남은 카테고리를 고려해 호출별 timeout을 동적으로 줄인다', async () => {
  const deadlineAt = Date.now() + 5 * 60 * 1000;
  let receivedTimeout = 0;
  const payload = await collectMonitoring({
    category: 'customs:북미',
    now,
    lookbackHours: 24,
    deadlineAt,
    callClaude: async (prompt, options) => {
      receivedTimeout = options.timeoutMs;
      const { domain, units } = promptDomainAndUnits(prompt);
      return searchedEnvelope(responseFor(domain, units));
    },
  });
  assert.ok(receivedTimeout >= 270000 && receivedTimeout <= 285000);
  assert.equal(payload.collection.completedCategories, 1);

  let calls = 0;
  const expired = await collectMonitoring({
    category: 'customs:북미',
    now,
    lookbackHours: 24,
    deadlineAt: Date.now() + 5000,
    callClaude: async () => {
      calls += 1;
      throw new Error('호출되면 안 됨');
    },
  });
  assert.equal(calls, 0);
  assert.equal(expired.failures[0].code, 'RUN_TIMEOUT');
});

test('한 카테고리의 최초 조사와 재조사는 동일한 총 시간 예산을 공유한다', async () => {
  let calls = 0;
  const startedAt = Date.now();
  const payload = await collectMonitoring({
    category: 'customs:북미',
    now,
    lookbackHours: 24,
    deadlineAt: Date.now() + 6500,
    callClaude: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 1600));
      throw new ClaudeCliError('BAD_OUTPUT', '늦게 반환된 손상 응답');
    },
  });
  assert.equal(calls, 1);
  assert.equal(payload.failures[0].code, 'TIMEOUT');
  assert.ok(Date.now() - startedAt < 3000);
});

test('그룹 선택은 해당 영역의 카테고리만 각각 조사하고 그룹 통계를 만든다', async () => {
  const cases = [
    { selector: 'CUSTOMS', domainKey: 'customs', count: 9 },
    { selector: '수출통제', domainKey: 'export', count: 6 },
    { selector: 'trade', domainKey: 'trade', count: 3 },
  ];
  for (const selected of cases) {
    const requested = [];
    const callClaude = async (prompt) => {
      const { domain, units } = promptDomainAndUnits(prompt);
      assert.equal(domain.key, selected.domainKey);
      assert.equal(units.length, 1);
      requested.push(`${domain.key}:${units[0].key}`);
      return searchedEnvelope(responseFor(domain, units));
    };
    const payload = await collectMonitoring({
      callClaude,
      group: selected.selector,
      now,
      lookbackHours: 24,
    });
    const expected = categoryCatalog
      .filter((entry) => entry.domainKey === selected.domainKey)
      .map((entry) => entry.id);
    assert.deepEqual(requested, expected);
    assert.equal(requested.length, selected.count);
    assert.equal(payload.collection.scope, 'group');
    assert.equal(payload.collection.selection.type, 'group');
    assert.equal(payload.collection.selection.id, selected.domainKey);
    assert.equal(payload.collection.selection.unitCount, selected.count);
    assert.deepEqual(payload.collection.requestedCategoryIds, expected);
    assert.equal(payload.collection.totalDomains, 1);
    assert.equal(payload.collection.completedDomains, 1);
    assert.equal(payload.collection.totalCategories, selected.count);
    assert.equal(payload.collection.completedCategories, selected.count);
    assert.deepEqual(Object.keys(payload.results), [selected.domainKey]);
    assert.deepEqual(Object.keys(payload.stats.byDomain), [selected.domainKey]);
  }
});

test('그룹 인사이트는 1000자 앞부분만 남기지 않고 모든 완료 카테고리를 균등하게 포함한다', async () => {
  const callClaude = async (prompt) => {
    const { domain, units } = promptDomainAndUnits(prompt);
    const [unit] = units;
    const response = responseFor(domain, units, {
      [unit.key]: [itemForUnit(domain, unit, {
        title: `${unit.key} 고유 조치`,
        sourceName: `${unit.key} 기관`,
        sourceUrl: `https://example.com/insight-${domain.units.indexOf(unit)}`,
      })],
    });
    response.insight = `${unit.key} 핵심 ` + '분석 '.repeat(300);
    return searchedEnvelope(response);
  };
  const payload = await collectMonitoring({
    callClaude,
    group: '관세',
    now,
    lookbackHours: 24,
  });
  assert.ok(payload.results.customs.insight.length <= 1000);
  for (const unit of domains[0].units) {
    assert.match(payload.results.customs.insight, new RegExp(`${unit.label}:`));
  }
});

test('그룹 일부 카테고리 실패는 나머지 결과를 보존하고 category·group 동시 지정은 거부한다', async () => {
  let calls = 0;
  const payload = await collectMonitoring({
    group: '무역구제',
    now,
    lookbackHours: 24,
    callClaude: async (prompt) => {
      calls += 1;
      const { domain, units } = promptDomainAndUnits(prompt);
      if (calls === 1) throw new ClaudeCliError('TIMEOUT', '그룹 일부 시간초과');
      return searchedEnvelope(responseFor(domain, units));
    },
  });
  assert.equal(calls, 3);
  assert.equal(payload.collection.scope, 'group');
  assert.equal(payload.collection.completedDomains, 1);
  assert.equal(payload.collection.fullyCompletedDomains, 0);
  assert.equal(payload.collection.completedCategories, 2);
  assert.equal(payload.failures.length, 1);
  assert.equal(payload.failures[0].categoryKey, '반덤핑');

  await assert.rejects(
    () => collectMonitoring({ category: 'customs:북미', group: '관세', now }),
    (error) => error.code === 'CONFIG' && /함께 사용할 수 없습니다/.test(error.message),
  );
  await assert.rejects(
    () => collectMonitoring({ groupSelection: {}, now }),
    /--group 뒤에 그룹/,
  );
  await assert.rejects(
    () => collectMonitoring({ group: '', now }),
    /--group 뒤에 그룹/,
  );
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
  let recoveryPrompt = '';
  const callClaude = async (prompt) => {
    const { domain, units } = promptDomainAndUnits(prompt);
    if (domain.key === 'customs' && units[0].key === '동아시아') {
      eastAsiaCalls += 1;
      if (eastAsiaCalls === 1) return searchedEnvelope(responseFor(domain, []));
      recoveryPrompt = prompt;
    }
    const categoryItems = units[0].key === '북미'
      ? { 북미: [item({ title: '보존할 북미 결과', sourceUrl: 'https://example.com/preserved' })] }
      : {};
    return searchedEnvelope(responseFor(domain, units, categoryItems));
  };

  const payload = await collectMonitoring({ callClaude, now, lookbackHours: 24 });
  assert.equal(eastAsiaCalls, 2);
  assert.match(recoveryPrompt, /이전 조사 오류 교정 지침/);
  assert.match(recoveryPrompt, /단일 JSON 객체/);
  assert.equal(payload.results.customs.categories.북미[0].title, '보존할 북미 결과');
  assert.equal(payload.results.customs.categoryStatus.북미.coverage, 'full');
  assert.equal(payload.results.customs.categoryStatus.동아시아.coverage, 'fallback');
  assert.equal(payload.results.customs.coverage.complete, true);
});

test('재조사 프롬프트는 실제 rejectedReasons의 카테고리 소속 오류를 구체적으로 교정한다', async () => {
  let calls = 0;
  let recoveryPrompt = '';
  const callClaude = async (prompt) => {
    calls += 1;
    const { domain, units } = promptDomainAndUnits(prompt);
    if (calls === 1) {
      const invalidResponse = responseFor(domain, units, {
        북미: [item({
          measureType: '규정 개정',
          title: '중국 전자부품 규정 개정',
          issuingCountry: '중국',
          agency: '중국 기관',
          sourceName: '중국 기관',
          sourceUrl: 'https://agency.gov/wrong-unit',
        })],
      });
      return searchedEnvelope(invalidResponse);
    }
    recoveryPrompt = prompt;
    return searchedEnvelope(responseFor(domain, units));
  };

  const payload = await collectMonitoring({
    callClaude,
    category: 'customs:북미',
    now,
    lookbackHours: 24,
  });
  assert.equal(calls, 2);
  assert.match(recoveryPrompt, /issuingCountry·agency·measureType/);
  assert.match(recoveryPrompt, /이전 탈락 1건/);
  assert.equal(payload.results.customs.categoryStatus.북미.status, 'empty');
  assert.equal(payload.results.customs.categoryStatus.북미.coverage, 'fallback');
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
        itemForUnit(domain, units[0], {
          title: '미국 전자부품 수출 제한 조치',
          measureType: '수출통제',
          summary: '짧은 설명',
          titleEn: '',
          businessImpact: '',
          sourceUrl: 'https://agency.gov/event-1',
        }),
        itemForUnit(domain, units[0], {
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
        itemForUnit(domain, units[0], {
          title: '공식 규제 포털 7월 28일 공지',
          announcedDate: '2026-07-28',
          sourceUrl: 'https://agency.gov/notices',
        }),
        itemForUnit(domain, units[0], {
          title: '공식 규제 포털 7월 29일 공지',
          announcedDate: '2026-07-29',
          sourceUrl: 'https://agency.gov/notices',
        }),
        itemForUnit(domain, units[0], {
          title: '같은 날 별도 철강 조치 발표',
          measureType: '철강 수출통제',
          announcedDate: '2026-07-29',
          sourceUrl: 'https://agency.gov/notices',
        }),
        itemForUnit(domain, units[0], {
          title: '전자부품 규정 개정',
          issuingCountry: '미국',
          agency: '미국 기관',
          sourceUrl: 'https://us.example.com/rule',
        }),
        itemForUnit(domain, units[0], {
          title: '전자부품 규정 개정',
          issuingCountry: '미국',
          agency: 'OFAC',
          sourceUrl: 'https://ca.example.com/rule',
        }),
      ];
    }
    return searchedEnvelope(responseFor(domain, units, categoryItems));
  };

  const payload = await collectMonitoring({ callClaude, now, lookbackHours: 24 });
  assert.equal(payload.results.export.categories.미국.length, 5);
});

test('기관 alias와 강한 사건번호가 같으면 발표일 ±1일 후보를 보수적으로 합친다', async () => {
  const callClaude = async (prompt) => {
    const { domain, units } = promptDomainAndUnits(prompt);
    const response = responseFor(domain, units, {
      미국: [
        itemForUnit(domain, units[0], {
          title: 'Case A-570-999 예비 공지',
          announcedDate: '2026-07-28',
          agency: 'BIS',
          sourceName: 'BIS',
          sourceUrl: 'https://bis.gov/case-summary',
        }),
        itemForUnit(domain, units[0], {
          title: 'A-570-999 공식 발표',
          announcedDate: '2026-07-29',
          agency: 'Bureau of Industry and Security',
          sourceName: 'BIS',
          sourceUrl: 'https://bis.gov/case-detail',
        }),
      ],
    });
    return searchedEnvelope(response);
  };
  const payload = await collectMonitoring({
    callClaude,
    category: 'export:미국',
    now,
    lookbackHours: 24,
  });
  assert.equal(payload.results.export.categories.미국.length, 1);
  assert.equal(payload.results.export.categoryStatus.미국.dedupedCount, 1);
});

test('같은 사안의 중복 후보에서는 출처 검증과 정보 품질을 중요도보다 우선한다', async () => {
  const callClaude = async (prompt) => {
    const { domain, units } = promptDomainAndUnits(prompt);
    const categoryItems = {};
    if (domain.key === 'export') {
      categoryItems.미국 = [
        itemForUnit(domain, units[0], {
          importance: '상',
          title: '반도체 장비 수출통제 개정',
          summary: '핵심 조치입니다.',
          titleEn: '',
          businessImpact: '',
          notes: '',
          sourceUrl: 'https://agency.gov/export-rule',
        }),
        itemForUnit(domain, units[0], {
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
  assert.equal(payload.results.export.categories.미국[0].importance, '중');
  assert.match(payload.results.export.categories.미국[0].summary, /상세하게/);
  assert.equal(payload.results.export.categories.한국.length, 0);
});

test('전체 후보를 중복 제거한 뒤 표시 한도를 적용해 숨은 후보를 승격하고 내부 후보는 노출하지 않는다', async () => {
  const agencyNames = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
  const customsCandidates = [
    item({
      importance: '상',
      measureType: '규정 개정',
      title: '미국 전자부품 규정 개정',
      agency: 'BIS',
      sourceName: 'BIS',
      sourceUrl: 'https://agency.gov/common-rule',
    }),
    ...agencyNames.map((name, index) => item({
      importance: index === agencyNames.length - 1 ? '하' : '중',
      measureType: `신고 서식 ${name}`,
      title: index === agencyNames.length - 1
        ? '표시 한도 뒤 승격 후보'
        : `전자부품 신고 절차 ${name}`,
      agency: `Customs ${name}`,
      sourceName: `Customs ${name}`,
      sourceUrl: `https://agency.gov/customs-${name}`,
    })),
  ];
  const callClaude = async (prompt) => {
    const { domain, units } = promptDomainAndUnits(prompt);
    const unit = units[0];
    const categoryItems = {};
    if (domain.key === 'customs' && unit.key === '북미') {
      categoryItems.북미 = customsCandidates;
    }
    if (domain.key === 'export' && unit.key === '미국') {
      categoryItems.미국 = [itemForUnit(domain, unit, {
        importance: '상',
        measureType: '규정 개정',
        title: '미국 전자부품 규정 개정',
        agency: 'BIS',
        sourceName: 'BIS',
        sourceUrl: 'https://agency.gov/common-rule',
      })];
    }
    return searchedEnvelope(responseFor(domain, units, categoryItems));
  };

  const payload = await collectMonitoring({ callClaude, now, lookbackHours: 24 });
  const customsItems = payload.results.customs.categories.북미;
  assert.equal(customsItems.length, researchPolicyForUnit(domains[0].units[0]).maximumItemsPerCategory);
  assert.ok(customsItems.some((entry) => entry.title === '표시 한도 뒤 승격 후보'));
  assert.equal(payload.results.customs.categoryStatus.북미.crossDomainDedupedCount, 1);
  assert.equal(payload.results.customs.categoryStatus.북미.truncatedCount, 0);
  assert.ok(Object.values(payload.results).every((result) => !Object.hasOwn(result, 'categoryCandidates')));
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
