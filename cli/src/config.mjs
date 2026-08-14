const PRODUCT_SCOPE = [
  '스마트폰, 태블릿, 스마트워치, 이어폰, TV, 모니터, 사운드바',
  '냉장고, 세탁기, 에어컨, 오븐, 청소기, 식기세척기',
  '의료기기, 네트워크 장비, 전자제품 부품, 반도체, AI 관련 품목',
  '철강, 알루미늄, 플라스틱 등 전자·가전 관련 자재',
].join(', ');

export const RESEARCH_DEPTHS = Object.freeze(['fast', 'standard', 'deep']);

const DEPTH_POLICY = Object.freeze({
  fast: Object.freeze({
    minimumOfficialSearches: 2,
    minimumBroadSearches: 2,
    officialTargetsPerSearch: 6,
    broadTargetsPerSearch: 8,
    maximumOfficialSearches: 4,
    maximumBroadSearches: 3,
    baseMaximumItems: 6,
    itemsPerTarget: 0.5,
    maximumItemsCeiling: 12,
  }),
  standard: Object.freeze({
    minimumOfficialSearches: 3,
    minimumBroadSearches: 3,
    officialTargetsPerSearch: 2,
    broadTargetsPerSearch: 3,
    maximumOfficialSearches: 8,
    maximumBroadSearches: 6,
    baseMaximumItems: 8,
    itemsPerTarget: 1,
    maximumItemsCeiling: 20,
  }),
  deep: Object.freeze({
    minimumOfficialSearches: 4,
    minimumBroadSearches: 4,
    officialTargetsPerSearch: 2,
    broadTargetsPerSearch: 3,
    maximumOfficialSearches: 10,
    maximumBroadSearches: 8,
    baseMaximumItems: 12,
    itemsPerTarget: 1.5,
    maximumItemsCeiling: 30,
  }),
});

// 이전 사용처를 위한 기본값이다. 실제 카테고리별 값은 researchPolicyForUnit()을 사용한다.
export const CATEGORY_RESEARCH_POLICY = Object.freeze({
  defaultDepth: 'standard',
  minimumOfficialSearches: DEPTH_POLICY.standard.minimumOfficialSearches,
  minimumBroadSearches: DEPTH_POLICY.standard.minimumBroadSearches,
  minimumSearchesPerCategory:
    DEPTH_POLICY.standard.minimumOfficialSearches
    + DEPTH_POLICY.standard.minimumBroadSearches,
  maximumItemsPerCategory: DEPTH_POLICY.standard.maximumItemsCeiling,
});

export function resolveResearchDepth(value = CATEGORY_RESEARCH_POLICY.defaultDepth) {
  const depth = String(value || '').trim().toLocaleLowerCase('en-US');
  if (!RESEARCH_DEPTHS.includes(depth)) {
    throw new Error(`조사 깊이는 ${RESEARCH_DEPTHS.join(', ')} 중 하나여야 합니다.`);
  }
  return depth;
}

export function researchPolicyForUnit(unit, depthValue = CATEGORY_RESEARCH_POLICY.defaultDepth) {
  const depth = resolveResearchDepth(depthValue);
  const base = DEPTH_POLICY[depth];
  const targetCount = Array.isArray(unit?.coverageTargets) ? unit.coverageTargets.length : 0;
  if (targetCount < 1 || !Array.isArray(unit?.queryTerms) || unit.queryTerms.length < 1) {
    throw new Error(`${unit?.key || '카테고리'}의 조사 대상 또는 검색어 설정이 비어 있습니다.`);
  }
  const minimumOfficialSearches = Math.min(
    base.maximumOfficialSearches,
    Math.max(base.minimumOfficialSearches, Math.ceil(targetCount / base.officialTargetsPerSearch)),
  );
  const minimumBroadSearches = Math.min(
    base.maximumBroadSearches,
    Math.max(base.minimumBroadSearches, Math.ceil(targetCount / base.broadTargetsPerSearch)),
  );
  const maximumItemsPerCategory = Math.min(
    base.maximumItemsCeiling,
    Math.ceil(base.baseMaximumItems + targetCount * base.itemsPerTarget),
  );
  return Object.freeze({
    depth,
    targetCount,
    minimumOfficialSearches,
    minimumBroadSearches,
    minimumSearchesPerCategory: minimumOfficialSearches + minimumBroadSearches,
    maximumItemsPerCategory,
    officialTargetsPerSearch: base.officialTargetsPerSearch,
  });
}

const COMMON_RULES = `
[공통 정확성 규칙]
- 반드시 선택된 CLI의 내장 웹 검색 도구를 사용해 최신 정보를 확인한다.
- 정부·국제기구의 원문, 관보, 신뢰도 높은 주요 언론만 사용한다.
- 발표일은 시행일이나 재게시일이 아니라 해당 조치가 최초 공표된 날짜다.
- 발표일 또는 원문을 확인할 수 없으면 포함하지 않는다. URL을 추측하지 않는다.
- 루머, 전망, 단순 의견, SNS, 동일 사안의 중복 보도를 제외한다.
- 농수산물(HS 01~24)은 제외하되 전 산업에 구조적 영향이 큰 사안은 허용한다.
- 기업 영향은 사실에서 직접 도출되는 범위만 쓰고 과장하지 않는다.
- 우선 품목: ${PRODUCT_SCOPE}
`;

