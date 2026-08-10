const PRODUCT_SCOPE = [
  '스마트폰, 태블릿, 스마트워치, 이어폰, TV, 모니터, 사운드바',
  '냉장고, 세탁기, 에어컨, 오븐, 청소기, 식기세척기',
  '의료기기, 네트워크 장비, 전자제품 부품, 반도체, AI 관련 품목',
  '철강, 알루미늄, 플라스틱 등 전자·가전 관련 자재',
].join(', ');

const MINIMUM_OFFICIAL_SEARCHES = 3;
const MINIMUM_BROAD_SEARCHES = 3;

export const CATEGORY_RESEARCH_POLICY = Object.freeze({
  minimumOfficialSearches: MINIMUM_OFFICIAL_SEARCHES,
  minimumBroadSearches: MINIMUM_BROAD_SEARCHES,
  minimumSearchesPerCategory: MINIMUM_OFFICIAL_SEARCHES + MINIMUM_BROAD_SEARCHES,
  maximumItemsPerCategory: 10,
});

const COMMON_RULES = `
[공통 정확성 규칙]
- 반드시 Claude Code의 내장 WebSearch를 사용해 최신 정보를 확인한다.
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

function units(rows, domainKey) {
  return rows.map(([key, description]) => {
    const officialDomains = officialDomainCatalog[domainKey]?.[key];
    if (!Array.isArray(officialDomains) || officialDomains.length === 0) {
      throw new Error(`${domainKey}:${key}의 공식 도메인 목록이 비어 있습니다.`);
    }
    return {
      key,
      label: key,
      description,
      officialDomains: Object.freeze([...officialDomains]),
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
  }))
)));

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

export function scopedDomains(categorySelection = null) {
  if (!categorySelection) return domains;
  const selectedDomain = domains.find((domain) => domain.key === categorySelection.domainKey);
  const selectedUnit = selectedDomain?.units.find((unit) => unit.key === categorySelection.unitKey);
  if (!selectedDomain || !selectedUnit) {
    throw new Error('선택한 카테고리가 현재 설정에 없습니다. --list-categories로 목록을 확인하세요.');
  }
  return [{ ...selectedDomain, units: [selectedUnit] }];
}

export function buildCategoryPrompt(domain, unit, context) {
  if (!domain?.units?.some((candidate) => candidate.key === unit?.key)) {
    throw new Error(`${domain?.label || '선택 영역'}의 조사 카테고리가 올바르지 않습니다.`);
  }
  const categoryTemplate = `    "${unit.key}": [${ITEM_SCHEMA}]`;
  const categoryScope = `- ${unit.key}: ${unit.description}`;
  const officialDomainScope = unit.officialDomains.join(', ');
  const {
    minimumOfficialSearches,
    minimumBroadSearches,
    minimumSearchesPerCategory,
    maximumItemsPerCategory,
  } = CATEGORY_RESEARCH_POLICY;

  return [
    '당신은 기업용 글로벌 통상 리서치 애널리스트다.',
    '파일을 읽거나 수정하지 말고 셸 명령도 실행하지 않는다. 웹 조사만 수행한다.',
    `조사 기간(KST): ${context.fromStr} ~ ${context.toStr}`,
    `오늘(KST): ${context.toISO}`,
    '',
    `[조사 영역] ${domain.label}`,
    categoryScope,
    domain.scope.trim(),
    COMMON_RULES.trim(),
    '- 원문에 발표시각과 시간대가 명시된 경우에만 announcedAt을 기록한다. 시각을 추정하지 않고, ISO 8601의 날짜 부분은 announcedDate와 같아야 한다.',
    '- announcedAt이 없으면 announcedDate 기준의 KST 달력 날짜 범위로 판정된다는 점을 고려한다.',
    '- 포함하는 항목은 importance, importanceReason, measureType, title, summary, announcedDate, issuingCountry, agency, sourceName, sourceUrl을 모두 채운다.',
    '- sourceUrl은 실제로 검색에서 확인한 공개 HTTPS 원문이어야 한다. URL이 없거나 중요도가 상·중·하 중 하나가 아니면 항목을 제외한다.',
    '',
    `[필수 ${minimumSearchesPerCategory}회 다각도 심층 검색 절차]`,
    `- 이 카테고리만 조사하며 Claude WebSearch를 총 최소 ${minimumSearchesPerCategory}회 성공시킨다. 모든 query는 의미상 서로 달라야 하며 단어 순서만 바꾼 반복 검색은 금지한다.`,
    `- 공식기관 원문 검색은 서로 다른 query로 최소 ${minimumOfficialSearches}회 실행한다. WebSearch의 allowed_domains에는 다음 신뢰 목록의 hostname 또는 그 하위 도메인만 1개 이상 넣는다: ${officialDomainScope}`,
    '- 공식 검색 1: 최신 법령·관보·행정명령·보도자료, 공식 검색 2: 집행기관의 이행지침·통관/허가/판정, 공식 검색 3: 전자·가전·부품·반도체·AI·철강·HS 품목별 조치를 각각 탐색한다.',
    '- URL이나 경로는 넣지 않고 blocked_domains와 함께 사용하지 않는다. 목록 밖 언론·민간 도메인은 이 검색에 넣지 않는다.',
    `- 일반 동향 검색은 서로 다른 query로 최소 ${minimumBroadSearches}회 실행하며 allowed_domains를 넣지 않는다. 일반 검색 1: 주요 국제·현지 언론, 일반 검색 2: 현지어 기사·통상 전문매체·산업협회, 일반 검색 3: 한국 기업·공급망·제품 영향을 각각 넓게 탐색한다.`,
    '- 복수 국가·기관 카테고리는 검색어마다 대상 묶음을 나누어 전체 범위를 고르게 확인하고, 한 국가나 기관만 반복 검색하지 않는다.',
    '- 모든 검색은 조사 기간, 대상 국가·기관, 조치 유형을 반영한다. 실패한 검색은 성공 횟수에 포함하지 말고 새로운 query로 보완한다.',
    `- 중복을 제외하고 최대 ${maximumItemsPerCategory}건. 해당 기간에 검증된 신규 동향이 없으면 빈 배열을 둔다.`,
    `- categories에는 "${unit.key}" 키를 정확히 한 번 포함한다.`,
    '',
    '[출력 형식]',
    '- 설명, 마크다운, 코드 펜스 없이 아래 형태의 JSON 객체 하나만 출력한다.',
    '- insight는 선택한 카테고리의 핵심 흐름과 기업 대응 포인트를 한국어 2~3문장으로 작성한다. 항목이 모두 없으면 빈 문자열이다.',
    '{',
    `  "domain": "${domain.key}",`,
    '  "insight": "영역 종합 인사이트",',
    '  "categories": {',
    categoryTemplate,
    '  }',
    '}',
  ].join('\n');
}

// 이전 import 사용처가 명확한 오류로 마이그레이션될 수 있도록 이름은 유지하되,
// 여러 카테고리를 한 요청으로 묶는 호출은 거부한다.
export function buildDomainPrompt(domain, context, requestedUnits = domain.units) {
  if (!Array.isArray(requestedUnits) || requestedUnits.length !== 1) {
    throw new Error('Claude 조사 프롬프트는 카테고리 하나만 포함해야 합니다.');
  }
  return buildCategoryPrompt(domain, requestedUnits[0], context);
}

export function domainByKey(key) {
  return domains.find((domain) => domain.key === key) || null;
}