const ITEM_SCHEMA = `{
  "importance": "상|중|하",
  "importanceReason": "중요도 판단 근거 1문장",
  "measureType": "관세율|HS|FTA/원산지|통관|수출통제|제재|AD|SG|CVD 등 조치 유형",
  "title": "간결한 한국어 제목",
  "titleEn": "영문 제목 또는 검색어",
  "summary": "핵심 조치·수치·일정을 담은 한국어 2~3문장",
  "businessImpact": "전자·가전·부품 기업 관점의 영향 1문장, 없으면 빈 문자열",
  "announcedDate": "YYYY-MM-DD",
  "announcedAt": "원문에서 확인한 발표시각(시간대 포함 ISO 8601) 또는 빈 문자열",
  "effectiveDate": "YYYY-MM-DD 또는 빈 문자열",
  "hsCode": "관련 HS 코드 또는 빈 문자열",
  "issuingCountry": "발표 주체 국가 또는 기구",
  "targetCountries": "대상·영향 국가",
  "agency": "발표 기관",
  "sourceName": "원문 기관 또는 매체명",
  "sourceUrl": "확인한 HTTPS 원문 URL(필수, 없으면 항목 자체 제외)",
  "notes": "적용 범위 등 확실한 추가 정보 또는 빈 문자열"
}`;

const customsUnits = [
  ['북미', '미국, 캐나다'],
  ['중남미', '멕시코, 브라질, 콜롬비아, 페루, 아르헨티나, 칠레, 파나마'],
  ['인도', '인도'],
  ['유럽', '영국, EU 및 회원국'],
  ['중동', '이집트, 사우디아라비아, UAE, 모로코, 튀니지, 요르단, 알제리, 튀르키예, 파키스탄, 이스라엘, 이라크'],
  ['동남아/오세아니아', '인도네시아, 말레이시아, 태국, 베트남, 필리핀, 싱가포르, 호주, 뉴질랜드'],
  ['아프리카', '남아프리카공화국, 나이지리아, 케냐'],
  ['CIS', '러시아, 카자흐스탄, 우즈베키스탄'],
  ['동아시아', '중국, 한국, 일본, 대만, 홍콩'],
];

const exportUnits = [
  ['미국', 'BIS, OFAC, DDTC, 백악관, DOJ'],
  ['한국', '산업통상부, 무역안보관리원, 관세청, 한국무역협회(KITA), 국가정보원 등'],
  ['EU/일본', 'European Commission, Council of the EU, 일본 METI'],
  ['중국/베트남', '중국 MOFCOM·국무원·MIIT·해관, 베트남 산업무역부·세관'],
  ['영국/캐나다/호주/인도', '영국 DBT·OFSI, 캐나다 Global Affairs, 호주 DFAT, 인도 DGFT'],
  ['UN 및 다자체제', 'UN 안보리, Wassenaar, NSG, MTCR, Australia Group'],
];

const tradeUnits = [
  ['반덤핑', 'Anti-Dumping 조사 개시·예비/최종 판정·재심·종료'],
  ['세이프가드', 'Safeguard 조사·잠정/최종 조치·연장·종료'],
  ['보조금/상계관세', 'Subsidies 및 Countervailing Duties 조사·판정·재심'],
];

function coverageTarget(label, aliases = []) {
  return Object.freeze({
    label,
    aliases: Object.freeze([...new Set([label, ...aliases])]),
  });
}

const coverageTargetCatalog = {
  customs: {
    북미: [coverageTarget('미국', ['United States', 'U.S.', 'US', 'USA']), coverageTarget('캐나다', ['Canada'])],
    중남미: [
      coverageTarget('멕시코', ['Mexico']), coverageTarget('브라질', ['Brazil']),
      coverageTarget('콜롬비아', ['Colombia']), coverageTarget('페루', ['Peru']),
      coverageTarget('아르헨티나', ['Argentina']), coverageTarget('칠레', ['Chile']),
      coverageTarget('파나마', ['Panama']),
    ],
    인도: [coverageTarget('인도', ['India'])],
    유럽: [
      coverageTarget('EU', ['European Union', '유럽연합']),
      coverageTarget('영국', ['United Kingdom', 'UK']),
    ],
    중동: [
      coverageTarget('이집트', ['Egypt']), coverageTarget('사우디아라비아', ['Saudi Arabia']),
      coverageTarget('UAE', ['United Arab Emirates', '아랍에미리트']),
      coverageTarget('모로코', ['Morocco']), coverageTarget('튀니지', ['Tunisia']),
      coverageTarget('요르단', ['Jordan']), coverageTarget('알제리', ['Algeria']),
      coverageTarget('튀르키예', ['Turkey', 'Türkiye']), coverageTarget('파키스탄', ['Pakistan']),
      coverageTarget('이스라엘', ['Israel']), coverageTarget('이라크', ['Iraq']),
    ],
    '동남아/오세아니아': [
      coverageTarget('인도네시아', ['Indonesia']), coverageTarget('말레이시아', ['Malaysia']),
      coverageTarget('태국', ['Thailand']), coverageTarget('베트남', ['Vietnam']),
      coverageTarget('필리핀', ['Philippines']), coverageTarget('싱가포르', ['Singapore']),
      coverageTarget('호주', ['Australia']), coverageTarget('뉴질랜드', ['New Zealand']),
    ],
    아프리카: [
      coverageTarget('남아프리카공화국', ['South Africa']),
      coverageTarget('나이지리아', ['Nigeria']), coverageTarget('케냐', ['Kenya']),
    ],
    CIS: [
      coverageTarget('러시아', ['Russia']), coverageTarget('카자흐스탄', ['Kazakhstan']),
      coverageTarget('우즈베키스탄', ['Uzbekistan']),
    ],
    동아시아: [
      coverageTarget('중국', ['China']), coverageTarget('한국', ['Korea']),
      coverageTarget('일본', ['Japan']), coverageTarget('대만', ['Taiwan']),
      coverageTarget('홍콩', ['Hong Kong']),
    ],
  },
  export: {
    미국: [
      coverageTarget('BIS', ['Bureau of Industry and Security']),
      coverageTarget('OFAC', ['Office of Foreign Assets Control']),
      coverageTarget('DDTC', ['Directorate of Defense Trade Controls']),
      coverageTarget('백악관', ['White House']), coverageTarget('DOJ', ['Department of Justice']),
    ],
    한국: [
      coverageTarget('산업통상부', ['산업통상자원부', 'MOTIE', 'MOTIR']),
      coverageTarget('무역안보관리원', ['KOSTI']), coverageTarget('관세청', ['Korea Customs Service']),
      coverageTarget('한국무역협회', ['KITA']),
    ],
    'EU/일본': [
      coverageTarget('EU', ['European Union', 'European Commission', 'Council of the EU']),
      coverageTarget('일본', ['Japan', 'METI']),
    ],
    '중국/베트남': [
      coverageTarget('중국', ['China', 'MOFCOM', 'MIIT']),
      coverageTarget('베트남', ['Vietnam']),
    ],
    '영국/캐나다/호주/인도': [
      coverageTarget('영국', ['United Kingdom', 'UK', 'DBT', 'OFSI']),
      coverageTarget('캐나다', ['Canada', 'Global Affairs Canada']),
      coverageTarget('호주', ['Australia', 'DFAT']), coverageTarget('인도', ['India', 'DGFT']),
    ],
    'UN 및 다자체제': [
      coverageTarget('UN', ['United Nations', 'UN Security Council']),
      coverageTarget('Wassenaar', ['Wassenaar Arrangement']), coverageTarget('NSG', ['Nuclear Suppliers Group']),
      coverageTarget('MTCR', ['Missile Technology Control Regime']),
      coverageTarget('Australia Group', ['AG', '호주그룹']),
    ],
  },
  trade: {
    반덤핑: [
      coverageTarget('미국', ['United States', 'U.S.', 'US', 'USA', 'USITC', 'ITA']),
      coverageTarget('EU', ['European Union', 'European Commission']),
      coverageTarget('중국', ['China', 'MOFCOM']), coverageTarget('인도', ['India', 'DGTR']),
      coverageTarget('한국·일본', ['Korea Japan', '한국 일본']),
      coverageTarget('WTO 회원국', ['WTO', 'WTO members', 'global anti-dumping']),
    ],
    세이프가드: [
      coverageTarget('미국', ['United States', 'U.S.', 'US', 'USA', 'USITC']),
      coverageTarget('EU', ['European Union', 'European Commission']),
      coverageTarget('아시아 주요국', ['Asia', 'Asia India Indonesia Philippines']),
      coverageTarget('중남미 주요국', ['Latin America', 'Latin America Brazil Mexico']),
      coverageTarget('WTO 회원국', ['WTO', 'WTO members', 'global safeguard']),
    ],
    '보조금/상계관세': [
      coverageTarget('미국', ['United States', 'U.S.', 'US', 'USA', 'USITC', 'ITA']),
      coverageTarget('EU', ['European Union', 'European Commission']),
      coverageTarget('중국', ['China', 'MOFCOM']), coverageTarget('인도', ['India', 'DGTR']),
      coverageTarget('한국·일본', ['Korea Japan', '한국 일본']),
      coverageTarget('WTO 회원국', ['WTO', 'WTO members', 'global countervailing']),
    ],
  },
};

function flattenedCoverageAliases(targets) {
  return [...new Set((targets || []).flatMap((target) => target.aliases || [target.label]))];
}

// 응답 항목이 실제로 선택 카테고리에 속하는지 런타임에서 확인할 때 사용한다.
// 검색 coverage target은 검색 분산을 위한 단위이고, item scope는 결과 필드 판정 단위다.
const itemScopeCatalog = {
  customs: Object.fromEntries(Object.entries(coverageTargetCatalog.customs).map(([key, targets]) => [
    key,
    {
      fields: ['issuingCountry'],
      aliases: flattenedCoverageAliases(targets),
    },
  ])),
  export: {
    미국: {
      fields: ['issuingCountry', 'agency'],
      aliases: ['미국', 'United States', 'U.S.', 'US', 'USA', 'BIS', 'OFAC', 'DDTC', 'White House', '백악관', 'DOJ'],
    },
    한국: {
      fields: ['issuingCountry', 'agency'],
      aliases: ['한국', '대한민국', 'Republic of Korea', 'South Korea', 'Korea', 'MOTIE', 'MOTIR', 'KOSTI', '관세청', 'KITA'],
    },
    'EU/일본': {
      fields: ['issuingCountry', 'agency'],
      aliases: ['EU', 'European Union', 'European Commission', 'Council of the EU', '일본', 'Japan', 'METI'],
    },
    '중국/베트남': {
      fields: ['issuingCountry', 'agency'],
      aliases: ['중국', 'China', 'PRC', 'MOFCOM', 'MIIT', '베트남', 'Vietnam'],
    },
    '영국/캐나다/호주/인도': {
      fields: ['issuingCountry', 'agency'],
      aliases: [
        '영국', 'United Kingdom', 'UK', 'DBT', 'OFSI',
        '캐나다', 'Canada', 'Global Affairs Canada',
        '호주', 'Australia', 'DFAT',
        '인도', 'India', 'DGFT',
      ],
    },
    'UN 및 다자체제': {
      fields: ['issuingCountry', 'agency'],
      aliases: [
        'UN', 'United Nations', 'Wassenaar', 'Wassenaar Arrangement', 'NSG',
        'Nuclear Suppliers Group', 'MTCR', 'Australia Group', 'AG', '호주그룹',
      ],
    },
  },
  trade: {
    반덤핑: {
      fields: ['measureType', 'title', 'titleEn'],
      aliases: ['반덤핑', 'anti-dumping', 'antidumping', 'AD'],
    },
    세이프가드: {
      fields: ['measureType', 'title', 'titleEn'],
      aliases: ['세이프가드', 'safeguard', 'SG'],
    },
    '보조금/상계관세': {
      fields: ['measureType', 'title', 'titleEn'],
      aliases: ['보조금', '상계관세', 'countervailing duty', 'countervailing', 'CVD', 'subsidy', 'subsidies'],
    },
  },
};

const queryTermCatalog = {
  customs: {
    북미: ['tariff customs notice', 'HTSUS CBP customs tariff', 'Canada customs tariff'],
    중남미: ['arancel aduana comercio exterior', 'tarifa importación electrónica', 'customs tariff Latin America'],
    인도: ['customs tariff notification India', 'DGFT import policy', 'CBIC customs electronics'],
    유럽: ['EU customs tariff regulation', 'UK customs notice', 'rules of origin customs Europe'],
    중동: ['customs tariff Middle East', 'import regulation electronics', 'GCC customs notice'],
    '동남아/오세아니아': ['ASEAN customs tariff', 'Oceania customs notice', 'import regulation electronics Asia Pacific'],
    아프리카: ['Africa customs tariff', 'import levy customs notice', 'electronics import regulation'],
    CIS: ['EAEU customs tariff', 'CIS import regulation', 'customs classification electronics'],
    동아시아: ['East Asia customs tariff', 'HS classification electronics', 'customs import regulation'],
  },
  export: {
    미국: ['EAR export controls', 'Entity List BIS', 'OFAC sanctions', 'ITAR DDTC'],
    한국: ['전략물자 수출통제', '무역안보 고시', '대외무역법 제재'],
    'EU/일본': ['EU dual-use sanctions', 'Japan METI export control', 'catch-all control'],
    '중국/베트남': ['China export control MOFCOM', 'critical minerals export licensing', 'Vietnam export control'],
    '영국/캐나다/호주/인도': ['export control sanctions', 'dual-use licensing', 'strategic goods control'],
    'UN 및 다자체제': ['multilateral export control list', 'UN sanctions committee', 'control regime plenary'],
  },
  trade: {
    반덤핑: ['anti-dumping initiation', 'preliminary final determination', 'sunset administrative review'],
    세이프가드: ['safeguard investigation', 'provisional definitive measure', 'WTO safeguard notification'],
    '보조금/상계관세': ['countervailing duty investigation', 'subsidy determination', 'CVD review'],
  },
};

const tradeRemedyOfficialDomains = [
  'wto.org', 'trade.gov', 'usitc.gov', 'federalregister.gov', 'europa.eu',
  'gov.uk', 'canada.ca', 'gc.ca', 'gov.in', 'gov.cn', 'go.kr', 'go.jp',
  'gov.au', 'govt.nz', 'gov.br', 'gob.mx', 'gov.za',
];

const officialDomainCatalog = {
  customs: {
    북미: [
      'cbp.gov', 'ustr.gov', 'whitehouse.gov', 'usitc.gov', 'federalregister.gov',
      'commerce.gov', 'trade.gov', 'regulations.gov', 'govinfo.gov', 'congress.gov',
      'treasury.gov', 'canada.ca', 'gc.ca',
    ],
    중남미: ['gob.mx', 'gov.br', 'gov.co', 'gob.pe', 'gob.ar', 'gob.cl', 'aduana.cl', 'gob.pa'],
    인도: ['gov.in', 'nic.in'],
    유럽: ['europa.eu', 'gov.uk', 'gouv.fr', 'bund.de', 'gob.es', 'overheid.nl'],
    중동: ['gov.sa', 'gov.ae', 'gov.eg', 'gov.ma', 'gov.tn', 'gov.jo', 'gov.dz', 'gov.tr', 'gov.pk', 'gov.il', 'gov.iq'],
    '동남아/오세아니아': ['go.id', 'gov.my', 'go.th', 'gov.vn', 'gov.ph', 'gov.sg', 'gov.au', 'govt.nz'],
    아프리카: ['gov.za', 'gov.ng', 'go.ke'],
    CIS: ['gov.ru', 'gov.kz', 'gov.uz'],
    동아시아: ['gov.cn', 'go.kr', 'go.jp', 'gov.tw', 'gov.hk'],
  },
  export: {
    미국: ['bis.gov', 'treasury.gov', 'state.gov', 'whitehouse.gov', 'justice.gov', 'federalregister.gov'],
    한국: ['motir.go.kr', 'motie.go.kr', 'mofa.go.kr', 'customs.go.kr', 'kosti.or.kr', 'kita.net'],
    'EU/일본': ['europa.eu', 'consilium.europa.eu', 'go.jp'],
    '중국/베트남': ['gov.cn', 'mofcom.gov.cn', 'miit.gov.cn', 'customs.gov.cn', 'gov.vn'],
    '영국/캐나다/호주/인도': ['gov.uk', 'canada.ca', 'gc.ca', 'gov.au', 'gov.in', 'nic.in'],
    'UN 및 다자체제': ['un.org', 'wassenaar.org', 'nuclearsuppliersgroup.org', 'mtcr.info', 'australiagroup.net'],
  },
  trade: {
    반덤핑: tradeRemedyOfficialDomains,
    세이프가드: tradeRemedyOfficialDomains,
    '보조금/상계관세': tradeRemedyOfficialDomains,
  },
};

export const OFFICIAL_SOURCES_REVIEWED_AT = '2026-08-10';
export const OFFICIAL_SOURCE_TIERS = Object.freeze([
  'government',
  'intergovernmental',
  'trusted-association',
]);

const INTERGOVERNMENTAL_DOMAINS = new Set([
  'wto.org', 'un.org', 'europa.eu', 'consilium.europa.eu', 'wassenaar.org',
  'nuclearsuppliersgroup.org', 'mtcr.info', 'australiagroup.net',
]);
const TRUSTED_ASSOCIATION_DOMAINS = new Set(['kita.net', 'kosti.or.kr']);

function officialSourceTier(hostname) {
  if (TRUSTED_ASSOCIATION_DOMAINS.has(hostname)) return 'trusted-association';
  if (INTERGOVERNMENTAL_DOMAINS.has(hostname)) return 'intergovernmental';
  return 'government';
}

export function validateOfficialSources(sources, label = '공식 출처') {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error(`${label} 목록이 비어 있습니다.`);
  }
  const seen = new Set();
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error(`${label} 메타데이터 형식이 올바르지 않습니다.`);
    }
    const hostname = String(source.hostname || '').trim().toLocaleLowerCase('en-US');
    if (!isTrustedOfficialDomain(hostname, [hostname])) {
      throw new Error(`${label} hostname 형식이 올바르지 않습니다: ${hostname || '(빈 값)'}`);
    }
    if (seen.has(hostname)) throw new Error(`${label} hostname이 중복되었습니다: ${hostname}`);
    seen.add(hostname);
    if (!OFFICIAL_SOURCE_TIERS.includes(source.sourceTier)) {
      throw new Error(`${label} sourceTier가 올바르지 않습니다: ${hostname}`);
    }
    const lastReviewed = String(source.lastReviewed || '');
    const reviewedDate = /^\d{4}-\d{2}-\d{2}$/.test(lastReviewed)
      ? new Date(`${lastReviewed}T00:00:00Z`)
      : null;
    if (!reviewedDate || Number.isNaN(reviewedDate.getTime())
      || reviewedDate.toISOString().slice(0, 10) !== lastReviewed) {
      throw new Error(`${label} lastReviewed가 누락되었거나 올바르지 않습니다: ${hostname}`);
    }
  }
  return true;
}

function units(rows, domainKey) {
  return rows.map(([key, description]) => {
    const officialDomains = officialDomainCatalog[domainKey]?.[key];
    const coverageTargets = coverageTargetCatalog[domainKey]?.[key];
    const queryTerms = queryTermCatalog[domainKey]?.[key];
    const itemScope = itemScopeCatalog[domainKey]?.[key];
    const officialSources = Array.isArray(officialDomains)
      ? officialDomains.map((hostname) => Object.freeze({
        hostname,
        sourceTier: officialSourceTier(hostname),
        lastReviewed: OFFICIAL_SOURCES_REVIEWED_AT,
      }))
      : [];
    validateOfficialSources(officialSources, `${domainKey}:${key}의 공식 출처`);
    if (!Array.isArray(coverageTargets) || coverageTargets.length === 0) {
      throw new Error(`${domainKey}:${key}의 조사 대상 목록이 비어 있습니다.`);
    }
    if (!Array.isArray(queryTerms) || queryTerms.length === 0) {
      throw new Error(`${domainKey}:${key}의 검색어 목록이 비어 있습니다.`);
    }
    if (
      !itemScope
      || !Array.isArray(itemScope.fields)
      || itemScope.fields.length === 0
      || !Array.isArray(itemScope.aliases)
      || itemScope.aliases.length === 0
    ) {
      throw new Error(`${domainKey}:${key}의 항목 소속 판정 설정이 비어 있습니다.`);
    }
    return {
      key,
      label: key,
      description,
      officialDomains: Object.freeze([...officialDomains]),
      officialSources: Object.freeze(officialSources),
      lastReviewed: OFFICIAL_SOURCES_REVIEWED_AT,
      coverageTargets: Object.freeze([...coverageTargets]),
      queryTerms: Object.freeze([...queryTerms]),
      itemScope: Object.freeze({
        fields: Object.freeze([...itemScope.fields]),
        aliases: Object.freeze([...new Set(itemScope.aliases)]),
      }),
    };
  });
}

export const domains = [
  {
    key: 'customs',
    label: '관세',
    color: '#1a4d8f',
    softColor: '#eaf1fa',
    palette: Object.freeze({
      band: '#13335f',
      catBg: '#eaf1fa',
      catBorder: '#1a4d8f',
      catText: '#15406f',
      chip: '#1a4d8f',
    }),
    units: units(customsUnits, 'customs'),
    scope: `
[관세 영역]
- 포함: 일반 관세율, HS 분류, FTA·원산지, 과세가격, 통관절차, 일반 수입 인허가·기술인증·검역.
- 제외: 반덤핑·세이프가드·상계관세는 무역구제 영역, 전략물자·제재·EAR·Entity List는 수출통제 영역.
- 중요도 상: 법령 개정, 즉시 적용 또는 광범위한 비용·통관 영향. 중: 준비·모니터링 필요. 하: 참고 동향.
`,
  },
  {
    key: 'export',
    label: '수출통제',
    color: '#9c2a2a',
    softColor: '#fbeded',
    palette: Object.freeze({
      band: '#7a1f1f',
      catBg: '#fbeded',
      catBorder: '#9c2a2a',
      catText: '#8a2424',
      chip: '#9c2a2a',
    }),
    units: units(exportUnits, 'export'),
    scope: `
[수출통제 영역]
- 포함: 전략물자·이중용도 통제, 경제제재, Entity List·SDN, EAR·ITAR, 수출허가·캐치올, 다자 수출통제체제.
- 제외: 일반 관세·HS·FTA·통관은 관세 영역, AD·SG·CVD는 무역구제 영역.
- 특히 한국 기업 직접 거명, 반도체·AI 통제, 중국 핵심광물, 한국 법령 개정을 우선한다.
- 중요도 상: 한국 기업·공급망에 즉각적이고 직접적인 영향. 중: 준수 준비 필요. 하: 참고 동향.
`,
  },
  {
    key: 'trade',
    label: '무역구제',
    color: '#1e7045',
    softColor: '#e9f4ee',
    palette: Object.freeze({
      band: '#1b5e3b',
      catBg: '#e9f4ee',
      catBorder: '#1e7045',
      catText: '#1a5e3a',
      chip: '#1e7045',
    }),
    units: units(tradeUnits, 'trade'),
    scope: `
[무역구제 영역]
- 포함: 반덤핑(AD), 세이프가드(SG), 보조금·상계관세(CVD)의 조사 개시, 예비·최종 판정, 관세 부과, 재심, 연장·종료.
- 제외: 일반 관세·HS·FTA·통관은 관세 영역, 전략물자·제재·수출허가는 수출통제 영역.
- 중요도 상: 실제 관세율·적용 품목·대상 기업에 직접 변화. 중: 조사·재심 등 대응 필요. 하: 참고 동향.
`,
  },
];

export const unitCount = domains.reduce((sum, domain) => sum + domain.units.length, 0);

export const categoryCatalog = Object.freeze(domains.flatMap((domain) => (
  domain.units.map((unit) => Object.freeze({
    id: `${domain.key}:${unit.key}`,
    domainKey: domain.key,
    domainLabel: domain.label,
    unitKey: unit.key,
    unitLabel: unit.label,
    description: unit.description,
    officialDomains: unit.officialDomains,
    officialSources: unit.officialSources,
    lastReviewed: unit.lastReviewed,
    coverageTargets: unit.coverageTargets,
    queryTerms: unit.queryTerms,
    itemScope: unit.itemScope,
  }))
)));

export const groupCatalog = Object.freeze(domains.map((domain) => Object.freeze({
  id: domain.key,
  domainKey: domain.key,
  domainLabel: domain.label,
  unitCount: domain.units.length,
})));

export function isTrustedOfficialDomain(value, allowedDomains) {
  const hostname = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  const labels = hostname.split('.');
  if (
    !hostname
    || hostname.length > 253
    || !hostname.includes('.')
    || !/^[a-z0-9.-]+$/i.test(hostname)
    || labels.some((label) => (
      !label
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    ))
    || !Array.isArray(allowedDomains)
  ) return false;
  return allowedDomains.some((allowed) => {
    const suffix = String(allowed || '').trim().toLowerCase().replace(/\.$/, '');
    return suffix && (hostname === suffix || hostname.endsWith(`.${suffix}`));
  });
}

export function resolveCategorySelector(value) {
  const selector = String(value || '').trim();
  if (!selector) throw new Error('--category 뒤에 카테고리를 입력해야 합니다.');
  const normalized = selector.toLocaleLowerCase('ko-KR');
  const matches = categoryCatalog.filter((entry) => {
    const aliases = [
      entry.id,
      `${entry.domainLabel}:${entry.unitKey}`,
      `${entry.domainKey}/${entry.unitKey}`,
      `${entry.domainLabel}/${entry.unitKey}`,
      entry.unitKey,
    ];
    return aliases.some((alias) => alias.toLocaleLowerCase('ko-KR') === normalized);
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `카테고리 이름이 여러 영역에 있어 하나를 고를 수 없습니다: ${selector}. `
      + `다음 중 하나를 사용하세요: ${matches.map((entry) => entry.id).join(', ')}`,
    );
  }
  throw new Error(`알 수 없는 카테고리: ${selector}. --list-categories로 목록을 확인하세요.`);
}

export function resolveGroupSelector(value) {
  const selector = String(value || '').trim();
  if (!selector) throw new Error('--group 뒤에 그룹을 입력해야 합니다.');
  const normalized = selector.toLocaleLowerCase('ko-KR');
  const match = groupCatalog.find((entry) => (
    entry.id.toLocaleLowerCase('ko-KR') === normalized
    || entry.domainLabel.toLocaleLowerCase('ko-KR') === normalized
  ));
  if (match) return match;
  throw new Error(`알 수 없는 그룹: ${selector}. --list-groups로 목록을 확인하세요.`);
}

export function scopedDomains(categorySelection = null, groupSelection = null) {
  if (categorySelection && groupSelection) {
    throw new Error('--category와 --group은 함께 사용할 수 없습니다.');
  }
  if (groupSelection) {
    const selectedDomain = domains.find((domain) => domain.key === groupSelection.domainKey);
    if (!selectedDomain) {
      throw new Error('선택한 그룹이 현재 설정에 없습니다. --list-groups로 목록을 확인하세요.');
    }
    return [selectedDomain];
  }
  if (!categorySelection) return domains;
  const selectedDomain = domains.find((domain) => domain.key === categorySelection.domainKey);
  const selectedUnit = selectedDomain?.units.find((unit) => unit.key === categorySelection.unitKey);
  if (!selectedDomain || !selectedUnit) {
    throw new Error('선택한 카테고리가 현재 설정에 없습니다. --list-categories로 목록을 확인하세요.');
  }
  return [{ ...selectedDomain, units: [selectedUnit] }];
}

export function buildCategoryPrompt(domain, unit, context, options = {}) {
  if (!domain?.units?.some((candidate) => candidate.key === unit?.key)) {
    throw new Error(`${domain?.label || '선택 영역'}의 조사 카테고리가 올바르지 않습니다.`);
  }
  const categoryTemplate = `    "${unit.key}": [${ITEM_SCHEMA}]`;
  const categoryScope = `- ${unit.key}: ${unit.description}`;
  const officialDomainScope = unit.officialDomains.join(', ');
  const officialSourceScope = unit.officialSources
    .map((source) => `${source.hostname}(${source.sourceTier})`)
    .join(', ');
  const queryTermScope = unit.queryTerms.join(' | ');
  const itemScope = unit.itemScope.aliases.join(', ');
  const {
    depth,
    minimumOfficialSearches,
    minimumBroadSearches,
    minimumSearchesPerCategory,
    maximumItemsPerCategory,
    officialTargetsPerSearch,
  } = researchPolicyForUnit(unit, options.depth);
  const coverageScope = Array.from(
    { length: Math.ceil(unit.coverageTargets.length / officialTargetsPerSearch) },
    (_, index) => unit.coverageTargets
      .slice(index * officialTargetsPerSearch, (index + 1) * officialTargetsPerSearch)
      .map((target) => target.label)
      .join(' + '),
  ).join(', ');
  const correctiveAppendix = String(options.correctiveAppendix || '').trim();
  const provider = ['claude', 'gemini', 'chatgpt'].includes(options.provider)
    ? options.provider
    : 'claude';
  const providerName = provider === 'gemini'
    ? 'Gemini CLI'
    : provider === 'chatgpt'
      ? 'ChatGPT(Codex CLI)'
      : 'Claude Code';
  const searchToolName = provider === 'gemini'
    ? 'google_web_search'
    : provider === 'chatgpt'
      ? 'web_search'
      : 'WebSearch';
  const officialSearchInstruction = provider === 'claude'
    ? `- 공식기관 원문 검색은 서로 다른 query로 최소 ${minimumOfficialSearches}회 실행한다. 각 공식 검색은 허용 도메인의 실제 원문 URL을 하나 이상 찾아야 한다. WebSearch의 allowed_domains에는 다음 신뢰 목록의 hostname 또는 그 하위 도메인만 1개 이상 넣는다: ${officialDomainScope}`
    : `- 공식기관 원문 검색은 서로 다른 query로 최소 ${minimumOfficialSearches}회 실행한다. ${searchToolName}의 query마다 다음 신뢰 목록 중 하나 이상의 hostname을 site:hostname 형식으로 명시하고, 목록 밖 site: 도메인은 쓰지 않는다: ${officialDomainScope}`;
  const broadSearchInstruction = provider === 'claude'
    ? `- 일반 동향 검색은 서로 다른 query로 최소 ${minimumBroadSearches}회 실행하며 allowed_domains와 blocked_domains를 모두 넣지 않는다. 일반 검색 1: 주요 국제·현지 언론, 일반 검색 2: 현지어 기사·통상 전문매체·산업협회, 일반 검색 3: 한국 기업·공급망·제품 영향을 각각 넓게 탐색한다.`
    : `- 일반 동향 검색은 서로 다른 query로 최소 ${minimumBroadSearches}회 실행하며 site: 연산자를 넣지 않는다. 일반 검색 1: 주요 국제·현지 언론, 일반 검색 2: 현지어 기사·통상 전문매체·산업협회, 일반 검색 3: 한국 기업·공급망·제품 영향을 각각 넓게 탐색한다.`;
  const providerEvidenceInstructions = provider === 'claude' ? [] : [
    '- 최종 JSON 최상위에 _searchEvidence 배열을 반드시 포함한다.',
    `- _searchEvidence에는 성공한 ${searchToolName} query마다 정확히 한 항목을 두고, 도구에 실제 전달한 query 문자열을 글자 하나 바꾸지 않고 복사한다.`,
    '- 각 항목은 {"query":"실제 query","mode":"official|broad","urls":["그 query 결과에서 실제 확인한 HTTPS 원문 URL"]} 형식이다.',
    '- official은 site:hostname을 사용한 공식기관 검색, broad는 site:를 사용하지 않은 일반 검색이다. 검색 결과에 없던 URL을 만들거나 다른 query의 URL을 옮기지 않는다.',
  ];

  return [
    '당신은 기업용 글로벌 통상 리서치 애널리스트다.',
    '파일을 읽거나 수정하지 말고 셸 명령도 실행하지 않는다. 웹 조사만 수행한다.',
    `조사 기간(KST): ${context.fromStr} ~ ${context.toStr}`,
    `오늘(KST): ${context.toISO}`,
    '',
    `[조사 영역] ${domain.label}`,
    categoryScope,
    `[조사 깊이] ${depth}`,
    `[반드시 검색 query로 모두 확인할 하위 대상] ${coverageScope}`,
    `[권장 검색어 축] ${queryTermScope}`,
    `[응답 항목 소속 허용값] ${unit.itemScope.fields.join('·')}: ${itemScope}`,
    `[출처 등급·최종 검토일 ${unit.lastReviewed}] ${officialSourceScope}`,
    domain.scope.trim(),
    COMMON_RULES.trim(),
    '- 원문에 발표시각과 시간대가 명시된 경우에만 announcedAt을 기록한다. 시각을 추정하지 않는다. announcedAt을 KST로 변환한 달력 날짜가 announcedDate와 같아야 한다.',
    '- announcedAt이 없으면 announcedDate 기준의 KST 달력 날짜 범위로 판정된다는 점을 고려한다.',
    '- 포함하는 항목은 importance, importanceReason, measureType, title, summary, announcedDate, issuingCountry, agency, sourceName, sourceUrl을 모두 채운다.',
    '- sourceUrl은 실제로 검색에서 확인한 공개 HTTPS 원문이어야 한다. URL이 없거나 중요도가 상·중·하 중 하나가 아니면 항목을 제외한다.',
    '',
    `[필수 ${minimumSearchesPerCategory}회 다각도 심층 검색 절차]`,
    `- 이 카테고리만 조사하며 ${providerName}의 ${searchToolName}를 총 최소 ${minimumSearchesPerCategory}회 성공시킨다. 모든 query는 의미상 서로 달라야 하며 단어 순서만 바꾼 반복 검색은 금지한다.`,
    officialSearchInstruction,
    `- 각 하위 대상은 실제 공식 원문 URL을 얻은 공식기관 검색 query에 최소 1회 포함한다. 공식 query 하나에는 하위 대상을 최대 ${officialTargetsPerSearch}개까지만 넣어 대상을 분산한다.`,
    '- government·intergovernmental 원문을 법적 근거로 우선한다. trusted-association은 보조 출처이며 법령·제재·판정의 유일한 원문 근거로 사용하지 않는다.',
    '- 공식 검색 1: 최신 법령·관보·행정명령·보도자료, 공식 검색 2: 집행기관의 이행지침·통관/허가/판정, 공식 검색 3: 전자·가전·부품·반도체·AI·철강·HS 품목별 조치를 각각 탐색한다.',
    provider === 'claude'
      ? '- URL이나 경로는 넣지 않고 blocked_domains와 함께 사용하지 않는다. 목록 밖 언론·민간 도메인은 이 검색에 넣지 않는다.'
      : '- site:에는 hostname만 넣고 URL 경로는 넣지 않는다. 목록 밖 언론·민간 도메인을 공식 검색의 site:에 넣지 않는다.',
    broadSearchInstruction,
    '- 각 하위 대상은 실제 결과 URL을 얻은 성공 검색 query 중 적어도 하나에 위 표기 또는 통용 영문명으로 명시한다. 여러 대상을 한 query에 묶을 수 있지만 누락은 금지한다.',
    '- 복수 국가·기관 카테고리는 하위 대상을 가능한 한 서로 다른 검색 query에 분산해 전체 범위를 고르게 확인하고, 한 국가나 기관만 반복 검색하지 않는다.',
    '- 최종 항목은 응답 항목 소속 허용값 중 하나와 실제로 일치해야 한다. 다른 지역·기관·조치 유형의 항목을 이 카테고리에 넣지 않는다.',
    '- 모든 검색은 조사 기간, 대상 국가·기관, 조치 유형을 반영한다. 실패한 검색은 성공 횟수에 포함하지 말고 새로운 query로 보완한다.',
    `- 중복을 제외하고 최대 ${maximumItemsPerCategory}건. 해당 기간에 검증된 신규 동향이 없으면 빈 배열을 둔다.`,
    `- categories에는 "${unit.key}" 키를 정확히 한 번 포함한다.`,
    ...providerEvidenceInstructions,
    correctiveAppendix ? '' : null,
    correctiveAppendix ? '[이전 조사 오류 교정 지침]' : null,
    correctiveAppendix || null,
    '',
    '[출력 형식]',
    '- 설명, 마크다운, 코드 펜스 없이 아래 형태의 단일 JSON 객체 하나만 출력한다.',
    '- insight는 선택한 카테고리의 핵심 흐름과 기업 대응 포인트를 한국어 2~3문장으로 작성한다. 항목이 모두 없으면 빈 문자열이다.',
    '{',
    `  "domain": "${domain.key}",`,
    '  "insight": "영역 종합 인사이트",',
    '  "categories": {',
    categoryTemplate,
    provider === 'claude' ? '  }' : '  },',
    provider === 'claude' ? null : '  "_searchEvidence": [',
    provider === 'claude' ? null : '    {"query":"실제 검색 query","mode":"official|broad","urls":["https://실제-검색-결과-URL"]}',
    provider === 'claude' ? null : '  ]',
    '}',
  ].filter((line) => line !== null).join('\n');
}

// 이전 import 사용처가 명확한 오류로 마이그레이션될 수 있도록 이름은 유지하되,
// 여러 카테고리를 한 요청으로 묶는 호출은 거부한다.
export function buildDomainPrompt(domain, context, requestedUnits = domain.units, options = {}) {
  if (!Array.isArray(requestedUnits) || requestedUnits.length !== 1) {
    throw new Error('조사 프롬프트는 카테고리 하나만 포함해야 합니다.');
  }
  return buildCategoryPrompt(domain, requestedUnits[0], context, options);
}

export function domainByKey(key) {
  return domains.find((domain) => domain.key === key) || null;
}
